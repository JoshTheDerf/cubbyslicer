/**
 * The sketch session (Orca's DesignSketchTool live sketch) on the kernel's session verbs
 * (`sketch_begin` … `sketch_commit`, contract "Sketch sessions").
 *
 * - **One app undo step.** The session lives in the kernel document (one open sketch per
 *   document) and changes nothing in the project until Finish: `sketch_commit` runs in one
 *   `runEdit`, so the whole sketch — new, or an edit of an existing one — is one undo step of
 *   the app history, with the plate objects it moves. While the session is open, Ctrl+Z / Ctrl+Y
 *   (and Edit ▸ Undo) are sketch-level: `undoOverride` routes them to the kernel's
 *   `sketch_undo` / `sketch_redo`. One user gesture (a drag of 40 solver steps, a fillet with its
 *   constraint bookkeeping) is one entry: the journal counts the kernel steps each gesture made
 *   (every successful mutating session call is one kernel step) and undoes that many.
 * - **Responsive.** Every call is a quiet kernel job (the solve is ~1–7 ms plus the worker hop);
 *   drags are coalesced latest-wins with one call in flight, so the UI thread never waits and the
 *   solver never falls behind the pointer.
 * - **Survives a kernel reset.** The page keeps the last state; if the kernel document was
 *   reopened (crash, cancel, memory recycle) the next call re-creates the session from it
 *   (`sketch_begin` + the entities + the constraints, forced) before going on.
 * - Other design edits are blocked while a sketch is open (`setSketchGuard`), as in Orca.
 */
import { markRaw, reactive, watch } from 'vue';
import { projectLoads } from '../../project/store';
import { undoOverride, type UndoOverride } from '../../app/shell/commands/edit';
import { setActionScopeRefiner } from '../../app/actions/dispatch';
import type { JobContext } from '../kernel/client';
import type { EdgeInfo, MutationResult, PlaneFrame } from '../kernel/types';
import { currentDoc, design, designKernel, runEdit, setSketchGuard, setStatus, DesignEditError, editBlocker } from '../session';
import { designUi } from '../state';
import { phone } from '../../app/shell/uiState';
import { designViewport } from '../viewport';
import {
  CONSTRAINT_TYPES, cons, dist, entity, isDimension, nearestOn, sub, toPlane, angleOf,
  type LoopReport, type Role, type SketchDescribe, type SkConstraint, type SkConstraintType, type SkEntity, type V2,
} from './model';
import {
  constraintEntities, constraintLabel, describeConstraint, duplicateOf, fromWire, guard, planLocal, refsPoint, rejectText, toWire,
  type Plan, type SelItem,
} from './constraints';
import type { DrawToolId } from './shapes';
import { QUOTE_TITLE, quoteEdit, type LiveQuote } from './quotes';

export type EditToolId = 'select' | 'dimension' | 'trim' | 'extend' | 'fillet' | 'chamfer' | 'offset' | 'mirror' | 'move' | 'rotate' | 'scale' | 'array' | 'polar' | 'use-edges';
export type SketchToolId = DrawToolId | EditToolId;

/** Where a new sketch goes: a datum plane (name or frame), a flat face, or an existing Sketch to edit. */
export type SketchTarget =
  | { plane: 'XY' | 'XZ' | 'YZ' | PlaneFrame; label?: string }
  | { face: { body: number; face: number }; generation: number }
  | { feature: number };

/** A refused constraint: what conflicts with it and what the user can do. */
export interface Conflict { message: string; pending: SkConstraint[]; offenders: number[] }

/** The inline value editor (Orca's SketchInlineEditor): one field, a queue for Tab. */
export interface ValueRequest {
  label: string;
  value: number;
  unit: 'mm' | '°' | '×' | '';
  /** Where it sits: plane point (anchored at the label) or null = centred over the view. */
  at: V2 | null;
  /** …or a screen position (container px), e.g. the dimension label being edited. */
  screen?: [number, number];
  /** Integer fields (counts). */
  int?: boolean;
  min?: number;
  /** Apply the value; a string refuses it (the field stays with the message). */
  submit(v: number): Promise<string | null>;
  /** Esc: keep the geometry as drawn. */
  cancel?(): void;
}

export const sk = reactive({
  open: false,
  /** Choosing where to sketch (Orca's `m_choosing_sketch_plane`). */
  choosing: false,
  starting: false,
  committing: false,
  /** The Sketch feature being edited (-1: a new sketch). */
  feature: -1,
  name: '',
  plane: null as PlaneFrame | null,
  planeLabel: '',
  entities: markRaw([]) as SkEntity[],
  constraints: markRaw([]) as SkConstraint[],
  dof: -1,
  solveOk: true,
  result: 0,
  bad: [] as number[],
  skipped: [] as number[],
  loops: null as LoopReport | null,
  sel: [] as SelItem[],
  selCons: [] as number[],
  tool: 'select' as SketchToolId,
  /** New entities are construction geometry (Orca's sticky Construction toggle). */
  construction: false,
  polygonSides: 6,
  polygonCircumscribed: false,
  conflict: null as Conflict | null,
  value: null as ValueRequest | null,
  /** Kernel steps per undo entry. */
  undo: [] as number[],
  redo: [] as number[],
  /** The last sketch finished in this view (Orca offers Extrude / Revolve on it). */
  finished: null as null | { index: number; name: string },
  /** Text / SVG regions waiting for Finish (rigid outlines; written onto the Sketch feature). */
  regions: null as null | { regions: V2[][][]; offset: V2; scale: V2; label: string; text?: { string: string; font: string; height: number } },
  /**
   * Text / SVG started on a picked face (Orca's `import_on_face`): the body it engraves and the
   * face's centre on the sketch plane, where the outlines are centred.
   */
  onFace: null as null | { body: number; centre: V2 },
});

let sessionDoc: number | null = null;
let gesture: { steps: number; label: string } | null = null;

export const sketchOpen = () => sk.open;

// ---- state from the kernel ----------------------------------------------------------------

type StateResult = Partial<SketchDescribe> & { ok?: boolean; error?: string; can_undo?: boolean; can_redo?: boolean };

function applyState(r: StateResult): void {
  if (Array.isArray(r.entities)) sk.entities = markRaw(r.entities as SkEntity[]);
  if (Array.isArray(r.constraints)) sk.constraints = markRaw(r.constraints as SkConstraint[]);
  if (typeof r.dof === 'number') sk.dof = r.dof;
  if (typeof r.solve_ok === 'boolean') sk.solveOk = r.solve_ok;
  if (typeof r.result === 'number') sk.result = r.result;
  if (Array.isArray(r.bad)) sk.bad = r.bad.slice();
  if (Array.isArray(r.skipped)) sk.skipped = r.skipped.slice();
  if (Array.isArray(r.closed_loops)) sk.loops = { closed_loops: r.closed_loops, open_ends: r.open_ends ?? [], defects: r.defects ?? [], buildable: !!r.buildable };
  // Selection indices past the end are gone (a delete shifted them).
  sk.sel = sk.sel.filter((s) => s.e < sk.entities.length);
  sk.selCons = sk.selCons.filter((i) => i < sk.constraints.length);
}

/** Make sure the kernel's document has this session (re-create it after a reset). Returns the doc. */
async function ensureSession(c: JobContext): Promise<number> {
  const doc = currentDoc();
  if (doc === null) throw new DesignEditError('No design is open.');
  if (sessionDoc === doc) return doc;
  // The document was reopened: the kernel's session is gone. Rebuild it from the page's copy.
  const target = sk.feature >= 0 ? { feature: sk.feature } : { plane: sk.plane };
  const begun = (await c.call<SketchDescribe>('sketch_begin', { doc, ...target })).result;
  if (begun.entities.length) await c.call('sketch_delete', { doc, entities: begun.entities.map((_, i) => i) });
  if (sk.entities.length) await c.call('sketch_add', { doc, entities: sk.entities, infer: false });
  if (sk.constraints.length) await c.call('sketch_constrain', { doc, constraints: sk.constraints, force: true });
  sessionDoc = doc;
  sk.undo = []; sk.redo = [];
  return doc;
}

/** A quiet kernel job on the session. */
function job<T>(fn: (c: JobContext, doc: number) => Promise<T>): Promise<T> {
  return designKernel().run('Sketch', async (c) => fn(c, await ensureSession(c)), { quiet: true });
}

function pushSteps(steps: number, label: string): void {
  if (steps <= 0) return;
  if (gesture) { gesture.steps += steps; return; }
  sk.undo = [...sk.undo, steps].slice(-200);
  sk.redo = [];
  void label;
}

/**
 * One session edit: `fn` makes kernel calls and returns how many kernel steps it made (each
 * successful mutating call is one); the state is re-read afterwards (`sketch_describe`).
 */
async function edit<T extends { steps: number }>(label: string, fn: (c: JobContext, doc: number) => Promise<T>, o: { describe?: boolean } = {}): Promise<T> {
  const out = await job(async (c, doc) => {
    const r = await fn(c, doc);
    const d = o.describe === false ? null : (await c.call<SketchDescribe>('sketch_describe', { doc })).result;
    return { r, d };
  });
  if (out.d) applyState(out.d);
  pushSteps(out.r.steps, label);
  return out.r;
}

/** Run one mutating call; returns its result and counts its step when it succeeded. */
async function step<T extends { ok?: boolean }>(c: JobContext, method: string, params: Record<string, unknown>): Promise<{ r: T; steps: number }> {
  const r = (await c.call<T>(method, params)).result;
  return { r, steps: r.ok === false ? 0 : 1 };
}

// ---- lifecycle -----------------------------------------------------------------------------

/** Orca's Sketch button: on the picked flat face, else ask where (planes / a face). */
export function startSketch(): string | null {
  const blocked = editBlocker();
  if (blocked) return blocked;
  const p = designUi.pick;
  if (p?.kind === 'face') { void beginSketch({ face: { body: p.body, face: p.face }, generation: p.generation }); return null; }
  sk.choosing = true;
  originBefore = designUi.showOrigin;
  designUi.showOrigin = true;
  setStatus('info', 'Click a reference plane or a flat face to sketch on it — Esc cancels.');
  return null;
}

let originBefore: boolean | null = null;
export function stopChoosing(): void {
  if (!sk.choosing) return;
  sk.choosing = false;
  if (originBefore !== null) { designUi.showOrigin = originBefore; originBefore = null; }
  design.status = null;
}

const PLANE_LABEL: Record<string, string> = { XY: 'Top plane (XY)', XZ: 'Front plane (XZ)', YZ: 'Right plane (YZ)' };

/** Open a session (new sketch on a plane / face, or edit an existing Sketch feature). */
export async function beginSketch(t: SketchTarget): Promise<boolean> {
  const blocked = editBlocker();
  if (blocked) { setStatus('warn', blocked); return false; }
  if (sk.open || sk.starting) return false;
  sk.starting = true;
  stopChoosing();
  try {
    const r = await designKernel().run('Opening the sketch', async (c) => {
      const doc = currentDoc();
      if (doc === null) throw new DesignEditError('No design is open.');
      const params: Record<string, unknown> = { doc };
      if ('feature' in t) params.feature = t.feature;
      else if ('face' in t) { params.face = t.face; params.generation = t.generation; }
      else params.plane = t.plane;
      let begun: SketchDescribe;
      try { begun = (await c.call<SketchDescribe>('sketch_begin', params)).result; } catch (e) {
        // A session left open (a previous tab life): drop it and try once more.
        if ((e as { code?: number }).code === -32022) { await c.call('sketch_cancel', { doc }).catch(() => {}); begun = (await c.call<SketchDescribe>('sketch_begin', params)).result; } else throw e;
      }
      sessionDoc = doc;
      return begun;
    });
    sk.open = true;
    sk.feature = 'feature' in t ? t.feature : -1;
    sk.name = 'feature' in t ? design.features[t.feature]?.name ?? 'Sketch' : '';
    sk.plane = r.plane;
    sk.planeLabel = 'feature' in t ? sk.name : 'face' in t ? `Face ${t.face.face} of Body ${t.face.body + 1}` : typeof t.plane === 'string' ? PLANE_LABEL[t.plane] : t.label ?? 'Plane';
    sk.entities = markRaw([]); sk.constraints = markRaw([]);
    sk.sel = []; sk.selCons = []; sk.undo = []; sk.redo = []; sk.conflict = null; sk.value = null; sk.regions = null; sk.onFace = null; sk.finished = null;
    sk.tool = 'select';
    applyState(r);
    designUi.pick = null;
    designUi.selected = 'feature' in t ? [t.feature] : [];
    // Phones: the panel sheet would cover the sketch.
    if (phone.value) designUi.panelOpen = false;
    // On a face: frame its body (an empty sketch has nothing else to frame).
    designViewport()?.sketchView?.(r.plane, sk.entities, 'face' in t ? design.bodies[t.face.body]?.bbox : undefined);
    setStatus('info', `Sketch plane: ${sk.planeLabel} — pick a tool (L line, R rectangle, C circle, A arc, D dimension).`);
    return true;
  } catch (e) {
    setStatus('error', `Can’t open the sketch: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    sk.starting = false;
  }
}

function closeLocal(): void {
  sk.open = false; sk.choosing = false; sk.feature = -1; sk.plane = null;
  sk.entities = markRaw([]); sk.constraints = markRaw([]); sk.sel = []; sk.selCons = []; sk.undo = []; sk.redo = [];
  sk.conflict = null; sk.value = null; sk.regions = null; sk.onFace = null; sk.loops = null; sk.dof = -1; sk.bad = []; sk.tool = 'select';
  sessionDoc = null; gesture = null;
  designViewport()?.sketchView?.(null, []);
}

/** Discard the session (Orca's Cancel). */
export async function cancelSketch(): Promise<void> {
  if (!sk.open) { stopChoosing(); return; }
  const doc = currentDoc();
  const own = sessionDoc === doc;
  closeLocal();
  if (own && doc !== null) await designKernel().run('Cancelling the sketch', async (c) => { await c.call('sketch_cancel', { doc }).catch(() => {}); }, { quiet: true }).catch(() => {});
  setStatus('info', 'Sketch discarded — the design is as it was.');
}

/** Finish (Orca's Confirm): `sketch_commit` as one app undo step; then offer Extrude / Revolve. */
export async function finishSketch(): Promise<{ ok: boolean; error: string; index?: number }> {
  if (!sk.open || sk.committing) return { ok: false, error: 'No sketch is open.' };
  if (sk.value) sk.value = null;
  sk.committing = true;
  const editing = sk.feature, regions = sk.regions, onFace = sk.onFace;
  const label = editing >= 0 ? `Edit ${sk.name}` : regions ? regions.label : 'Sketch';
  try {
    const out = await runEdit(label, async (c, doc) => {
      await ensureSession(c);
      const fields: Record<string, unknown> | null = regions ? { imported_regions: regions.regions, import_offset: regions.offset, import_scale_x: regions.scale[0], import_scale_y: regions.scale[1] } : null;
      if (fields && regions?.text) Object.assign(fields, { text_string: regions.text.string, text_font: regions.text.font, text_height: regions.text.height });
      // Orca's import_on_face: the art remembers its host body, and its Extrude defaults to an inward Cut of it.
      if (fields && onFace && editing < 0) Object.assign(fields, { import_on_face: true, import_face_body: onFace.body });
      // Kernel v1.2 takes the regions with the commit (one rebuild; it refuses an entity-less session
      // without them); older kernels ignore `fields`, so they get the set_feature below.
      const r = (await c.call<MutationResult & { sketch_index?: number; fields_applied?: boolean }>('sketch_commit', { doc, ...(regions && editing < 0 ? { name: `${regions.label} ${design.features.length + 1}` } : {}), ...(fields ? { fields } : {}) })).result;
      if (r.ok && fields && !r.fields_applied && typeof r.sketch_index === 'number') {
        const s = (await c.call<MutationResult>('set_feature', { doc, index: r.sketch_index, fields })).result;
        if (!s.ok) return { ...s, sketch_index: r.sketch_index };
      }
      if (!r.ok) {
        // A refused edit (a later feature fails): is the session still there? Keep it either way.
        const open = (await c.call<{ sketch_open: boolean }>('describe_scene', { doc })).result.sketch_open;
        if (!open) sessionDoc = null;
      }
      return r;
    }, { sketch: true, feature: editing >= 0 ? editing : undefined, done: (r) => (editing >= 0 ? `${sk.name} updated` : `Added ${design.features[(r as { sketch_index?: number }).sketch_index ?? -1]?.name ?? 'the sketch'}`) });
    const r = out.result as (MutationResult & { sketch_index?: number }) | null;
    if (!out.ok) return { ok: false, error: out.error || 'The sketch was refused.' };
    const index = r?.sketch_index ?? editing;
    closeLocal();
    designUi.selected = index >= 0 ? [index] : [];
    sk.finished = index >= 0 ? { index, name: design.features[index]?.name ?? 'Sketch' } : null;
    return { ok: true, error: '', index };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus('error', `Can’t finish the sketch: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    sk.committing = false;
  }
}

// ---- undo inside the session ----------------------------------------------------------------

export async function sketchUndo(): Promise<void> {
  const n = sk.undo[sk.undo.length - 1];
  if (!n) { setStatus('info', 'Nothing to undo in this sketch (Cancel discards it).'); return; }
  sk.undo = sk.undo.slice(0, -1);
  const d = await job(async (c, doc) => { for (let i = 0; i < n; i++) await c.call('sketch_undo', { doc }); return (await c.call<SketchDescribe>('sketch_describe', { doc })).result; });
  applyState(d);
  sk.redo = [...sk.redo, n];
}

export async function sketchRedo(): Promise<void> {
  const n = sk.redo[sk.redo.length - 1];
  if (!n) return;
  sk.redo = sk.redo.slice(0, -1);
  const d = await job(async (c, doc) => { for (let i = 0; i < n; i++) await c.call('sketch_redo', { doc }); return (await c.call<SketchDescribe>('sketch_describe', { doc })).result; });
  applyState(d);
  sk.undo = [...sk.undo, n];
}

const override: UndoOverride = {
  undo: () => { void sketchUndo(); },
  redo: () => { void sketchRedo(); },
  canUndo: () => sk.undo.length > 0,
  canRedo: () => sk.redo.length > 0,
  undoLabel: () => (sk.undo.length ? 'sketch edit' : null),
  redoLabel: () => (sk.redo.length ? 'sketch edit' : null),
};

watch(() => sk.open, (o) => { undoOverride.value = o ? override : (undoOverride.value === override ? null : undoOverride.value); });
setSketchGuard(() => (sk.open ? 'Finish or cancel the sketch first.' : null));
// Orca's sketch key map replaces the feature map while a sketch is open (actions.ts: scope 'sketch').
setActionScopeRefiner((s) => (s === 'design' && sk.open ? 'sketch' : s));
// A new project: the session (in the old document) is gone.
watch(projectLoads, () => { if (sk.open) { closeLocal(); setStatus('info', 'The sketch was closed: another project was opened.'); } sk.finished = null; });

// ---- gestures and drags -------------------------------------------------------------------------

export function beginGesture(label: string): void { if (!gesture) gesture = { steps: 0, label }; }
export async function endGesture(): Promise<void> {
  await dragIdle();
  const g = gesture;
  gesture = null;
  if (g && g.steps) { sk.undo = [...sk.undo, g.steps].slice(-200); sk.redo = []; }
  // Drags skip the loop report; read it once at the end.
  if (g && sk.open) applyState(await job(async (c, doc) => (await c.call<SketchDescribe>('sketch_describe', { doc })).result));
}

type DragReq = { kind: 'point'; entity: number; role: Role; to: V2 } | { kind: 'entity'; index: number; entity: SkEntity } | { kind: 'line'; index: number; p0: V2; p1: V2 };
let dragNext: DragReq | null = null;
let dragRunning: Promise<void> | null = null;

/** Drag a point (or an entity) under the solver; coalesced: only the latest target is sent. */
export function drag(req: DragReq): void {
  dragNext = req;
  if (!dragRunning) dragRunning = pumpDrag().finally(() => { dragRunning = null; });
}
async function dragIdle(): Promise<void> { while (dragRunning) await dragRunning; }
async function pumpDrag(): Promise<void> {
  while (dragNext) {
    const q = dragNext;
    dragNext = null;
    try {
      const out = await job(async (c, doc) => {
        let steps = 0, last: StateResult | null = null;
        const go = async (m: string, p: Record<string, unknown>) => { const s = await step<StateResult>(c, m, { doc, ...p }); steps += s.steps; last = s.r; };
        if (q.kind === 'point') await go('sketch_drag', { entity: q.entity, role: q.role, to: q.to });
        else if (q.kind === 'line') { await go('sketch_drag', { entity: q.index, role: 'p0', to: q.p0 }); await go('sketch_drag', { entity: q.index, role: 'p1', to: q.p1 }); }
        else await go('sketch_set_entity', { index: q.index, entity: q.entity });
        return { steps, last: last as StateResult | null };
      });
      if (out.last) applyState(out.last);
      pushSteps(out.steps, 'Drag');
    } catch (e) {
      setStatus('warn', `Drag refused: ${e instanceof Error ? e.message : String(e)}`);
      dragNext = null;
    }
  }
}

// ---- adding geometry ----------------------------------------------------------------------------

/**
 * Add entities and the constraints that come with them (shape constraints, snaps, H / V) as one
 * undo entry. Constraints the solver refuses are dropped one by one (Orca's one-at-a-time
 * fallback) so a shape always lands; the dropped ones are reported.
 */
export async function addEntities(entities: SkEntity[], constraints: SkConstraint[], label = 'Draw', o: { infer?: boolean } = {}): Promise<{ first: number; dropped: SkConstraint[] }> {
  const ents = entities.map((e) => ({ ...e, construction: e.construction }));
  const out = await edit(label, async (c, doc) => {
    const a = await step<{ ok: boolean; first_index: number }>(c, 'sketch_add', { doc, entities: ents, infer: !!o.infer });
    let steps = a.steps;
    const dropped: SkConstraint[] = [];
    const list = constraints.filter((x) => !guard(x, [...sk.entities, ...ents]));
    if (list.length) {
      const all = await step<{ ok: boolean }>(c, 'sketch_constrain', { doc, constraints: list });
      steps += all.steps;
      if (!all.r.ok) {
        for (const x of list) {
          const one = await step<{ ok: boolean }>(c, 'sketch_constrain', { doc, constraint: x });
          steps += one.steps;
          if (!one.r.ok) dropped.push(x);
        }
      }
    }
    return { steps, first: a.r.first_index, dropped };
  });
  if (out.dropped.length) setStatus('warn', `Added — ${out.dropped.length} inferred constraint${out.dropped.length > 1 ? 's' : ''} would over-constrain the sketch and ${out.dropped.length > 1 ? 'were' : 'was'} left out (${out.dropped.map((x) => constraintLabel(x.type)).join(', ')}).`);
  return { first: out.first, dropped: out.dropped };
}

// ---- constraints ----------------------------------------------------------------------------------

/** What a constraint button would do with the selection (local rules for vertices, else the kernel's planner). */
export async function planFor(type: SkConstraintType, sel: readonly SelItem[] = sk.sel): Promise<Plan> {
  const local = planLocal(type, sel, sk.entities);
  if (local) return local;
  if (!sel.length) return { kind: 'reject', reason: 'Select the entities first' };
  const r = await job(async (c, doc) => (await c.call<{ kind: string; reason: string; constraints: SkConstraint[]; prefill: number }>('sketch_plan', { doc, type, entities: sel.slice(0, 3).map((s) => s.e) })).result);
  if (r.kind === 'reject') return { kind: 'reject', reason: rejectText(r.reason) };
  if (r.kind === 'ask_value') return { kind: 'ask_value', constraints: r.constraints, prefill: r.prefill, unit: type === 'angle' ? '°' : 'mm' };
  return { kind: 'apply', constraints: r.constraints };
}

/** Orca's constraint button on the selection. */
export async function applyConstraint(type: SkConstraintType): Promise<string | null> {
  const plan = await planFor(type);
  if (plan.kind === 'reject') { setStatus('info', `${constraintLabel(type)}: ${plan.reason}.`); return plan.reason; }
  if (plan.kind === 'apply') return addConstraints(plan.constraints);
  const c0 = plan.constraints[0];
  requestValue({
    label: constraintLabel(type), value: plan.prefill, unit: plan.unit, at: anchorOf(c0),
    submit: async (v) => addConstraints(plan.constraints.map((c) => ({ ...c, value: toWire(c.type, v) }))),
  });
  return null;
}

/**
 * Add constraints (one undo entry). A batch the solver can't satisfy is not added: the
 * constraints it conflicts with are found and named (`sk.conflict`), with Replace / Keep both.
 */
export async function addConstraints(list: SkConstraint[], o: { force?: boolean } = {}): Promise<string | null> {
  for (const c of list) { const g = guard(c, sk.entities); if (g) { setStatus('warn', g); return g; } }
  const fresh = list.filter((c) => duplicateOf(c, sk.constraints) < 0);
  if (!fresh.length) { setStatus('info', `${constraintLabel(list[0].type)} is already there.`); return null; }
  const out = await edit('Constrain', async (c, doc) => {
    const s = await step<{ ok: boolean; error?: string; bad?: number[]; conflicts?: number[] }>(c, 'sketch_constrain', { doc, constraints: fresh, ...(o.force ? { force: true } : {}) });
    if (s.r.ok) return { steps: s.steps, offenders: [] as number[], error: '' };
    // Kernel v1.2 names the conflicting set itself; older kernels are probed one removal at a time.
    const offenders = Array.isArray(s.r.conflicts) ? rankOffenders(s.r.conflicts) : await findOffenders(c, doc, fresh);
    return { steps: 0, offenders, error: s.r.error ?? '' };
  });
  if (!out.error) {
    sk.conflict = null;
    const over = o.force && !sk.solveOk;
    setStatus(over ? 'warn' : 'ok', over ? `Kept ${fresh.map((x) => constraintLabel(x.type)).join(', ')} — the sketch is over-constrained (${sk.bad.length} conflicting).` : `${fresh.map((x) => constraintLabel(x.type)).join(', ')} added — ${dofText()}.`);
    return null;
  }
  const names = out.offenders.map((i) => describeConstraint(sk.constraints[i], sk.entities, i));
  const what = fresh.map((x) => describeConstraint(x, sk.entities)).join(', ');
  const message = names.length ? `${what} conflicts with ${names.join('; ')}.` : `${what} over-constrains the sketch (or can’t be satisfied).`;
  sk.conflict = { message, pending: fresh, offenders: out.offenders };
  setStatus('error', `${message} Nothing was added.`);
  return message;
}

/** The kernel's conflicting set, dimensions first (the useful ones to name and replace), newest first. */
function rankOffenders(conflicts: number[]): number[] {
  const known = conflicts.filter((i) => sk.constraints[i]).sort((a, b) => b - a);
  return [...known.filter((i) => isDimension(sk.constraints[i])), ...known.filter((i) => !isDimension(sk.constraints[i]))].slice(0, 3);
}

/**
 * Older kernels (v1.1): which existing constraints make `pending` unsolvable: for each candidate sharing an entity
 * with it, would `pending` be accepted without that one? Probes are undone (kernel steps).
 */
async function findOffenders(c: JobContext, doc: number, pending: SkConstraint[]): Promise<number[]> {
  const ents = new Set(pending.flatMap(constraintEntities));
  const touches = (x: SkConstraint) => constraintEntities(x).some((e) => ents.has(e)) || x.ea === -2 || x.eb === -2;
  // Dimensions first (the useful ones to name and replace), newest first; then geometric
  // constraints on the same entities.
  const all = sk.constraints.map((x, i) => ({ x, i })).reverse();
  const cand = [...all.filter(({ x }) => isDimension(x)), ...all.filter(({ x }) => !isDimension(x) && touches(x))].slice(0, 32);
  const out: number[] = [];
  for (const { i } of cand) {
    const del = await step<{ ok: boolean }>(c, 'sketch_delete_constraint', { doc, index: i });
    if (!del.steps) continue;
    const add = await step<{ ok: boolean }>(c, 'sketch_constrain', { doc, constraints: pending });
    for (let k = 0; k < del.steps + add.steps; k++) await c.call('sketch_undo', { doc });
    if (add.steps) out.push(i);
    if (out.length >= 3) break;
  }
  return out;
}

/** Conflict: drop the named constraint(s) and add the new one (one undo entry). */
export async function resolveConflict(mode: 'replace' | 'keep' | 'dismiss'): Promise<void> {
  const cf = sk.conflict;
  sk.conflict = null;
  if (!cf || mode === 'dismiss') return;
  if (mode === 'keep') { await addConstraints(cf.pending, { force: true }); return; }
  beginGesture('Replace constraint');
  try {
    // The first one named (a dimension when one is involved): removing it is enough.
    await deleteConstraints(cf.offenders.slice(0, 1));
    // Entity indices don't move when constraints are deleted: the pending batch still applies.
    await addConstraints(cf.pending);
  } finally { await endGesture(); }
}

/** Change a dimension's value (`sketch_set_constraint`); an unsatisfiable value changes nothing. */
export async function setConstraintValue(index: number, value: number): Promise<string | null> {
  const c = sk.constraints[index];
  if (!c) return 'That dimension is gone.';
  if (!Number.isFinite(value)) return 'Enter a number';
  if ((c.type === 'distance' || c.type === 'radius' || c.type === 'diameter') && value <= 0) return 'Enter a value above 0';
  const out = await edit('Dimension', async (k, doc) => {
    const s = await step<{ ok: boolean; error?: string; bad?: number[] }>(k, 'sketch_set_constraint', { doc, index, value: toWire(c.type, value) });
    return { steps: s.steps, ok: s.r.ok, error: s.r.error ?? '' };
  });
  if (!out.ok) { const m = `${constraintLabel(c.type)} ${value} can’t be satisfied${out.error ? ` (${out.error})` : ''} — nothing changed.`; setStatus('error', m); return m; }
  setStatus('ok', `${constraintLabel(c.type)} set to ${value}${c.type === 'angle' ? '°' : ' mm'} — ${dofText()}.`);
  return null;
}

export async function deleteConstraints(indices: number[]): Promise<void> {
  const list = [...new Set(indices)].filter((i) => i >= 0 && i < sk.constraints.length).sort((a, b) => b - a);
  if (!list.length) return;
  await edit('Delete constraint', async (c, doc) => {
    let steps = 0;
    for (const i of list) steps += (await step(c, 'sketch_delete_constraint', { doc, index: i })).steps;
    return { steps };
  });
  sk.selCons = [];
}

/**
 * A click on a constraint badge (Orca's `remove_constraint_near`): with the Select tool a plain
 * click deletes that constraint and re-solves (one sketch undo entry); Shift / Ctrl toggle it in
 * the selection instead, and other tools select it.
 */
export async function badgeClick(index: number, additive: boolean): Promise<void> {
  const c = sk.constraints[index];
  if (!c) return;
  if (!additive && sk.tool === 'select') {
    const what = describeConstraint(c, sk.entities, index);
    await deleteConstraints([index]);
    setStatus('ok', `Deleted ${what} — ${dofText()}.`);
    return;
  }
  if (!additive) sk.sel = [];
  sk.selCons = additive ? (sk.selCons.includes(index) ? sk.selCons.filter((x) => x !== index) : [...sk.selCons, index]) : [index];
}

// ---- entity edits ---------------------------------------------------------------------------------

export async function deleteSelection(): Promise<void> {
  const ents = [...new Set(sk.sel.filter((s) => s.role === undefined || sk.entities[s.e]?.type === 'point').map((s) => s.e))];
  if (sk.selCons.length && !ents.length) { await deleteConstraints(sk.selCons); return; }
  if (!ents.length) { setStatus('info', 'Select entities or constraints to delete.'); return; }
  await edit('Delete', async (c, doc) => (await step(c, 'sketch_delete', { doc, entities: ents })));
  sk.sel = []; sk.selCons = [];
  setStatus('ok', `Deleted ${ents.length} entit${ents.length > 1 ? 'ies' : 'y'} and the constraints on ${ents.length > 1 ? 'them' : 'it'}.`);
}

/** Orca's Q: toggle construction on the selection, or the sticky mode for new entities. */
export async function toggleConstruction(): Promise<void> {
  const ents = [...new Set(sk.sel.map((s) => s.e))];
  if (!ents.length) { sk.construction = !sk.construction; setStatus('info', sk.construction ? 'New entities are construction geometry (Q to turn off).' : 'New entities are regular geometry.'); return; }
  await edit('Construction', async (c, doc) => step(c, 'sketch_construction', { doc, entities: ents }));
}

/** Constraints whose point the trim / extend moves (they would pull it back): dropped first, as Orca's GUI does. */
function movingEnd(e: SkEntity, pick: V2, op: 'trim' | 'extend'): Role | null {
  if (e.type !== 'line' && e.type !== 'arc') return null;
  if (op === 'extend') return dist(pick, e.p0) <= dist(pick, e.p1) ? 'p0' : 'p1';
  return nearestOn(e, pick).t <= 0.5 ? 'p0' : 'p1';
}

/**
 * Trim / extend (`sketch_ops`). Kernel quirk worked around openly: the op moves one end, then
 * re-solves — a constraint on that end (a Coincident, the line's length) pulls it straight back
 * and the call reports success with nothing changed. Those constraints are removed first (Orca's
 * GUI bookkeeping "trim/extend drop refs to the cut entity"), and put back if the op fails.
 */
export async function trimExtend(op: 'trim' | 'extend', index: number, pick: V2): Promise<boolean> {
  const e = sk.entities[index];
  if (!e) return false;
  const role = movingEnd(e, pick, op);
  const drop = role ? sk.constraints.map((c, i) => ({ c, i })).filter(({ c }) => refsPoint(c, index, role) || (c.type === 'distance' && c.ea === index && c.eb === index)).map(({ i }) => i).sort((a, b) => b - a) : [];
  const out = await edit(op === 'trim' ? 'Trim' : 'Extend', async (c, doc) => {
    let steps = 0;
    for (const i of drop) steps += (await step(c, 'sketch_delete_constraint', { doc, index: i })).steps;
    const r = await step<{ ok: boolean; error?: string }>(c, 'sketch_ops', { doc, op, entity: index, pick });
    if (!r.r.ok) { for (let k = 0; k < steps; k++) await c.call('sketch_undo', { doc }); return { steps: 0, ok: false, error: r.r.error ?? '' }; }
    return { steps: steps + r.steps, ok: true, error: '' };
  });
  if (!out.ok) { setStatus('warn', `${op === 'trim' ? 'Trim' : 'Extend'}: ${out.error || 'nothing to do there'}.`); return false; }
  setStatus('ok', `${op === 'trim' ? 'Trimmed' : 'Extended'} ${describeEntity(index)}${drop.length ? ` (${drop.length} constraint${drop.length > 1 ? 's' : ''} on the moved end removed)` : ''}.`);
  return true;
}

/**
 * Fillet / chamfer two lines (`sketch_ops`). Kernel quirk worked around openly: with the corner
 * Coincident still there the kernel keeps it, the solve drags both lines back to the corner and
 * the arc comes out at half the radius in the wrong place; without it the kernel adds the arc's
 * end Coincidents and one Tangent. So the corner constraint goes first, and the second Tangent
 * (Orca's ladder) is added after when the solver takes it.
 */
export async function filletLines(op: 'fillet' | 'chamfer', a: number, b: number, size: number): Promise<string | null> {
  const ea = sk.entities[a], eb = sk.entities[b];
  if (ea?.type !== 'line' || eb?.type !== 'line') return 'Fillet and chamfer join two lines';
  if (!(size > 0)) return 'Enter a value above 0';
  const corner = sk.constraints.map((c, i) => ({ c, i })).filter(({ c }) => c.type === 'coincident' && ((c.ea === a && c.eb === b) || (c.ea === b && c.eb === a))).map(({ i }) => i).sort((x, y) => y - x);
  const out = await edit(op === 'fillet' ? 'Fillet' : 'Chamfer', async (c, doc) => {
    let steps = 0;
    for (const i of corner) steps += (await step(c, 'sketch_delete_constraint', { doc, index: i })).steps;
    const r = await step<{ ok: boolean; error?: string; first_index?: number }>(c, 'sketch_ops', { doc, op, a, b, ...(op === 'fillet' ? { radius: size } : { distance: size }) });
    if (!r.r.ok) { for (let k = 0; k < steps; k++) await c.call('sketch_undo', { doc }); return { steps: 0, error: r.r.error || 'the lines are parallel, or the size is too large for them' }; }
    steps += r.steps;
    const arcIndex = r.r.first_index;
    if (op === 'fillet' && typeof arcIndex === 'number') steps += (await step<{ ok: boolean }>(c, 'sketch_constrain', { doc, constraint: cons('tangent', b, 'p0', arcIndex, 'p0') })).steps;
    return { steps, error: '' };
  });
  if (out.error) { setStatus('warn', `${op === 'fillet' ? 'Fillet' : 'Chamfer'}: ${out.error}.`); return out.error; }
  setStatus('ok', `${op === 'fillet' ? 'Fillet' : 'Chamfer'} ${size} mm between ${describeEntity(a)} and ${describeEntity(b)}.`);
  return null;
}

export async function offsetEntities(ents: number[], distance: number): Promise<string | null> {
  if (!ents.length) return 'Select the entities to offset';
  if (!distance) return 'Enter a distance (negative for the other side)';
  const r = await edit('Offset', async (c, doc) => step<{ ok: boolean; added?: number; error?: string }>(c, 'sketch_offset', { doc, entities: ents, distance }));
  if (!r.r.ok || !r.r.added) { const m = `Offset: ${r.r.error || 'nothing could be offset (ellipses, splines and points are skipped)'}.`; setStatus('warn', m); return m; }
  setStatus('ok', `Offset ${r.r.added} entit${r.r.added > 1 ? 'ies' : 'y'} by ${distance} mm.`);
  return null;
}

export async function mirrorEntities(ents: number[], axis: number): Promise<string | null> {
  const l = sk.entities[axis];
  if (l?.type !== 'line') return 'Pick a line as the mirror axis';
  const list = ents.filter((i) => i !== axis);
  if (!list.length) return 'Select the entities to mirror first';
  const r = await edit('Mirror', async (c, doc) => step<{ ok: boolean; added?: number; error?: string }>(c, 'sketch_mirror', { doc, entities: list, axis_a: l.p0, axis_b: l.p1 }));
  if (!r.r.ok) { const m = `Mirror: ${r.r.error || 'refused'}.`; setStatus('warn', m); return m; }
  setStatus('ok', `Mirrored ${list.length} entit${list.length > 1 ? 'ies' : 'y'} about ${describeEntity(axis)}.`);
  return null;
}

export interface TransformArgs { move?: V2; angle?: number; scale?: number; pivot?: V2; copy?: boolean }
export async function transformEntities(ents: number[], t: TransformArgs): Promise<string | null> {
  if (!ents.length) return 'Select the entities first';
  const r = await edit('Transform', async (c, doc) => step<{ ok: boolean; error?: string }>(c, 'sketch_ops', {
    doc, op: 'transform', entities: ents, move: t.move ?? [0, 0], angle: ((t.angle ?? 0) * Math.PI) / 180, scale: t.scale ?? 1, pivot: t.pivot ?? [0, 0], ...(t.copy ? { copy: true } : {}),
  }));
  if (!r.r.ok) { const m = `Transform: ${r.r.error || 'refused'}.`; setStatus('warn', m); return m; }
  return null;
}

/** Linear (`step`) or polar (`angleStep` degrees about `pivot`) array: count − 1 copies. */
export async function arrayEntities(ents: number[], count: number, o: { step?: V2; angleStep?: number; pivot?: V2 }): Promise<string | null> {
  if (!ents.length) return 'Select the entities first';
  if (!(count >= 2)) return 'The count is at least 2';
  const r = await edit('Array', async (c, doc) => step<{ ok: boolean; added?: number; error?: string }>(c, 'sketch_ops', {
    doc, op: 'array', entities: ents, count: Math.round(count), step: o.step ?? [0, 0], angle_step: ((o.angleStep ?? 0) * Math.PI) / 180, pivot: o.pivot ?? [0, 0],
  }));
  if (!r.r.ok) { const m = `Array: ${r.r.error || 'refused'}.`; setStatus('warn', m); return m; }
  setStatus('ok', `Added ${r.r.added ?? count - 1} cop${(r.r.added ?? count - 1) > 1 ? 'ies' : 'y'}.`);
  return null;
}

/**
 * Use (project) body edges in the sketch, Onshape's "Use" / Orca's project_edges_into_sketch:
 * straight edges become lines, circles / arcs in a plane parallel to the sketch become circles /
 * arcs, projected onto the sketch plane and fixed in place.
 */
export async function useEdges(body: number, edges: number[], generation: number): Promise<string | null> {
  const plane = sk.plane;
  if (!plane) return 'No sketch is open';
  const infos = await job(async (c, doc) => Promise.all(edges.map(async (edge) => (await c.call<EdgeInfo>('edge_info', { doc, body, edge, generation })).result)));
  const n = [plane.x_axis[1] * plane.y_axis[2] - plane.x_axis[2] * plane.y_axis[1], plane.x_axis[2] * plane.y_axis[0] - plane.x_axis[0] * plane.y_axis[2], plane.x_axis[0] * plane.y_axis[1] - plane.x_axis[1] * plane.y_axis[0]];
  const ents: SkEntity[] = [], fixes: SkConstraint[] = [];
  let skipped = 0;
  const base = sk.entities.length;
  for (const f of infos) {
    if (f.curve === 'line') {
      const a = toPlane(plane, f.p0), b = toPlane(plane, f.p1);
      if (dist(a, b) < 1e-6) { skipped++; continue; }
      const i = base + ents.length;
      ents.push(entity('line', { p0: a, p1: b }));
      fixes.push(cons('fix', i, 'p0'), cons('fix', i, 'p1'));
    } else if (f.circle && Math.abs(Math.abs(f.circle.axis[0] * n[0] + f.circle.axis[1] * n[1] + f.circle.axis[2] * n[2]) - 1) < 1e-6) {
      const c = toPlane(plane, f.circle.center), r = f.circle.radius, i = base + ents.length;
      if (Math.hypot(f.p0[0] - f.p1[0], f.p0[1] - f.p1[1], f.p0[2] - f.p1[2]) < 1e-6) {
        ents.push(entity('circle', { center: c, radius: r }));
        fixes.push(cons('fix', i, 'center'), cons('radius', i, 'center', -1, 'p0', r));
      } else {
        const a0 = angleOf(sub(toPlane(plane, f.p0), c));
        let a1 = angleOf(sub(toPlane(plane, f.p1), c));
        const ccw = (f.circle.axis[0] * n[0] + f.circle.axis[1] * n[1] + f.circle.axis[2] * n[2]) > 0;
        if (ccw) { while (a1 <= a0) a1 += 2 * Math.PI; } else { while (a1 >= a0) a1 -= 2 * Math.PI; }
        ents.push(entity('arc', { center: c, radius: r, start_angle: a0, end_angle: a1 }));
        fixes.push(cons('fix', i, 'center'), cons('fix', i, 'p0'), cons('fix', i, 'p1'));
      }
    } else skipped++;
  }
  if (!ents.length) { const m = 'Those edges can’t be used here (only straight edges and circles / arcs parallel to the sketch plane).'; setStatus('warn', m); return m; }
  await addEntities(ents, fixes, 'Use edges');
  setStatus('ok', `Used ${ents.length} edge${ents.length > 1 ? 's' : ''} (fixed in place)${skipped ? `; ${skipped} skipped (curved out of the sketch plane)` : ''}.`);
  return null;
}

// ---- live measurement labels (Orca's render_live_quotes) -------------------------------------------

/**
 * A click on a live quote (Orca): a Length or Radius becomes a driving dimension at its current
 * value and its editor opens (`place_dimension`); a line's angle, an arc's sweep and an ellipse's
 * axes open an editor that changes the geometry (a typed line angle drops its H / V first, as
 * Orca's `set_line_angle` does). `screen` places the editor over the label.
 */
export async function promoteQuote(q: LiveQuote, screen?: [number, number]): Promise<void> {
  if (!sk.entities[q.e]) return;
  const at = { at: null, ...(screen ? { screen } : {}) };
  const title = q.title ?? QUOTE_TITLE[q.kind];
  if (q.dim || (!q.rotate && (q.kind === 'length' || q.kind === 'radius'))) {
    // A shape's size label: the driving dimension the drawing tool's own size field uses (quotes.ts).
    const c = q.dim ?? (q.kind === 'length' ? cons('distance', q.e, 'p0', q.e, 'p1', q.value) : cons('radius', q.e, 'center', -1, 'p0', q.value));
    if (await addConstraints([c])) return;
    const i = duplicateOf(c, sk.constraints);
    if (i < 0) return;
    requestValue({ label: title, value: +q.value.toFixed(4), unit: 'mm', ...at, submit: (v) => setConstraintValue(i, v) });
    return;
  }
  if (q.rotate) {
    // A shape's angle (Orca's set_rect_angle / set_slot_angle / set_polygon_angle): turn it, with its
    // construction geometry, about Orca's pivot; the members' H / V go first (drop_orientation_constraints).
    const r = q.rotate;
    requestValue({
      label: title, value: +q.value.toFixed(4), unit: '°', ...at,
      submit: async (v) => {
        if (!Number.isFinite(v)) return 'Type an angle';
        if (r.ents.some((e) => !sk.entities[e])) return 'That shape is gone';
        const da = v - q.value;
        if (Math.abs(da) < 1e-9) return null;
        beginGesture('Edit value');
        try {
          const hv = sk.constraints.map((c, i) => ({ c, i })).filter(({ c }) => (c.type === 'horizontal' || c.type === 'vertical') && r.ents.includes(c.ea) && (c.eb === c.ea || c.eb < 0)).map(({ i }) => i);
          if (hv.length) await deleteConstraints(hv);
          const err = await transformEntities(r.ents, { angle: da, pivot: r.pivot });
          if (err) return `${title.replace(' (°)', '')} ${v}° can’t be set (${err})`;
        } finally { await endGesture(); }
        setStatus('ok', `Angle set to ${v}° — ${dofText()}.`);
        return null;
      },
    });
    return;
  }
  const deg = q.kind === 'angle' || q.kind === 'sweep';
  requestValue({
    label: title, value: +q.value.toFixed(4), unit: deg ? '°' : 'mm', ...at,
    submit: async (v) => {
      const e = sk.entities[q.e];
      const n = e ? quoteEdit(e, q.kind, v) : 'That entity is gone';
      if (typeof n === 'string') return n;
      beginGesture('Edit value');
      try {
        if (q.kind === 'angle') {
          const hv = sk.constraints.map((c, i) => ({ c, i })).filter(({ c }) => (c.type === 'horizontal' || c.type === 'vertical') && c.ea === q.e && c.eb === q.e).map(({ i }) => i);
          if (hv.length) await deleteConstraints(hv);
        }
        const out = await edit('Edit value', async (c, doc) => {
          const s = await step<StateResult>(c, 'sketch_set_entity', { doc, index: q.e, entity: n });
          return { steps: s.steps, error: s.r.ok === false ? s.r.error ?? 'refused' : '' };
        });
        if (out.error) return `${QUOTE_TITLE[q.kind]} ${v} can’t be set (${out.error})`;
      } finally { await endGesture(); }
      setStatus('ok', `${QUOTE_TITLE[q.kind].replace(' (°)', '')} set to ${v}${deg ? '°' : ' mm'} — ${dofText()}.`);
      return null;
    },
  });
}

// ---- text / SVG outlines ----------------------------------------------------------------------------

/**
 * Put rigid outlines (text, an SVG's fills) in the sketch: Orca keeps them as the Sketch
 * feature's `imported_regions`, and a sketch with regions extrudes only those — so they go in a
 * sketch of their own (refused when the sketch already has regular geometry).
 */
export function placeRegions(regions: V2[][][], label: 'Text' | 'SVG', o: { offset?: V2; text?: { string: string; font: string; height: number } } = {}): string | null {
  if (!sk.open) return 'No sketch is open';
  if (sk.entities.some((e) => !e.construction)) return `${label} goes in a sketch of its own — finish this one first, then start a new sketch for it`;
  if (!regions.length) return `The ${label.toLowerCase()} has no outline`;
  // On a picked face the outlines (centred on their box) go to the face's centre, as in Orca.
  sk.regions = { regions, offset: o.offset ?? sk.regions?.offset ?? sk.onFace?.centre ?? [0, 0], scale: [1, 1], label, ...(o.text ? { text: o.text } : {}) };
  setStatus('ok', `${label}: ${regions.length} outline region${regions.length === 1 ? '' : 's'} placed — drag a corner to scale, the centre to move; Finish writes them into the sketch (they extrude as they are).`);
  return null;
}
/**
 * Orca's Text / SVG outside a sketch (`open_text_dialog` / `add_imported_sketch`): with a flat
 * face picked the art goes on that face, centred on it, and remembers the face's body
 * (`import_on_face`: its Extrude defaults to an inward Cut of that body); otherwise on the Top
 * plane (Orca's reference plane). Opens the sketch the outlines live in; true when it is open.
 */
export async function beginArt(): Promise<boolean> {
  if (sk.open) return true;
  const p = designUi.pick;
  if (p?.kind === 'face') {
    const doc = currentDoc();
    const info = doc === null ? null : await designKernel().run('Reading the face', async (c) => (await c.call<{ centroid?: [number, number, number]; plane?: PlaneFrame }>('face_info', { doc, body: p.body, face: p.face, generation: p.generation })).result, { quiet: true }).catch(() => null);
    if (info?.plane && info.centroid) {
      if (!(await beginSketch({ face: { body: p.body, face: p.face }, generation: p.generation }))) return false;
      const o = sk.plane!.origin, c = info.centroid, d = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
      const x = sk.plane!.x_axis, y = sk.plane!.y_axis;
      sk.onFace = { body: p.body, centre: [d[0] * x[0] + d[1] * x[1] + d[2] * x[2], d[0] * y[0] + d[1] * y[1] + d[2] * y[2]] };
      return true;
    }
  }
  return beginSketch({ plane: 'XY' });
}
export function moveRegions(offset: V2): void { if (sk.regions) sk.regions = { ...sk.regions, offset }; }
export function clearRegions(): void { sk.regions = null; }

/** A region point where it lands: base × scale + offset (the Sketch feature's import convention). */
export function regionPoint(p: V2, r: { offset: V2; scale: V2 } | null = sk.regions): V2 {
  return r ? [p[0] * r.scale[0] + r.offset[0], p[1] * r.scale[1] + r.offset[1]] : p;
}
const baseBounds = new WeakMap<V2[][][], { min: V2; max: V2 }>();
function regionsBounds(regions: V2[][][]): { min: V2; max: V2 } {
  let b = baseBounds.get(regions);
  if (b) return b;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const reg of regions) for (const loop of reg) for (const [x, y] of loop) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  b = x0 === Infinity ? { min: [0, 0], max: [0, 0] } : { min: [x0, y0], max: [x1, y1] };
  baseBounds.set(regions, b);
  return b;
}
const baseCorner = (b: { min: V2; max: V2 }, i: number): V2 => [i === 1 || i === 2 ? b.max[0] : b.min[0], i === 2 || i === 3 ? b.max[1] : b.min[1]];

/** The placed outlines' box corners (0 min/min, 1 max/min, 2 max/max, 3 min/max; Orca's `xform_world_corners`), or null. */
export function regionCorners(): V2[] | null {
  const r = sk.regions;
  if (!r) return null;
  const b = regionsBounds(r.regions);
  return [0, 1, 2, 3].map((i) => regionPoint(baseCorner(b, i), r));
}

/**
 * Orca's TransformArt drag (`drag_xform_handle`): handle 4 (the centre) moves the outlines by the
 * pointer's travel since `anchor`; a corner (0–3) scales them, X and Y apart, holding the opposite
 * corner (`anchor`, where it was when the drag began) and sending the grabbed one to `target`.
 */
export function dragRegionHandle(handle: number, anchor: V2, target: V2): void {
  const r = sk.regions;
  if (!r) return;
  if (handle === 4) { sk.regions = { ...r, offset: [r.offset[0] + target[0] - anchor[0], r.offset[1] + target[1] - anchor[1]] }; return; }
  const b = regionsBounds(r.regions), bg = baseCorner(b, handle), ba = baseCorner(b, (handle + 2) % 4);
  const offset: V2 = [r.offset[0], r.offset[1]], scale: V2 = [r.scale[0], r.scale[1]];
  for (const k of [0, 1] as const) {
    const db = bg[k] - ba[k];
    if (Math.abs(db) <= 1e-9) continue;
    let s = (target[k] - anchor[k]) / db;
    if (Math.abs(s) < 1e-4) s = s < 0 ? -1e-4 : 1e-4;
    scale[k] = s;
    offset[k] = anchor[k] - ba[k] * s;
  }
  sk.regions = { ...r, offset, scale };
}

// ---- inline value editor ---------------------------------------------------------------------------

export function requestValue(r: ValueRequest): void { sk.value = r; }

/** Where a constraint's value label sits (plane mm), for the inline editor. */
export function anchorOf(c: SkConstraint | undefined): V2 | null {
  if (!c) return null;
  const e = sk.entities[c.ea];
  if (!e) return null;
  if (e.type === 'line') return [(e.p0[0] + e.p1[0]) / 2, (e.p0[1] + e.p1[1]) / 2];
  if (e.type === 'arc' || e.type === 'circle') return e.center;
  return e.p0;
}

// ---- text ----------------------------------------------------------------------------------------------

export function dofText(): string {
  if (!sk.solveOk) return sk.bad.length ? `✗ ${sk.bad.length} conflicting constraint${sk.bad.length > 1 ? 's' : ''}` : '✗ Conflicting constraints';
  if (sk.dof === 0) return '✓ Fully constrained';
  if (sk.dof < 0) return sk.entities.length ? 'Not constrained yet' : 'Empty sketch';
  return `${sk.dof} degree${sk.dof === 1 ? '' : 's'} of freedom`;
}

export function describeEntity(i: number): string {
  const e = sk.entities[i];
  return e ? `${e.construction ? 'construction ' : ''}${e.type.replace('_', ' ')} ${i + 1}` : `entity ${i + 1}`;
}

export { CONSTRAINT_TYPES, fromWire };

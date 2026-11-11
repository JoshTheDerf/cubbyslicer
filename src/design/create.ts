/**
 * Creating features: the open feature card (one at a time, as in Orca), its live preview ghost,
 * Confirm / Cancel, and Orca's right-click offer menu (DesignOffer) that opens cards prefilled
 * from what is picked. A card's Confirm is one `runEdit` (`add_feature`): one rebuild, one undo
 * step; a refused add changes nothing and keeps the card open with the kernel's message.
 *
 * Preview: `feature_preview` replays the whole history with the candidate applied, so it costs
 * an edit. It runs by itself (debounced) while the design rebuilds quickly; on a slow design the
 * card offers a Preview button instead (an honest cost, shown with the last rebuild time).
 */
import { markRaw, reactive, shallowRef } from 'vue';
import { toast } from '../ui';
import { phone } from '../app/shell/uiState';
import type { JobContext } from './kernel/client';
import { decodePlateMeshes } from './kernel/mesh';
import type { DatumsResult, FeatureType, HoleStandard, MassProperties, MutationResult, PlateMeshLayout, PreviewResult, ThreadStandard } from './kernel/types';
import { cancelPick, picking } from './pick';
import { design, designKernel, editBlocker, readDesign, runEdit, setStatus } from './session';
import { designUi, type DesignPick } from './state';
import { beginSketch, startSketch } from './sketch/session';
import { CREATE_TOOLS, getTool, type CreateTool, type Draft, type KernelReads, type ToolCtx } from './tools';
import type { GhostMesh } from './scene/DesignScene';

/** Previews run by themselves while a rebuild takes less than this. */
export const AUTO_PREVIEW_MAX_MS = 2500;

export type PreviewState = 'off' | 'idle' | 'running' | 'ok' | 'invalid' | 'manual';

export const card = reactive({
  tool: null as CreateTool | null,
  draft: {} as Draft,
  /** The kernel refused the last Confirm (or a row's derived update failed). */
  error: '',
  confirming: false,
  /** A row's derived update (face → plane, standard → sizes) is running. */
  resolving: false,
  preview: { state: 'off' as PreviewState, text: '' },
  /** Kernel-side context for the rows (datums, standards), loaded when a card opens. */
  ctx: null as ToolCtx | null,
});

/** Orca's preview ghost (null: none). */
export const ghost = shallowRef<readonly GhostMesh[] | null>(null);

let threads: ThreadStandard[] | null = null;
let holes: HoleStandard[] | null = null;
let datumsCache: { generation: number; d: DatumsResult } | null = null;

const TYPE_LABELS: Partial<Record<FeatureType, string>> = { DeleteFace: 'Delete Face', CoordSys: 'Coordinate System' };

/** Orca's default name: "<Type> <counter>" with one counter for every type (here: the next feature number). */
export function defaultName(type: FeatureType): string { return `${TYPE_LABELS[type] ?? type} ${design.features.length + 1}`; }

function reads(c: JobContext, doc: number): KernelReads {
  return { call: async <T>(method: string, params: Record<string, unknown> = {}) => (await c.call<T>(method, { doc, ...params })).result };
}

/** Kernel reads as a quiet job of their own (row updates). */
const quietReads: KernelReads = { call: <T>(method: string, params: Record<string, unknown> = {}) => readDesign(async (c, doc) => (await c.call<T>(method, { doc, ...params })).result) };

/** The rows' context: bodies, features, datums, the thread / hole tables (cached). */
export async function loadToolCtx(): Promise<ToolCtx> {
  const needDatums = !datumsCache || datumsCache.generation !== design.generation;
  if (!threads || !holes || needDatums) {
    await readDesign(async (c, doc) => {
      if (!threads) threads = (await c.call<{ threads: ThreadStandard[] }>('thread_standards')).result.threads ?? [];
      if (!holes) holes = (await c.call<{ holes: HoleStandard[] }>('hole_standards')).result.holes ?? [];
      if (needDatums) datumsCache = { generation: design.generation, d: (await c.call<DatumsResult>('datums', { doc })).result };
    });
  }
  return markRaw({
    bodies: design.bodies.slice(), features: design.features.slice(), datums: datumsCache?.d ?? null, threads: threads ?? [], holes: holes ?? [],
    generation: design.generation, modelingOrigin: design.modelingOrigin,
  });
}

/** The kernel tables (bridge tools). */
export async function standards(): Promise<{ threads: ThreadStandard[]; holes: HoleStandard[] }> {
  await loadToolCtx();
  return { threads: threads ?? [], holes: holes ?? [] };
}

// ---- the card ---------------------------------------------------------------------------

/** Which pick-derived rows to resolve when a card opens prefilled. */
const PREFILLED = ['face', 'sketch_ref'];

/**
 * Open a feature card (Orca: a tool button / key / offer verb). The current viewport pick
 * prefills it. Returns the refusal (Orca's guards) or null.
 */
export async function openCard(id: string, opts: { pick?: DesignPick | null; prefill?: Draft } = {}): Promise<string | null> {
  const tool = getTool(id);
  if (!tool) return `Unknown feature card "${id}".`;
  const blocked = editBlocker();
  if (blocked) { setStatus('warn', blocked); return blocked; }
  if (picking.spec) cancelPick();
  const ctx = await loadToolCtx();
  const need = tool.needs?.(ctx) ?? null;
  if (need) { setStatus('error', need); return need; }
  const pick = opts.pick === undefined ? designUi.pick : opts.pick;
  card.tool = markRaw(tool);
  card.ctx = ctx;
  card.draft = { ...tool.init(ctx, pick), ...(opts.prefill ?? {}) };
  card.error = '';
  card.confirming = false;
  card.preview = { state: tool.noPreview ? 'off' : 'idle', text: tool.noPreview ? `${tool.title} ready` : '' };
  ghost.value = null;
  designUi.selected = [];
  designUi.phoneSection = 'features';
  if (phone.value) designUi.panelOpen = true;
  setStatus('info', tool.hint ?? tool.title);
  for (const k of PREFILLED) if (card.draft[k] !== undefined && card.draft[k] !== null && card.draft[k] !== -1) await rowChanged(k, false);
  schedulePreview();
  return null;
}

/** Close the card without adding anything (Cancel / Esc). */
export function cancelCard(): void {
  if (picking.spec) cancelPick();
  card.tool = null;
  card.draft = {};
  card.error = '';
  card.ctx = null;
  previewToken++;
  ghost.value = null;
  design.status = null;
}

/** Set a row (the card's controls, the bridge). Runs the card's derived update, then previews. */
export async function setCardValue(key: string, value: unknown): Promise<void> {
  if (!card.tool) return;
  card.draft = { ...card.draft, [key]: value };
  await rowChanged(key);
}

async function rowChanged(key: string, preview = true): Promise<void> {
  const t = card.tool;
  if (!t) return;
  card.error = '';
  if (t.changed && card.ctx) {
    card.resolving = true;
    const d = { ...card.draft };
    try {
      await t.changed(key, d, quietReads, card.ctx);
      if (card.tool === t) card.draft = d;
    } catch (e) {
      // The hook may have dropped a reference it can't use (a curved face for a hole): keep that.
      if (card.tool === t) { card.draft = d; card.error = e instanceof Error ? e.message : String(e); setStatus('warn', card.error); }
    } finally {
      card.resolving = false;
    }
  }
  if (preview) schedulePreview();
}

/** Why Confirm would be refused (a required reference missing, the card's own check), or null. */
export function cardProblem(): string | null {
  const t = card.tool;
  if (!t || !card.ctx) return 'No card is open.';
  const d = card.draft;
  for (const r of t.rows) {
    if (!r.required || (r.when && !r.when(d))) continue;
    const v = d[r.key];
    const empty = v === null || v === undefined || v === -1 || (typeof v === 'object' && Array.isArray((v as { ids?: unknown[] }).ids) && !(v as { ids: unknown[] }).ids.length);
    if (empty) return r.required;
  }
  return t.validate?.(d, card.ctx) ?? null;
}

/** Confirm: add the feature (one rebuild, one undo step). Returns the new feature's index, or null. */
export async function confirmCard(): Promise<{ ok: boolean; error: string; index?: number }> {
  const t = card.tool;
  if (!t || !card.ctx) return { ok: false, error: 'No card is open.' };
  if (picking.spec) cancelPick();
  const problem = cardProblem();
  if (problem) { card.error = problem; setStatus('warn', problem); return { ok: false, error: problem }; }
  const d = { ...card.draft }, ctx = { ...card.ctx, generation: design.generation };
  const type = t.type(d);
  const name = String(d.name ?? '') || defaultName(type);
  card.confirming = true;
  previewToken++;
  try {
    const r = await runEdit(`Add ${name}`, async (c, doc) => {
      const fields = await t.fields(d, reads(c, doc), ctx);
      // `generation`: the kernel refuses the request (-32010) when its face / edge ids are stale.
      // A Shell that would change nothing is refused by the kernel itself (v1.2: ok:false).
      const res = (await c.call<MutationResult>('add_feature', { doc, type, name, fields, generation: ctx.generation })).result;
      return res;
    }, { done: `${name} added` });
    if (!r.ok) {
      const msg = r.error === 'superseded' ? 'The design changed while this was added — check the card and confirm again.' : `The model could not be rebuilt: ${r.error || 'refused'}`;
      if (card.tool === t) card.error = msg;
      return { ok: false, error: msg };
    }
    const index = r.result?.index ?? design.features.length - 1;
    if (card.tool === t) { card.tool = null; card.draft = {}; card.ctx = null; ghost.value = null; }
    if (design.features[index]) designUi.selected = [index];
    if (type === 'Plane') setStatus('ok', `${name} added — pick it as a sketch plane.`);
    return { ok: true, error: '', index };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (card.tool === t) card.error = msg;
    return { ok: false, error: msg };
  } finally {
    card.confirming = false;
  }
}

// ---- preview (Orca's ghost) -------------------------------------------------------------------

let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewToken = 0;

function schedulePreview(): void {
  const t = card.tool;
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  if (!t || t.noPreview) return;
  ghost.value = null;
  if (cardProblem()) { card.preview = { state: 'idle', text: '' }; return; }
  if (design.lastRebuildMs > AUTO_PREVIEW_MAX_MS) {
    card.preview = { state: 'manual', text: `Each rebuild takes ≈ ${Math.round(design.lastRebuildMs / 1000)} s` };
    return;
  }
  card.preview = { state: 'running', text: 'Preview…' };
  previewTimer = setTimeout(() => { previewTimer = null; void runPreview(); }, 350);
}

/** Show the ghost now (the Preview button on slow designs; the bridge). */
export async function runPreview(): Promise<{ ok: boolean; error: string; triangles: number }> {
  const t = card.tool;
  if (!t || !card.ctx) return { ok: false, error: 'No card is open.', triangles: 0 };
  const problem = cardProblem();
  if (problem) return { ok: false, error: problem, triangles: 0 };
  const token = ++previewToken;
  const d = { ...card.draft }, ctx = { ...card.ctx, generation: design.generation };
  card.preview = { state: 'running', text: 'Preview…' };
  try {
    const r = await readDesign(async (c, doc) => {
      const fields = await t.fields(d, reads(c, doc), ctx);
      const p = await c.call<PreviewResult>('feature_preview', { doc, type: t.type(d), fields });
      return { res: p.result, meshes: p.result.ok ? decodePlateMeshes(p.result.meshes.map((m) => ({ ...m, triFace: { offset: 0, count: 0 }, triangles: 0, vertices: 0 })) as PlateMeshLayout[], p.blob) : [] };
    }, design.lastRebuildMs > AUTO_PREVIEW_MAX_MS ? 'Previewing' : undefined);
    if (token !== previewToken || card.tool !== t) return { ok: false, error: 'superseded', triangles: 0 };
    if (!r.res.ok) {
      ghost.value = null;
      card.preview = { state: 'invalid', text: `Invalid: ${r.res.error || 'the feature does not build here'}` };
      return { ok: false, error: r.res.error, triangles: 0 };
    }
    const tris = r.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
    ghost.value = markRaw(r.meshes.map((m) => ({ positions: m.positions, indices: m.indices })));
    card.preview = { state: 'ok', text: `Preview — ${tris.toLocaleString()} triangles` };
    return { ok: true, error: '', triangles: tris };
  } catch (e) {
    if (token !== previewToken) return { ok: false, error: 'superseded', triangles: 0 };
    const msg = e instanceof Error ? e.message : String(e);
    ghost.value = null;
    card.preview = { state: 'invalid', text: `Invalid: ${msg}` };
    return { ok: false, error: msg, triangles: 0 };
  }
}

// ---- bodies ----------------------------------------------------------------------------------

/** Volume and area of a body (Orca's offer "Volume and area"). */
export async function bodyMass(b: number): Promise<MassProperties> {
  const m = await readDesign(async (c, doc) => (await c.call<MassProperties>('mass_properties', { doc, body: b })).result);
  setStatus('info', `Body ${b + 1}: volume ${m.volume.toFixed(1)} mm³ (${(m.volume / 1000).toFixed(2)} cm³), area ${m.surface_area.toFixed(1)} mm²${m.is_solid ? '' : ' — not a closed solid'}.`);
  return m;
}

// ---- the offer menu (DesignOffer) ---------------------------------------------------------------

export interface OfferItem { label: string; icon?: string; disabled?: boolean; kbds?: string[]; onSelect?: () => void; type?: 'label' | 'separator'; children?: OfferItem[][] }

const run = (id: string, prefill?: Draft, pick?: DesignPick | null) => () => {
  void openCard(id, { prefill, pick }).then((err) => { if (err) toast.warn(err); });
};

/**
 * Orca's offer for the current pick: a header line, then the families that apply to it
 * (Add material, Remove, Fillet / chamfer / draft, Repeat, Transform, Reference, Modify).
 * `surface` is the picked face's surface type when known ('plane', 'cylinder', …), `curve` the
 * picked edge's ('line', 'circle', …).
 */
export function offerItems(p: DesignPick | null, info: { surface?: string; curve?: string; faceEdges?: number[]; cylinderFace?: number } = {}, act: {
  renameBody: (b: number) => void; colorBody: (b: number) => void; deleteBody: (b: number) => void; zoom: () => void; editFeature: (i: number) => void;
}): OfferItem[][] {
  const bodyN = p ? `Body ${p.body + 1}` : '';
  const bodies = design.bodies.filter((b) => b.face_count > 0).length;
  const flat = p?.kind === 'face' && info.surface === 'plane';
  const cyl = p?.kind === 'face' && info.surface === 'cylinder';
  const edge = p?.kind === 'edge';
  const circle = edge && info.curve === 'circle';
  const head = !p ? 'Nothing selected'
    : p.kind === 'body' ? `${bodyN} — solid body`
      : p.kind === 'face' ? `${flat ? 'Flat' : cyl ? 'Cylindrical' : 'Curved'} face ${p.face} of ${bodyN}`
        : `${circle ? 'Circular' : info.curve === 'line' ? 'Straight' : ''} edge ${p.edge} of ${bodyN}`.replace(/^ /, '');
  const groups: OfferItem[][] = [[{ type: 'label', label: head }]];
  // Orca: the offer starts with the sketch the pick allows (on this flat face, else a new one).
  const selSketch = designUi.selected.length === 1 && design.features[designUi.selected[0]]?.type === 'Sketch' ? designUi.selected[0] : -1;
  const sketchRow: OfferItem[] = [];
  if (flat) sketchRow.push({ label: 'Sketch on this face', icon: 'i-lucide-pen-tool', kbds: ['shift', 's'], onSelect: () => { void beginSketch({ face: { body: p!.body, face: (p as { face: number }).face }, generation: p!.generation as number }); } });
  else if (!p && selSketch < 0) sketchRow.push({ label: 'New sketch…', icon: 'i-lucide-pen-tool', kbds: ['shift', 's'], onSelect: () => { const e = startSketch(); if (e) toast.warn(e); } });
  if (selSketch >= 0 && !p) {
    const name = design.features[selSketch].name;
    sketchRow.push({ label: `Edit ${name}`, icon: 'i-lucide-pencil', onSelect: () => { void beginSketch({ feature: selSketch }); } },
      { label: `Extrude ${name}`, icon: CREATE_TOOLS.find((t) => t.id === 'extrude')?.icon, kbds: ['shift', 'e'], onSelect: run('extrude', { sketch_ref: selSketch }) },
      { label: `Revolve ${name}`, icon: CREATE_TOOLS.find((t) => t.id === 'revolve')?.icon, kbds: ['shift', 'r'], onSelect: run('revolve', { sketch_ref: selSketch }) });
  }
  if (sketchRow.length) groups.push(sketchRow);
  const top: OfferItem[] = [];
  if (p) {
    if (p.kind === 'body') top.push({ label: 'Rename…', icon: 'i-lucide-text-cursor-input', kbds: ['f2'], onSelect: () => act.renameBody(p.body) });
    top.push({ label: 'Color…', icon: 'i-lucide-palette', onSelect: () => act.colorBody(p.body) });
    top.push({ label: 'Zoom to selection', icon: 'i-lucide-zoom-in', kbds: ['z'], onSelect: act.zoom });
  }
  if (top.length) groups.push(top);
  const fam: OfferItem[] = [];
  const family = (label: string, icon: string, items: OfferItem[], reason: string) => {
    const live = items.filter(Boolean);
    if (!live.length) { fam.push({ label: `${label} — ${p ? reason : 'select something first'}`, icon, disabled: true }); return; }
    if (live.length === 1) { fam.push({ ...live[0], icon: live[0].icon ?? icon }); return; }
    fam.push({ label, icon, children: [live] });
  };
  const icon = (id: string) => CREATE_TOOLS.find((t) => t.id === id)?.icon;
  const faceRef = p?.kind === 'face' ? { body: p.body, ids: [p.face], generation: p.generation } : null;

  family('Add material', 'i-lucide-arrow-up-from-line', [
    ...(flat ? [{ label: 'Extrude (push/pull)', icon: icon('pushpull'), kbds: ['shift', 'e'], onSelect: run('pushpull') }, { label: 'Thicken', icon: icon('thicken'), onSelect: run('thicken') }] : []),
    ...(!p && design.features.some((f) => f.type === 'Sketch') ? [{ label: 'Extrude a sketch', icon: icon('extrude'), kbds: ['shift', 'e'], onSelect: run('extrude') }, { label: 'Revolve', icon: icon('revolve'), kbds: ['shift', 'r'], onSelect: run('revolve') }] : []),
  ], 'pick a flat face');
  family('Remove', 'i-lucide-circle-dot', [
    ...(flat ? [{ label: 'Hole', icon: icon('hole'), kbds: ['shift', 'h'], onSelect: run('hole') }] : []),
    ...(cyl || (circle && info.cylinderFace !== undefined) ? [{ label: 'Thread', icon: icon('thread'), kbds: ['shift', 't'],
      onSelect: run('thread', undefined, cyl ? p : { kind: 'face', body: p!.body, face: info.cylinderFace!, generation: p!.generation }) }] : []),
    ...(flat || p?.kind === 'body' ? [{ label: 'Shell', icon: icon('shell'), kbds: ['shift', 'k'], onSelect: run('shell') }] : []),
    ...(p ? [{ label: 'Cut', icon: icon('cut'), kbds: ['shift', 'x'], onSelect: run('cut') }] : []),
    ...(flat ? [{ label: 'Split with this face', icon: icon('cut'), onSelect: run('cut', { by: 'face', face: faceRef }) }] : []),
  ], 'pick a face or a body');
  family('Fillet / chamfer / draft', 'i-lucide-square-round-corner', [
    ...(edge || p?.kind === 'body' || flat ? [
      { label: 'Fillet', icon: 'i-lucide-square-round-corner', kbds: ['shift', 'f'], onSelect: run('fillet', { kind: 'Fillet', ...(flat && info.faceEdges ? { edges: { body: p!.body, ids: info.faceEdges, generation: p!.generation } } : {}) }) },
      { label: 'Chamfer', icon: 'i-lucide-scissors-line-dashed', onSelect: run('fillet', { kind: 'Chamfer', ...(flat && info.faceEdges ? { edges: { body: p!.body, ids: info.faceEdges, generation: p!.generation } } : {}) }) },
    ] : []),
    ...(flat ? [{ label: 'Draft', icon: icon('draft'), kbds: ['shift', 'd'], onSelect: run('draft') }] : []),
  ], 'pick an edge, a flat face or a body');
  family('Repeat', 'i-lucide-grid-3x3', [
    ...(p && !circle && !(edge && info.curve === 'line') && !cyl ? [
      { label: 'Linear pattern', icon: 'i-lucide-grid-3x3', kbds: ['shift', 'n'], onSelect: run('pattern', { pattern_circular: 0 }) },
      { label: 'Circular pattern', icon: 'i-lucide-rotate-cw', onSelect: run('pattern', { pattern_circular: 1 }) },
    ] : []),
    ...(cyl ? [{ label: 'Circular pattern around this axis', icon: 'i-lucide-rotate-cw', onSelect: run('pattern', { pattern_circular: 1, plane: 'face', planeFace: faceRef }) }] : []),
    ...(p ? [{ label: 'Mirror', icon: icon('mirror'), kbds: ['shift', 'z'], onSelect: run('mirror', flat ? { plane: 'face', planeFace: faceRef } : undefined) }] : []),
  ], 'pick a body');
  family('Transform', 'i-lucide-move-3d', p ? [{ label: 'Move', icon: icon('transform'), kbds: ['shift', 'y'], onSelect: run('transform') },
    ...(bodies >= 2 ? [{ label: 'Boolean with another body', icon: icon('boolean'), kbds: ['shift', 'b'], onSelect: run('boolean') }] : [])] : [], 'pick a body');
  family('Reference', 'i-lucide-square-dashed', [
    { label: 'Plane', icon: icon('plane'), kbds: ['shift', 'p'], onSelect: run('plane', flat ? undefined : { faceA: null }) },
    { label: 'Axis', icon: icon('axis'), kbds: ['shift', 'a'], onSelect: run('axis') },
    ...(!p || cyl ? [{ label: 'Helix', icon: icon('helix'), onSelect: run('helix', cyl ? { plane: 'face', planeFace: faceRef } : undefined) }] : []),
    ...(p ? [{ label: 'Volume and area', icon: 'i-lucide-ruler', onSelect: () => { void bodyMass(p.body).catch((e: unknown) => toast.error(String((e as Error)?.message ?? e))); } }] : []),
  ], '');
  const src = p ? design.bodies[p.body]?.source_feature : undefined;
  family('Modify', 'i-lucide-pencil', p ? [
    ...(src !== undefined && design.features[src] ? [{ label: `Edit ${design.features[src].name}`, icon: 'i-lucide-pencil', onSelect: () => act.editFeature(src) }] : []),
    ...(p.kind === 'face' ? [{ label: 'Delete Face', icon: icon('deleteface'), onSelect: run('deleteface') }] : []),
    { label: 'Delete Body', icon: 'i-lucide-trash-2', onSelect: () => act.deleteBody(p.body) },
  ] : [], 'select something first');
  groups.push(fam);
  return groups;
}

/** Cards that need a body etc. — for menus: is the card available right now (cheap, no kernel). */
export function toolAvailable(t: CreateTool): string | null {
  if (editBlocker()) return editBlocker();
  if (designKernel().status.phase === 'failed') return 'The CAD kernel isn’t available.';
  return t.needs?.({ bodies: design.bodies, features: design.features, datums: null, threads: [], holes: [], generation: design.generation, modelingOrigin: design.modelingOrigin }) ?? null;
}

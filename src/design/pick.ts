/**
 * Pick-driven references: a feature card's or the parameter editor's reference field (faces,
 * edges, a body, a point on a face) is filled by clicking in the viewport. One field picks at a
 * time (`picking.spec`); the viewport routes its clicks here while it does, with the hover and
 * the click restricted to the field's kind. Multi-pick fields toggle (click adds, click again
 * removes); single fields replace. Values carry the body and the `generation` they were picked
 * on (contract "Ids": face / edge ids are ordinals of one rebuild).
 *
 * An existing feature's references name the topology of its *input* — the design as it was
 * before that feature — not the finished design. Editing them picks on a rolled-back copy
 * (`rollbackBefore`): a scratch document opened from the saved bytes with that feature and
 * every later one suppressed (one replay of the prefix), shown in place of the design while
 * the field picks. Orca's cards pick on the live design; new features are appended last, so
 * for them the two are the same.
 */
import { markRaw, reactive, shallowRef } from 'vue';
import type { Vec3 } from '../project/math';
import { getOrcaCadRecipe } from '../project/persistence/passthrough';
import { decodeDisplayMeshes, type DisplayBody } from './kernel/mesh';
import type { DescribeScene, DisplayMeshLayout, DocOpenResult, MutationResult, SceneBody } from './kernel/types';
import { design, designKernel, setStatus } from './session';
import { designUi } from './state';
import { phone } from '../app/shell/uiState';

/** Phones: the panel sheet covers the view — put it away while picking, bring it back after. */
function sheetFor(picking: boolean): void { if (phone.value) designUi.panelOpen = !picking; }

export type PickKind = 'face' | 'faces' | 'edge' | 'edges' | 'body' | 'point';

/** A picked reference: one body and the face / edge ids on it (a point pick also has the spot). */
export interface PickValue { body: number; ids: number[]; point?: Vec3; generation: number }

export interface PickSpec {
  /** Which field picks (the card / editor row key). */
  key: string;
  kind: PickKind;
  /** Row label, for the banner ("Edges"). */
  label: string;
  /** Orca's status prompt ("Click a solid EDGE in the viewport"). */
  prompt: string;
  /** Refuse some picks (e.g. only planar faces): a message, or null to accept. */
  accept?: (hit: PickHit) => string | null | Promise<string | null>;
}

/** What the viewport resolved a click to. */
export interface PickHit { body: number; face?: number; edge?: number; point?: Vec3; generation: number }

export const picking = reactive({
  spec: null as PickSpec | null,
  value: null as PickValue | null,
  /** The value when picking started (Esc restores it). */
  initial: null as PickValue | null,
  /** Picking on the design as it was before feature `before` (an existing feature's references). */
  rollback: null as null | { before: number; name: string; generation: number; bodies: SceneBody[] },
  /** The rolled-back copy is being built. */
  rollingBack: false,
  rollbackError: '',
});

/** Display meshes of the rolled-back copy (shown instead of the design while picking on it). */
export const rollbackBodies = shallowRef<readonly DisplayBody[] | null>(null);

let onChange: ((v: PickValue | null) => void) | null = null;
let rollbackKey: { bytes: Uint8Array | null; before: number } | null = null;

const multi = (k: PickKind) => k === 'faces' || k === 'edges';
const noun = (k: PickKind) => (k === 'face' || k === 'faces' || k === 'point' ? 'face' : k === 'body' ? 'body' : 'edge');
const bodyName = (b: number) => {
  const list = picking.rollback?.bodies ?? design.bodies;
  return `Body ${b + 1}${list[b]?.name ? ` — ${list[b].name}` : ''}`;
};

/** The generation of the geometry being picked on. */
export function pickGeneration(): number { return picking.rollback?.generation ?? design.generation; }

/** What a value reads as ("Edge 4", "3 edges of Body 1", "Face 2 at 10.0, 4.0"). */
export function pickText(v: PickValue | null | undefined, kind: PickKind): string {
  if (!v) return kind === 'body' ? 'none' : `(no ${noun(kind)} picked)`;
  if (kind === 'body') return bodyName(v.body);
  if (!v.ids.length) return `(no ${noun(kind)} picked)`;
  const n = noun(kind);
  return v.ids.length === 1 ? `${n === 'face' ? 'Face' : 'Edge'} ${v.ids[0]}` : `${v.ids.length} ${n}s`;
}

/** Start picking a field. `cb` gets every change (and the initial value back on Esc). */
export function startPick(spec: PickSpec, initial: PickValue | null, cb: (v: PickValue | null) => void, opts: { rollbackBefore?: number } = {}): void {
  if (picking.spec) finishPick();
  picking.spec = markRaw(spec);
  picking.initial = initial ? { ...initial, ids: [...initial.ids] } : null;
  picking.value = initial ? { ...initial, ids: [...initial.ids] } : null;
  onChange = cb;
  sheetFor(true);
  if (opts.rollbackBefore !== undefined) void ensureRollback(opts.rollbackBefore);
  else dropRollback();
  setStatus('info', `${spec.prompt}${multi(spec.kind) ? ' — click again to remove one' : ''}. Enter finishes, Esc cancels.`);
}

/** Done picking (Enter, the Done button, another field). */
export function finishPick(): void {
  if (!picking.spec) return;
  const v = picking.value, spec = picking.spec;
  picking.spec = null;
  onChange = null;
  dropRollback();
  sheetFor(false);
  setStatus('info', `${spec.label}: ${pickText(v, spec.kind)}.`);
}

/** Esc: put the value back as it was and stop. */
export function cancelPick(): void {
  if (!picking.spec) return;
  const cb = onChange;
  const init = picking.initial;
  picking.spec = null;
  onChange = null;
  dropRollback();
  sheetFor(false);
  cb?.(init);
  design.status = null;
}

/** Clear the field's value (the row's clear button while picking). */
export function clearPick(): void {
  if (!picking.spec) return;
  picking.value = null;
  onChange?.(null);
}

/** A viewport click while a field picks. */
export async function pickHit(hit: PickHit | null): Promise<void> {
  const spec = picking.spec;
  if (!spec) return;
  if (!hit) { setStatus('info', `${spec.prompt}. Nothing there — Enter finishes, Esc cancels.`); return; }
  if (picking.rollingBack) { setStatus('info', 'Still rolling the design back to this feature’s input…'); return; }
  const k = spec.kind;
  const id = k === 'edge' || k === 'edges' ? hit.edge : k === 'body' ? undefined : hit.face;
  if (k !== 'body' && id === undefined) { setStatus('warn', `That is not a${noun(k) === 'edge' ? 'n edge' : ' face'} — ${spec.prompt.toLowerCase()}.`); return; }
  const refusal = spec.accept ? await spec.accept(hit) : null;
  if (picking.spec !== spec) return;
  if (refusal) { setStatus('warn', refusal); return; }
  const cur = picking.value;
  let next: PickValue;
  if (k === 'body') next = { body: hit.body, ids: [], generation: hit.generation };
  else if (!multi(k) || !cur || cur.body !== hit.body || cur.generation !== hit.generation) {
    next = { body: hit.body, ids: [id!], generation: hit.generation, ...(hit.point ? { point: hit.point } : {}) };
    if (multi(k) && cur?.ids.length && cur.body !== hit.body) setStatus('info', `${spec.label} are on one body: started again on ${bodyName(hit.body)}.`);
  } else {
    const has = cur.ids.includes(id!);
    next = { ...cur, ids: has ? cur.ids.filter((x) => x !== id) : [...cur.ids, id!] };
  }
  picking.value = next;
  onChange?.(next);
  if (k === 'body') setStatus('info', `${spec.label}: ${bodyName(next.body)}. Enter finishes.`);
  else if (multi(k)) setStatus('info', `${spec.label}: ${pickText(next, k)} of ${bodyName(next.body)} — click more to add, click one again to remove it, Enter finishes.`);
  else setStatus('info', `${spec.label}: ${pickText(next, k)} of ${bodyName(next.body)}. Enter finishes, or click another ${noun(k)}.`);
}

// ---- rollback: pick on the design as it was before a feature ------------------------------

function dropRollback(): void {
  picking.rollback = null;
  picking.rollingBack = false;
  picking.rollbackError = '';
  rollbackBodies.value = null;
}

async function ensureRollback(before: number): Promise<void> {
  const bytes = getOrcaCadRecipe();
  if (rollbackKey && rollbackKey.bytes === bytes && rollbackKey.before === before && rollbackBodies.value && picking.rollback) return;
  picking.rollingBack = true;
  picking.rollbackError = '';
  const name = design.features[before]?.name ?? `feature ${before + 1}`;
  const later = design.features.filter((f) => f.index >= before && f.enabled).map((f) => f.index);
  try {
    const r = await designKernel().run(`Rolling back to before ${name}`, async (c) => {
      if (!bytes) throw new Error('The design has not been saved yet.');
      const { result: o } = await c.call<DocOpenResult>('doc_open', {}, bytes);
      try {
        if (later.length) {
          const { result: s } = await c.call<MutationResult>('suppress_feature', { doc: o.doc, indices: later, suppressed: true, force: true });
          if (!s.ok && !s.kept) throw new Error(s.error || 'The design before this feature does not rebuild.');
        }
        const { result: scene } = await c.call<DescribeScene>('describe_scene', { doc: o.doc });
        const m = await c.call<{ meshes: DisplayMeshLayout[] }>('get_mesh', { doc: o.doc });
        return { scene, meshes: decodeDisplayMeshes(m.result.meshes, m.blob) };
      } finally {
        await c.call('doc_close', { doc: o.doc }).catch(() => {});
      }
    }, { cancellable: true });
    if (!picking.spec) return;
    if (r.scene.error) throw new Error(`the design before ${name} doesn’t rebuild (${r.scene.error})`);
    rollbackKey = { bytes, before };
    picking.rollback = { before, name, generation: r.scene.generation, bodies: r.scene.bodies };
    rollbackBodies.value = markRaw(r.meshes);
    // A value picked on another generation names other topology: keep it only when it is this copy's.
    if (picking.value && picking.value.generation !== r.scene.generation) picking.value = { ...picking.value, generation: r.scene.generation };
  } catch (e) {
    picking.rollbackError = e instanceof Error ? e.message : String(e);
    setStatus('error', `Couldn’t show the design before ${name}: ${picking.rollbackError}`);
  } finally {
    picking.rollingBack = false;
  }
}

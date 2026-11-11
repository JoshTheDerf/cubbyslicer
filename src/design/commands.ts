/**
 * Design tab commands (feature list, parameters, variables, bodies, commit). Each committed
 * edit is one `runEdit` (session.ts): one kernel job, one undo step. Names and arguments follow
 * the kernel methods they call (docs/CAD-KERNEL-CONTRACT.md).
 */
import { activeView } from '../app/state';
import { addDesignAssembly, addDesignObjects, designLinks, designObjects, getObject, mutate, relinkDesignObjects, selectedIds } from '../project/store';
import { preferences } from '../app/preferences';
import { getOrcaCadRecipe, setOrcaCadRecipe } from '../project/persistence/passthrough';
import type { FeatureJson, MutationResult, PlateMeshLayout } from './kernel/types';
import { decodePlateMeshes } from './kernel/mesh';
import { bodyIdentity, resolveLink } from './link';
import {
  activateDesign, currentDoc, design, designKernel, DesignEditError, editBlocker, readDesign, runEdit, setStatus, type EditOutcome,
} from './session';
import { designUi } from './state';

const fname = (i: number) => design.features[i]?.name ?? `feature ${i + 1}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- selection --------------------------------------------------------------------------

/** Click a feature row: select it (Ctrl/Cmd toggles, Shift extends the range). */
export function selectFeature(i: number, mods: { toggle?: boolean; range?: boolean } = {}): void {
  const s = designUi.selected;
  if (mods.range && s.length) {
    const a = s[s.length - 1], lo = Math.min(a, i), hi = Math.max(a, i);
    const range = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
    designUi.selected = [...s.filter((x) => !range.includes(x)), ...range.filter((x) => x !== i), i];
  } else if (mods.toggle) {
    designUi.selected = s.includes(i) ? s.filter((x) => x !== i) : [...s, i];
  } else {
    designUi.selected = [i];
  }
  designUi.pick = null;
  const f = design.features[i];
  if (f && designUi.selected.length === 1) {
    const err = design.featureErrors[i] ?? (design.failing?.index === i ? design.failing.error : '');
    setStatus(err ? 'error' : 'info', err ? `${f.name}: ${err}` : `${f.name} selected — F2 renames it, Delete removes it.`);
  }
}

export function selectAllFeatures(): void { designUi.selected = design.features.map((f) => f.index); }

// ---- feature edits ------------------------------------------------------------------------

/** Rename a feature (no rebuild). */
export function renameFeature(i: number, name: string): Promise<EditOutcome> {
  const n = name.trim();
  if (!n || n === design.features[i]?.name) return Promise.resolve({ ok: true, error: '', result: null });
  return runEdit(`Rename ${fname(i)}`, async (c, doc) => {
    await c.call('rename_feature', { doc, index: i, name: n });
    return { ok: true };
  }, { feature: i, geometry: false, done: `Renamed to ${n}` });
}

/**
 * Suppress / unsuppress features (Orca's eye). Several at once are one rebuild and one undo step.
 * `force` keeps the toggle even if the rebuild still fails — the way to repair a document that
 * doesn't rebuild, where every transactional edit is rolled back; it is the default then.
 */
export function setSuppressed(indices: readonly number[], suppressed: boolean, opts: { force?: boolean } = {}): Promise<EditOutcome> {
  const list = [...new Set(indices)].filter((i) => design.features[i] && design.features[i].enabled === suppressed).sort((a, b) => a - b);
  if (!list.length) return Promise.resolve({ ok: true, error: '', result: null });
  const force = opts.force ?? !design.ok;
  const what = list.length === 1 ? fname(list[0]) : plural(list.length, 'feature');
  return runEdit(`${suppressed ? 'Suppress' : 'Unsuppress'} ${what}`, async (c, doc) => {
    const p = list.length === 1 ? { index: list[0] } : { indices: list };
    return (await c.call<MutationResult>('suppress_feature', { doc, ...p, suppressed, ...(force ? { force: true } : {}) })).result;
  }, { feature: list.length === 1 ? list[0] : undefined, done: `${what} ${suppressed ? 'suppressed' : 'unsuppressed'}` });
}

/** Move a feature up (-1) / down (+1) in the history (refused when a consumer would come before its input). */
export function moveFeature(i: number, delta: -1 | 1): Promise<EditOutcome> {
  const to = i + delta;
  if (to < 0 || to >= design.features.length) return Promise.resolve({ ok: false, error: 'Already at the end.', result: null });
  return runEdit(`Move ${fname(i)} ${delta < 0 ? 'up' : 'down'}`, async (c, doc) => (await c.call<MutationResult>('move_feature', { doc, index: i, delta })).result,
    { feature: i, history: (r) => (r.ok && r.index !== undefined && r.index !== i ? { kind: 'move', from: i, to: r.index } : null), done: `Moved ${fname(i)}` });
}

/** Delete a feature (a Sketch takes the features made from it along; one Ctrl+Z restores them). */
export function deleteFeature(i: number): Promise<EditOutcome> {
  const name = fname(i);
  return runEdit(`Delete ${name}`, async (c, doc) => (await c.call<MutationResult>('delete_feature', { doc, index: i })).result, {
    feature: i,
    history: (r) => (r.ok && r.removed?.length ? { kind: 'delete', removed: r.removed } : null),
    done: (r) => ((r.removed?.length ?? 1) > 1 ? `Deleted ${name} and ${plural(r.removed!.length - 1, 'feature')} made from it` : `Deleted ${name}`),
  });
}

/** Delete several features, last first (each its own kernel edit, one undo step each). */
export async function deleteFeatures(indices: readonly number[]): Promise<void> {
  for (const i of [...new Set(indices)].sort((a, b) => b - a)) {
    if (!design.features[i]) continue;
    const r = await deleteFeature(i);
    if (!r.ok) break;
  }
}

/** The full field record of a feature (for the parameter editor). */
export function getFeature(i: number): Promise<FeatureJson> {
  return readDesign(async (c, doc) => (await c.call<{ feature: FeatureJson }>('get_feature', { doc, index: i })).result.feature);
}

/**
 * Apply a parameter edit as one rebuild: changed `fields` plus the feature's whole `expr` map
 * (field → expression; bound fields are driven by their expression on every rebuild).
 */
export function setFeatureParams(i: number, fields: Record<string, unknown>, expr?: Record<string, string>, generation?: number): Promise<EditOutcome> {
  const all = { ...fields, ...(expr ? { expr } : {}) };
  if (!Object.keys(all).length) return Promise.resolve({ ok: true, error: '', result: null });
  // `generation` (the rebuild the draft / picked ids came from): the kernel refuses face / edge ids
  // in `fields` from an older one (-32010).
  return runEdit(`Edit ${fname(i)}`, async (c, doc) => (await c.call<MutationResult>('set_feature', { doc, index: i, fields: all, ...(generation !== undefined ? { generation } : {}) })).result,
    { feature: i, done: `${fname(i)} updated` });
}

// ---- variables ------------------------------------------------------------------------------

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Add / change a document variable (empty `expr` deletes it). Names: letters, digits, underscores. */
export function setVariable(name: string, expr: string): Promise<EditOutcome> {
  const n = name.trim();
  if (!VAR_NAME.test(n)) return Promise.reject(new DesignEditError('A variable name starts with a letter and has only letters, digits and underscores.'));
  const e = expr.trim();
  return runEdit(e ? `Set ${n}` : `Delete ${n}`, async (c, doc) => (await c.call<MutationResult>('set_variable', { doc, name: n, expr: e })).result,
    { done: e ? `${n} = ${e}` : `Deleted ${n}` });
}

// ---- bodies ---------------------------------------------------------------------------------

/** Rename a body (its own name, saved in the design; not its feature's). Empty clears it. */
export function renameBody(b: number, name: string): Promise<EditOutcome> {
  const n = name.trim();
  return runEdit(`Rename body ${b + 1}`, async (c, doc) => {
    await c.call('set_body', { doc, body: b, name: n || null });
    return { ok: true };
  }, { geometry: false, done: n ? `Body ${b + 1} is now ${n}` : `Body ${b + 1} name cleared` });
}

export function toggleBodyHidden(b: number): void {
  const h = designUi.hiddenBodies;
  const hide = !h.includes(b);
  designUi.hiddenBodies = hide ? [...h, b] : h.filter((x) => x !== b);
  setStatus('info', `Body ${b + 1} ${hide ? 'hidden' : 'shown'}${hide ? ' — hidden bodies are not committed to the plate' : ''}.`);
}

/** CSS hex (#rrggbb) → the kernel's RGBA 0..1. */
export function hexToRgba(hex: string): [number, number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}
export function rgbaToHex(c: readonly number[] | undefined): string {
  if (!c) return '';
  return `#${c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** A body's display colour (saved in the design; Orca's Color). `null` clears it. */
export function setBodyColor(b: number, color: string | null): Promise<EditOutcome> {
  const rgba = color === null ? null : hexToRgba(color);
  if (color !== null && !rgba) return Promise.reject(new DesignEditError(`"${color}" is not a colour (#rrggbb).`));
  return runEdit(`Color body ${b + 1}`, async (c, doc) => {
    await c.call('set_body', { doc, body: b, color: rgba });
    return { ok: true };
  }, { geometry: false, done: rgba ? `Body ${b + 1} color set` : `Body ${b + 1} color cleared` });
}

/**
 * Delete a body: removes the feature it was made from (Orca, no confirmation — Ctrl+Z
 * restores it). A Sketch feature cascades to what was made from it.
 */
export function deleteBody(b: number): Promise<EditOutcome> {
  const body = design.bodies[b];
  if (!body || !design.features[body.source_feature]) return Promise.reject(new DesignEditError(`No body ${b + 1}.`));
  const f = body.source_feature, name = fname(f);
  return runEdit(`Delete body ${b + 1}`, async (c, doc) => (await c.call<MutationResult>('delete_feature', { doc, index: f })).result, {
    feature: f,
    history: (r) => (r.ok && r.removed?.length ? { kind: 'delete', removed: r.removed } : null),
    done: `Deleted ${name}, the feature this body was made from — Ctrl+Z restores it`,
  });
}

// ---- plate --------------------------------------------------------------------------------

/** Bodies that would go to the plate: visible, with faces, not committed yet. */
export function commitCandidates(): number[] {
  const linked = new Set(designLinks().map((l) => resolveLink(l.link, design.bodies)));
  return design.bodies.filter((b) => b.face_count > 0 && !designUi.hiddenBodies.includes(b.index) && !linked.has(b.index)).map((b) => b.index);
}

/**
 * Commit to Plate: one plate object per visible body not committed yet, each live-linked to its
 * body (later design edits replace its mesh). Bodies already on the plate are just selected.
 */
export async function commitToPlate(opts: { switchView?: boolean; mode?: 'assembly' | 'bodies' } = {}): Promise<string[]> {
  const mode = opts.mode ?? preferences.designCommitMode;
  activateDesign();
  const blocked = editBlocker();
  if (blocked && !design.readOnly) throw new DesignEditError(blocked);
  if (!design.bodies.some((b) => b.face_count > 0)) throw new DesignEditError(design.ok ? 'Nothing to commit — the design has no bodies.' : 'Nothing to commit — the design doesn’t rebuild.');
  const bodies = commitCandidates();
  const already = [...new Set(designLinks().filter((l) => resolveLink(l.link, design.bodies) >= 0).map((l) => l.owner.id))];
  if (!bodies.length) {
    if (already.length) {
      selectedIds.value = already;
      if (opts.switchView !== false) activeView.value = 'prepare';
      setStatus('info', 'Every body is already on the plate; linked objects follow your edits.');
      return already;
    }
    throw new DesignEditError('All bodies are hidden — show one before committing.');
  }
  const snapshotBodies = design.bodies.slice();
  const meshes = await designKernel().run('Committing to the plate', async (c) => {
    const doc = currentDoc();
    if (doc === null) throw new DesignEditError('No design is open.');
    const r = await c.call<{ meshes: PlateMeshLayout[] }>('export_mesh', { doc, bodies });
    return decodePlateMeshes(r.result.meshes, r.blob);
  });
  const items = meshes.filter((m) => m.indices.length).map((m) => {
    const b = snapshotBodies[m.body];
    return { name: b?.user_name ? b.name : `Design Body ${m.body + 1}`, mesh: m, link: { ...bodyIdentity(snapshotBodies, m.body), body: m.body } };
  });
  const label = items.length === 1 ? `Commit ${items[0].name} to plate` : `Commit ${items.length} bodies to plate${mode === 'assembly' ? ' as an assembly' : ''}`;
  const ids = mode === 'assembly' && items.length > 1 ? addDesignAssembly(items, 'Design Assembly', label) : addDesignObjects(items.length === 1 && !snapshotBodies[items[0].link.body]?.user_name ? [{ ...items[0], name: 'Design Body' }] : items, label);
  // Design ids from the object list and the plate both lead back here.
  if (opts.switchView !== false) activeView.value = 'prepare';
  setStatus('ok', mode === 'assembly' && items.length > 1 ? `Committed ${plural(items.length, 'body')} to the plate as one assembly object (a part per body) — it follows your design edits.`
    : `Committed ${plural(ids.length, 'body')} to the plate — they follow your design edits.`);
  return ids;
}

/** "Edit in Design": open the Design tab on the body a plate object was committed from. */
export function editInDesign(objectId: string): boolean {
  const o = getObject(objectId);
  const link = o?.design ?? o?.parts?.find((p) => p.design)?.design;
  if (!o || !link) return false;
  activeView.value = 'design';
  activateDesign();
  const b = resolveLink(link, design.bodies);
  const f = link.sourceFeature;
  if (design.features[f]) designUi.selected = [f];
  designUi.pick = b >= 0 ? { kind: 'body', body: b } : null;
  setStatus('info', b >= 0 ? `${o.name} comes from body ${b + 1} (${design.bodies[b]?.name ?? ''}), made by ${fname(f)}.` : `${o.name}’s body is not in the design right now (its feature is suppressed or fails).`);
  return true;
}

/** Drop the link of these objects (they become plain meshes; one undo step). */
export function unlinkObjects(ids: readonly string[]): void {
  const set = new Set(ids);
  mutate(ids.length === 1 ? 'Unlink from design' : `Unlink ${ids.length} objects from design`, () => {
    for (const o of designObjects()) if (set.has(o.id)) { delete o.design; for (const p of o.parts ?? []) delete p.design; }
  }, { slice: false });
}

/**
 * Erase the design (Orca's "New Design": every feature and body). Undoable here (Orca's isn't).
 * Linked plate objects stay as plain meshes.
 */
export function clearDesign(): void {
  if (!getOrcaCadRecipe()) return;
  mutate('Clear design', () => {
    setOrcaCadRecipe(null);
    relinkDesignObjects(() => ({ link: null }));
  }, { slice: false });
  designUi.selected = [];
  designUi.pick = null;
  setStatus('info', 'The design was cleared — Ctrl+Z brings it back.');
}

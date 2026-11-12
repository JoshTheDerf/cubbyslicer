/**
 * Texture Displacement tool commands (desktop GLGizmoTextureDisplacement):
 * add / change / remove layers, select / erase the whole model for a layer,
 * and bake. Shared by the tool panel and the MCP bridge; each is one undo step.
 */
import { commitTextureBake, getMeshTexture, getObject, meshTexture, setTextureMasks, setTextureStack, textureOwner } from '../project/store';
import type { ProjectObject, TextureLayer, TextureStack } from '../project/types';
import { Matrix4, Vector3 } from 'three';
import { SliceCancelled, paintFromStates } from '../engine/client';
import type { PaintMap } from '../engine/types';
import { mergePaint, nearestTriangle, trianglesFacing } from '../bridge/logic';
import { paintWith } from '../paint/session';
import { isPainted, meshMoved, runBake, textureParts, type PartResult, type RunOptions, type TexturePart } from './bake';
import { applyTextureAdjustments, decodeLayerImage, encodeHeightPng, isIdentity, type TextureAdjustments } from './image';
import { saveUserTexture, type UserTexture } from './userLibrary';
import { defaultLayerJson, defaultOptions, freeSlot, layerSlot, str, maskFits, MAX_TEXTURE_LAYERS, wholeMask, withFields } from './model';

export const stackOf = (o: ProjectObject): TextureStack | undefined => getMeshTexture(textureOwner(o)).stack;

function emptyStack(): TextureStack { return Object.freeze({ layers: Object.freeze([]), options: Object.freeze(defaultOptions()) }); }

function withOptions(stack: TextureStack, patch: Record<string, unknown>): TextureStack {
  return Object.freeze({ layers: stack.layers, options: Object.freeze({ ...stack.options, ...patch }) });
}

/** A texture for a layer: its name, its archive-independent label (`path`) and the PNG. */
export interface LayerTexture { name: string; path: string; image: Uint8Array }

/**
 * add_texture_layer: the lowest free slot, starting on `texture` (desktop: the
 * first library texture). Returns the slot, or -1 when all eight are used.
 */
export function addTextureLayer(objectId: string, texture: LayerTexture | null): number {
  const o = getObject(objectId);
  if (!o) return -1;
  const stack = stackOf(o) ?? emptyStack();
  const slot = freeSlot(stack);
  if (slot < 0) return -1;
  const json = { ...defaultLayerJson(slot), ...(texture ? { name: texture.name, path: texture.path } : {}) };
  const layer: TextureLayer = Object.freeze({ json: Object.freeze(json), image: texture?.image ?? null });
  const next = withOptions(Object.freeze({ layers: Object.freeze([...stack.layers, layer]), options: stack.options }), { active_slot: slot });
  setTextureStack(textureOwner(o), next, 'Add texture displacement layer');
  return slot;
}

/** Change fields of a layer (and / or its texture). `mergeKey` coalesces a slider drag into one step. */
export function updateTextureLayer(objectId: string, slot: number, patch: Record<string, unknown>,
                                   opts: { label?: string; mergeKey?: string; texture?: LayerTexture } = {}): void {
  const o = getObject(objectId);
  const stack = o && stackOf(o);
  if (!o || !stack) return;
  const tex = opts.texture ? { name: opts.texture.name, path: opts.texture.path } : {};
  const layers = stack.layers.map((l) => (layerSlot(l) === slot ? withFields(l, { ...patch, ...tex }, opts.texture?.image) : l));
  setTextureStack(textureOwner(o), Object.freeze({ layers: Object.freeze(layers), options: stack.options }),
    opts.label ?? (opts.texture ? 'Change texture displacement texture' : 'Texture displacement layer'), opts.mergeKey);
}

/** remove_texture_layer: the layer and its paint on every model part. */
export function removeTextureLayer(objectId: string, slot: number): void {
  const o = getObject(objectId);
  const stack = o && stackOf(o);
  if (!o || !stack) return;
  const layers = stack.layers.filter((l) => layerSlot(l) !== slot);
  const next = layers.length ? Object.freeze({ layers: Object.freeze(layers), options: stack.options }) : null;
  setTextureMasks(textureParts(o).map((p) => ({ meshId: p.mesh.id, slot, mask: null })), 'Remove texture displacement layer',
    { meshId: textureOwner(o), stack: next });
}

/**
 * The new slot of each layer when the layer in `slot` moves to `toIndex` of
 * the slot-ordered stack (move_texture_layer: an insertion index that counts
 * the moved layer's own position). Layers in between shift by one and keep
 * their order. Empty when nothing moves.
 */
export function reorderedSlots(slots: readonly number[], slot: number, toIndex: number): Map<number, number> {
  const sorted = [...slots].sort((a, b) => a - b);
  const from = sorted.indexOf(slot);
  if (from < 0) return new Map();
  const to = Math.min(Math.max(toIndex > from ? toIndex - 1 : toIndex, 0), sorted.length - 1);
  if (to === from) return new Map();
  const order = [...sorted];
  order.splice(from, 1);
  order.splice(to, 0, slot);
  const out = new Map<number, number>();
  order.forEach((old, i) => { if (old !== sorted[i]) out.set(old, sorted[i]); });
  return out;
}

/**
 * move_texture_layer: the layers' order is their slot order (the first sits
 * on the bare surface, each next one blends onto those before), so moving a
 * layer exchanges slots, and every model part's masks move with them. One
 * undo step. Returns the old → new slot map (empty when nothing moved).
 */
export function moveTextureLayer(objectId: string, slot: number, toIndex: number): Map<number, number> {
  const o = getObject(objectId);
  const stack = o && stackOf(o);
  if (!o || !stack) return new Map();
  const map = reorderedSlots(stack.layers.map(layerSlot), slot, toIndex);
  if (!map.size) return map;
  const layers = stack.layers.map((l) => (map.has(layerSlot(l)) ? withFields(l, { slot: map.get(layerSlot(l)) }) : l));
  const active = Number(stack.options.active_slot ?? -1);
  const options = map.has(active) ? Object.freeze({ ...stack.options, active_slot: map.get(active) }) : stack.options;
  const changes: Array<{ meshId: string; slot: number; mask: ReadonlyArray<readonly [number, string]> | null }> = [];
  for (const p of textureParts(o)) {
    const masks = p.texture.masks ?? {};
    for (const [from, to] of map) changes.push({ meshId: p.mesh.id, slot: to, mask: masks[String(from)] ?? null });
  }
  setTextureMasks(changes, 'Reorder texture displacement layers', { meshId: textureOwner(o), stack: Object.freeze({ layers: Object.freeze(layers), options }) });
  return map;
}

/**
 * commit_image_adjust: the layer's image with `adj` applied, saved to My
 * textures as a copy (named after the layer, made unique), and the layer
 * pointed at it - the only way an adjustment becomes permanent (desktop never
 * stores the adjustment itself). Null when nothing changes.
 */
export async function saveAdjustedCopy(objectId: string, slot: number, adj: TextureAdjustments): Promise<UserTexture | null> {
  const o = getObject(objectId);
  const l = o && stackOf(o)?.layers.find((x) => layerSlot(x) === slot);
  if (!l?.image) throw new Error('The layer has no image to adjust.');
  if (isIdentity(adj)) return null;
  const src = decodeLayerImage(l.image);
  if (!src) throw new Error('Could not load the selected texture.');
  const saved = await saveUserTexture(str(l.json, 'name') || 'texture', encodeHeightPng(applyTextureAdjustments(src, adj)));
  updateTextureLayer(objectId, slot, {}, { texture: { name: saved.name, path: `${saved.name}.png`, image: saved.image } });
  return saved;
}

/** select_whole_model: every facet of every model part painted with the layer in `slot`. */
export function selectWholeModel(objectId: string, slot: number): void {
  const o = getObject(objectId);
  if (!o || slot < 0 || slot >= MAX_TEXTURE_LAYERS) return;
  setTextureMasks(textureParts(o).map((p) => ({ meshId: p.mesh.id, slot, mask: wholeMask(p.mesh.triangleCount) })),
    'Select whole model for texture displacement');
}

/** Erase whole model: the layer's paint cleared from every model part. */
export function eraseWholeModel(objectId: string, slot: number): void {
  const o = getObject(objectId);
  if (!o) return;
  setTextureMasks(textureParts(o).map((p) => ({ meshId: p.mesh.id, slot, mask: null })), 'Reset texture displacement selection');
}

/** The slots with paint on any model part of the object. */
export function paintedSlotsOf(o: ProjectObject): Set<number> {
  void meshTexture.value; // reactive dependency for callers in computed()
  const out = new Set<number>();
  for (const p of textureParts(o)) for (const s of Object.keys(p.texture.masks ?? {})) if (p.texture.masks?.[s]?.length) out.add(Number(s));
  return out;
}

export const anyPartPainted = (o: ProjectObject) => textureParts(o).some((p) => isPainted(p.texture));

export interface BakeOutcome { ok: boolean; message?: string; cancelled?: boolean; parts?: number; budgetLimited?: boolean }

/**
 * bake(): every painted part displaced, committed as one undo step. Parts
 * whose bake moved nothing are left as they were; when none moved, nothing
 * changes and the paint is kept (desktop's finalize()).
 */
export async function bakeTexture(objectId: string, opts: Pick<RunOptions, 'signal' | 'onPart' | 'onProgress' | 'images'> = {}): Promise<BakeOutcome> {
  const o = getObject(objectId);
  if (!o) return { ok: false, message: 'No such object.' };
  if (!anyPartPainted(o)) return { ok: false, message: 'Nothing is painted, there is nothing to bake.' };
  const before = new Map(textureParts(o).map((p) => [p.partId, p.mesh.id]));
  let results: PartResult[] | null;
  try {
    results = await runBake(objectId, opts);
  } catch (e) {
    if (e instanceof SliceCancelled) return { ok: false, cancelled: true, message: 'The bake was cancelled.' };
    throw e;
  }
  if (opts.signal?.aborted) return { ok: false, cancelled: true, message: 'The bake was cancelled.' };
  if (!results) return { ok: false, message: 'The object changed while baking.' };
  // A part whose mesh changed meanwhile (undo, another tool) is skipped, like desktop's stale-volume check.
  const now = getObject(objectId);
  const current = new Map(now ? textureParts(now).map((p) => [p.partId, p.mesh.id]) : []);
  const moved = results.filter((r) => current.get(r.part.partId) === before.get(r.part.partId) && meshMoved(r.part.mesh, r.positions, r.indices));
  if (!moved.length) {
    return { ok: false, message: 'The bake produced no displacement, so nothing was changed and the paint was kept. Check that the painted layer has a texture and a non-zero depth.' };
  }
  commitTextureBake(objectId, moved.map((r) => ({ partId: r.part.partId, positions: r.positions, indices: r.indices, paint: r.paint })));
  return { ok: true, parts: moved.length, budgetLimited: moved.some((r) => r.budgetLimited) };
}

export type TexturePaintMode = 'sphere' | 'smart_fill' | 'facing';
export interface TexturePaintSpec {
  mode: TexturePaintMode;
  /** sphere / smart_fill: a world (bed) point on or near the surface. */
  point?: [number, number, number];
  /** sphere: mm. */
  radius?: number;
  /** smart_fill: the angle threshold; facing: the cone around `direction` (degrees). */
  angle?: number;
  /** facing: world direction. */
  direction?: [number, number, number];
  erase?: boolean;
}

/**
 * Scripted painting of a layer's mask (the bridge; the panel paints with the
 * pointer, src/texture/paint.ts): a sphere or a connected area at a point, on
 * the model part nearest to it, or every face of every part facing a
 * direction. One undo step.
 */
export async function paintTextureArea(objectId: string, slot: number, spec: TexturePaintSpec): Promise<{ paintedTriangles: number; distance?: number }> {
  const o = getObject(objectId);
  if (!o) throw new Error('No such object.');
  if (!stackOf(o)?.layers.some((l) => layerSlot(l) === slot)) throw new Error('No such texture layer.');
  const parts = textureParts(o);
  const state = spec.erase ? 0 : 1;
  const key = String(slot);
  const changes: Array<{ meshId: string; slot: number; mask: PaintMap | null }> = [];
  let distance: number | undefined;
  for (const p of parts) {
    if (!maskFits(p.texture.masks?.[key], p.mesh.triangleCount)) throw new Error('This layer’s paint was recorded for a different mesh; erase it (wholeModel: "erase") first.');
  }
  if (spec.mode === 'facing') {
    if (!spec.direction) throw new Error('mode "facing" needs direction [x, y, z].');
    for (const p of parts) {
      const tris = trianglesFacing(p.mesh.positions, p.mesh.indices, p.matrix, spec.direction, spec.angle ?? 45);
      if (!tris.length) continue;
      const cur = p.texture.masks?.[key] as PaintMap | undefined;
      const tm = { positions: p.mesh.positions, indices: p.mesh.indices };
      const next = state === 0 ? mergePaint(cur, [], tris) : mergePaint(cur, await paintFromStates(tm, tris.map((t): [number, number] => [t, 1])));
      changes.push({ meshId: p.mesh.id, slot, mask: next.length ? next : null });
    }
  } else {
    if (!spec.point) throw new Error(`mode "${spec.mode}" needs point [x, y, z].`);
    let best: { part: TexturePart; tri: number; point: [number, number, number]; distance: number } | null = null;
    for (const p of parts) {
      const h = nearestTriangle(p.mesh.positions, p.mesh.indices, p.matrix, spec.point);
      if (h && (!best || h.distance < best.distance)) best = { part: p, tri: h.tri, point: h.point, distance: h.distance };
    }
    if (!best) throw new Error('The object has no triangles.');
    distance = best.distance;
    const m = best.part.matrix;
    const inv = new Matrix4().fromArray(m).invert();
    const local = new Vector3(...best.point).applyMatrix4(inv).toArray();
    const cam = new Vector3(0, 0, 10_000).applyMatrix4(inv).toArray();
    const tm = { positions: best.part.mesh.positions, indices: best.part.mesh.indices };
    const cur = best.part.texture.masks?.[key] as PaintMap | undefined;
    const radius = spec.radius ?? 5;
    const next = await paintWith(tm, 'texture', cur, spec.mode === 'sphere'
      ? { kind: 'sphere', facet: best.tri, point: local, camera: cam, radius, trafo: m, state }
      : { kind: 'fill', facet: best.tri, point: local, camera: cam, angle: spec.angle ?? 30, trafo: m, state });
    changes.push({ meshId: best.part.mesh.id, slot, mask: next.length ? next : null });
  }
  if (changes.length) setTextureMasks(changes, state ? 'Paint texture displacement' : 'Erase texture displacement paint');
  const now = getObject(objectId);
  const painted = now ? textureParts(now).reduce((n, p) => n + (p.texture.masks?.[key]?.length ?? 0), 0) : 0;
  return { paintedTriangles: painted, distance };
}

/**
 * Texture Displacement tool commands (desktop GLGizmoTextureDisplacement):
 * add / change / remove layers, select / erase the whole model for a layer,
 * and bake. Shared by the tool panel and the MCP bridge; each is one undo step.
 */
import { commitTextureBake, getMeshTexture, getObject, meshTexture, setTextureMasks, setTextureStack, textureOwner } from '../project/store';
import type { ProjectObject, TextureLayer, TextureStack } from '../project/types';
import { isPainted, meshMoved, runBake, textureParts } from './bake';
import { defaultLayerJson, defaultOptions, freeSlot, layerSlot, MAX_TEXTURE_LAYERS, wholeMask, withFields } from './model';

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

export interface BakeOutcome { ok: boolean; message?: string; parts?: number; budgetLimited?: boolean }

/**
 * bake(): every painted part displaced, committed as one undo step. Parts
 * whose bake moved nothing are left as they were; when none moved, nothing
 * changes and the paint is kept (desktop's finalize()).
 */
export async function bakeTexture(objectId: string): Promise<BakeOutcome> {
  const o = getObject(objectId);
  if (!o) return { ok: false, message: 'No such object.' };
  if (!anyPartPainted(o)) return { ok: false, message: 'Nothing is painted, there is nothing to bake.' };
  const before = new Map(textureParts(o).map((p) => [p.partId, p.mesh.id]));
  const results = await runBake(objectId);
  if (!results) return { ok: false, message: 'The object changed while baking.' };
  // A part whose mesh changed meanwhile (undo, another tool) is skipped, like desktop's stale-volume check.
  const now = getObject(objectId);
  const current = new Map(now ? textureParts(now).map((p) => [p.partId, p.mesh.id]) : []);
  const moved = results.filter((r) => current.get(r.part.partId) === before.get(r.part.partId) && meshMoved(r.part.mesh, r.positions, r.indices));
  if (!moved.length) {
    return { ok: false, message: 'The bake produced no displacement, so nothing was changed and the paint was kept. Check that the painted layer has a texture and a non-zero depth.' };
  }
  commitTextureBake(objectId, moved.map((r) => ({ partId: r.part.partId, positions: r.positions, indices: r.indices })));
  return { ok: true, parts: moved.length, budgetLimited: moved.some((r) => r.budgetLimited) };
}

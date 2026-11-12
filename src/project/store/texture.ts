/**
 * Orca 2.5 texture displacement in the project (src/texture has the tool):
 * the layer stack lives on the object's own mesh (desktop: its first model
 * part), every model part has a paint mask per layer slot. Both are keyed by
 * mesh id, so instances share them and they follow undo / redo.
 */
import type { MeshTexture, ProjectObject, TextureStack } from '../types';
import { mutate } from './history';
import { swapVolumeMesh } from './toolObjects';
import { addMesh, getObject, meshTexture } from './state';

type Mask = ReadonlyArray<readonly [number, string]>;

/** Texture displacement of a mesh (empty when it has none). */
export function getMeshTexture(meshId: string): MeshTexture { return meshTexture.value[meshId] ?? {}; }

/** The mesh holding an object's layer stack: its own mesh (desktop's first model part). */
export function textureOwner(o: ProjectObject): string { return o.meshId; }

function write(meshId: string, t: MeshTexture): void {
  const next = { ...meshTexture.value };
  const clean: { stack?: TextureStack; masks?: Record<string, Mask> } = {};
  if (t.stack?.layers.length) clean.stack = t.stack;
  if (t.masks && Object.keys(t.masks).length) clean.masks = t.masks as Record<string, Mask>;
  if (clean.stack || clean.masks) next[meshId] = Object.freeze(clean); else delete next[meshId];
  meshTexture.value = next;
}

/**
 * Replace a mesh's layer stack (null / no layers removes it). One undo step;
 * `mergeKey` coalesces a slider drag. Doesn't change what is sliced.
 */
export function setTextureStack(meshId: string, stack: TextureStack | null, label: string, mergeKey?: string): void {
  mutate(label, () => { write(meshId, { ...getMeshTexture(meshId), stack: stack ?? undefined }); }, { slice: false, mergeKey });
}

/** Set (or with null clear) paint masks of several meshes as one undo step, optionally with a new stack. */
export function setTextureMasks(changes: Array<{ meshId: string; slot: number; mask: Mask | null }>, label: string,
                                stack?: { meshId: string; stack: TextureStack | null }): void {
  mutate(label, () => {
    if (stack) write(stack.meshId, { ...getMeshTexture(stack.meshId), stack: stack.stack ?? undefined });
    for (const c of changes) {
      const cur = getMeshTexture(c.meshId);
      const masks: Record<string, Mask> = { ...(cur.masks ?? {}) };
      if (c.mask?.length) masks[String(c.slot)] = Object.freeze(c.mask.map((e) => Object.freeze([e[0], e[1]] as const)));
      else delete masks[String(c.slot)];
      write(c.meshId, { ...cur, masks });
    }
  }, { slice: false });
}

export interface TextureBakeResult {
  /** null = the object's own mesh. */
  partId: string | null;
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Desktop's TextureDisplacementBakeJob commit: each baked volume gets its
 * displaced mesh (one undo step), the layer stack moves to the new owner mesh
 * and the baked volumes' masks are cleared (the default pipeline rebuilds the
 * topology, so no mask still applies). Other paint of a baked volume resets,
 * as with any mesh-replacing tool.
 */
export function commitTextureBake(objectId: string, results: TextureBakeResult[], label = 'Bake texture displacement'): void {
  const o = getObject(objectId);
  if (!o || !results.length) return;
  mutate(label, () => {
    const stack = getMeshTexture(textureOwner(o)).stack;
    for (const r of results) {
      const m = addMesh(r.positions, r.indices);
      swapVolumeMesh(objectId, r.partId, m, null);
      if (r.partId === null && stack) write(m.id, { stack });
    }
  });
}

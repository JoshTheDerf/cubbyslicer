/**
 * Painted facets per mesh (support / seam / colour / fuzzy): undoable edits
 * and the read-outs slicing needs.
 */
import type { PaintLayer, PaintLayers, PaintMap } from '../../engine/types';
import type { ProjectObject } from '../types';
import { mutate } from './history';
import { meshIdsOf, meshPaint } from './state';

/** Paint of a mesh (empty when unpainted). */
export function getMeshPaint(meshId: string): PaintLayers { return meshPaint.value[meshId] ?? {}; }

/** Replace one paint layer of a mesh (null / empty clears it). Undoable. */
export function setMeshPaint(meshId: string, layer: PaintLayer, map: PaintMap | null, label = 'Paint'): void {
  mutate(label, () => { writeMeshPaint(meshId, layer, map); });
}

/** setMeshPaint without its own undo step (inside a `mutate`). */
export function writeMeshPaint(meshId: string, layer: PaintLayer, map: PaintMap | null): void {
  const cur = meshPaint.value[meshId] ?? {};
  const nextLayers: PaintLayers = { ...cur };
  if (map && map.length) nextLayers[layer] = map; else delete nextLayers[layer];
  const next = { ...meshPaint.value };
  if (Object.keys(nextLayers).length) next[meshId] = nextLayers; else delete next[meshId];
  meshPaint.value = next;
}

/** Paint layers of a mesh for the engine (undefined when unpainted). */
export function paintFor(meshId: string): PaintLayers | undefined {
  const p = meshPaint.value[meshId];
  return p && Object.keys(p).length ? p : undefined;
}

// Paint layer objects are immutable: a per-object counter tells slices apart cheaply.
const paintIds = new WeakMap<object, number>();
let paintSeq = 0;
/** A token that changes whenever any of the object's meshes is repainted. */
export function paintVersion(o: ProjectObject): string {
  return meshIdsOf(o).map((id) => {
    const p = meshPaint.value[id];
    if (!p) return 0;
    let v = paintIds.get(p);
    if (v === undefined) { v = ++paintSeq; paintIds.set(p, v); }
    return v;
  }).join('.');
}

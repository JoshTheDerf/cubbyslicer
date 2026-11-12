/** Whole-project load / reset and the serialised views persistence writes (src/project/persistence). */
import { toRaw } from 'vue';
import type { PaintLayers } from '../../engine/types';
import { MAX_PLATES, clonePlate, newPlate, type PlateMeta } from '../plates';
import type { MeshData, MeshTexture, ProjectObject } from '../types';
import { cloneObj } from './clone';
import { changed, clearHistory } from './history';
import {
  activePlate, addMesh, meshIdsOf, meshPaint, meshRevision, meshTexture, meshes, objects, plates, projectLoads, projectName, selectedIds,
} from './state';

export interface ProjectData {
  name: string;
  objects: ProjectObject[];
  meshes: MeshData[];
  plates?: PlateMeta[];
  paint?: Record<string, PaintLayers>;
  /** Texture displacement per mesh id (Orca 2.5). */
  texture?: Record<string, MeshTexture>;
}

/** Replace the whole project (clears undo history). */
export function loadProjectData(data: ProjectData): void {
  projectLoads.value++;
  meshes.clear();
  for (const m of data.meshes) addMesh(m.positions, m.indices, m.id);
  objects.value = data.objects.filter((o) => meshes.has(o.meshId)).map((o) => {
    const c = cloneObj(o);
    if (c.parts) { c.parts = c.parts.filter((p) => meshes.has(p.meshId)); if (!c.parts.length) delete c.parts; }
    return c;
  });
  plates.value = data.plates?.length ? data.plates.slice(0, MAX_PLATES).map((p) => ({ ...clonePlate(p), name: String(p.name ?? '').slice(0, 80) })) : [newPlate()];
  activePlate.value = 0;
  const paint: Record<string, PaintLayers> = {};
  for (const [id, layers] of Object.entries(data.paint ?? {})) if (meshes.has(id)) paint[id] = layers;
  meshPaint.value = paint;
  const texture: Record<string, MeshTexture> = {};
  for (const [id, t] of Object.entries(data.texture ?? {})) if (meshes.has(id)) texture[id] = t;
  meshTexture.value = texture;
  projectName.value = data.name || 'Untitled project';
  selectedIds.value = [];
  clearHistory();
  meshRevision.value++;
  changed(true);
}

export function resetProject(): void {
  loadProjectData({ name: 'Untitled project', objects: [], meshes: [] });
}

export function serializeObjects(): ProjectObject[] { return objects.value.map(cloneObj); }

/** Paint of the live meshes (for project files / autosave). */
export function serializePaint(): Record<string, PaintLayers> {
  const live = new Set(objects.value.flatMap(meshIdsOf));
  const out: Record<string, PaintLayers> = {};
  for (const [id, layers] of Object.entries(meshPaint.value)) if (live.has(id)) out[id] = layers;
  return out;
}

/** Texture displacement of the live meshes (for project files / autosave). */
export function serializeTexture(): Record<string, MeshTexture> {
  const live = new Set(objects.value.flatMap(meshIdsOf));
  const out: Record<string, MeshTexture> = {};
  for (const [id, t] of Object.entries(meshTexture.value)) if (live.has(id)) out[id] = t;
  return out;
}

export function serializePlates(): PlateMeta[] { return plates.value.map((p) => clonePlate(toRaw(p))); }

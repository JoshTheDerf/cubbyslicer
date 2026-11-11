/**
 * The project's live state: objects, plates, selection refs, the mesh
 * registry and paint, plus the plain lookups every other store module uses.
 *
 * - `objects` is deeply reactive (small data: transforms, names, overrides).
 * - Meshes live in a plain Map of `markRaw` typed arrays, never proxied or
 *   JSON-serialised; `meshRevision` signals changes.
 */
import { computed, markRaw, ref, shallowRef } from 'vue';
import { bedFromConfig, resolvedConfig } from '../../app/state';
import type { ConfigValue, PaintLayers } from '../../engine/types';
import { computeBBox } from '../mesh';
import { newPlate, plateBed, type PlateMeta } from '../plates';
import type { MeshData, ProjectObject } from '../types';

// ---- reactive state ---------------------------------------------------------

export const objects = ref<ProjectObject[]>([]);
export const selectedIds = ref<string[]>([]);
/** A part picked in the object list (its settings are edited instead of the object's). UI state, not undoable. */
export const selectedPart = ref<{ objectId: string; partId: string } | null>(null);
export const projectName = ref('Untitled project');
/** Bumps on any change that should be persisted (autosave watches this). */
export const projectRevision = ref(0);
/** Bumps when the mesh map changes. */
export const meshRevision = ref(0);
/** Bumped whenever a whole project is loaded (new / open / import as project). */
export const projectLoads = ref(0);

/** The printer's bed (plate 0's placement; other plates are offset copies — see plates.ts). */
export const bed = computed(() => bedFromConfig(resolvedConfig.value));

/** Plates (Orca PartPlateList). Part of the undo snapshot; at least one. */
export const plates = ref<PlateMeta[]>([newPlate()]);
/** The plate being sliced / previewed / receiving new objects. */
export const activePlate = ref(0);

export function plateBedOf(i: number) { return plateBed(bed.value, i, plates.value.length); }

export function clampActivePlate(): void {
  if (activePlate.value > plates.value.length - 1) activePlate.value = plates.value.length - 1;
  if (activePlate.value < 0) activePlate.value = 0;
}

/**
 * Painted facets per mesh (Orca support / seam / color / fuzzy painting), keyed
 * by mesh id: instances share their paint like Orca's instances share volumes.
 * PaintMap arrays are immutable — replace, never mutate — so snapshots share them.
 */
export const meshPaint = shallowRef<Record<string, PaintLayers>>({});

/** Shared empty override record (read-only views of objects / parts without overrides). */
export const EMPTY_OVERRIDES: Readonly<Record<string, ConfigValue>> = Object.freeze({});

// ---- mesh registry ------------------------------------------------------------

/** Every mesh still referenced by the project or its undo history (history.ts collects the rest). */
export const meshes = new Map<string, MeshData>();

export function addMesh(positions: Float32Array, indices: Uint32Array, id = uid('m')): MeshData {
  const mesh = markRaw({
    id,
    positions: markRaw(positions),
    indices: markRaw(indices),
    bbox: computeBBox(positions),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  }) as MeshData;
  meshes.set(id, mesh);
  meshRevision.value++;
  return mesh;
}

export function getMesh(id: string): MeshData | undefined { return meshes.get(id); }

/** Every mesh an object uses (its own + its parts'). */
export function meshIdsOf(o: ProjectObject): string[] {
  return o.parts?.length ? [o.meshId, ...o.parts.map((p) => p.meshId)] : [o.meshId];
}

/** Meshes referenced by the current plate (for export/persistence). */
export function liveMeshes(): MeshData[] {
  const out = new Map<string, MeshData>();
  for (const o of objects.value) for (const id of meshIdsOf(o)) { const m = meshes.get(id); if (m) out.set(m.id, m); }
  return [...out.values()];
}

// ---- lookups --------------------------------------------------------------------

export function uid(prefix = 'o'): string {
  const c = globalThis.crypto as Crypto | undefined;
  const r = c?.randomUUID ? c.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${r}`;
}

export function getObject(id: string): ProjectObject | undefined {
  return objects.value.find((o) => o.id === id);
}

/** The objects with these ids (default: the selection), in project order. */
export function targets(ids?: string[]): ProjectObject[] {
  const set = new Set(ids ?? selectedIds.value);
  return objects.value.filter((o) => set.has(o.id));
}

export function uniqueName(base: string): string {
  const names = new Set(objects.value.map((o) => o.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\s\(\d+\)$/, '');
  for (let i = 2; ; i++) if (!names.has(`${stem} (${i})`)) return `${stem} (${i})`;
}

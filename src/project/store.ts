/**
 * Project store: the plates, their objects, meshes, selection and undo/redo.
 *
 * - `objects` is deeply reactive (small data: transforms, names, overrides).
 * - Meshes live in a plain Map of `markRaw` typed arrays, never proxied or
 *   JSON-serialised; `meshRevision` signals changes.
 * - Every mutation goes through `mutate()`, which records a snapshot operation
 *   on the shared (CubbyCAD) HistoryManager and calls `markSliceInputsChanged()`
 *   when slicing is affected.
 */
import { computed, markRaw, ref, shallowRef, toRaw, watch } from 'vue';
import { bedFromConfig, markSliceInputsChanged, resolvedConfig } from '../app/state';
import type { ConfigValue, FlatConfig, PaintLayer, PaintLayers, PaintMap, SliceObjectInput } from '../engine/types';
import { arrange, type ArrangeItem, type Rect } from './arrange';
import { mergeWorldInfo, partWorldInfo, worldInfo, type WorldInfo } from './geometry';
import { HistoryManager, type Operation } from '@cubby/shared/history';
import {
  composeTRS, decomposeTRS, mat4Determinant3, mat4Identity, mat4InvertAffine, mat4Multiply, quatFromAxisAngle, transformPoint, quatFromUnitVectors, quatMultiply, quatNormalize,
  type Quat, type Vec3,
} from './math';
import { computeBBox } from './mesh';
import { splitMesh } from './split';
import { MAX_PLATES, clonePlate, newPlate, plateBed, plateIndexAt, plateOffset, plateShift, type PlateMeta } from './plates';
import type { MeshData, ObjectIssue, ObjectPart, ParsedObject, PartType, ProjectObject, BrimPoint, EmbossMeta } from './types';
import { PART_TYPE_LABELS } from './types';
import { validatePlate } from './validate';
import { layerSliceFields } from '../layers/sliceFields';

/** Other areas plug their state into project files through this (see persistence/sections.ts). */
export { registerProjectSection, type ProjectSection } from './persistence/sections';

// ---- state ----------------------------------------------------------------

export const objects = ref<ProjectObject[]>([]);
export const selectedIds = ref<string[]>([]);
/** A part picked in the object list (its settings are edited instead of the object's). UI state, not undoable. */
export const selectedPart = ref<{ objectId: string; partId: string } | null>(null);
export const projectName = ref('Untitled project');
/** Bumps on any change that should be persisted (autosave watches this). */
export const projectRevision = ref(0);
/** Bumps when the mesh map changes. */
export const meshRevision = ref(0);

const meshes = new Map<string, MeshData>();

/** The printer's bed (plate 0's placement; other plates are offset copies — see plates.ts). */
export const bed = computed(() => bedFromConfig(resolvedConfig.value));

/** Plates (Orca PartPlateList). Part of the undo snapshot; at least one. */
export const plates = ref<PlateMeta[]>([newPlate()]);
/** The plate being sliced / previewed / receiving new objects. */
export const activePlate = ref(0);

export function plateBedOf(i: number) { return plateBed(bed.value, i, plates.value.length); }
export const activePlateBed = computed(() => plateBedOf(Math.min(activePlate.value, plates.value.length - 1)));

/**
 * Painted facets per mesh (Orca support / seam / color / fuzzy painting), keyed
 * by mesh id: instances share their paint like Orca's instances share volumes.
 * PaintMap arrays are immutable — replace, never mutate — so snapshots share them.
 */
export const meshPaint = shallowRef<Record<string, PaintLayers>>({});

interface Snapshot { objects: ProjectObject[]; plates: PlateMeta[]; paint: Record<string, PaintLayers> }

/**
 * Undo entry: the project before and after one `mutate()`. Snapshots are cheap
 * (objects are small; meshes and paint maps are shared by reference).
 * Coalescing keeps the first `before` and the newest `after`.
 */
class SnapshotOperation implements Operation<ProjectState> {
  readonly type = 'snapshot';
  readonly timestamp = Date.now();
  constructor(readonly description: string, readonly before: Snapshot, readonly after: Snapshot, readonly coalesceKey?: string) {}
  coalesceWith(prev: Operation<ProjectState>): Operation<ProjectState> | null {
    return prev instanceof SnapshotOperation ? new SnapshotOperation(prev.description, prev.before, this.after, this.coalesceKey) : null;
  }
  apply(): void { restore(this.after); }
  unapply(): void { restore(this.before); }
}
/** The live project is module state; operations restore into it directly. */
type ProjectState = Record<string, never>;
const history = new HistoryManager<ProjectState>({ maxHistorySize: 100 });
history.initialize({});
function* heldSnapshots(): Iterable<Snapshot> {
  for (const op of [...history.getUndoOperations(), ...history.getRedoOperations()]) {
    if (op instanceof SnapshotOperation) { yield op.before; yield op.after; }
  }
}
export const historyState = ref<{ undo: string | null; redo: string | null }>({ undo: null, redo: null });
/** Mesh bytes that may be kept alive only for undo. */
const HISTORY_MESH_BYTES = 512 * 1024 * 1024;


// ---- helpers ----------------------------------------------------------------

export function uid(prefix = 'o'): string {
  const c = globalThis.crypto as Crypto | undefined;
  const r = c?.randomUUID ? c.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${r}`;
}

function cloneOverrides(o: Record<string, ConfigValue>): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const [k, v] of Object.entries(toRaw(o))) out[k] = Array.isArray(v) ? [...v] : v;
  return out;
}

function clonePart(p: ObjectPart): ObjectPart {
  const r = toRaw(p);
  const out: ObjectPart = { ...r, position: [...r.position] as Vec3, rotation: [...r.rotation] as Quat, scale: [...r.scale] as Vec3, overrides: cloneOverrides(r.overrides) };
  if (r.emboss) out.emboss = { ...toRaw(r.emboss) }; // tools: text / SVG source
  return out;
}

function cloneObj(o: ProjectObject): ProjectObject {
  const r = toRaw(o);
  const out: ProjectObject = {
    ...r,
    position: [...r.position] as Vec3,
    rotation: [...r.rotation] as Quat,
    scale: [...r.scale] as Vec3,
    overrides: cloneOverrides(r.overrides),
  };
  if (r.parts?.length) out.parts = toRaw(r.parts).map(clonePart);
  else delete out.parts;
  if (r.layerHeightProfile?.length) out.layerHeightProfile = [...toRaw(r.layerHeightProfile)];
  else delete out.layerHeightProfile;
  if (r.layerRanges?.length) out.layerRanges = toRaw(r.layerRanges).map((l) => ({ ...toRaw(l), overrides: cloneOverrides(l.overrides) }));
  else delete out.layerRanges;
  // tools: text / SVG emboss source + brim ears
  if (r.emboss) out.emboss = { ...toRaw(r.emboss) }; else delete out.emboss;
  if (r.brimPoints?.length) out.brimPoints = toRaw(r.brimPoints).map((b) => ({ pos: [...toRaw(b).pos] as Vec3, radius: b.radius }));
  else delete out.brimPoints;
  return out;
}

/** Every mesh an object uses (its own + its parts'). */
function meshIdsOf(o: ProjectObject): string[] {
  return o.parts?.length ? [o.meshId, ...o.parts.map((p) => p.meshId)] : [o.meshId];
}

/**
 * Bounding box of an object in its own (unscaled, unrotated) frame: its mesh
 * plus its model parts (each part's mesh box corners through the part's TRS).
 * Multiply by |scale| for Orca's "Size" row.
 */
export function objectLocalBBox(o: ProjectObject): { min: Vec3; max: Vec3 } | null {
  const mesh = meshes.get(o.meshId);
  if (!mesh) return null;
  const min = [...mesh.bbox.min] as Vec3, max = [...mesh.bbox.max] as Vec3;
  for (const p of o.parts ?? []) {
    if (p.type !== 'part') continue;
    const pm = meshes.get(p.meshId);
    if (!pm) continue;
    const m = composeTRS(p.position, p.rotation, p.scale);
    for (let c = 0; c < 8; c++) {
      const q = transformPoint(m, [c & 1 ? pm.bbox.max[0] : pm.bbox.min[0], c & 2 ? pm.bbox.max[1] : pm.bbox.min[1], c & 4 ? pm.bbox.max[2] : pm.bbox.min[2]]);
      for (let k = 0; k < 3; k++) { if (q[k] < min[k]) min[k] = q[k]; if (q[k] > max[k]) max[k] = q[k]; }
    }
  }
  return { min, max };
}

/** World bbox + footprint of an object: its mesh plus its model parts (Orca's instance bbox excludes modifiers). */
function objectWorldInfo(o: ProjectObject): WorldInfo | null {
  const mesh = meshes.get(o.meshId);
  if (!mesh) return null;
  let info = worldInfo(o, mesh);
  for (const p of o.parts ?? []) {
    if (p.type !== 'part') continue;
    const pm = meshes.get(p.meshId);
    if (pm) info = mergeWorldInfo(info, partWorldInfo(o, p, pm));
  }
  return info;
}

function snapshot(): Snapshot {
  return { objects: objects.value.map(cloneObj), plates: plates.value.map((p) => clonePlate(toRaw(p))), paint: meshPaint.value };
}

function samePaint(a: Record<string, PaintLayers>, b: Record<string, PaintLayers>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (!y) return false;
    for (const l of ['support', 'seam', 'color', 'fuzzy'] as const) if (x[l] !== y[l]) return false;
  }
  return true;
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  // Paint maps are immutable: compare by reference (they can be large).
  return samePaint(a.paint, b.paint) && JSON.stringify([a.objects, a.plates]) === JSON.stringify([b.objects, b.plates]);
}

/** Paint of a mesh (empty when unpainted). */
export function getMeshPaint(meshId: string): PaintLayers { return meshPaint.value[meshId] ?? {}; }

/** Replace one paint layer of a mesh (null / empty clears it). Undoable. */
export function setMeshPaint(meshId: string, layer: PaintLayer, map: PaintMap | null, label = 'Paint'): void {
  mutate(label, () => { writeMeshPaint(meshId, layer, map); });
}

function writeMeshPaint(meshId: string, layer: PaintLayer, map: PaintMap | null): void {
  const cur = meshPaint.value[meshId] ?? {};
  const nextLayers: PaintLayers = { ...cur };
  if (map && map.length) nextLayers[layer] = map; else delete nextLayers[layer];
  const next = { ...meshPaint.value };
  if (Object.keys(nextLayers).length) next[meshId] = nextLayers; else delete next[meshId];
  meshPaint.value = next;
}

/** Clear a paint layer on every given mesh (e.g. "Erase all" / "Remove all supports painting"). */
export function clearMeshPaint(meshIds: string[], layer: PaintLayer, label = 'Erase painting'): void {
  mutate(label, () => { for (const id of meshIds) writeMeshPaint(id, layer, null); });
}

function refreshHistoryState(): void {
  historyState.value = { undo: history.getLastOperationDescription(), redo: history.getRedoDescription() };
}

/** Drop meshes nobody (current plate or history) references; trim history under memory pressure. */
function collectMeshes(): void {
  const live = new Set(objects.value.flatMap(meshIdsOf));
  for (;;) {
    const held = new Set<string>();
    for (const s of heldSnapshots()) for (const o of s.objects) for (const id of meshIdsOf(o)) held.add(id);
    let bytes = 0;
    for (const id of held) {
      if (live.has(id)) continue;
      const m = meshes.get(id);
      if (m) bytes += m.positions.byteLength + m.indices.byteLength;
    }
    if (bytes <= HISTORY_MESH_BYTES || !history.dropOldest()) {
      let changed = false;
      for (const id of [...meshes.keys()]) {
        if (!live.has(id) && !held.has(id)) { meshes.delete(id); changed = true; }
      }
      if (changed) meshRevision.value++;
      return;
    }
  }
}

function changed(slice: boolean): void {
  projectRevision.value++;
  if (slice) markSliceInputsChanged();
}

/**
 * Run `fn` as one undoable step. `mergeKey` coalesces rapid repeated edits
 * (e.g. typing in a setting, a drag) into one entry while they come less than
 * a second apart; `endGesture()` closes the entry early.
 */
export function mutate(label: string, fn: () => void, opts: { slice?: boolean; mergeKey?: string } = {}): void {
  const before = snapshot();
  fn();
  const after = snapshot();
  if (sameSnapshot(before, after)) return;
  history.recordOperation(new SnapshotOperation(label, before, after, opts.mergeKey));
  pruneSelection();
  collectMeshes();
  refreshHistoryState();
  changed(opts.slice ?? true);
}

function restore(s: Snapshot): void {
  objects.value = s.objects.map(cloneObj);
  meshPaint.value = s.paint ?? {};
  plates.value = s.plates.length ? s.plates.map(clonePlate) : [newPlate()];
  clampActivePlate();
  pruneSelection();
  // No collectMeshes() here: the history pops the operation before calling
  // apply/unapply, so its other snapshot's meshes would look unreferenced.
  // undo() / redo() collect once the operation is back on a stack.
  changed(true);
}

/** Gesture boundary (drag end, dialog close): the next edit starts a new undo entry. */
export function endGesture(): void { history.finalizeActiveTransform(); }

export function undo(): string | null {
  const label = history.getLastOperationDescription();
  if (!history.undo()) return null;
  collectMeshes();
  refreshHistoryState();
  return label;
}

export function redo(): string | null {
  const label = history.getRedoDescription();
  if (!history.redo()) return null;
  collectMeshes();
  refreshHistoryState();
  return label;
}

function clampActivePlate(): void {
  if (activePlate.value > plates.value.length - 1) activePlate.value = plates.value.length - 1;
  if (activePlate.value < 0) activePlate.value = 0;
}

function pruneSelection(): void {
  const ids = new Set(objects.value.map((o) => o.id));
  const next = selectedIds.value.filter((id) => ids.has(id));
  if (next.length !== selectedIds.value.length) selectedIds.value = next;
}

export function getObject(id: string): ProjectObject | undefined {
  return objects.value.find((o) => o.id === id);
}

export function getMesh(id: string): MeshData | undefined { return meshes.get(id); }

/** Meshes referenced by the current plate (for export/persistence). */
export function liveMeshes(): MeshData[] {
  const out = new Map<string, MeshData>();
  for (const o of objects.value) for (const id of meshIdsOf(o)) { const m = meshes.get(id); if (m) out.set(m.id, m); }
  return [...out.values()];
}

function targets(ids?: string[]): ProjectObject[] {
  const set = new Set(ids ?? selectedIds.value);
  return objects.value.filter((o) => set.has(o.id));
}

function uniqueName(base: string): string {
  const names = new Set(objects.value.map((o) => o.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\s\(\d+\)$/, '');
  for (let i = 2; ; i++) if (!names.has(`${stem} (${i})`)) return `${stem} (${i})`;
}

// ---- derived --------------------------------------------------------------

/** World bbox + XY hull per object id. */
export const objectInfo = computed(() => {
  void meshRevision.value;
  const m = new Map<string, WorldInfo>();
  for (const o of objects.value) {
    const info = objectWorldInfo(o);
    if (info) m.set(o.id, info);
  }
  return m;
});

function plateOfInfo(i: WorldInfo): number {
  return plateIndexAt((i.min[0] + i.max[0]) / 2, (i.min[1] + i.max[1]) / 2, plates.value.length, bed.value);
}

/** Plate index per object id (-1 = on no plate). */
export const objectPlate = computed(() => {
  const m = new Map<string, number>();
  for (const [id, info] of objectInfo.value) m.set(id, plateOfInfo(info));
  return m;
});

// A picked part only stays picked while its object is the single selection and the part exists.
watch([selectedIds, objects], () => {
  const sp = selectedPart.value;
  if (!sp) return;
  const o = selectedIds.value.length === 1 && selectedIds.value[0] === sp.objectId ? getObject(sp.objectId) : undefined;
  if (!o?.parts?.some((p) => p.id === sp.partId)) selectedPart.value = null;
}, { deep: false });

export function getPartOverrides(objId: string, partId: string): Readonly<Record<string, ConfigValue>> {
  return getObject(objId)?.parts?.find((p) => p.id === partId)?.overrides ?? EMPTY;
}

// Orca: selecting an object makes its plate the current one.
watch(() => selectedIds.value.at(-1), (id) => {
  const p = id ? objectPlate.value.get(id) : undefined;
  if (p !== undefined && p >= 0 && p !== activePlate.value) activePlate.value = p;
});

export function plateOf(id: string): number { return objectPlate.value.get(id) ?? -1; }
export function objectsOnPlate(i: number): ProjectObject[] { return objects.value.filter((o) => plateOf(o.id) === i); }

/** Plate problems per object id (only printable objects are checked, each against its own plate). */
export const objectIssues = computed(() => {
  const byPlate = new Map<number, Array<{ id: string; hull: WorldInfo['hull']; min: WorldInfo['min']; max: WorldInfo['max'] }>>();
  const out = new Map<string, ObjectIssue[]>();
  for (const o of objects.value) {
    if (!o.printable) continue;
    const info = objectInfo.value.get(o.id);
    if (!info) continue;
    const p = objectPlate.value.get(o.id) ?? -1;
    if (p < 0) { out.set(o.id, ['outside']); continue; }
    let l = byPlate.get(p);
    if (!l) byPlate.set(p, (l = []));
    l.push({ id: o.id, hull: info.hull, min: info.min, max: info.max });
  }
  for (const [p, items] of byPlate) for (const [id, issues] of validatePlate(items, plateBedOf(p))) out.set(id, issues);
  return out;
});

/** Printable objects on the active plate that are off it / too tall (blocking); overlaps are warnings. */
export const plateBlockingIssues = computed(() => {
  let n = 0;
  for (const [id, l] of objectIssues.value) {
    if (!l.some((i: ObjectIssue) => i !== 'overlap')) continue;
    const p = objectPlate.value.get(id) ?? -1;
    // Off-plate objects aren't sliced with any plate: they don't block it.
    if (p === activePlate.value) n++;
  }
  return n;
});

export const selectedObjects = computed(() => targets());
export const primarySelection = computed(() => {
  const id = selectedIds.value.at(-1);
  return id ? getObject(id) ?? null : null;
});

export const plateStats = computed(() => {
  void meshRevision.value;
  let tris = 0, n = 0;
  for (const o of objects.value) {
    if (objectPlate.value.get(o.id) !== activePlate.value) continue;
    n++;
    tris += meshes.get(o.meshId)?.triangleCount ?? 0;
  }
  return { objects: n, triangles: tris, total: objects.value.length };
});

// ---- selection ----------------------------------------------------------------

export function select(ids: string[], mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
  if (mode === 'replace') { selectedIds.value = [...new Set(ids)]; return; }
  const cur = new Set(selectedIds.value);
  for (const id of ids) {
    if (mode === 'toggle' && cur.has(id)) cur.delete(id); else cur.add(id);
  }
  selectedIds.value = [...cur];
}
export function selectAll(): void { selectedIds.value = objects.value.map((o) => o.id); }
export function clearSelection(): void { if (selectedIds.value.length) selectedIds.value = []; }
export function isSelected(id: string): boolean { return selectedIds.value.includes(id); }

// ---- placement helpers --------------------------------------------------------------

function infoOf(o: ProjectObject): WorldInfo | null { return objectWorldInfo(o); }

function dropObj(o: ProjectObject): void {
  const i = infoOf(o);
  if (i && Math.abs(i.min[2]) > 1e-6) o.position = [o.position[0], o.position[1], o.position[2] - i.min[2]];
}

function rectOf(o: ProjectObject): Rect | null {
  const i = infoOf(o);
  return i ? { minX: i.min[0], minY: i.min[1], maxX: i.max[0], maxY: i.max[1] } : null;
}

/** Arrange `movers` on plate `plate` around fixed `others`. Returns the ids that didn't fit. */
function arrangeInternal(movers: ProjectObject[], others: ProjectObject[], spacing: number, center: boolean,
  strategy: 'bottom-left' | 'nearest-center' = 'bottom-left', plate = activePlate.value): string[] {
  const items: ArrangeItem[] = [];
  for (const o of movers) { const r = rectOf(o); if (r) items.push({ id: o.id, ...r }); }
  const obstacles = others.map(rectOf).filter((r): r is Rect => !!r);
  const res = arrange(items, plateBedOf(plate), { spacing, obstacles, center, strategy });
  for (const o of movers) {
    const d = res.moves.get(o.id);
    if (d) o.position = [o.position[0] + d[0], o.position[1] + d[1], o.position[2]];
  }
  return res.unplaced;
}

function fitsWhereItIs(o: ProjectObject, others: ProjectObject[], plate = activePlate.value): boolean {
  const r = rectOf(o);
  if (!r) return true;
  const b = plateBedOf(plate);
  if (r.minX < b.min[0] || r.minY < b.min[1] || r.maxX > b.max[0] || r.maxY > b.max[1]) return false;
  return others.every((x) => {
    const q = rectOf(x);
    return !q || r.maxX <= q.minX || q.maxX <= r.minX || r.maxY <= q.minY || q.maxY <= r.minY;
  });
}

// ---- mesh + object creation ------------------------------------------------

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

export interface AddOptions { select?: boolean; label?: string }

/** Add parsed objects (from import). Returns new object ids. */
export function addParsedObjects(parsed: ParsedObject[], opts: AddOptions = {}): string[] {
  const ids: string[] = [];
  mutate(opts.label ?? (parsed.length === 1 ? `Add ${parsed[0].name}` : `Add ${parsed.length} objects`), () => {
    const plate = activePlate.value;
    const existing = objectsOnPlate(plate);
    const fresh: ProjectObject[] = [];
    const b = plateBedOf(plate);
    const [ox, oy] = plateOffset(plate, plates.value.length, bed.value);
    for (const p of parsed) {
      const mesh = addMesh(p.positions, p.indices);
      let position: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0];
      let rotation: Quat = [0, 0, 0, 1];
      let scale: Vec3 = [1, 1, 1];
      if (p.transform) {
        const d = decomposeTRS(p.transform);
        if (d.exact) {
          position = [d.position[0] + ox, d.position[1] + oy, d.position[2]]; rotation = d.rotation; scale = d.scale;
        } else {
          // Sheared placement: bake the linear part into the mesh.
          const m = p.transform, pos = mesh.positions;
          for (let i = 0; i < pos.length; i += 3) {
            const x = pos[i], y = pos[i + 1], z = pos[i + 2];
            pos[i] = m[0] * x + m[4] * y + m[8] * z;
            pos[i + 1] = m[1] * x + m[5] * y + m[9] * z;
            pos[i + 2] = m[2] * x + m[6] * y + m[10] * z;
          }
          mesh.bbox = computeBBox(pos);
          position = [m[12] + ox, m[13] + oy, m[14]];
        }
      }
      const o: ProjectObject = {
        id: uid(), name: uniqueName(p.name), meshId: mesh.id,
        position, rotation, scale, visible: true, printable: p.printable ?? true, overrides: {}, color: '',
      };
      objects.value.push(o);
      const live = objects.value[objects.value.length - 1];
      dropObj(live);
      fresh.push(live);
      ids.push(o.id);
    }
    // Keep file placements when they fit; otherwise find room for the new objects.
    const needs = fresh.some((o, i) => !fitsWhereItIs(o, [...existing, ...fresh.filter((_, j) => j !== i)]));
    if (needs) {
      if (existing.length === 0) arrangeInternal(fresh, existing, 6, true, 'bottom-left', plate);
      else arrangeInternal(fresh, existing, 6, false, 'nearest-center', plate);
    }
  });
  if (opts.select ?? true) selectedIds.value = ids;
  return ids;
}

export function removeObjects(ids = selectedIds.value.slice()): void {
  if (!ids.length) return;
  const set = new Set(ids);
  mutate(ids.length === 1 ? `Delete ${getObject(ids[0])?.name ?? 'object'}` : `Delete ${ids.length} objects`, () => {
    objects.value = objects.value.filter((o) => !set.has(o.id));
  });
}

/** Duplicate each target `count` times as instances (shared mesh). */
export function duplicateObjects(ids = selectedIds.value.slice(), count = 1): string[] {
  const src = targets(ids);
  if (!src.length || count < 1) return [];
  const created: string[] = [];
  mutate(count > 1 ? `Add ${count} instances` : 'Duplicate', () => {
    const p0 = plateOf(src[0].id);
    const plate = p0 >= 0 ? p0 : activePlate.value;
    const existing = objectsOnPlate(plate);
    const fresh: ProjectObject[] = [];
    for (const s of src) {
      for (let i = 0; i < count; i++) {
        const c = cloneObj(s);
        c.id = uid();
        c.name = uniqueName(s.name);
        objects.value.push(c);
        fresh.push(objects.value[objects.value.length - 1]);
        created.push(c.id);
      }
    }
    placeOnPlates(fresh, existing, plate);
  });
  selectedIds.value = created;
  return created;
}

/**
 * Put `fresh` objects on `plate` next to what's there; whatever doesn't fit
 * spills onto the following plates (created as needed, like Orca's arrange).
 */
function placeOnPlates(fresh: ProjectObject[], existing: ProjectObject[], plate: number): void {
  let pending = fresh;
  let p = plate;
  for (let guard = 0; pending.length && guard < MAX_PLATES; guard++) {
    // Move pending objects onto plate p first (arrange works in that plate's space).
    if (p !== plate) shiftToPlate(pending, p);
    const others = p === plate ? existing : objects.value.filter((o) => !pending.includes(o) && plateOfLive(o) === p);
    const unplaced = new Set(arrangeInternal(pending, others, 6, false, 'nearest-center', p));
    pending = pending.filter((o) => unplaced.has(o.id));
    if (!pending.length) break;
    p++;
    if (p >= plates.value.length) {
      if (plates.value.length >= MAX_PLATES) break;
      insertPlate(plates.value.length);
    }
  }
}

function plateOfLive(o: ProjectObject): number { const i = infoOf(o); return i ? plateOfInfo(i) : -1; }

/** Translate objects so their footprint centre lands in the middle of plate `p`. */
function shiftToPlate(objs: ProjectObject[], p: number): void {
  const b = plateBedOf(p);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  for (const o of objs) {
    const r = rectOf(o);
    if (!r) continue;
    o.position = [o.position[0] + cx - (r.minX + r.maxX) / 2, o.position[1] + cy - (r.minY + r.maxY) / 2, o.position[2]];
  }
}

/**
 * Re-layout: the plate grid changes shape with the plate count, so objects
 * follow their plate (`map[old] = new index`, -1 = plate deleted → its objects removed).
 */
function relayoutPlates(nOld: number, nNew: number, map: (old: number) => number): void {
  const b = bed.value;
  const keep: ProjectObject[] = [];
  for (const o of objects.value) {
    const i = infoOf(o);
    const from = i ? plateIndexAt((i.min[0] + i.max[0]) / 2, (i.min[1] + i.max[1]) / 2, nOld, b) : -1;
    if (from < 0) { keep.push(o); continue; }
    const to = map(from);
    if (to < 0) continue;
    const [dx, dy] = plateShift(b, from, nOld, to, nNew);
    if (dx || dy) o.position = [o.position[0] + dx, o.position[1] + dy, o.position[2]];
    keep.push(o);
  }
  if (keep.length !== objects.value.length) objects.value = keep;
}

function insertPlate(at: number): void {
  const n = plates.value.length;
  relayoutPlates(n, n + 1, (i) => (i >= at ? i + 1 : i));
  const next = plates.value.slice();
  next.splice(at, 0, newPlate());
  plates.value = next;
}

// ---- plates ---------------------------------------------------------------------

export function setActivePlate(i: number): void {
  if (i >= 0 && i < plates.value.length) activePlate.value = i;
}

/** Add an empty plate at the end (or after `after`); it becomes active. */
export function addPlate(after = plates.value.length - 1): number {
  if (plates.value.length >= MAX_PLATES) return -1;
  const at = Math.min(plates.value.length, after + 1);
  mutate('Add plate', () => insertPlate(at), { slice: false });
  activePlate.value = at;
  return at;
}

/** Delete plate `i` and the objects on it (Orca's plate delete). Keeps at least one plate. */
export function deletePlate(i = activePlate.value): void {
  const n = plates.value.length;
  if (n <= 1 || i < 0 || i >= n) return;
  mutate(`Delete ${plates.value[i].name || `plate ${i + 1}`}`, () => {
    relayoutPlates(n, n - 1, (p) => (p === i ? -1 : p > i ? p - 1 : p));
    plates.value = plates.value.filter((_, k) => k !== i);
  });
  if (activePlate.value > i) activePlate.value--;
  clampActivePlate();
}

export function renamePlate(i: number, name: string): void {
  mutate('Rename plate', () => { const p = plates.value[i]; if (p) p.name = name.trim().slice(0, 80); }, { slice: false });
}

export function setPlateLocked(i: number, locked: boolean): void {
  mutate(locked ? 'Lock plate' : 'Unlock plate', () => { const p = plates.value[i]; if (p) p.locked = locked; }, { slice: false });
}

/** Move objects to plate `i`, keeping their place on the plate when it's free, else arranging them there. */
export function moveObjectsToPlate(ids: string[], i: number): void {
  const ts = targets(ids);
  if (!ts.length || i < 0 || i >= plates.value.length) return;
  mutate(`Move to plate ${i + 1}`, () => {
    const b = bed.value, n = plates.value.length;
    for (const o of ts) {
      const from = plateOfLive(o);
      if (from === i) continue;
      if (from >= 0) {
        const [dx, dy] = plateShift(b, from, n, i, n);
        o.position = [o.position[0] + dx, o.position[1] + dy, o.position[2]];
      } else shiftToPlate([o], i);
    }
    const others = objects.value.filter((o) => !ts.includes(o) && plateOfLive(o) === i);
    const clash = ts.filter((o, k) => !fitsWhereItIs(o, [...others, ...ts.filter((_, j) => j !== k)], i));
    if (clash.length) placeOnPlates(clash, [...others, ...ts.filter((o) => !clash.includes(o))], i);
  });
  activePlate.value = i;
}

/** Instances of an object: every object sharing its mesh (Orca's instances of one ModelObject). */
export function instancesOf(id: string): ProjectObject[] {
  const o = getObject(id);
  return o ? objects.value.filter((x) => x.meshId === o.meshId) : [];
}

/**
 * Orca "Set number of instances": make each target's instance group exactly
 * `count` strong — new instances are placed next to the others on the same
 * plate (spilling to the next plates when full); surplus ones are removed
 * newest-first, never the object itself.
 */
export function setInstanceCount(ids: string[], count: number | ((current: number) => number)): void {
  const clampN = (c: number) => Math.max(1, Math.min(500, Math.round(c)));
  const seen = new Set<string>();
  const groups: Array<{ src: ProjectObject; members: ProjectObject[] }> = [];
  for (const o of targets(ids)) {
    if (seen.has(o.meshId)) continue;
    seen.add(o.meshId);
    groups.push({ src: o, members: objects.value.filter((x) => x.meshId === o.meshId) });
  }
  const want = groups.map((g) => clampN(typeof count === 'function' ? count(g.members.length) : count));
  if (!groups.length || groups.every((g, i) => g.members.length === want[i])) return;
  const created: string[] = [];
  const label = typeof count === 'number' ? `Set ${want[0]} instance${want[0] === 1 ? '' : 's'}` : 'Change instances';
  mutate(label, () => {
    groups.forEach(({ src, members }, gi) => {
      const n = want[gi];
      if (members.length > n) {
        const drop = new Set(members.filter((m) => m.id !== src.id).slice(-(members.length - n)).map((m) => m.id));
        objects.value = objects.value.filter((o) => !drop.has(o.id));
      } else if (members.length < n) {
        const live = getObject(src.id)!;
        const p0 = plateOfLive(live);
        const plate = p0 >= 0 ? p0 : activePlate.value;
        const existing = objects.value.filter((o) => plateOfLive(o) === plate);
        const fresh: ProjectObject[] = [];
        for (let i = members.length; i < n; i++) {
          const c = cloneObj(live);
          c.id = uid();
          c.name = uniqueName(live.name);
          objects.value.push(c);
          fresh.push(objects.value[objects.value.length - 1]);
          created.push(c.id);
        }
        placeOnPlates(fresh, existing, plate);
      }
    });
  });
  if (created.length) selectedIds.value = [...new Set([...selectedIds.value.filter((id) => getObject(id)), ...created])];
}

/** Orca "-": remove the newest other instance of each target's group. */
export function removeInstance(ids = selectedIds.value.slice()): void {
  setInstanceCount(ids, (c) => c - 1);
}

/**
 * Orca "Split to objects": each connected piece of a target's mesh becomes an
 * object of its own, in place (same rotation / scale / settings). Returns the
 * number of objects created; 0 when nothing could be split.
 */
export function splitToObjects(ids = selectedIds.value.slice()): number {
  const work: Array<{ o: ProjectObject; pieces: ReturnType<typeof splitMesh> }> = [];
  for (const o of targets(ids)) {
    const mesh = meshes.get(o.meshId);
    if (!mesh) continue;
    const pieces = splitMesh(mesh.positions, mesh.indices);
    if (pieces.length > 1) work.push({ o, pieces });
  }
  if (!work.length) return 0;
  const created: string[] = [];
  mutate('Split to objects', () => {
    for (const { o, pieces } of work) {
      const src = cloneObj(o);
      const m = composeTRS(src.position, src.rotation, src.scale);
      const at = objects.value.findIndex((x) => x.id === o.id);
      const fresh: ProjectObject[] = pieces.map((pc, k) => {
        const mesh = addMesh(pc.positions, pc.indices);
        const c = cloneObj(src);
        c.id = uid();
        c.meshId = mesh.id;
        c.name = `${src.name}_${k + 1}`;
        // The piece was re-centred on its bbox centre: move the origin there.
        c.position = transformPoint(m, pc.center);
        return c;
      });
      objects.value.splice(at, 1, ...fresh);
      for (const c of fresh) created.push(c.id);
    }
  });
  selectedIds.value = created;
  return created.length;
}

/** One volume of a cut piece: world-space mesh (bed mm) + its paint. */
export interface PieceVolume { name: string; type: PartType; positions: Float32Array; indices: Uint32Array; paint?: PaintLayers }
/** One object produced by the cut tool; `assembled` maps its world placement to the assembled pose (column-major). */
export interface ObjectPiece { name: string; volumes: PieceVolume[]; assembled?: number[] }

/**
 * Replace an object with the pieces of an engine cut (Orca GLGizmoCut3D →
 * Plater::cut): each piece becomes an object whose first model part is its
 * mesh (origin at its bottom centre) and whose other volumes (connectors,
 * modifiers, …) are parts. Paint and part settings are kept; variable layer
 * height, height ranges and brim ears don't survive a cut (as in Orca).
 * Returns the new object ids.
 */
export function replaceWithPieces(objectId: string, pieces: ObjectPiece[], label = 'Cut'): string[] {
  const src = getObject(objectId);
  if (!src) return [];
  const plate = Math.max(0, plateOf(objectId));
  const created: string[] = [];
  mutate(label, () => {
    const base = cloneObj(src);
    const partOverrides = new Map((base.parts ?? []).map((p) => [p.name, p.overrides]));
    const fresh: ProjectObject[] = [];
    pieces.forEach((pc, k) => {
      const solids = pc.volumes.filter((v) => v.type === 'part' && v.indices.length);
      if (!solids.length) return;
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const v of solids) {
        const q = v.positions;
        for (let i = 0; i < q.length; i += 3) {
          if (q[i] < minX) minX = q[i]; if (q[i] > maxX) maxX = q[i];
          if (q[i + 1] < minY) minY = q[i + 1]; if (q[i + 1] > maxY) maxY = q[i + 1];
          if (q[i + 2] < minZ) minZ = q[i + 2];
        }
      }
      const origin: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, minZ];
      const local = (v: PieceVolume): MeshData => {
        const q = new Float32Array(v.positions.length);
        for (let i = 0; i < q.length; i += 3) { q[i] = v.positions[i] - origin[0]; q[i + 1] = v.positions[i + 1] - origin[1]; q[i + 2] = v.positions[i + 2] - origin[2]; }
        const m = addMesh(q, v.indices);
        for (const [layer, map] of Object.entries(v.paint ?? {}) as Array<[PaintLayer, PaintMap]>) writeMeshPaint(m.id, layer, map);
        return m;
      };
      const main = solids[0];
      const o: ProjectObject = {
        ...base,
        id: uid(), name: pieces.length > 1 ? (pc.name && pc.name !== src.name ? pc.name : `${src.name}_${k + 1}`) : src.name,
        meshId: local(main).id, position: origin, rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        parts: pc.volumes.filter((v) => v !== main && v.indices.length).map((v): ObjectPart => ({
          id: uid('p'), name: v.name || PART_TYPE_LABELS[v.type], meshId: local(v).id, type: v.type,
          position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], overrides: { ...(partOverrides.get(v.name) ?? {}) },
        })),
      };
      delete o.layerHeightProfile; delete o.layerRanges; delete o.brimPoints; delete o.emboss; delete o.assembly;
      if (!o.parts?.length) delete o.parts;
      // Where the piece sits in the assembled model: (world → assembled) · translate(origin),
      // composed with the source's own assembly pose if it had one.
      {
        let a = mat4Multiply(pc.assembled ?? mat4Identity(), composeTRS(origin, [0, 0, 0, 1], [1, 1, 1]));
        if (src.assembly) {
          const toAsm = mat4Multiply(composeTRS(src.assembly.position, src.assembly.rotation, src.assembly.scale),
            mat4InvertAffine(composeTRS(src.position, src.rotation, src.scale)));
          a = mat4Multiply(toAsm, a);
        }
        const d = decomposeTRS(a);
        o.assembly = { position: d.position, rotation: d.rotation, scale: d.scale };
      }
      fresh.push(o);
    });
    if (!fresh.length) return;
    const at = objects.value.findIndex((x) => x.id === objectId);
    objects.value.splice(at, 1, ...fresh);
    const live = objects.value.filter((x) => fresh.some((f) => f.id === x.id));
    for (const o of live) dropObj(o);
    const others = objectsOnPlate(plate).filter((x) => !live.includes(x));
    if (live.some((o, i) => !fitsWhereItIs(o, [...others, ...live.filter((_, j) => j !== i)], plate))) {
      arrangeInternal(live, others, 6, false, 'nearest-center', plate);
    }
    for (const o of live) created.push(o.id);
  });
  if (created.length) selectedIds.value = created;
  return created;
}

/**
 * Orca "Split to parts": the object keeps one piece as its own mesh and the
 * other connected pieces become parts of it (one object, several volumes).
 * Returns the number of parts created.
 */
export function splitToParts(ids = selectedIds.value.slice()): number {
  const work: Array<{ o: ProjectObject; pieces: ReturnType<typeof splitMesh> }> = [];
  for (const o of targets(ids)) {
    const mesh = meshes.get(o.meshId);
    if (!mesh) continue;
    const pieces = splitMesh(mesh.positions, mesh.indices);
    if (pieces.length > 1) work.push({ o, pieces });
  }
  if (!work.length) return 0;
  let created = 0;
  mutate('Split to parts', () => {
    for (const { o, pieces } of work) {
      const live = getObject(o.id)!;
      const m = composeTRS([...live.position] as Vec3, [...live.rotation] as Quat, [...live.scale] as Vec3);
      const c0 = pieces[0].center;
      // Existing parts keep their world placement: shift them by the new origin.
      const oldParts = (live.parts ?? []).map((p) => ({ ...clonePart(p), position: [p.position[0] - c0[0], p.position[1] - c0[1], p.position[2] - c0[2]] as Vec3 }));
      const base = addMesh(pieces[0].positions, pieces[0].indices);
      live.meshId = base.id;
      live.position = transformPoint(m, c0);
      const newParts: ObjectPart[] = pieces.slice(1).map((pc, k) => ({
        id: uid('p'), name: `${live.name}_${k + 2}`, meshId: addMesh(pc.positions, pc.indices).id, type: 'part' as PartType,
        position: [pc.center[0] - c0[0], pc.center[1] - c0[1], pc.center[2] - c0[2]] as Vec3, rotation: [0, 0, 0, 1] as Quat, scale: [1, 1, 1] as Vec3,
        overrides: {},
      }));
      live.parts = [...oldParts, ...newParts];
      created += newParts.length;
    }
  });
  return created;
}

function findPart(objId: string, partId: string): { o: ProjectObject; p: ObjectPart } | null {
  const o = getObject(objId);
  const p = o?.parts?.find((x) => x.id === partId);
  return o && p ? { o, p } : null;
}

export function removePart(objId: string, partId: string): void {
  mutate('Delete part', () => {
    const o = getObject(objId);
    if (!o?.parts) return;
    o.parts = o.parts.filter((p) => p.id !== partId);
    if (!o.parts.length) delete o.parts;
    dropObj(o);
  });
}

/** Move / rotate / scale one part (object-local frame). The object stays on the bed. */
export function setPartTransform(objId: string, partId: string, t: { position?: Vec3; rotation?: Quat; scale?: Vec3 }, label = 'Move part'): void {
  mutate(label, () => {
    const f = findPart(objId, partId);
    if (!f) return;
    if (t.position) f.p.position = [...t.position] as Vec3;
    if (t.rotation) f.p.rotation = quatNormalize(t.rotation);
    if (t.scale) f.p.scale = t.scale.map((v) => (Math.abs(v) < 1e-4 ? Math.sign(v || 1) * 1e-4 : v)) as Vec3;
    if (f.p.type === 'part') dropObj(f.o);
  });
}

export function setPartType(objId: string, partId: string, type: PartType): void {
  mutate('Change part type', () => { const f = findPart(objId, partId); if (f) { f.p.type = type; dropObj(f.o); } });
}

export function renamePart(objId: string, partId: string, name: string): void {
  const n = name.trim();
  if (!n) return;
  mutate('Rename part', () => { const f = findPart(objId, partId); if (f) f.p.name = n.slice(0, 200); }, { slice: false });
}

export function setPartOverride(objId: string, partId: string, key: string, value: ConfigValue | undefined): void {
  mutate(value === undefined ? 'Reset part setting' : 'Change part setting', () => {
    const f = findPart(objId, partId);
    if (!f) return;
    if (value === undefined) delete f.p.overrides[key];
    else f.p.overrides[key] = Array.isArray(value) ? [...value] : value;
  }, { mergeKey: `povr:${partId}:${key}` });
}

/**
 * Orca "Add part / modifier / negative part / support blocker / enforcer":
 * `positions`/`indices` are mesh-local (centred); the part is placed at
 * `localPos` in the object's frame (default: the object's origin).
 */
export function addPart(objId: string, type: PartType, name: string, positions: Float32Array, indices: Uint32Array, localPos: Vec3 = [0, 0, 0]): string | null {
  const o = getObject(objId);
  if (!o) return null;
  const id = uid('p');
  mutate(`Add ${type === 'part' ? 'part' : type.replace('_', ' ')}`, () => {
    const live = getObject(objId)!;
    const mesh = addMesh(positions, indices);
    const part: ObjectPart = { id, name, meshId: mesh.id, type, position: [...localPos] as Vec3, rotation: [0, 0, 0, 1], scale: [1, 1, 1], overrides: {} };
    live.parts = [...(live.parts ?? []), part];
    if (type === 'part') dropObj(live);
  });
  return id;
}

/** In-app clipboard payload: object snapshots plus the meshes they use (kept alive while on the clipboard). */
export interface ObjectClipboard { objects: ProjectObject[]; meshes: MeshData[] }

export function copyObjects(ids = selectedIds.value.slice()): ObjectClipboard | null {
  const src = targets(ids);
  if (!src.length) return null;
  const ms = new Map<string, MeshData>();
  for (const o of src) for (const id of meshIdsOf(o)) { const m = meshes.get(id); if (m) ms.set(m.id, m); }
  return { objects: src.filter((o) => ms.has(o.meshId)).map(cloneObj), meshes: [...ms.values()] };
}

/** Paste clipboard objects as new instances placed near the plate centre. Returns the new ids. */
export function pasteObjects(clip: ObjectClipboard): string[] {
  if (!clip.objects.length) return [];
  const created: string[] = [];
  mutate(clip.objects.length === 1 ? `Paste ${clip.objects[0].name}` : `Paste ${clip.objects.length} objects`, () => {
    for (const m of clip.meshes) if (!meshes.has(m.id)) { meshes.set(m.id, m); meshRevision.value++; }
    const plate = activePlate.value;
    const existing = objectsOnPlate(plate);
    const fresh: ProjectObject[] = [];
    for (const s of clip.objects) {
      const c = cloneObj(s);
      c.id = uid();
      c.name = uniqueName(s.name);
      objects.value.push(c);
      fresh.push(objects.value[objects.value.length - 1]);
      created.push(c.id);
    }
    shiftToPlate(fresh.filter((o) => plateOfLive(o) !== plate), plate);
    placeOnPlates(fresh, existing, plate);
  });
  selectedIds.value = created;
  return created;
}

/** Move objects by a bed-space delta (arrow-key nudges coalesce into one undo step). */
export function translateObjects(delta: Vec3, ids = selectedIds.value.slice()): void {
  mutate('Move', () => {
    for (const o of targets(ids)) o.position = [o.position[0] + delta[0], o.position[1] + delta[1], o.position[2] + delta[2]];
  }, { mergeKey: `nudge:${ids.join(',')}` });
}

/** Remove every object on plate `i` (default: the active plate). */
export function clearPlate(i = activePlate.value): void {
  mutate('Clear plate', () => { objects.value = objects.value.filter((o) => plateOfLive(o) !== i); });
}

/** Remove every object on every plate (Orca "Delete all", Ctrl+D). Plates stay. */
export function clearAll(): void {
  mutate('Delete all', () => { objects.value = []; });
}

// ---- edits ----------------------------------------------------------------

export function renameObject(id: string, name: string): void {
  const n = name.trim();
  if (!n) return;
  mutate('Rename', () => { const o = getObject(id); if (o) o.name = n; }, { slice: false });
}

export function setVisible(ids: string[], visible: boolean): void {
  mutate(visible ? 'Show' : 'Hide', () => { for (const o of targets(ids)) o.visible = visible; }, { slice: false });
}

export function setPrintable(ids: string[], printable: boolean): void {
  mutate(printable ? 'Mark printable' : 'Mark not printable', () => { for (const o of targets(ids)) o.printable = printable; });
}

export function setColor(ids: string[], color: string): void {
  mutate('Change colour', () => { for (const o of targets(ids)) o.color = color; }, { slice: false });
}

export interface TransformPatch { id: string; position?: Vec3; rotation?: Quat; scale?: Vec3 }

/**
 * Apply transforms (gizmo drag end, numeric panel). Rotation/scale changes
 * keep the object on the bed; pure moves keep Z as given.
 */
export function setTransforms(patches: TransformPatch[], label = 'Move', opts: { drop?: boolean; mergeKey?: string } = {}): void {
  mutate(label, () => {
    for (const p of patches) {
      const o = getObject(p.id);
      if (!o) continue;
      const rs = !!(p.rotation || p.scale);
      if (p.position) o.position = [...p.position] as Vec3;
      if (p.rotation) o.rotation = quatNormalize(p.rotation);
      if (p.scale) o.scale = p.scale.map((s) => (Math.abs(s) < 1e-4 ? Math.sign(s || 1) * 1e-4 : s)) as Vec3;
      if (opts.drop ?? rs) dropObj(o);
    }
  }, { mergeKey: opts.mergeKey });
}

export function dropToBed(ids = selectedIds.value.slice()): void {
  mutate('Drop to bed', () => { for (const o of targets(ids)) dropObj(o); });
}

/** Centre the selection (as a group) on the bed. */
export function centerObjects(ids = selectedIds.value.slice()): void {
  const ts = targets(ids);
  if (!ts.length) return;
  mutate('Center', () => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of ts) {
      const r = rectOf(o);
      if (!r) continue;
      minX = Math.min(minX, r.minX); minY = Math.min(minY, r.minY);
      maxX = Math.max(maxX, r.maxX); maxY = Math.max(maxY, r.maxY);
    }
    if (!Number.isFinite(minX)) return;
    const p0 = plateOfLive(ts[0]);
    const b = plateBedOf(p0 >= 0 ? p0 : activePlate.value);
    const dx = (b.min[0] + b.max[0]) / 2 - (minX + maxX) / 2;
    const dy = (b.min[1] + b.max[1]) / 2 - (minY + maxY) / 2;
    for (const o of ts) o.position = [o.position[0] + dx, o.position[1] + dy, o.position[2]];
  });
}

/** Mirror along a world axis, in place. */
export function mirrorObjects(axis: 0 | 1 | 2, ids = selectedIds.value.slice()): void {
  mutate(`Mirror ${'XYZ'[axis]}`, () => {
    for (const o of targets(ids)) {
      // F·R·S = (F·R·F)·(F·S): conjugated rotation + negated scale component.
      const q = o.rotation;
      const nq: Quat = axis === 0 ? [q[0], -q[1], -q[2], q[3]] : axis === 1 ? [-q[0], q[1], -q[2], q[3]] : [-q[0], -q[1], q[2], q[3]];
      const s = [...o.scale] as Vec3;
      s[axis] = -s[axis];
      o.rotation = nq;
      o.scale = s;
      dropObj(o);
    }
  });
}

/** Rotate about a world axis by `deg` degrees (about each object's origin). */
export function rotateObjects(axis: Vec3, deg: number, ids = selectedIds.value.slice()): void {
  const dq = quatFromAxisAngle(axis, (deg * Math.PI) / 180);
  mutate('Rotate', () => {
    for (const o of targets(ids)) { o.rotation = quatNormalize(quatMultiply(dq, o.rotation)); dropObj(o); }
  });
}

/** Rotate so the face with world-space normal `n` faces the bed. */
export function layOnFace(id: string, n: Vec3): void {
  const l = Math.hypot(n[0], n[1], n[2]);
  if (!(l > 0)) return;
  const dq = quatFromUnitVectors([n[0] / l, n[1] / l, n[2] / l], [0, 0, -1]);
  mutate('Lay on face', () => {
    const o = getObject(id);
    if (!o) return;
    o.rotation = quatNormalize(quatMultiply(dq, o.rotation));
    dropObj(o);
  });
}

/** Uniformly scale each target to the largest size fitting the build volume, then centre it. */
export function scaleToFit(ids = selectedIds.value.slice()): void {
  mutate('Scale to fit', () => {
    for (const o of targets(ids)) {
      const i = infoOf(o);
      if (!i) continue;
      const p = plateOfInfo(i);
      const b = plateBedOf(p >= 0 ? p : activePlate.value);
      const sx = i.max[0] - i.min[0], sy = i.max[1] - i.min[1], sz = i.max[2] - i.min[2];
      let f = Math.min(((b.max[0] - b.min[0]) * 0.98) / (sx || 1), ((b.max[1] - b.min[1]) * 0.98) / (sy || 1));
      if (b.maxHeight > 0) f = Math.min(f, (b.maxHeight * 0.98) / (sz || 1));
      if (!Number.isFinite(f) || f <= 0) continue;
      o.scale = o.scale.map((s) => s * f) as Vec3;
      dropObj(o);
      const j = infoOf(o)!;
      o.position = [
        o.position[0] + (b.min[0] + b.max[0]) / 2 - (j.min[0] + j.max[0]) / 2,
        o.position[1] + (b.min[1] + b.max[1]) / 2 - (j.min[1] + j.max[1]) / 2,
        o.position[2],
      ];
    }
  });
}

/**
 * Auto-arrange (Orca A / Shift+A).
 *  - ids: those objects, on the active plate, around the rest of that plate.
 *  - scope 'plate': everything on the active plate.
 *  - scope 'all' (default): every unlocked plate; off-plate objects join the
 *    active plate, and what doesn't fit spills onto following / new plates.
 * Returns the number of objects that could not be placed.
 */
export function arrangeObjects(ids?: string[], spacing = 6, scope: 'all' | 'plate' = 'all'): number {
  let unplaced: string[] = [];
  mutate('Arrange', () => {
    const active = activePlate.value;
    if (ids) {
      const set = new Set(ids);
      const movers = objects.value.filter((o) => set.has(o.id));
      for (const o of movers) dropObj(o);
      shiftToPlate(movers.filter((o) => plateOfLive(o) !== active), active);
      const others = objects.value.filter((o) => !set.has(o.id) && plateOfLive(o) === active);
      unplaced = arrangeInternal(movers, others, spacing, false, 'bottom-left', active);
      return;
    }
    const groups = new Map<number, ProjectObject[]>();
    for (const o of objects.value) {
      dropObj(o);
      let p = plateOfLive(o);
      if (p < 0) { p = active; shiftToPlate([o], p); }
      if (plates.value[p]?.locked) continue;
      if (scope === 'plate' && p !== active) continue;
      let g = groups.get(p);
      if (!g) groups.set(p, (g = []));
      g.push(o);
    }
    let carry: ProjectObject[] = [];
    const last = Math.max(plates.value.length - 1, ...groups.keys());
    for (let p = 0; p <= last || carry.length; p++) {
      if (p >= MAX_PLATES) break;
      if (p >= plates.value.length) {
        if (scope === 'plate') break;
        insertPlate(plates.value.length);
      }
      if (plates.value[p].locked) continue;
      if (scope === 'plate' && p !== active && !carry.length) continue;
      const movers = [...(groups.get(p) ?? []), ...carry];
      if (!movers.length) continue;
      if (carry.length) shiftToPlate(carry, p);
      const left = new Set(arrangeInternal(movers, [], spacing, true, 'bottom-left', p));
      carry = movers.filter((o) => left.has(o.id));
      if (scope === 'plate' && carry.length) { unplaced = carry.map((o) => o.id); carry = []; break; }
    }
    unplaced = [...unplaced, ...carry.map((o) => o.id)];
  });
  return unplaced.length;
}

// ---- per-object overrides -------------------------------------------------------

const EMPTY: Readonly<Record<string, ConfigValue>> = Object.freeze({});

/** Reactive override record for an object (read-only view; use setObjectOverride to change). */
export function getObjectOverrides(id: string): Readonly<Record<string, ConfigValue>> {
  return getObject(id)?.overrides ?? EMPTY;
}

/** Set (or clear with `undefined`) one per-object override. Undoable; rapid edits coalesce. */
export function setObjectOverride(id: string, key: string, value: ConfigValue | undefined): void {
  mutate(value === undefined ? 'Reset object setting' : 'Change object setting', () => {
    const o = getObject(id);
    if (!o) return;
    if (value === undefined) delete o.overrides[key];
    else o.overrides[key] = Array.isArray(value) ? [...value] : value;
  }, { mergeKey: `ovr:${id}:${key}` });
}

/** Replace all overrides of an object at once. */
export function setObjectOverrides(id: string, values: Record<string, ConfigValue>): void {
  mutate('Change object settings', () => {
    const o = getObject(id);
    if (o) o.overrides = { ...values };
  });
}

export function overrideCount(id: string): number {
  return Object.keys(getObject(id)?.overrides ?? {}).length;
}

// ---- slicing -----------------------------------------------------------------

/**
 * Printable objects as engine inputs. Mesh arrays are shared (not copied)
 * unless the transform mirrors (det < 0), in which case a winding-flipped
 * index copy is produced so facets stay outward-facing.
 */
export function getSliceObjects(plate = activePlate.value): SliceObjectInput[] {
  const out: SliceObjectInput[] = [];
  const [ox, oy] = plateOffset(plate, plates.value.length, bed.value);
  for (const o of objects.value) {
    if (!o.printable) continue;
    const mesh = meshes.get(o.meshId);
    if (!mesh) continue;
    const info = objectWorldInfo(o)!;
    if (plateOfInfo(info) !== plate) continue;
    // Engine coordinates are the printer's bed: remove the plate's grid offset.
    const pos: Vec3 = [o.position[0] - ox, o.position[1] - oy, o.position[2] - info.min[2]];
    const transform = composeTRS(pos, [...o.rotation] as Quat, [...o.scale] as Vec3);
    const cfgOf = (ov: Record<string, ConfigValue>): FlatConfig | undefined => {
      const raw = toRaw(ov);
      return Object.keys(raw).length ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])) : undefined;
    };
    const parts = (o.parts ?? []).flatMap((p) => {
      const pm = meshes.get(p.meshId);
      if (!pm) return [];
      const pt = mat4Multiply(transform, composeTRS([...p.position] as Vec3, [...p.rotation] as Quat, [...p.scale] as Vec3));
      const pp = paintFor(p.meshId);
      return [{ id: p.id, name: p.name, type: p.type, positions: pm.positions, indices: windingFor(pm.indices, pt), transform: pt, config: cfgOf(p.overrides), ...(pp ? { paint: pp } : {}) }];
    });
    out.push({
      id: o.id, name: o.name, positions: mesh.positions, indices: windingFor(mesh.indices, transform), transform, config: cfgOf(o.overrides),
      ...(parts.length ? { parts } : {}),
      ...(paintFor(o.meshId) ? { paint: paintFor(o.meshId) } : {}),
      ...layerSliceFields(toRaw(o), info.max[2] - info.min[2], resolvedConfig.value),
      ...(o.brimPoints?.length ? { brimPoints: toRaw(o.brimPoints).map((b) => ({ pos: [...toRaw(b).pos] as [number, number, number], radius: b.radius })) } : {}),
    });
  }
  return out;
}

// Paint layer objects are immutable: a per-object counter tells slices apart cheaply.
const paintIds = new WeakMap<object, number>();
let paintSeq = 0;
function paintVersion(o: ProjectObject): string {
  return meshIdsOf(o).map((id) => {
    const p = meshPaint.value[id];
    if (!p) return 0;
    let v = paintIds.get(p);
    if (v === undefined) { v = ++paintSeq; paintIds.set(p, v); }
    return v;
  }).join('.');
}

/** Paint layers of a mesh for the engine (undefined when unpainted). */
function paintFor(meshId: string): PaintLayers | undefined {
  const p = meshPaint.value[meshId];
  return p && Object.keys(p).length ? p : undefined;
}

/** Indices as given, or a winding-flipped copy when the transform mirrors (facets stay outward-facing). */
function windingFor(src: Uint32Array, transform: number[]): Uint32Array {
  if (mat4Determinant3(transform) >= 0) return src;
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i += 3) { out[i] = src[i]; out[i + 1] = src[i + 2]; out[i + 2] = src[i + 1]; }
  return out;
}

/**
 * What a plate's slice depends on besides the config: its printable objects
 * (plate-relative placement, mesh, overrides). A plate's result is stale when
 * this or the config changed since it was sliced.
 */
export function plateSliceSignature(plate: number): string {
  void meshRevision.value;
  const [ox, oy] = plateOffset(plate, plates.value.length, bed.value);
  const parts: string[] = [];
  for (const o of objects.value) {
    if (!o.printable || objectPlate.value.get(o.id) !== plate) continue;
    const r = toRaw(o);
    parts.push(JSON.stringify([r.id, r.meshId, paintVersion(r), r.position[0] - ox, r.position[1] - oy, r.position[2], r.rotation, r.scale, toRaw(r.overrides), toRaw(r.parts ?? []),
      toRaw(o.layerHeightProfile ?? null), toRaw(o.layerRanges ?? null), toRaw(o.brimPoints ?? null)]));
  }
  // Plate settings + slider custom G-codes (Orca PartPlate config / CustomGCode::Info).
  const pm = plates.value[plate];
  if (pm?.config || pm?.customGcodes) parts.push(JSON.stringify([toRaw(pm.config ?? null), toRaw(pm.customGcodes ?? null)]));
  return parts.join('|');
}

// ---- whole-project load/reset (used by persistence) -----------------------------

export interface ProjectData {
  name: string;
  objects: ProjectObject[];
  meshes: MeshData[];
  plates?: PlateMeta[];
  paint?: Record<string, PaintLayers>;
}

/** Bumped whenever a whole project is loaded (new / open / import as project). */
export const projectLoads = ref(0);

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
  projectName.value = data.name || 'Untitled project';
  selectedIds.value = [];
  history.clear();
  refreshHistoryState();
  meshRevision.value++;
  changed(true);
}

export function resetProject(): void {
  loadProjectData({ name: 'Untitled project', objects: [], meshes: [] });
}

export function serializeObjects(): ProjectObject[] { return snapshot().objects; }
/** Paint of the live meshes (for project files / autosave). */
export function serializePaint(): Record<string, PaintLayers> {
  const live = new Set(objects.value.flatMap(meshIdsOf));
  const out: Record<string, PaintLayers> = {};
  for (const [id, layers] of Object.entries(meshPaint.value)) if (live.has(id)) out[id] = layers;
  return out;
}

export function serializePlates(): PlateMeta[] { return plates.value.map((p) => clonePlate(toRaw(p))); }

// ==== tools: text / SVG emboss, simplify, mesh boolean, brim ears (src/tools) ====

type ToolMeshPatch = { positions: Float32Array; indices: Uint32Array };

/** Point every volume using `from` (the object's own mesh or a part's, on all instances) at mesh `to`. */
function swapVolumeMesh(objId: string, partId: string | null, to: MeshData, emboss: EmbossMeta | null | undefined): void {
  const o = getObject(objId);
  if (!o) return;
  if (partId === null) {
    const from = o.meshId;
    for (const x of objects.value) {
      if (x.meshId !== from) continue;
      x.meshId = to.id;
      if (emboss === null) delete x.emboss; else if (emboss) x.emboss = { ...emboss };
      dropObj(x);
    }
  } else {
    const p = o.parts?.find((q) => q.id === partId);
    if (!p) return;
    p.meshId = to.id;
    if (emboss === null) delete p.emboss; else if (emboss) p.emboss = { ...emboss };
    if (p.type === 'part') dropObj(o);
  }
}

/**
 * Add a tool-made mesh (text / SVG) as a new object. Without `position` it is
 * placed next to what is on the active plate. Returns the new object id.
 */
export function addToolObject(name: string, mesh: ToolMeshPatch, opts: { emboss?: EmbossMeta; position?: Vec3; rotation?: Quat; label?: string } = {}): string {
  const id = uid();
  mutate(opts.label ?? `Add ${name}`, () => {
    const m = addMesh(mesh.positions, mesh.indices);
    const plate = activePlate.value;
    const existing = objectsOnPlate(plate);
    const b = plateBedOf(plate);
    const o: ProjectObject = {
      id, name: uniqueName(name), meshId: m.id,
      position: opts.position ? [...opts.position] as Vec3 : [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0],
      rotation: opts.rotation ? [...opts.rotation] as Quat : [0, 0, 0, 1], scale: [1, 1, 1],
      visible: true, printable: true, overrides: {}, color: '',
      ...(opts.emboss ? { emboss: { ...opts.emboss } } : {}),
    };
    objects.value.push(o);
    const live = objects.value[objects.value.length - 1];
    dropObj(live);
    if (!opts.position && !fitsWhereItIs(live, existing, plate)) placeOnPlates([live], existing, plate);
  });
  selectedIds.value = [id];
  return id;
}

/** Add a part with a full placement in the object's frame (text / SVG on a surface). Returns the part id. */
export function addToolPart(objId: string, type: PartType, name: string, mesh: ToolMeshPatch,
  t: { position: Vec3; rotation: Quat; scale?: Vec3 }, emboss?: EmbossMeta): string | null {
  if (!getObject(objId)) return null;
  const id = uid('p');
  mutate(`Add ${PART_TYPE_LABELS[type].toLowerCase()} ${name}`, () => {
    const live = getObject(objId)!;
    const m = addMesh(mesh.positions, mesh.indices);
    const part: ObjectPart = {
      id, name, meshId: m.id, type, position: [...t.position] as Vec3, rotation: quatNormalize(t.rotation),
      scale: t.scale ? [...t.scale] as Vec3 : [1, 1, 1], overrides: {}, ...(emboss ? { emboss: { ...emboss } } : {}),
    };
    live.parts = [...(live.parts ?? []), part];
    if (type === 'part') dropObj(live);
  });
  return id;
}

/**
 * Replace a volume's geometry (partId null = the object's own mesh, on all
 * its instances): text / SVG re-edit, simplify. `emboss`: new source,
 * null = drop it (geometry no longer matches), undefined = keep.
 */
export function replaceVolumeMesh(objId: string, partId: string | null, mesh: ToolMeshPatch,
  opts: { label: string; emboss?: EmbossMeta | null; mergeKey?: string; name?: string }): void {
  mutate(opts.label, () => {
    const m = addMesh(mesh.positions, mesh.indices);
    swapVolumeMesh(objId, partId, m, opts.emboss);
    if (opts.name) {
      const o = getObject(objId);
      const n = opts.name.slice(0, 200);
      if (o && partId === null) o.name = n;
      else { const p = o?.parts?.find((q) => q.id === partId); if (p) p.name = n; }
    }
  }, { mergeKey: opts.mergeKey });
}

/**
 * Orca mesh boolean result: the target volume gets the result mesh (in its
 * own mesh frame); the tool volumes are removed when `deleteInput`.
 */
export function commitBoolean(p: {
  label: string; objectId: string; partId: string | null; mesh: ToolMeshPatch;
  removeObjects?: string[]; removeParts?: Array<{ objectId: string; partId: string }>;
}): void {
  mutate(p.label, () => {
    const m = addMesh(p.mesh.positions, p.mesh.indices);
    swapVolumeMesh(p.objectId, p.partId, m, null);
    for (const rp of p.removeParts ?? []) {
      const o = getObject(rp.objectId);
      if (!o?.parts) continue;
      o.parts = o.parts.filter((x) => x.id !== rp.partId);
      if (!o.parts.length) delete o.parts;
      dropObj(o);
    }
    if (p.removeObjects?.length) {
      const drop = new Set(p.removeObjects.filter((id) => id !== p.objectId));
      objects.value = objects.value.filter((o) => !drop.has(o.id));
    }
  });
  selectedIds.value = [p.objectId];
}

/** Orca brim ears: the points of an object (ModelObject::brim_points — shared by its instances). */
export function setBrimPoints(objId: string, pts: BrimPoint[], label = 'Brim ears edit'): void {
  const o = getObject(objId);
  if (!o) return;
  mutate(label, () => {
    const meshId = getObject(objId)!.meshId;
    for (const x of objects.value) {
      if (x.meshId !== meshId) continue;
      if (pts.length) x.brimPoints = pts.map((b) => ({ pos: [...b.pos] as Vec3, radius: b.radius }));
      else delete x.brimPoints;
    }
  });
}

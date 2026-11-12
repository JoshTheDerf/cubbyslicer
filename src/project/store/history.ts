/**
 * Undo / redo. Every mutation goes through `mutate()`, which records a
 * snapshot operation on the shared (CubbyCAD) HistoryManager and calls
 * `markSliceInputsChanged()` when slicing is affected. Meshes no snapshot or
 * live object references are dropped here.
 */
import { ref, toRaw } from 'vue';
import { markSliceInputsChanged } from '../../app/state';
import type { PaintLayers } from '../../engine/types';
import { HistoryManager, type Operation } from '@cubby/shared/history';
import { clonePlate, newPlate, type PlateMeta } from '../plates';
import type { MeshTexture, ProjectObject } from '../types';
import { cloneObj } from './clone';
import { pruneSelection } from './selection';
import { clampActivePlate, meshIdsOf, meshPaint, meshRevision, meshTexture, meshes, objects, plates, projectRevision } from './state';

interface Snapshot {
  objects: ProjectObject[]; plates: PlateMeta[]; paint: Record<string, PaintLayers>;
  /** Texture displacement per mesh (immutable record, compared by identity). */
  texture: Record<string, MeshTexture>;
  slots: Record<string, unknown>;
}

/**
 * Project state outside the store that undo must restore too (the Design tab's document bytes,
 * src/design/history.ts). `capture` returns an immutable value compared by identity; `restore`
 * puts one back (called inside undo / redo, after objects and plates).
 */
export interface SnapshotSlot<T> { capture(): T; restore(v: T): void }
const slots = new Map<string, SnapshotSlot<unknown>>();
export function registerSnapshotSlot<T>(name: string, slot: SnapshotSlot<T>): () => void {
  slots.set(name, slot as SnapshotSlot<unknown>);
  return () => { if (slots.get(name) === slot) slots.delete(name); };
}
function captureSlots(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, s] of slots) out[k] = s.capture();
  return out;
}

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

// Snapshot equality compares trees by identity (they are immutable and can hold large baked meshes).
const cadTokens = new WeakMap<object, number>();
let cadTokenSeq = 0;
function snapshotReplacer(k: string, v: unknown): unknown {
  if (k !== 'cad' || !v || typeof v !== 'object') return v;
  const n = (v as { node: object }).node;
  let t = cadTokens.get(n);
  if (t === undefined) { t = ++cadTokenSeq; cadTokens.set(n, t); }
  return t;
}

function snapshot(): Snapshot {
  return { objects: objects.value.map(cloneObj), plates: plates.value.map((p) => clonePlate(toRaw(p))), paint: meshPaint.value, texture: meshTexture.value, slots: captureSlots() };
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

function sameSlots(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) return false;
  return true;
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  // Paint maps and slot values are immutable: compare by reference (they can be large).
  return samePaint(a.paint, b.paint) && a.texture === b.texture && sameSlots(a.slots, b.slots) && JSON.stringify([a.objects, a.plates], snapshotReplacer) === JSON.stringify([b.objects, b.plates], snapshotReplacer);
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

/** Something persisted changed; `slice`: it also changes what gets sliced. */
export function changed(slice: boolean): void {
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
  meshTexture.value = s.texture ?? {};
  plates.value = s.plates.length ? s.plates.map(clonePlate) : [newPlate()];
  clampActivePlate();
  for (const [k, slot] of slots) if (k in s.slots) slot.restore(s.slots[k]);
  pruneSelection();
  // No collectMeshes() here: the history pops the operation before calling
  // apply/unapply, so its other snapshot's meshes would look unreferenced.
  // undo() / redo() collect once the operation is back on a stack.
  changed(true);
}

/**
 * Edits still evaluating off-thread when history moves (a CubbyCAD slider released just before
 * Ctrl+Z, src/cad/commands.ts) settle first: the guard cancels or keeps them, then returns
 * undefined to go on, or the navigation's result itself — the label of what it took back (an
 * edit not recorded yet is undone by dropping it) or null (refused).
 */
export type PendingEditGuard = (kind: 'undo' | 'redo' | 'reset') => string | null | undefined;
let pendingEdits: PendingEditGuard | null = null;
export function setPendingEditGuard(g: PendingEditGuard | null): void { pendingEdits = g; }

/** Gesture boundary (drag end, dialog close): the next edit starts a new undo entry. */
export function endGesture(): void { history.finalizeActiveTransform(); }

export function undo(): string | null {
  const settled = pendingEdits?.('undo');
  if (settled !== undefined) return settled;
  const label = history.getLastOperationDescription();
  if (!history.undo()) return null;
  collectMeshes();
  refreshHistoryState();
  return label;
}

export function redo(): string | null {
  const settled = pendingEdits?.('redo');
  if (settled !== undefined) return settled;
  const label = history.getRedoDescription();
  if (!history.redo()) return null;
  collectMeshes();
  refreshHistoryState();
  return label;
}

/** Forget every undo step (a whole project was loaded). */
export function clearHistory(): void {
  pendingEdits?.('reset');
  history.clear();
  refreshHistoryState();
}

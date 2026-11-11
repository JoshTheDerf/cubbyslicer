/**
 * Where objects go: dropping onto the bed, fit checks, packing new objects
 * next to what is on a plate (src/project/arrange.ts), spilling onto further
 * plates, and moving objects with their plate when the plate grid changes.
 * Helpers for use inside a `mutate`; none records an undo step itself.
 *
 * The user-facing Arrange commands run Orca's arrange on the engine instead
 * (app/shell/arrange.ts → arrangeIO.ts).
 */
import { arrange, type ArrangeItem, type Rect } from '../arrange';
import { MAX_PLATES, newPlate, plateIndexAt, plateShift } from '../plates';
import type { ProjectObject } from '../types';
import { objectWorldInfo, plateOfLive } from './derived';
import { activePlate, bed, objects, plateBedOf, plates } from './state';

/** Put the object's lowest point on the bed. */
export function dropObj(o: ProjectObject): void {
  const i = objectWorldInfo(o);
  if (i && Math.abs(i.min[2]) > 1e-6) o.position = [o.position[0], o.position[1], o.position[2] - i.min[2]];
}

/** XY footprint box of an object. */
export function rectOf(o: ProjectObject): Rect | null {
  const i = objectWorldInfo(o);
  return i ? { minX: i.min[0], minY: i.min[1], maxX: i.max[0], maxY: i.max[1] } : null;
}

/** Arrange `movers` on plate `plate` around fixed `others`. Returns the ids that didn't fit. */
export function arrangeInternal(movers: ProjectObject[], others: ProjectObject[], spacing: number, center: boolean,
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

/** The object is inside plate `plate` and clear of `others` (footprint boxes). */
export function fitsWhereItIs(o: ProjectObject, others: ProjectObject[], plate = activePlate.value): boolean {
  const r = rectOf(o);
  if (!r) return true;
  const b = plateBedOf(plate);
  if (r.minX < b.min[0] || r.minY < b.min[1] || r.maxX > b.max[0] || r.maxY > b.max[1]) return false;
  return others.every((x) => {
    const q = rectOf(x);
    return !q || r.maxX <= q.minX || q.maxX <= r.minX || r.maxY <= q.minY || q.maxY <= r.minY;
  });
}

/** Some of `fresh` overlap each other or `others`, or leave plate `plate`. */
export function anyClash(fresh: ProjectObject[], others: ProjectObject[], plate = activePlate.value): boolean {
  return fresh.some((o, i) => !fitsWhereItIs(o, [...others, ...fresh.filter((_, j) => j !== i)], plate));
}

/**
 * Put `fresh` objects on `plate` next to what's there; whatever doesn't fit
 * spills onto the following plates (created as needed, like Orca's arrange).
 */
export function placeOnPlates(fresh: ProjectObject[], existing: ProjectObject[], plate: number): void {
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

/** Translate objects so their footprint centre lands in the middle of plate `p`. */
export function shiftToPlate(objs: ProjectObject[], p: number): void {
  const b = plateBedOf(p);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  for (const o of objs) {
    const r = rectOf(o);
    if (!r) continue;
    o.position = [o.position[0] + cx - (r.minX + r.maxX) / 2, o.position[1] + cy - (r.minY + r.maxY) / 2, o.position[2]];
  }
}

// ---- plate grid -------------------------------------------------------------------

const KEEP_IN_PLACE = -2;

/**
 * Re-layout: the plate grid changes shape with the plate count, so objects
 * follow their plate (`map[old] = new index`, -1 = plate deleted → its objects
 * removed, KEEP_IN_PLACE = plate deleted, its objects stay where they are).
 */
function relayoutPlates(nOld: number, nNew: number, map: (old: number) => number): void {
  const b = bed.value;
  const keep: ProjectObject[] = [];
  for (const o of objects.value) {
    const i = objectWorldInfo(o);
    const from = i ? plateIndexAt((i.min[0] + i.max[0]) / 2, (i.min[1] + i.max[1]) / 2, nOld, b) : -1;
    if (from < 0) { keep.push(o); continue; }
    const to = map(from);
    if (to === KEEP_IN_PLACE) { keep.push(o); continue; }
    if (to < 0) continue;
    const [dx, dy] = plateShift(b, from, nOld, to, nNew);
    if (dx || dy) o.position = [o.position[0] + dx, o.position[1] + dy, o.position[2]];
    keep.push(o);
  }
  if (keep.length !== objects.value.length) objects.value = keep;
}

/** Insert an empty plate at `at`, moving objects on later plates along. */
export function insertPlate(at: number): void {
  const n = plates.value.length;
  relayoutPlates(n, n + 1, (i) => (i >= at ? i + 1 : i));
  const next = plates.value.slice();
  next.splice(at, 0, newPlate());
  plates.value = next;
}

/** Remove plate `i`; its objects go with it (`keepObjects`: they stay where they are). */
export function removePlateAt(i: number, keepObjects = false): void {
  const n = plates.value.length;
  relayoutPlates(n, n - 1, (p) => (p === i ? (keepObjects ? KEEP_IN_PLACE : -1) : p > i ? p - 1 : p));
  plates.value = plates.value.filter((_, k) => k !== i);
}

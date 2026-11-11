/**
 * Orca 2.5 Align / Distribute (GLGizmoAlignment, objects in the World frame):
 * line the selected objects up by an edge or centre of their joint bounding
 * box, or space three or more evenly by their centres, keeping the outer two
 * in place. X and Y only: objects always sit on the bed, so Orca's Z variants
 * (which matter for parts) have nothing to do here. One undo step each.
 */
import { getObject, objectInfo, selectedIds, setTransforms } from '../../../project/store';

export type AlignAxis = 0 | 1;
export type AlignEdge = 'min' | 'center' | 'max';

interface Box { id: string; min: number; max: number }

function boxes(axis: AlignAxis, ids: readonly string[]): Box[] {
  const out: Box[] = [];
  for (const id of ids) {
    const info = objectInfo.value.get(id);
    if (info) out.push({ id, min: info.min[axis], max: info.max[axis] });
  }
  return out;
}

function move(axis: AlignAxis, shifts: Array<{ id: string; d: number }>, label: string): void {
  const patches = shifts.flatMap(({ id, d }) => {
    const o = getObject(id);
    if (!o || Math.abs(d) < 1e-6) return [];
    const position = [...o.position] as [number, number, number];
    position[axis] += d;
    return [{ id, position }];
  });
  if (patches.length) setTransforms(patches, label, { drop: false });
}

/** Number of objects Align needs (2) and Distribute needs (3). */
export const ALIGN_MIN = 2, DISTRIBUTE_MIN = 3;

/** Align the objects' min / centre / max along `axis` with the selection's joint box. */
export function alignObjects(axis: AlignAxis, edge: AlignEdge, ids: readonly string[] = selectedIds.value): void {
  const bs = boxes(axis, ids);
  if (bs.length < ALIGN_MIN) return;
  const lo = Math.min(...bs.map((b) => b.min)), hi = Math.max(...bs.map((b) => b.max));
  const target = edge === 'min' ? lo : edge === 'max' ? hi : (lo + hi) / 2;
  const at = (b: Box) => (edge === 'min' ? b.min : edge === 'max' ? b.max : (b.min + b.max) / 2);
  move(axis, bs.map((b) => ({ id: b.id, d: target - at(b) })), `Align ${'XY'[axis]} ${edge === 'center' ? 'center' : edge}`);
}

/** Space the objects' centres evenly along `axis`, keeping the first and last in place. */
export function distributeObjects(axis: AlignAxis, ids: readonly string[] = selectedIds.value): void {
  const bs = boxes(axis, ids).map((b) => ({ ...b, c: (b.min + b.max) / 2 })).sort((a, b) => a.c - b.c);
  if (bs.length < DISTRIBUTE_MIN) return;
  const first = bs[0].c, step = (bs[bs.length - 1].c - first) / (bs.length - 1);
  move(axis, bs.slice(1, -1).map((b, i) => ({ id: b.id, d: first + (i + 1) * step - b.c })), `Distribute ${'XY'[axis]}`);
}

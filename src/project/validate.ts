/**
 * Plate validation: flags objects outside the printable area / too tall /
 * touching exclude areas, and pairs of objects whose footprints overlap.
 */
import type { BedShape } from '../app/state';
import { pointInPolygon, polygonsOverlap, type Pt } from './math';
import type { ObjectIssue } from './types';

export interface ValidateItem {
  id: string;
  hull: Pt[];
  min: [number, number, number];
  max: [number, number, number];
}

const TOL = 0.01; // mm

export function validatePlate(items: ValidateItem[], bed: BedShape): Map<string, ObjectIssue[]> {
  const out = new Map<string, ObjectIssue[]>();
  const add = (id: string, i: ObjectIssue) => {
    const l = out.get(id);
    if (!l) out.set(id, [i]); else if (!l.includes(i)) l.push(i);
  };
  for (const it of items) {
    if (it.hull.some((p) => !pointInPolygon(p, bed.polygon, TOL))) add(it.id, 'outside');
    else if (it.min[2] < -TOL) add(it.id, 'outside');
    if (bed.maxHeight > 0 && it.max[2] - Math.min(0, it.min[2]) > bed.maxHeight + TOL) add(it.id, 'height');
    for (const ex of bed.excludeAreas) if (polygonsOverlap(it.hull, ex)) add(it.id, 'exclude');
  }
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (a.max[0] <= b.min[0] || b.max[0] <= a.min[0] || a.max[1] <= b.min[1] || b.max[1] <= a.min[1]) continue;
      if (polygonsOverlap(a.hull, b.hull)) { add(a.id, 'overlap'); add(b.id, 'overlap'); }
    }
  }
  return out;
}

export const ISSUE_LABELS: Record<ObjectIssue, string> = {
  outside: 'Outside the printable area',
  height: 'Taller than the printer’s max height',
  exclude: 'Touches an excluded bed area',
  overlap: 'Overlaps another object',
};

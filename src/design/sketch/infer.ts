/**
 * Snapping and automatic constraints while drawing — Orca's SketchInference on the page:
 *
 * - `snapPoint` (`infer_point_snap`): the cursor snaps to an entity's end (tier 0), a centre (1),
 *   the sketch origin (2), a midpoint (3) or a point on an edge (4); lower tiers win, then the
 *   nearest. Construction entities take part.
 * - `axisHint` (`infer_axis_constraint`): a line within 3° of horizontal / vertical snaps to it.
 * - What a recorded snap becomes when the click lands (Coincident for an end / centre / origin,
 *   Midpoint, Point on object for an edge) is `anchorConstraints` in shapes.ts.
 *
 * The hint shown before the click and the constraint applied on it come from the same snap
 * record, so what the user sees is what they get. Shift held suppresses snapping (Orca).
 */
import {
  REF_ORIGIN, angleOf, dist, ends, hasCenter, midpointOf, nearestOn, sub,
  type Role, type SkEntity, type V2,
} from './model';

export type SnapKind = 'end' | 'center' | 'origin' | 'midpoint' | 'edge' | 'none';
export interface Snap { kind: SnapKind; p: V2; entity: number; role?: Role }

const TIER: Record<SnapKind, number> = { end: 0, center: 1, origin: 2, midpoint: 3, edge: 4, none: 9 };
export const SNAP_LABEL: Record<SnapKind, string> = { end: 'Endpoint', center: 'Centre', origin: 'Origin', midpoint: 'Midpoint', edge: 'On curve', none: '' };

export interface SnapOptions {
  /** Entities not to snap to (the one being drawn). */
  exclude?: ReadonlySet<number>;
  /** Extra points to snap to, as ends of pseudo entities (the first point of a chain being drawn). */
  extra?: ReadonlyArray<{ p: V2; entity: number; role: Role }>;
  origin?: boolean;
  /** Snap to edges (on-curve) too. */
  edges?: boolean;
}

/** Orca's `infer_point_snap`: the best snap within `tol` (plane mm) of `q`, or a 'none' snap at q. */
export function snapPoint(entities: readonly SkEntity[], q: V2, tol: number, o: SnapOptions = {}): Snap {
  let best: Snap = { kind: 'none', p: q, entity: -1 };
  let bestD = Infinity;
  const offer = (kind: SnapKind, p: V2, entity: number, role?: Role) => {
    const d = dist(p, q);
    if (d > tol) return;
    if (TIER[kind] < TIER[best.kind] || (TIER[kind] === TIER[best.kind] && d < bestD)) { best = { kind, p, entity, role }; bestD = d; }
  };
  entities.forEach((e, i) => {
    if (o.exclude?.has(i)) return;
    for (const end of ends(e)) offer('end', end.p, i, end.role);
    if (hasCenter(e)) offer('center', e.center, i, 'center');
    const m = midpointOf(e);
    if (m) offer('midpoint', m, i);
    if (o.edges !== false && e.type !== 'point') {
      const n = nearestOn(e, q);
      // Orca: the interior of a line (2–98 %), of an arc's sweep, or a circle's rim.
      if (e.type !== 'line' || (n.t > 0.02 && n.t < 0.98)) offer('edge', n.p, i);
    }
  });
  for (const x of o.extra ?? []) offer('end', x.p, x.entity, x.role);
  if (o.origin !== false) offer('origin', [0, 0], REF_ORIGIN, 'p0');
  return best;
}

/** Orca's `infer_axis_constraint`: H / V when the segment is within `tolDeg` of an axis. */
export function axisHint(anchor: V2, tip: V2, tolDeg = 3): 'horizontal' | 'vertical' | null {
  const d = sub(tip, anchor);
  if (Math.hypot(d[0], d[1]) < 1e-9) return null;
  const a = Math.abs((angleOf(d) * 180) / Math.PI);
  const off = Math.min(a, 180 - a);
  if (off <= tolDeg) return 'horizontal';
  if (Math.abs(90 - a) <= tolDeg) return 'vertical';
  return null;
}

/** Snap the tip of a segment onto the axis the hint names (keeps the snapped length). */
export function applyAxis(anchor: V2, tip: V2, axis: 'horizontal' | 'vertical' | null): V2 {
  if (axis === 'horizontal') return [tip[0], anchor[1]];
  if (axis === 'vertical') return [anchor[0], tip[1]];
  return tip;
}

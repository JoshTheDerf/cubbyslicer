/**
 * Measurements between two (world-space) features, after Orca's
 * Measure::get_measurement: strict distance (closest points of the actual
 * features), infinite distance (to the supporting line / plane), angle
 * between edges / planes (with the arc Orca draws) and the XYZ delta.
 */
import { add, cross, dist, dot, len, norm, scl, sub, type Feature, type V3 } from './features';

export interface DistAndPoints { value: number; from: V3; to: V3 }
export interface AngleResult { deg: number; center: V3; dirA: V3; dirB: V3; radius: number }
export interface Measurement {
  strict?: DistAndPoints;
  infinite?: DistAndPoints;
  angle?: AngleResult;
  delta?: V3;
}

const EPS = 1e-9;
const PARALLEL = 1 - 1e-6;

function closestOnSeg(p: V3, a: V3, b: V3): V3 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > EPS ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return add(a, scl(ab, t));
}

function closestOnLine(p: V3, a: V3, b: V3): V3 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  return l2 > EPS ? add(a, scl(ab, dot(sub(p, a), ab) / l2)) : a;
}

function projectOnPlane(p: V3, o: V3, n: V3): V3 { return sub(p, scl(n, dot(sub(p, o), n))); }

function closestOnCircle(p: V3, c: V3, n: V3, r: number): V3 {
  const q = projectOnPlane(p, c, n);
  let d = sub(q, c);
  if (len(d) < EPS) d = Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]);
  return add(c, scl(norm(d), r));
}

/** Closest points between two segments. */
export function segSeg(p1: V3, q1: V3, p2: V3, q2: V3): [V3, V3] {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a <= EPS && e <= EPS) return [p1, p2];
  if (a <= EPS) { t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = dot(d1, r);
    if (e <= EPS) { s = Math.max(0, Math.min(1, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > EPS ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  return [add(p1, scl(d1, s)), add(p2, scl(d2, t))];
}

const dp = (from: V3, to: V3): DistAndPoints => ({ value: dist(from, to), from, to });

/** Angle between two edges, measured with both directions pointing away from their (projected) intersection. */
export function angleEdgeEdge(a0: V3, a1: V3, b0: V3, b1: V3): AngleResult | undefined {
  let ua = norm(sub(a1, a0)), ub = norm(sub(b1, b0));
  if (Math.abs(dot(ua, ub)) > PARALLEL) return undefined;
  const n = norm(cross(ua, ub));
  // Intersection of the two lines projected into the plane through a0 with normal n.
  const pb0 = projectOnPlane(b0, a0, n);
  // Solve a0 + s ua = pb0 + t ub (in-plane).
  const w = sub(a0, pb0);
  const den = dot(cross(ua, ub), n);
  const t = dot(cross(ua, w), n) / den;
  const center = add(pb0, scl(ub, -t));
  // Directions away from the centre.
  if (dist(center, a0) > dist(center, a1)) ua = scl(ua, -1);
  const pb1 = projectOnPlane(b1, a0, n);
  if (dist(center, pb0) > dist(center, pb1)) ub = scl(ub, -1);
  const deg = (Math.acos(Math.max(-1, Math.min(1, dot(ua, ub)))) * 180) / Math.PI;
  const radius = Math.min(dist(center, scl(add(a0, a1), 0.5)), dist(center, scl(add(pb0, pb1), 0.5)));
  return { deg, center, dirA: ua, dirB: ub, radius };
}

function angleEdgePlane(a: V3, b: V3, o: V3, n: V3): AngleResult | undefined {
  const u = norm(sub(b, a));
  if (Math.abs(dot(u, n)) < 1e-6) return undefined; // parallel to the plane
  // Edge ∩ plane, then the edge's projection onto the plane as the 2nd leg.
  const s = dot(sub(o, a), n) / dot(u, n);
  const inter = add(a, scl(u, s));
  let e1 = a, e2 = b;
  if (dist(e1, inter) > dist(e2, inter)) { e1 = b; e2 = a; }
  const dirA = norm(sub(e2, e1));
  let onPlane = sub(dirA, scl(n, dot(dirA, n)));
  if (len(onPlane) < 1e-9) onPlane = Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]);
  const dirB = norm(onPlane);
  const deg = (Math.acos(Math.max(-1, Math.min(1, dot(dirA, dirB)))) * 180) / Math.PI;
  return { deg, center: inter, dirA, dirB, radius: Math.max(dist(inter, scl(add(a, b), 0.5)), 1) };
}

function anglePlanePlane(o1: V3, n1: V3, o2: V3, n2: V3): AngleResult | undefined {
  if (Math.abs(dot(n1, n2)) > PARALLEL) return undefined;
  const dir = norm(cross(n1, n2));
  // A point on both planes: solve with the third equation dir·x = 0.
  const d1 = dot(n1, o1), d2 = dot(n2, o2);
  const n1xn2 = cross(n1, n2), den = dot(n1xn2, n1xn2);
  const p0 = scl(add(scl(cross(n2, n1xn2), d1), scl(cross(n1xn2, n1), d2)), 1 / den);
  const proj = (o: V3) => add(p0, scl(dir, dot(sub(o, p0), dir)));
  const c1 = proj(o1), c2 = proj(o2);
  let dirA = sub(o1, c1), dirB = sub(o2, c2);
  if (len(dirA) < 1e-9) dirA = cross(n1, dir);
  if (len(dirB) < 1e-9) dirB = cross(n2, dir);
  dirA = norm(dirA); dirB = norm(dirB);
  const deg = (Math.acos(Math.max(-1, Math.min(1, dot(dirA, dirB)))) * 180) / Math.PI;
  const radius = Math.max(10, dist(o1, c1), dist(o2, c2));
  const center = scl(add(c1, c2), 0.5);
  return { deg, center, dirA, dirB, radius };
}

function withDelta(m: Measurement): Measurement {
  const d = m.strict ?? m.infinite;
  if (d) m.delta = sub(d.to, d.from);
  return m;
}

const ORDER: Record<Feature['type'], number> = { point: 0, edge: 1, circle: 2, plane: 3 };

/** Measure between two features (world space). */
export function measure(fa: Feature, fb: Feature): Measurement {
  const swap = ORDER[fa.type] > ORDER[fb.type];
  const f1 = swap ? fb : fa, f2 = swap ? fa : fb;
  const m = measureOrdered(f1, f2);
  if (swap) {
    for (const k of ['strict', 'infinite'] as const) {
      const d = m[k];
      if (d) m[k] = { value: d.value, from: d.to, to: d.from };
    }
    if (m.angle) m.angle = { ...m.angle, dirA: m.angle.dirB, dirB: m.angle.dirA };
  }
  return withDelta(m);
}

function measureOrdered(f1: Feature, f2: Feature): Measurement {
  if (f1.type === 'point') {
    const p = f1.p;
    switch (f2.type) {
      case 'point': return { strict: dp(p, f2.p) };
      case 'edge': return { strict: dp(p, closestOnSeg(p, f2.a, f2.b)), infinite: dp(p, closestOnLine(p, f2.a, f2.b)) };
      case 'circle': return { strict: dp(p, closestOnCircle(p, f2.c, f2.n, f2.r)) };
      case 'plane': return { infinite: dp(p, projectOnPlane(p, f2.o, f2.n)) };
    }
  }
  if (f1.type === 'edge') {
    switch (f2.type) {
      case 'edge': {
        const [x, y] = segSeg(f1.a, f1.b, f2.a, f2.b);
        return { strict: dp(x, y), angle: angleEdgeEdge(f1.a, f1.b, f2.a, f2.b) };
      }
      case 'circle': {
        const c = f2.c;
        return { strict: dp(closestOnSeg(c, f1.a, f1.b), c), infinite: dp(closestOnLine(c, f1.a, f1.b), c) };
      }
      case 'plane': {
        const da = dot(sub(f1.a, f2.o), f2.n), db = dot(sub(f1.b, f2.o), f2.n);
        const angle = angleEdgePlane(f1.a, f1.b, f2.o, f2.n);
        if (Math.abs(da - db) < 1e-6) return { infinite: dp(f1.a, projectOnPlane(f1.a, f2.o, f2.n)) };
        if (da * db <= 0) return { angle };
        const near = Math.abs(da) < Math.abs(db) ? f1.a : f1.b;
        return { strict: dp(near, projectOnPlane(near, f2.o, f2.n)), angle };
      }
    }
  }
  if (f1.type === 'circle') {
    switch (f2.type) {
      case 'circle': return { strict: dp(f1.c, f2.c) };
      case 'plane': return { infinite: dp(f1.c, projectOnPlane(f1.c, f2.o, f2.n)) };
    }
  }
  if (f1.type === 'plane' && f2.type === 'plane') {
    if (Math.abs(dot(f1.n, f2.n)) > PARALLEL) return { infinite: dp(f1.o, projectOnPlane(f1.o, f2.o, f2.n)) };
    return { angle: anglePlanePlane(f1.o, f1.n, f2.o, f2.n) };
  }
  return {};
}

/** The single distance Orca offers to "scale to" (strict when available). */
export function primaryDistance(m: Measurement): DistAndPoints | undefined {
  return m.strict ?? m.infinite;
}

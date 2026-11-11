/**
 * Sketch model: the kernel's sketch JSON (docs/CAD-KERNEL-CONTRACT.md "Sketch JSON") and the
 * 2D geometry the sketcher needs on the page — sampling entities for display, distances and
 * nearest points for hit-testing and snapping, the real ends of each entity type, and the
 * circle / arc constructions the drawing tools use. Pure: no Vue, no kernel.
 *
 * Plane coordinates are millimetres in the sketch plane's frame (`x_axis`, `y_axis` from its
 * `origin`); entity angles are radians (an arc sweeps from `start_angle` to `end_angle`, the
 * sign of the difference is its direction).
 */
import type { PlaneFrame, Vec3 } from '../kernel/types';

export type V2 = [number, number];
export type SkType = 'line' | 'arc' | 'circle' | 'point' | 'ellipse' | 'ellipse_arc' | 'spline';
export type Role = 'p0' | 'p1' | 'center';

/** `SketchEntity`, every field present (as the kernel emits it). */
export interface SkEntity {
  type: SkType;
  p0: V2;
  p1: V2;
  center: V2;
  radius: number;
  start_angle: number;
  end_angle: number;
  construction: boolean;
  rminor: number;
  rotation: number;
  ctrl: V2[];
}

/** The 25 constraint types (Orca's `SketchEntityConstraintType`, kernel spellings). */
export const CONSTRAINT_TYPES = [
  'fix', 'coincident', 'horizontal', 'vertical', 'distance', 'lock_x', 'lock_y', 'equal_length', 'parallel', 'perpendicular',
  'concentric', 'tangent', 'midpoint', 'symmetric', 'angle', 'radius', 'diameter', 'point_on_line', 'point_on_object',
  'equal_radius', 'collinear', 'distance_x', 'distance_y', 'symmetric_about_y', 'symmetric_about_x',
] as const;
export type SkConstraintType = typeof CONSTRAINT_TYPES[number];

/** `SketchEntityConstraintDef`. Entity -1 unused, -2 sketch origin, -3 X axis, -4 Y axis. */
export interface SkConstraint { type: SkConstraintType; ea: number; ra: Role; eb: number; rb: Role; value: number; ec: number; rc: Role }

export const REF_ORIGIN = -2;
export const REF_AXIS_X = -3;
export const REF_AXIS_Y = -4;

/** Valued constraints (dimensions). */
export const DIMENSION_TYPES: ReadonlySet<SkConstraintType> = new Set(['distance', 'angle', 'radius', 'diameter', 'distance_x', 'distance_y', 'lock_x', 'lock_y']);
/** point_on_line carries a value too (signed distance; 0 = on the line). */
export function isDimension(c: SkConstraint): boolean { return DIMENSION_TYPES.has(c.type) || (c.type === 'point_on_line' && c.value !== 0); }

export interface SkLoop { entities: number[]; holes: number[]; closed: boolean; area: number; defect: boolean; defect_at?: V2 }
export interface LoopReport { closed_loops: SkLoop[]; open_ends: V2[]; defects: V2[]; buildable: boolean }
/** Solve result fields every session edit returns. */
export interface SolveInfo { solve_ok: boolean; dof: number; result: number; bad: number[]; skipped: number[] }

/** `sketch_describe` / `sketch_begin`. */
export interface SketchDescribe extends SolveInfo, LoopReport {
  ok: boolean;
  entities: SkEntity[];
  constraints: SkConstraint[];
  plane: PlaneFrame;
  plane_name?: string | null;
  feature: number;
  selection: number[];
}

// ---- construction -----------------------------------------------------------------------

const Z: V2 = [0, 0];

/** A complete entity from the fields that matter for its type (arc / ellipse-arc ends derived). */
export function entity(type: SkType, f: Partial<SkEntity> = {}): SkEntity {
  const e: SkEntity = {
    type, p0: f.p0 ?? Z, p1: f.p1 ?? Z, center: f.center ?? Z, radius: f.radius ?? 0, start_angle: f.start_angle ?? 0, end_angle: f.end_angle ?? 0,
    construction: !!f.construction, rminor: f.rminor ?? 0, rotation: f.rotation ?? 0, ctrl: f.ctrl ?? [],
  };
  if (type === 'arc') { e.p0 = onCircle(e.center, e.radius, e.start_angle); e.p1 = onCircle(e.center, e.radius, e.end_angle); }
  else if (type === 'circle' || type === 'ellipse') e.p0 = e.center;
  else if (type === 'ellipse_arc') { e.p0 = onEllipse(e, e.start_angle); e.p1 = onEllipse(e, e.end_angle); }
  else if (type === 'spline' && e.ctrl.length) { e.p0 = e.ctrl[0]; e.p1 = e.ctrl[e.ctrl.length - 1]; }
  return e;
}
export const line = (p0: V2, p1: V2, construction = false) => entity('line', { p0, p1, construction });
export const point = (p: V2, construction = false) => entity('point', { p0: p, construction });
export const circle = (center: V2, radius: number, construction = false) => entity('circle', { center, radius, construction });
export const arc = (center: V2, radius: number, a0: number, a1: number, construction = false) => entity('arc', { center, radius, start_angle: a0, end_angle: a1, construction });

/** A constraint with the unused slots filled the way the kernel reports them. */
export function cons(type: SkConstraintType, ea: number, ra: Role = 'p0', eb = -1, rb: Role = 'p0', value = 0, ec = -1, rc: Role = 'p0'): SkConstraint {
  return { type, ea, ra, eb, rb, value, ec, rc };
}

// ---- vectors --------------------------------------------------------------------------------

export const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: V2, k: number): V2 => [a[0] * k, a[1] * k];
export const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
export const len = (a: V2) => Math.hypot(a[0], a[1]);
export const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const mid = (a: V2, b: V2): V2 => lerp(a, b, 0.5);
export const perp = (a: V2): V2 => [-a[1], a[0]];
export const norm = (a: V2): V2 => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0]; };
export const angleOf = (a: V2) => Math.atan2(a[1], a[0]);
export const onCircle = (c: V2, r: number, a: number): V2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
export function onEllipse(e: Pick<SkEntity, 'center' | 'radius' | 'rminor' | 'rotation'>, t: number): V2 {
  const x = e.radius * Math.cos(t), y = e.rminor * Math.sin(t), c = Math.cos(e.rotation), s = Math.sin(e.rotation);
  return [e.center[0] + x * c - y * s, e.center[1] + x * s + y * c];
}
/** Angle normalised to (-π, π]. */
export function wrapPi(a: number): number { let x = a % (2 * Math.PI); if (x <= -Math.PI) x += 2 * Math.PI; if (x > Math.PI) x -= 2 * Math.PI; return x; }

// ---- entity geometry -------------------------------------------------------------------------

/** The point a constraint role names on an entity (`p0` of a circle is its centre). */
export function rolePoint(e: SkEntity, r: Role): V2 {
  if (r === 'center') return e.type === 'line' || e.type === 'point' || e.type === 'spline' ? e.p0 : e.center;
  if (e.type === 'circle' || e.type === 'ellipse') return e.center;
  return r === 'p0' ? e.p0 : e.p1;
}

/** The entity's real points (Orca's `sketch_entity_ends`): what endpoint snaps and coincidences use. */
export function ends(e: SkEntity): Array<{ role: Role; p: V2 }> {
  switch (e.type) {
    case 'point': return [{ role: 'p0', p: e.p0 }];
    case 'circle': case 'ellipse': return [];
    default: return [{ role: 'p0', p: e.p0 }, { role: 'p1', p: e.p1 }];
  }
}
export const hasCenter = (e: SkEntity) => e.type === 'arc' || e.type === 'circle' || e.type === 'ellipse' || e.type === 'ellipse_arc';
export const isRound = (e: SkEntity) => e.type === 'arc' || e.type === 'circle';

/** Clamped uniform B-spline of degree min(3, n-1) (SketchEngine's evaluation). */
export function splineAt(ctrl: readonly V2[], t: number): V2 {
  const n = ctrl.length;
  if (n === 0) return [0, 0];
  if (n === 1) return ctrl[0];
  const p = Math.min(3, n - 1);
  const knots: number[] = [];
  const inner = n - p;
  for (let i = 0; i <= p; i++) knots.push(0);
  for (let i = 1; i < inner; i++) knots.push(i / inner);
  for (let i = 0; i <= p; i++) knots.push(1);
  const u = Math.min(Math.max(t, 0), 1 - 1e-12);
  let k = p;
  while (k < n - 1 && knots[k + 1] <= u) k++;
  const d: V2[] = [];
  for (let j = 0; j <= p; j++) d.push([...ctrl[k - p + j]] as V2);
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const den = knots[i + p - r + 1] - knots[i];
      const a = den > 0 ? (u - knots[i]) / den : 0;
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
    }
  }
  return d[p];
}

/** A polyline along the entity (display, hit-testing). Points: a single vertex. */
export function sample(e: SkEntity, seg = 48): V2[] {
  switch (e.type) {
    case 'line': return [e.p0, e.p1];
    case 'point': return [e.p0];
    case 'circle': { const out: V2[] = []; for (let i = 0; i <= seg; i++) out.push(onCircle(e.center, e.radius, (i / seg) * 2 * Math.PI)); return out; }
    case 'arc': {
      const sweep = e.end_angle - e.start_angle, n = Math.max(4, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * seg));
      const out: V2[] = []; for (let i = 0; i <= n; i++) out.push(onCircle(e.center, e.radius, e.start_angle + (sweep * i) / n)); return out;
    }
    case 'ellipse': { const out: V2[] = []; for (let i = 0; i <= seg; i++) out.push(onEllipse(e, (i / seg) * 2 * Math.PI)); return out; }
    case 'ellipse_arc': {
      const sweep = e.end_angle - e.start_angle, n = Math.max(4, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * seg));
      const out: V2[] = []; for (let i = 0; i <= n; i++) out.push(onEllipse(e, e.start_angle + (sweep * i) / n)); return out;
    }
    case 'spline': {
      if (e.ctrl.length < 2) return e.ctrl.slice();
      const n = Math.max(8, e.ctrl.length * 12), out: V2[] = [];
      for (let i = 0; i <= n; i++) out.push(splineAt(e.ctrl, i / n));
      return out;
    }
  }
}

/** Nearest point of a segment. */
export function nearestOnSegment(a: V2, b: V2, q: V2): { p: V2; t: number; d: number } {
  const ab = sub(b, a), l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), ab) / l2)) : 0;
  const p = lerp(a, b, t);
  return { p, t, d: dist(p, q) };
}

/** Is angle `a` inside the arc's sweep? */
export function inSweep(e: Pick<SkEntity, 'start_angle' | 'end_angle'>, a: number): boolean {
  const s = e.start_angle, sw = e.end_angle - e.start_angle;
  if (Math.abs(sw) >= 2 * Math.PI - 1e-9) return true;
  let d = (a - s) % (2 * Math.PI);
  if (sw >= 0) { if (d < 0) d += 2 * Math.PI; return d <= sw + 1e-9; }
  if (d > 0) d -= 2 * Math.PI;
  return d >= sw - 1e-9;
}

/** Nearest point on an entity; `t` is the position along it (0..1) where that means something. */
export function nearestOn(e: SkEntity, q: V2): { p: V2; d: number; t: number } {
  switch (e.type) {
    case 'point': return { p: e.p0, d: dist(e.p0, q), t: 0 };
    case 'line': return nearestOnSegment(e.p0, e.p1, q);
    case 'circle': {
      const v = sub(q, e.center), a = angleOf(v), p = onCircle(e.center, e.radius, a);
      return { p, d: dist(p, q), t: ((a + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) };
    }
    case 'arc': {
      const a = angleOf(sub(q, e.center));
      if (inSweep(e, a)) {
        const p = onCircle(e.center, e.radius, a), sw = e.end_angle - e.start_angle;
        let d = (a - e.start_angle) % (2 * Math.PI); if (sw >= 0 && d < 0) d += 2 * Math.PI; if (sw < 0 && d > 0) d -= 2 * Math.PI;
        return { p, d: dist(p, q), t: sw ? d / sw : 0 };
      }
      const d0 = dist(e.p0, q), d1 = dist(e.p1, q);
      return d0 <= d1 ? { p: e.p0, d: d0, t: 0 } : { p: e.p1, d: d1, t: 1 };
    }
    default: {
      const pts = sample(e, 96);
      let best = { p: pts[0], d: Infinity, t: 0 };
      for (let i = 0; i + 1 < pts.length; i++) {
        const s = nearestOnSegment(pts[i], pts[i + 1], q);
        if (s.d < best.d) best = { p: s.p, d: s.d, t: (i + s.t) / (pts.length - 1) };
      }
      return best;
    }
  }
}

export function midpointOf(e: SkEntity): V2 | null {
  if (e.type === 'line') return mid(e.p0, e.p1);
  if (e.type === 'arc') return onCircle(e.center, e.radius, (e.start_angle + e.end_angle) / 2);
  return null;
}

/** Axis-aligned bounds of entities (plane mm), or null when empty. */
export function bounds(list: readonly SkEntity[]): { min: V2; max: V2 } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of list) for (const p of sample(e, 24)) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return x0 === Infinity ? null : { min: [x0, y0], max: [x1, y1] };
}

/** Circle through three points (null when collinear). */
export function circleThrough(a: V2, b: V2, c: V2): { center: V2; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = dot(a, a), b2 = dot(b, b), c2 = dot(c, c);
  const center: V2 = [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
  return { center, radius: dist(center, a) };
}

/** The arc from `a` to `b` passing through `via` (start a, end b, swept the way that contains via). */
export function arcThrough(a: V2, b: V2, via: V2): SkEntity | null {
  const c = circleThrough(a, b, via);
  if (!c) return null;
  const sa = angleOf(sub(a, c.center)), sb = angleOf(sub(b, c.center)), sv = angleOf(sub(via, c.center));
  let ccw = sb - sa; if (ccw < 0) ccw += 2 * Math.PI;
  let dv = sv - sa; if (dv < 0) dv += 2 * Math.PI;
  const sweep = dv <= ccw ? ccw : ccw - 2 * Math.PI;
  return arc(c.center, c.radius, sa, sa + sweep);
}

/** The arc that starts at `p` tangent to direction `t` and ends at `q` (null when q is on the tangent line). */
export function tangentArc(p: V2, t: V2, q: V2): SkEntity | null {
  const n = perp(norm(t)), pq = sub(q, p), k = 2 * dot(pq, n);
  if (Math.abs(k) < 1e-9) return null;
  const r = dot(pq, pq) / k; // signed: centre at p + r n
  const center = add(p, scale(n, r));
  const a0 = angleOf(sub(p, center)), a1 = angleOf(sub(q, center));
  // Travel direction at p must follow t: CCW when the centre is on the left (r > 0).
  let sweep = a1 - a0;
  if (r > 0) { if (sweep <= 0) sweep += 2 * Math.PI; } else if (sweep >= 0) sweep -= 2 * Math.PI;
  return arc(center, Math.abs(r), a0, a0 + sweep);
}

/** Tangent direction of an entity at one of its ends, pointing out of the entity (for tangent arcs). */
export function endTangent(e: SkEntity, role: Role): V2 | null {
  if (e.type === 'line') return norm(role === 'p1' ? sub(e.p1, e.p0) : sub(e.p0, e.p1));
  if (e.type === 'arc') {
    const a = role === 'p1' ? e.end_angle : e.start_angle, dir = Math.sign(e.end_angle - e.start_angle) || 1;
    const tan: V2 = [-Math.sin(a) * dir, Math.cos(a) * dir];
    return role === 'p1' ? tan : scale(tan, -1);
  }
  return null;
}

// ---- plane frame ----------------------------------------------------------------------------

export function toWorld(f: PlaneFrame, p: V2): Vec3 {
  return [f.origin[0] + p[0] * f.x_axis[0] + p[1] * f.y_axis[0], f.origin[1] + p[0] * f.x_axis[1] + p[1] * f.y_axis[1], f.origin[2] + p[0] * f.x_axis[2] + p[1] * f.y_axis[2]];
}
export function toPlane(f: PlaneFrame, w: Vec3): V2 {
  const d: Vec3 = [w[0] - f.origin[0], w[1] - f.origin[1], w[2] - f.origin[2]];
  return [d[0] * f.x_axis[0] + d[1] * f.x_axis[1] + d[2] * f.x_axis[2], d[0] * f.y_axis[0] + d[1] * f.y_axis[1] + d[2] * f.y_axis[2]];
}
/** The side the sketch is seen from: x × y (Orca's XZ plane stores normal +Y although x × y = −Y). */
export function viewNormal(f: PlaneFrame): Vec3 {
  const a = f.x_axis, b = f.y_axis;
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// ---- labels ----------------------------------------------------------------------------------

export const TYPE_NAMES: Record<SkType, string> = { line: 'Line', arc: 'Arc', circle: 'Circle', point: 'Point', ellipse: 'Ellipse', ellipse_arc: 'Elliptical arc', spline: 'Spline' };
export function entityName(list: readonly SkEntity[], i: number): string {
  if (i === REF_ORIGIN) return 'the origin';
  if (i === REF_AXIS_X) return 'the X axis';
  if (i === REF_AXIS_Y) return 'the Y axis';
  const e = list[i];
  return e ? `${e.construction ? 'construction ' : ''}${TYPE_NAMES[e.type].toLowerCase()} ${i + 1}` : `entity ${i + 1}`;
}

// ---- regions (Orca's DesignSketchTool::region_loops / region_at / selected_loop_entities) ----------

/** A closed loop of a sketch: its outline, the entities that make it, and the loops directly inside it (holes). */
export interface RegionLoop { poly: V2[]; ents: number[]; holes: number[] }

const JOIN_TOL = 1e-4;
const polyArea = (q: readonly V2[]) => { let a2 = 0; for (let i = 0, j = q.length - 1; i < q.length; j = i++) a2 += (q[j][0] + q[i][0]) * (q[j][1] - q[i][1]); return Math.abs(a2) / 2; };
function pointIn(pt: V2, q: readonly V2[]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const A = q[i], B = q[j];
    if ((A[1] > pt[1]) !== (B[1] > pt[1]) && pt[0] < ((B[0] - A[0]) * (pt[1] - A[1])) / (B[1] - A[1]) + A[0]) inside = !inside;
  }
  return inside;
}
/** A point strictly inside a simple polygon: off its lowest (convex) vertex along the bisector. */
function interiorPoint(q: readonly V2[]): V2 {
  let k = 0;
  for (let i = 1; i < q.length; i++) if (q[i][1] < q[k][1] || (q[i][1] === q[k][1] && q[i][0] < q[k][0])) k = i;
  const v = q[k], a = q[(k + q.length - 1) % q.length], b = q[(k + 1) % q.length];
  const ax = a[0] - v[0], ay = a[1] - v[1], bx = b[0] - v[0], by = b[1] - v[1], la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-12 || lb < 1e-12) return v;
  const sx = ax / la + bx / lb, sy = ay / la + by / lb, ls = Math.hypot(sx, sy);
  if (ls < 1e-12) return v;
  const step = 1e-3 * Math.min(la, lb);
  return [v[0] + (sx / ls) * step, v[1] + (sy / ls) * step];
}

/**
 * Orca's region_loops: circles / ellipses are loops of their own; lines, arcs and splines are
 * chained end to end into closed loops (open chains are dropped); a loop inside another is a hole
 * of the smallest loop containing it. Construction geometry takes no part.
 */
export function regionLoops(entities: readonly SkEntity[]): RegionLoop[] {
  const near = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < JOIN_TOL;
  const out: RegionLoop[] = [];
  const segs: Array<{ pts: V2[]; ent: number; used: boolean }> = [];
  entities.forEach((e, i) => {
    if (e.construction) return;
    if (e.type === 'circle' || e.type === 'ellipse') { const p = sample(e, 64); p.pop(); out.push({ poly: p, ents: [i], holes: [] }); }
    else if (e.type === 'line' || e.type === 'arc' || e.type === 'ellipse_arc' || e.type === 'spline') { const p = sample(e, 64); if (p.length >= 2) segs.push({ pts: p, ent: i, used: false }); }
  });
  for (const s0 of segs) {
    if (s0.used) continue;
    s0.used = true;
    const loop = s0.pts.slice(), ents = [s0.ent], start = loop[0];
    let cur = loop[loop.length - 1], extended = true;
    while (extended && !near(cur, start)) {
      extended = false;
      for (const t of segs) {
        if (t.used) continue;
        const q = t.pts;
        if (near(q[0], cur)) { for (let k = 1; k < q.length; k++) loop.push(q[k]); cur = q[q.length - 1]; }
        else if (near(q[q.length - 1], cur)) { for (let k = q.length - 2; k >= 0; k--) loop.push(q[k]); cur = q[0]; }
        else continue;
        t.used = true; ents.push(t.ent); extended = true;
        break;
      }
    }
    if (near(cur, start) && loop.length >= 4) { loop.pop(); out.push({ poly: loop, ents, holes: [] }); }
  }
  const probe = out.map((r) => (r.poly.length >= 3 ? interiorPoint(r.poly) : r.poly[0]));
  out.forEach((r, i) => {
    if (!r.poly.length) return;
    let best = -1, bestArea = 0;
    out.forEach((o, j) => {
      if (i === j || o.poly.length < 3 || !pointIn(probe[i], o.poly)) return;
      const a = polyArea(o.poly);
      if (best < 0 || a < bestArea) { best = j; bestArea = a; }
    });
    if (best >= 0) out[best].holes.push(i);
  });
  return out;
}

/** The region a plane point is in: the smallest loop containing it (inside a hole, that hole's own loop), or -1. */
export function regionAt(loops: readonly RegionLoop[], p: V2): number {
  let best = -1, bestArea = Infinity;
  loops.forEach((r, i) => { if (r.poly.length >= 3 && pointIn(p, r.poly)) { const a = polyArea(r.poly); if (a < bestArea) { best = i; bestArea = a; } } });
  return best;
}

/** Orca's selected_loop_entities: the region's own boundary plus every loop directly inside it, in entity order. */
export function loopEntityIndices(loops: readonly RegionLoop[], region: number): number[] {
  const r = loops[region];
  if (!r) return [];
  return [...new Set([...r.ents, ...r.holes.flatMap((h) => loops[h]?.ents ?? [])])].sort((a, b) => a - b);
}

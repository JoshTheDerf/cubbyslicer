/**
 * Desktop OrcaSlicer 2.5's prime tower placement geometry, ported 1:1 so the
 * Prepare view places and drags the tower the way desktop does:
 *
 * - `clampAnchor`: PartPlate::estimate_wipe_tower_polygon's clamp (a position
 *   valid by WIPE_TOWER_MARGIN stays; one more than 5 mm out is re-placed with
 *   the 15 mm comfort margin).
 * - `relocateAnchor`: the same function's obstacle search when it re-placed the
 *   tower (`nearest_clear_wipe_tower_anchor`, libslic3r/GCode/WipeTowerEstimate.cpp):
 *   the clear spot nearest the saved position, keeping off every object's
 *   convex hull grown by its brim and WIPE_TOWER_MARGIN (PartPlate::wipe_tower_obstacles).
 * - `moveBoxInsidePolygon`: WipeTower::move_box_inside_polygon, the drag clamp
 *   (Selection::translate) and the move into a shaped printable area.
 *
 * All in mm, plate-local (the frame of `wipe_tower_x/y` and the slice job).
 */

export type P2 = [number, number];
export type Poly = P2[];
export interface Box2 { min: P2; max: P2 }

/** libslic3r.h */
export const WIPE_TOWER_MARGIN = 1;
export const WIPE_TOWER_AUTO_MARGIN = 15;
/** SCALED_EPSILON (100 scaled units) in mm. */
const EPS = 1e-4;

const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull, counter-clockwise, no collinear points (Andrew's monotone chain). */
export function convexHull(points: readonly P2[]): Poly {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: P2[] = [], upper: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/** 2D convex hull of a mesh's vertices under a column-major 4x4 transform (ModelObject::convex_hull_2d). */
export function meshHull2d(positions: ArrayLike<number>, t: readonly number[]): Poly {
  const pts: P2[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    pts.push([t[0] * x + t[4] * y + t[8] * z + t[12], t[1] * x + t[5] * y + t[9] * z + t[13]]);
  }
  return convexHull(pts);
}

export function rotatePoly(poly: readonly P2[], deg: number): Poly {
  if (!deg) return poly.map((p) => [p[0], p[1]] as P2);
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return poly.map(([x, y]) => [x * c - y * s, x * s + y * c] as P2);
}

export function translatePoly(poly: readonly P2[], dx: number, dy: number): Poly {
  return poly.map(([x, y]) => [x + dx, y + dy] as P2);
}

export function boundsOf(poly: readonly P2[]): Box2 {
  const min: P2 = [Infinity, Infinity], max: P2 = [-Infinity, -Infinity];
  for (const [x, y] of poly) {
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
  }
  return { min, max };
}

/**
 * A convex polygon grown by `delta` with mitred corners (Clipper's default jtMiter,
 * miter limit 3: sharper corners are squared off), as Slic3r::offset(polygon, delta).
 */
export function offsetConvex(poly: readonly P2[], delta: number): Poly {
  const h = convexHull(poly);
  if (h.length < 3 || delta === 0) return h;
  const n = h.length, out: P2[] = [];
  const normal = (a: P2, b: P2): P2 => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l]; };
  for (let i = 0; i < n; i++) {
    const prev = h[(i + n - 1) % n], cur = h[i], next = h[(i + 1) % n];
    const n1 = normal(prev, cur), n2 = normal(cur, next);
    const cosA = n1[0] * n2[0] + n1[1] * n2[1];
    const r = 1 + cosA; // 2cos²(θ/2)
    if (r < 2 / (3 * 3)) {
      // Past the miter limit: square the corner.
      out.push([cur[0] + n1[0] * delta, cur[1] + n1[1] * delta], [cur[0] + n2[0] * delta, cur[1] + n2[1] * delta]);
    } else {
      const k = delta / r;
      out.push([cur[0] + (n1[0] + n2[0]) * k, cur[1] + (n1[1] + n2[1]) * k]);
    }
  }
  return out;
}

/** Strictly inside a convex counter-clockwise polygon (touching the outline is not inside). */
function insideConvex(poly: readonly P2[], p: P2, tol = 1e-9): boolean {
  if (poly.length < 3) return false;
  for (let i = 0; i < poly.length; i++) if (cross(poly[i], poly[(i + 1) % poly.length], p) <= tol) return false;
  return true;
}

/** Inside or on any polygon (even-odd ray cast + on-edge check). */
export function pointInPolygon(poly: readonly P2[], p: P2, tol = 1e-7): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (distSqToSegment(p, a, b).d <= tol * tol) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distSqToSegment(p: P2, a: P2, b: P2): { d: number; q: P2 } {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  let t = l > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  const q: P2 = [a[0] + t * dx, a[1] + t * dy];
  return { d: (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2, q };
}

/** Parameters t in (0,1) where segment ab crosses segment cd. */
function crossings(a: P2, b: P2, c: P2, d: P2, out: number[]): void {
  const r: P2 = [b[0] - a[0], b[1] - a[1]], s: P2 = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return;
  const qp: P2 = [c[0] - a[0], c[1] - a[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  if (t > 1e-12 && t < 1 - 1e-12 && u >= -1e-12 && u <= 1 + 1e-12) out.push(t);
}

/**
 * nearest_clear_wipe_tower_anchor: the anchor nearest `target`, within `bounds`,
 * at which `footprint` (tower-local, anchored at its origin) overlaps no
 * obstacle (touching is allowed); null when every anchor is blocked.
 */
export function nearestClearAnchor(bounds: Box2, footprint: readonly P2[], obstacles: readonly (readonly P2[])[], target: P2): P2 | null {
  const tower = convexHull(footprint);
  // The anchors that put the footprint on a convex obstacle: the obstacle grown by the reflected footprint.
  const blocked = obstacles.map((o) => {
    const diffs: P2[] = [];
    for (const p of o) for (const f of tower) diffs.push([p[0] - f[0], p[1] - f[1]]);
    return convexHull(diffs);
  }).filter((b) => b.length >= 3);
  const b: Box2 = { min: [bounds.min[0] - EPS, bounds.min[1] - EPS], max: [bounds.max[0] + EPS, bounds.max[1] + EPS] };
  const rect: Poly = [[b.min[0], b.min[1]], [b.max[0], b.min[1]], [b.max[0], b.max[1]], [b.min[0], b.max[1]]];
  const inBounds = (p: P2) => p[0] >= b.min[0] - 1e-9 && p[0] <= b.max[0] + 1e-9 && p[1] >= b.min[1] - 1e-9 && p[1] <= b.max[1] + 1e-9;
  const free = (p: P2) => inBounds(p) && !blocked.some((q) => insideConvex(q, p));
  if (free(target)) return target;
  // The clear region's outline is made of pieces of the bounds and of the blocked polygons' edges.
  const loops = [rect, ...blocked];
  let best: P2 | null = null, bestD = Infinity;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], c = loop[(i + 1) % loop.length];
      const ts = [0, 1];
      for (const other of loops) {
        if (other === loop) continue;
        for (let j = 0; j < other.length; j++) crossings(a, c, other[j], other[(j + 1) % other.length], ts);
      }
      ts.sort((x, y) => x - y);
      for (let k = 0; k + 1 < ts.length; k++) {
        const t0 = ts[k], t1 = ts[k + 1];
        if (t1 - t0 < 1e-12) continue;
        const p0: P2 = [a[0] + (c[0] - a[0]) * t0, a[1] + (c[1] - a[1]) * t0];
        const p1: P2 = [a[0] + (c[0] - a[0]) * t1, a[1] + (c[1] - a[1]) * t1];
        const mid: P2 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
        if (!free(mid)) continue;
        const { d, q } = distSqToSegment(target, p0, p1);
        if (d < bestD) { bestD = d; best = q; }
      }
    }
  }
  return best;
}

/**
 * WipeTower::move_box_inside_polygon: the shift that brings `box` inside the
 * printable area, `offset` from its outline. Rectangular beds clamp per axis
 * (a dragged tower slides along the edge); shaped beds walk towards the middle.
 */
export function moveBoxInsidePolygon(box: Box2, polygons: readonly (readonly P2[])[], offset: number): P2 {
  if (!polygons.length) return [0, 0];
  const bed = boundsOf(polygons.flat());
  const bw = box.max[0] - box.min[0], bh = box.max[1] - box.min[1];
  if (bw >= bed.max[0] - bed.min[0] - 2 * offset || bh >= bed.max[1] - bed.min[1] - 2 * offset) return [0, 0];
  const shift: P2 = [0, 0];
  for (const axis of [0, 1] as const) {
    if (box.max[axis] > bed.max[axis] - offset) shift[axis] = bed.max[axis] - offset - box.max[axis];
    else if (box.min[axis] < bed.min[axis] + offset) shift[axis] = bed.min[axis] + offset - box.min[axis];
  }
  let area = 0;
  for (const p of polygons) area += Math.abs(polyArea(p));
  const bedArea = (bed.max[0] - bed.min[0]) * (bed.max[1] - bed.min[1]);
  if (area >= bedArea * (1 - 1e-5)) return shift;
  const pad = Math.max(offset, 0) - EPS;
  const padded: Box2 = { min: [box.min[0] - pad + shift[0], box.min[1] - pad + shift[1]], max: [box.max[0] + pad + shift[0], box.max[1] + pad + shift[1]] };
  const fits = (m: P2) => {
    const corners: P2[] = [[padded.min[0] + m[0], padded.min[1] + m[1]], [padded.max[0] + m[0], padded.min[1] + m[1]],
      [padded.max[0] + m[0], padded.max[1] + m[1]], [padded.min[0] + m[0], padded.max[1] + m[1]]];
    return corners.every((c) => polygons.some((p) => pointInPolygon(p, c)));
  };
  if (fits([0, 0])) return shift;
  let lo: P2 = [0, 0];
  let hi: P2 = [(bed.min[0] + bed.max[0]) / 2 - (padded.min[0] + padded.max[0]) / 2, (bed.min[1] + bed.max[1]) / 2 - (padded.min[1] + padded.max[1]) / 2];
  if (!fits(hi)) return shift;
  for (let i = 0; i < 12; i++) {
    const mid: P2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
    if (fits(mid)) hi = mid; else lo = mid;
  }
  return [shift[0] + hi[0], shift[1] + hi[1]];
}

function polyArea(p: readonly P2[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  return a / 2;
}

/** The tower's size as estimate_wipe_tower_polygon sees it. */
export interface TowerSize {
  width: number;
  depth: number;
  /** Resolved brim width. */
  brim: number;
  /** Type2 cone bulge past the body box. */
  cone: number;
  rotation: number;
}

export interface ClampResult {
  x: number;
  y: number;
  /** Re-placed (more than 5 mm out), not just snapped onto the bound. */
  replaced: boolean;
  /** Comfort bounds (15 mm margin) and validity bounds (1 mm margin) for the anchor. */
  comfort: Box2;
  valid: Box2;
}

/** estimate_wipe_tower_polygon's clamp of a saved anchor on a plate `plateW` × `plateD`. */
export function clampAnchor(x: number, y: number, s: TowerSize, plateW: number, plateD: number): ClampResult {
  const wb = s.brim + s.cone;
  const margin = WIPE_TOWER_MARGIN + wb;
  const xHi = Math.max(margin, plateW - s.width - margin), yHi = Math.max(margin, plateD - s.depth - margin);
  const marginC = WIPE_TOWER_AUTO_MARGIN + wb;
  let xLoC = marginC, xHiC = plateW - s.width - marginC;
  if (xLoC > xHiC) { xLoC = margin; xHiC = xHi; }
  let yLoC = marginC, yHiC = plateD - s.depth - marginC;
  if (yLoC > yHiC) { yLoC = margin; yHiC = yHi; }
  const tol = 5;
  const replaceX = x < margin - tol || x > xHi + tol;
  const replaceY = y < margin - tol || y > yHi + tol;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    x: replaceX ? clamp(x, xLoC, xHiC) : clamp(x, margin, xHi),
    y: replaceY ? clamp(y, yLoC, yHiC) : clamp(y, margin, yHi),
    replaced: replaceX || replaceY,
    comfort: { min: [xLoC, yLoC], max: [xHiC, yHiC] },
    valid: { min: [margin, margin], max: [xHi, yHi] },
  };
}

/** The tower footprint the obstacle search keeps clear: body box grown by brim + cone, turned about the anchor. */
export function towerKeepOut(s: TowerSize): Poly {
  const wb = s.brim + s.cone;
  return rotatePoly([[-wb, -wb], [s.width + wb, -wb], [s.width + wb, s.depth + wb], [-wb, s.depth + wb]], s.rotation);
}

/** PartPlate::wipe_tower_obstacles: an object's outline grown by its brim (none for no_brim) and WIPE_TOWER_MARGIN. */
export function towerObstacle(hull: readonly P2[], brim: number): Poly {
  return offsetConvex(hull, brim + WIPE_TOWER_MARGIN);
}

export interface Relocation { x: number; y: number; moved: boolean; overlapsObjects: boolean }

/**
 * estimate_wipe_tower_polygon with a WipeTowerRelocation: clamp the saved
 * anchor; when that re-placed it, take the re-placed spot if clear of the
 * objects, else the clear spot nearest the saved one (comfort bounds first,
 * then the validity bounds); none clear = it stays on an object.
 */
export function relocateAnchor(x: number, y: number, s: TowerSize, plateW: number, plateD: number,
                               obstacles: () => readonly (readonly P2[])[]): Relocation {
  const c = clampAnchor(x, y, s, plateW, plateD);
  if (!c.replaced) return { x: c.x, y: c.y, moved: false, overlapsObjects: false };
  const tower = towerKeepOut(s);
  const objs = obstacles();
  const placed: P2 = [c.x, c.y];
  if (nearestClearAnchor({ min: placed, max: placed }, tower, objs, placed)) return { x: c.x, y: c.y, moved: true, overlapsObjects: false };
  const clear = nearestClearAnchor(c.comfort, tower, objs, [x, y]) ?? nearestClearAnchor(c.valid, tower, objs, [x, y]);
  if (clear) return { x: clear[0], y: clear[1], moved: true, overlapsObjects: false };
  return { x: c.x, y: c.y, moved: true, overlapsObjects: true };
}

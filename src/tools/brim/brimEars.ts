/**
 * Brim ears (Orca GLGizmoBrimEars): the object's first-layer outline, ear
 * auto-generation by corner angle, and the "invalid ear" check.
 *
 *  - first layer: the object's model parts sliced at z = 0.1 mm above its
 *    bottom (world XY);
 *  - auto-generate: Douglas–Peucker simplify each loop by the detection
 *    radius, then take outer-contour convex corners / hole concave corners
 *    whose turn exceeds 180° − max angle (Polygon::convex_points);
 *  - an ear is invalid when its disc doesn't touch the first layer (Orca
 *    find_single).
 */
import { pointInPolygon, type Pt } from '../../project/math';

export interface Loop { pts: Pt[]; hole: boolean }

export const EAR_DEFAULTS = { maxAngle: 125, detectionRadius: 1, headDiameterMin: 5, headDiameterMax: 20 };

/** Orca get_brim_default_radius(): initial layer line width × 16 is the *diameter*. */
export function defaultHeadDiameter(initialLineWidth: number, nozzle: number): number {
  const w = initialLineWidth > 0 ? initialLineWidth : nozzle > 0 ? nozzle : 0.4;
  return Math.max(EAR_DEFAULTS.headDiameterMin, Math.min(EAR_DEFAULTS.headDiameterMax, w * 16));
}

/**
 * Slice triangles (already in world coordinates) with the plane z = h:
 * closed loops in XY. Loops are classified outer / hole by nesting depth and
 * oriented outer CCW, holes CW.
 */
export function sliceAtZ(world: Float32Array, indices: Uint32Array, h: number): Loop[] {
  const segs: Array<[Pt, Pt]> = [];
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]].map((i) => [world[i * 3], world[i * 3 + 1], world[i * 3 + 2]]);
    const pts: Pt[] = [];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      const da = a[2] - h, db = b[2] - h;
      if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
        const s = da / (da - db);
        pts.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
      }
    }
    if (pts.length === 2) segs.push([pts[0], pts[1]]);
  }
  return chainSegments(segs);
}

function keyOf(p: Pt): string { return `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`; }

function chainSegments(segs: Array<[Pt, Pt]>): Loop[] {
  // Undirected chaining (triangle winding may be mixed after mirroring etc.).
  const adj = new Map<string, Array<{ other: string; seg: number }>>();
  const pt = new Map<string, Pt>();
  segs.forEach(([a, b], i) => {
    const ka = keyOf(a), kb = keyOf(b);
    if (ka === kb) return;
    pt.set(ka, a); pt.set(kb, b);
    (adj.get(ka) ?? adj.set(ka, []).get(ka)!).push({ other: kb, seg: i });
    (adj.get(kb) ?? adj.set(kb, []).get(kb)!).push({ other: ka, seg: i });
  });
  const used = new Set<number>();
  const loops: Pt[][] = [];
  for (const [start, list] of adj) {
    for (const first of list) {
      if (used.has(first.seg)) continue;
      const loop: Pt[] = [pt.get(start)!];
      used.add(first.seg);
      let cur = first.other;
      for (let guard = 0; guard < segs.length + 2 && cur !== start; guard++) {
        loop.push(pt.get(cur)!);
        const nx = adj.get(cur)?.find((e) => !used.has(e.seg));
        if (!nx) break;
        used.add(nx.seg);
        cur = nx.other;
      }
      if (cur === start && loop.length >= 3) loops.push(loop);
    }
  }
  return classify(loops);
}

export function area(p: Pt[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  return -a / 2; // > 0 CCW
}

function classify(loops: Pt[][]): Loop[] {
  return loops.map((l, i) => {
    const probe = l[0];
    let depth = 0;
    loops.forEach((o, j) => { if (j !== i && pointInPolygon(probe, o, 0)) depth++; });
    const hole = depth % 2 === 1;
    const ccw = area(l) > 0;
    const pts = hole === ccw ? l.slice().reverse() : l;
    return { pts, hole };
  });
}

/** Douglas–Peucker on a closed loop (Orca: loop closed by repeating the first point). */
export function douglasPeucker(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3 || tol <= 0) return pts;
  const closed = [...pts, pts[0]];
  const keep = new Uint8Array(closed.length);
  keep[0] = keep[closed.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, closed.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let best = -1, bd = 0;
    const [ax, ay] = closed[s], [bx, by] = closed[e];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = closed[i];
      let d: number;
      if (l2 < 1e-18) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0 && bd > tol) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  const out = closed.filter((_, i) => keep[i]);
  // Orca drops the closing duplicate only when more than 4 points remain.
  if (out.length > 4) out.pop();
  else if (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

/** Polygon::convex_points / concave_points with an angle threshold (radians). */
export function cornerPoints(pts: Pt[], threshold: number, convex: boolean): Pt[] {
  const n = pts.length;
  if (n < 3) return [];
  const cosT = Math.cos(threshold + 1e-12);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const v1: Pt = [p1[0] - p0[0], p1[1] - p0[1]], v2: Pt = [p2[0] - p1[0], p2[1] - p1[1]];
    const c = v1[0] * v2[1] - v1[1] * v2[0];
    if (convex ? !(c > 0) : !(c < 0)) continue;
    if (threshold > 1e-9) {
      const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
      if (!(l1 > 0 && l2 > 0)) continue;
      if ((v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2) >= cosT) continue;
    }
    out.push(p1);
  }
  return out;
}

/** Orca generate_points() over all first-layer loops. Holes are walked reversed (CCW) and yield concave corners. */
export function autoEarPoints(loops: Loop[], detectionRadius: number, maxAngleDeg: number): Pt[] {
  const threshold = ((180 - maxAngleDeg) * Math.PI) / 180;
  const out: Pt[] = [];
  for (const l of loops) {
    const pts = l.hole ? l.pts.slice().reverse() : l.pts;
    const simp = detectionRadius > 0 ? douglasPeucker(pts, detectionRadius) : pts;
    out.push(...cornerPoints(simp, Math.max(0, Math.min(Math.PI - 1e-6, threshold)), !l.hole));
  }
  return out;
}

function distToLoop(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

/** Is p inside the first layer (inside an outer loop and not inside one of its holes)? */
export function insideLayer(p: Pt, loops: Loop[]): boolean {
  let depth = 0;
  for (const l of loops) if (pointInPolygon(p, l.pts, 0)) depth++;
  return depth % 2 === 1;
}

/**
 * Orca find_single(): an ear is valid when its disc overlaps the first layer
 * or (transitively) another valid ear. Returns the invalid indices.
 */
export function invalidEars(ears: Array<{ p: Pt; r: number }>, loops: Loop[]): Set<number> {
  const valid = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    ears.forEach((e, i) => {
      if (valid.has(i)) return;
      const touches = insideLayer(e.p, loops) || loops.some((l) => distToLoop(e.p, l.pts) <= e.r)
        || [...valid].some((j) => Math.hypot(ears[j].p[0] - e.p[0], ears[j].p[1] - e.p[1]) <= ears[j].r + e.r);
      if (touches) { valid.add(i); grew = true; }
    });
  }
  return new Set(ears.map((_, i) => i).filter((i) => !valid.has(i)));
}

/** Orca get_detection_radius_max() (bounded slider range), in mm. */
export function detectionRadiusMax(loops: Loop[]): number {
  let maxDist = 0;
  for (const l of loops) {
    if (l.hole) continue;
    let tol = 0, min = douglasPeucker(l.pts, 0).length, repeat = 0;
    for (let guard = 0; guard < 100; guard++) {
      tol += 10;
      const n = douglasPeucker(l.pts, tol).length;
      if (n === min) { repeat++; if (repeat > 1) break; }
      min = n;
    }
    for (let guard = 0; guard < 100; guard++) {
      tol -= 1;
      if (tol <= 0) break;
      const n = douglasPeucker(l.pts, tol).length;
      if (n <= min) min = n; else break;
    }
    tol += 1;
    maxDist = Math.max(maxDist, tol);
  }
  return maxDist > 100 || maxDist <= 0 ? 100 : maxDist;
}

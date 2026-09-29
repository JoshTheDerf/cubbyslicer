/**
 * Surface features for the measure tool (Orca / PrusaSlicer Measure.cpp):
 * a mesh is segmented into planes (coplanar, edge-connected triangles); the
 * border of each plane is split into straight edges and circles / arcs.
 * Hovering picks the feature under the cursor in this order: circle centre →
 * circle → edge endpoint → edge → plane (Shift: the exact surface point).
 *
 * Everything here is mesh-local (the tool transforms features to world).
 */

export type V3 = [number, number, number];

export type Feature =
  | { type: 'point'; p: V3 }
  | { type: 'edge'; a: V3; b: V3 }
  | { type: 'circle'; c: V3; n: V3; r: number }
  | { type: 'plane'; o: V3; n: V3; plane: number };

export interface PlaneInfo {
  normal: V3;
  origin: V3;
  tris: number[];
  /** Border features, computed on first use. */
  edges?: Array<{ a: V3; b: V3 }>;
  circles?: Array<{ c: V3; n: V3; r: number }>;
}

export interface MeshAnalysis {
  planeOfTri: Int32Array;
  planes: PlaneInfo[];
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  adj: Int32Array;
}

const ANGLE_TOL = Math.cos((0.5 * Math.PI) / 180);

// ---- small vector helpers ----
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; };
export const dist = (a: V3, b: V3): number => len(sub(a, b));

function vtx(pos: ArrayLike<number>, i: number): V3 { return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]; }

/** Triangle adjacency across each edge (-1 = border or non-manifold edge). */
export function triangleAdjacency(indices: ArrayLike<number>): Int32Array {
  const T = indices.length / 3;
  const adj = new Int32Array(T * 3).fill(-1);
  const map = new Map<string, number>();
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t * 3 + k], b = indices[t * 3 + ((k + 1) % 3)];
      const rev = `${b},${a}`;
      const o = map.get(rev);
      if (o !== undefined && o >= 0) {
        adj[t * 3 + k] = Math.floor(o / 3);
        adj[o] = t;
        map.set(rev, -1); // consumed; a third triangle on this edge stays unlinked
      } else if (o === undefined) {
        map.set(`${a},${b}`, t * 3 + k);
      }
    }
  }
  return adj;
}

/** Segment the mesh into planes. */
export function analyzeMesh(positions: ArrayLike<number>, indices: ArrayLike<number>): MeshAnalysis {
  const T = indices.length / 3;
  const adj = triangleAdjacency(indices);
  const normals = new Float64Array(T * 3);
  let diag = 0;
  {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      x0 = Math.min(x0, positions[i]); x1 = Math.max(x1, positions[i]);
      y0 = Math.min(y0, positions[i + 1]); y1 = Math.max(y1, positions[i + 1]);
      z0 = Math.min(z0, positions[i + 2]); z1 = Math.max(z1, positions[i + 2]);
    }
    diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1;
  }
  const distTol = Math.max(1e-3, diag * 1e-5);
  for (let t = 0; t < T; t++) {
    const a = vtx(positions, indices[t * 3]), b = vtx(positions, indices[t * 3 + 1]), c = vtx(positions, indices[t * 3 + 2]);
    const n = norm(cross(sub(b, a), sub(c, a)));
    normals[t * 3] = n[0]; normals[t * 3 + 1] = n[1]; normals[t * 3 + 2] = n[2];
  }
  const planeOfTri = new Int32Array(T).fill(-1);
  const planes: PlaneInfo[] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < T; seed++) {
    if (planeOfTri[seed] >= 0) continue;
    const n: V3 = [normals[seed * 3], normals[seed * 3 + 1], normals[seed * 3 + 2]];
    const o = vtx(positions, indices[seed * 3]);
    const d0 = dot(n, o);
    const pi = planes.length;
    const tris: number[] = [];
    planeOfTri[seed] = pi;
    stack.push(seed);
    while (stack.length) {
      const t = stack.pop()!;
      tris.push(t);
      for (let k = 0; k < 3; k++) {
        const u = adj[t * 3 + k];
        if (u < 0 || planeOfTri[u] >= 0) continue;
        if (normals[u * 3] * n[0] + normals[u * 3 + 1] * n[1] + normals[u * 3 + 2] * n[2] < ANGLE_TOL) continue;
        let ok = true;
        for (let j = 0; j < 3 && ok; j++) if (Math.abs(dot(n, vtx(positions, indices[u * 3 + j])) - d0) > distTol) ok = false;
        if (!ok) continue;
        planeOfTri[u] = pi;
        stack.push(u);
      }
    }
    // Origin: area-weighted centroid of the plane's triangles.
    let ax = 0, ay = 0, az = 0, aw = 0;
    for (const t of tris) {
      const a = vtx(positions, indices[t * 3]), b = vtx(positions, indices[t * 3 + 1]), c = vtx(positions, indices[t * 3 + 2]);
      const w = len(cross(sub(b, a), sub(c, a))) / 2 || 1e-12;
      ax += (a[0] + b[0] + c[0]) / 3 * w; ay += (a[1] + b[1] + c[1]) / 3 * w; az += (a[2] + b[2] + c[2]) / 3 * w; aw += w;
    }
    planes.push({ normal: n, origin: [ax / aw, ay / aw, az / aw], tris });
  }
  return { planeOfTri, planes, positions, indices, adj };
}

/** Border loops of a plane (vertex index chains, wound with the plane). */
export function planeBorderLoops(m: MeshAnalysis, plane: number): number[][] {
  const { indices, adj, planeOfTri } = m;
  const next = new Map<number, number[]>();
  for (const t of m.planes[plane].tris) {
    for (let k = 0; k < 3; k++) {
      const u = adj[t * 3 + k];
      if (u >= 0 && planeOfTri[u] === plane) continue;
      const a = indices[t * 3 + k], b = indices[t * 3 + ((k + 1) % 3)];
      const l = next.get(a);
      if (l) l.push(b); else next.set(a, [b]);
    }
  }
  const loops: number[][] = [];
  for (const start of [...next.keys()]) {
    if (!next.get(start)?.length) continue;
    const loop: number[] = [];
    let v = start;
    for (let guard = 0; guard < 1e7; guard++) {
      loop.push(v);
      const n = next.get(v)?.pop();
      if (n === undefined || n === start) break;
      v = n;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Circle through three points (null when collinear). */
export function circleFrom3(a: V3, b: V3, c: V3): { c: V3; n: V3; r: number } | null {
  const ab = sub(b, a), ac = sub(c, a);
  const n = cross(ab, ac);
  const nl2 = dot(n, n);
  if (nl2 < 1e-18) return null;
  const t = add(scl(cross(n, ab), dot(ac, ac)), scl(cross(ac, n), dot(ab, ab)));
  const off = scl(t, 1 / (2 * nl2));
  return { c: add(a, off), n: norm(n), r: len(off) };
}

/**
 * Split a closed border polyline into straight edges and arcs → circles.
 * Arcs are runs of ≥ 4 consecutive segments of similar length turning by a
 * similar, small angle in the same direction (tessellated holes / fillets).
 */
export function splitBorder(pts: V3[], normal: V3): { edges: Array<{ a: V3; b: V3 }>; circles: Array<{ c: V3; n: V3; r: number }> } {
  // Remove collinear points (turn < ~0.3°).
  let p = pts.slice();
  for (let changed = true; changed && p.length > 3;) {
    changed = false;
    for (let i = 0; i < p.length && p.length > 3; i++) {
      const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
      const u = norm(sub(b, a)), v = norm(sub(c, b));
      if (dot(u, v) > 0.99999 || dist(a, b) < 1e-9) { p.splice(i, 1); i--; changed = true; }
    }
  }
  const n = p.length;
  const edges: Array<{ a: V3; b: V3 }> = [];
  const circles: Array<{ c: V3; n: V3; r: number }> = [];
  if (n < 3) return { edges, circles };
  const segLen = (i: number) => dist(p[i], p[(i + 1) % n]);
  // Signed turn at vertex i (between segment i-1 and i), around the plane normal.
  const turn = (i: number) => {
    const u = norm(sub(p[i], p[(i + n - 1) % n])), v = norm(sub(p[(i + 1) % n], p[i]));
    return Math.atan2(dot(cross(u, v), normal), dot(u, v));
  };
  const turns = Array.from({ length: n }, (_, i) => turn(i));
  const lens = Array.from({ length: n }, (_, i) => segLen(i));
  const similar = (i: number, j: number) => {
    const ti = turns[i], tj = turns[j];
    if (Math.sign(ti) !== Math.sign(tj) || Math.abs(ti) < 1e-3 || Math.abs(ti) > Math.PI / 4) return false;
    return Math.abs(ti - tj) <= Math.max(0.2 * Math.abs(ti), 0.01) && Math.abs(lens[i] - lens[j]) <= 0.2 * Math.max(lens[i], lens[j]);
  };
  // Whole loop a circle?
  if (n >= 8 && turns.every((_, i) => similar(i, 0))) {
    const c = circleFrom3(p[0], p[Math.floor(n / 3)], p[Math.floor((2 * n) / 3)]);
    if (c) { circles.push({ c: c.c, n: normal, r: c.r }); return { edges, circles }; }
  }
  // Find arc runs over segments: segment i is "arc-like" with segment i+1 when vertex i+1's turn is similar to vertex i's.
  const inArc = new Array<boolean>(n).fill(false);
  // Start scanning after a non-similar vertex so runs don't wrap mid-way.
  let startAt = 0;
  for (let i = 0; i < n; i++) if (!similar(i, (i + 1) % n)) { startAt = (i + 1) % n; break; }
  let i = 0;
  while (i < n) {
    const s = (startAt + i) % n;
    let j = i;
    while (j + 1 < n && similar((startAt + j) % n, (startAt + j + 1) % n)) j++;
    // vertices s..(startAt+j) have similar turns → segments between them form the arc.
    const count = j - i; // number of segments fully inside the run
    if (count >= 3) {
      const first = p[(s + n - 1) % n], mid = p[(startAt + i + Math.floor((j - i) / 2)) % n], last = p[(startAt + j + 1) % n];
      const c = circleFrom3(first, mid, last);
      if (c) {
        circles.push({ c: c.c, n: normal, r: c.r });
        for (let k = i - 1; k <= j; k++) inArc[(startAt + k + n) % n] = true;
      }
    }
    i = j + 1;
  }
  for (let k = 0; k < n; k++) if (!inArc[k]) edges.push({ a: p[k], b: p[(k + 1) % n] });
  return { edges, circles };
}

export function ensurePlaneBorder(m: MeshAnalysis, plane: number): PlaneInfo {
  const pl = m.planes[plane];
  if (pl.edges) return pl;
  pl.edges = [];
  pl.circles = [];
  for (const loop of planeBorderLoops(m, plane)) {
    const r = splitBorder(loop.map((v) => vtx(m.positions, v)), pl.normal);
    pl.edges.push(...r.edges);
    pl.circles.push(...r.circles);
  }
  return pl;
}

function pointSegDist(p: V3, a: V3, b: V3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return dist(p, add(a, scl(ab, t)));
}

/** The feature under a surface hit (mesh-local point on triangle `tri`), with a pick tolerance in mesh units. */
export function pickFeature(m: MeshAnalysis, tri: number, p: V3, tol: number, surfacePoint = false): Feature {
  if (surfacePoint) return { type: 'point', p };
  const plane = m.planeOfTri[tri];
  if (plane < 0) return { type: 'point', p };
  const pl = ensurePlaneBorder(m, plane);
  for (const c of pl.circles!) if (dist(p, c.c) < tol * 1.5) return { type: 'point', p: c.c };
  for (const c of pl.circles!) if (Math.abs(dist(p, c.c) - c.r) < tol) return { type: 'circle', c: c.c, n: c.n, r: c.r };
  let best: { e: { a: V3; b: V3 }; d: number } | null = null;
  for (const e of pl.edges!) {
    if (dist(p, e.a) < tol) return { type: 'point', p: e.a };
    if (dist(p, e.b) < tol) return { type: 'point', p: e.b };
    const d = pointSegDist(p, e.a, e.b);
    if (d < tol && (!best || d < best.d)) best = { e, d };
  }
  if (best) return { type: 'edge', a: best.e.a, b: best.e.b };
  return { type: 'plane', o: pl.origin, n: pl.normal, plane };
}

/** Transform a feature by a column-major 4x4 (mesh-local → world). */
export function transformFeature(f: Feature, m: ArrayLike<number>): Feature {
  const tp = (v: V3): V3 => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
  // Normal matrix = inverse transpose of the linear part (cofactor matrix works up to scale).
  const c0: V3 = [m[0], m[1], m[2]], c1: V3 = [m[4], m[5], m[6]], c2: V3 = [m[8], m[9], m[10]];
  const tn = (v: V3): V3 => {
    const r0 = cross(c1, c2), r1 = cross(c2, c0), r2 = cross(c0, c1);
    const det = dot(c0, r0);
    const out = norm([r0[0] * v[0] + r1[0] * v[1] + r2[0] * v[2], r0[1] * v[0] + r1[1] * v[1] + r2[1] * v[2], r0[2] * v[0] + r1[2] * v[1] + r2[2] * v[2]]);
    return det < 0 ? scl(out, -1) : out;
  };
  switch (f.type) {
    case 'point': return { type: 'point', p: tp(f.p) };
    case 'edge': return { type: 'edge', a: tp(f.a), b: tp(f.b) };
    case 'plane': return { type: 'plane', o: tp(f.o), n: tn(f.n), plane: f.plane };
    case 'circle': {
      // Radius: scale of an in-plane direction.
      const u = norm(Math.abs(f.n[0]) < 0.9 ? cross(f.n, [1, 0, 0]) : cross(f.n, [0, 1, 0]));
      const r = dist(tp(add(f.c, scl(u, f.r))), tp(f.c));
      return { type: 'circle', c: tp(f.c), n: tn(f.n), r };
    }
  }
}

export const FEATURE_LABELS: Record<Feature['type'], string> = { point: 'Point', edge: 'Edge', circle: 'Circle', plane: 'Plane' };

/**
 * Derived world-space geometry for project objects: bbox + XY footprint
 * (convex hull). The expensive part — transforming every vertex by R*S — is
 * cached per (mesh, rotation, scale), so moving objects is O(hull size).
 */
import { convexHull, linearRS, type Pt, type Quat, type Vec3 } from './math';
import type { MeshData, ObjectPart, ProjectObject } from './types';

export interface LinearInfo {
  /** Bounds of R*S*v (no translation). */
  min: Vec3;
  max: Vec3;
  /** CCW convex hull of the XY projection of R*S*v. */
  hull: Pt[];
}

export interface WorldInfo {
  min: Vec3;
  max: Vec3;
  hull: Pt[];
}

const cache = new WeakMap<MeshData, Map<string, LinearInfo>>();
const PER_MESH = 6;

function key(q: Quat, s: Vec3): string {
  return `${q.map((v) => v.toFixed(7)).join(',')}|${s.map((v) => v.toFixed(7)).join(',')}`;
}

/** Transform + XY hull. Akl–Toussaint pre-filter for small meshes, angular buckets for big ones. */
export function computeLinearInfo(positions: Float32Array, q: Quat, s: Vec3): LinearInfo {
  return computeMatrixInfo(positions, linearRS(q, s));
}

/** Same as computeLinearInfo for an arbitrary column-major 3×3 linear map. */
export function computeMatrixInfo(positions: Float32Array, m: ArrayLike<number>): LinearInfo {
  const n = positions.length / 3;
  if (n === 0) return { min: [0, 0, 0], max: [0, 0, 0], hull: [] };
  const xs = new Float64Array(n), ys = new Float64Array(n);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  // Extreme point indices for 8 directions.
  const ext = new Int32Array(8);
  const extV = new Float64Array(8).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const x0 = positions[i * 3], y0 = positions[i * 3 + 1], z0 = positions[i * 3 + 2];
    const x = m[0] * x0 + m[3] * y0 + m[6] * z0;
    const y = m[1] * x0 + m[4] * y0 + m[7] * z0;
    const z = m[2] * x0 + m[5] * y0 + m[8] * z0;
    xs[i] = x; ys[i] = y;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    if (x > extV[0]) { extV[0] = x; ext[0] = i; }
    if (y > extV[1]) { extV[1] = y; ext[1] = i; }
    if (-x > extV[2]) { extV[2] = -x; ext[2] = i; }
    if (-y > extV[3]) { extV[3] = -y; ext[3] = i; }
    const a = x + y, b = x - y;
    if (a > extV[4]) { extV[4] = a; ext[4] = i; }
    if (b > extV[5]) { extV[5] = b; ext[5] = i; }
    if (-b > extV[6]) { extV[6] = -b; ext[6] = i; }
    if (-a > extV[7]) { extV[7] = -a; ext[7] = i; }
  }
  const candidates = n > BUCKET_THRESHOLD ? bucketCandidates(xs, ys, n, minX, minY, maxX, maxY) : aklToussaint(xs, ys, n, ext);
  if (n > BUCKET_THRESHOLD) for (const i of ext) candidates.push([xs[i], ys[i]]); // exact extremes
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], hull: convexHull(candidates) };
}

/** Above this many vertices the hull is computed from angular-bucket extremes. */
const BUCKET_THRESHOLD = 60_000;
const BUCKETS = 4096;

/** Keep points not strictly inside the octagon of 8 directional extremes. */
function aklToussaint(xs: Float64Array, ys: Float64Array, n: number, ext: Int32Array): Pt[] {
  const oct = convexHull([...ext].map((i) => [xs[i], ys[i]] as Pt));
  const out: Pt[] = [];
  if (oct.length < 3) { for (let i = 0; i < n; i++) out.push([xs[i], ys[i]]); return out; }
  const edges = oct.map((a, i) => { const b = oct[(i + 1) % oct.length]; return [a[0], a[1], b[0] - a[0], b[1] - a[1]]; });
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    let inside = true;
    for (const e of edges) if (e[2] * (y - e[1]) - e[3] * (x - e[0]) <= 1e-9) { inside = false; break; }
    if (!inside) out.push([x, y]);
  }
  return out;
}

/**
 * Farthest point from the bbox centre in each of BUCKETS angular sectors
 * (pseudo-angle, no trig). The hull of these differs from the exact hull by
 * well under a micron for plate-sized parts, at O(n) cost.
 */
function bucketCandidates(xs: Float64Array, ys: Float64Array, n: number, minX: number, minY: number, maxX: number, maxY: number): Pt[] {
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const best = new Int32Array(BUCKETS).fill(-1);
  const bestD = new Float64Array(BUCKETS);
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - cx, dy = ys[i] - cy;
    const s = Math.abs(dx) + Math.abs(dy);
    if (s === 0) continue;
    // Pseudo-angle in [0, 4): monotone in the true angle.
    const p = dy >= 0 ? (dx >= 0 ? dy / s : 2 - dy / s) : (dx < 0 ? 2 - dy / s : 4 + dy / s);
    const b = Math.min(BUCKETS - 1, Math.floor((p / 4) * BUCKETS));
    const d = dx * dx + dy * dy;
    if (best[b] < 0 || d > bestD[b]) { best[b] = i; bestD[b] = d; }
  }
  const out: Pt[] = [];
  for (let b = 0; b < BUCKETS; b++) if (best[b] >= 0) out.push([xs[best[b]], ys[best[b]]]);
  return out;
}

export function linearInfo(mesh: MeshData, q: Quat, s: Vec3): LinearInfo {
  let m = cache.get(mesh);
  if (!m) { m = new Map(); cache.set(mesh, m); }
  const k = key(q, s);
  let info = m.get(k);
  if (info) {
    // LRU bump.
    m.delete(k); m.set(k, info);
    return info;
  }
  info = computeLinearInfo(mesh.positions, q, s);
  m.set(k, info);
  if (m.size > PER_MESH) m.delete(m.keys().next().value as string);
  return info;
}

/** Column-major 3×3 product a·b. */
function mul3(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const c = new Array<number>(9);
  for (let col = 0; col < 3; col++) for (let r = 0; r < 3; r++) {
    c[col * 3 + r] = a[r] * b[col * 3] + a[3 + r] * b[col * 3 + 1] + a[6 + r] * b[col * 3 + 2];
  }
  return c;
}

function matrixInfo(mesh: MeshData, m: number[]): LinearInfo {
  let c = cache.get(mesh);
  if (!c) { c = new Map(); cache.set(mesh, c); }
  const k = `M${m.map((v) => v.toFixed(7)).join(',')}`;
  let info = c.get(k);
  if (info) { c.delete(k); c.set(k, info); return info; }
  info = computeMatrixInfo(mesh.positions, m);
  c.set(k, info);
  if (c.size > PER_MESH) c.delete(c.keys().next().value as string);
  return info;
}

/** World info of one part of an object (world = object TRS · part TRS). */
export function partWorldInfo(obj: Pick<ProjectObject, 'position' | 'rotation' | 'scale'>, part: Pick<ObjectPart, 'position' | 'rotation' | 'scale'>, mesh: MeshData): WorldInfo {
  const lo = linearRS(obj.rotation, obj.scale);
  const li = matrixInfo(mesh, mul3(lo, linearRS(part.rotation, part.scale)));
  const p = part.position;
  const px = obj.position[0] + lo[0] * p[0] + lo[3] * p[1] + lo[6] * p[2];
  const py = obj.position[1] + lo[1] * p[0] + lo[4] * p[1] + lo[7] * p[2];
  const pz = obj.position[2] + lo[2] * p[0] + lo[5] * p[1] + lo[8] * p[2];
  return {
    min: [li.min[0] + px, li.min[1] + py, li.min[2] + pz],
    max: [li.max[0] + px, li.max[1] + py, li.max[2] + pz],
    hull: li.hull.map((q) => [q[0] + px, q[1] + py] as Pt),
  };
}

/** Union of world infos (bbox union, hull of both hulls). */
export function mergeWorldInfo(a: WorldInfo, b: WorldInfo): WorldInfo {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
    hull: convexHull([...a.hull, ...b.hull]),
  };
}

export function worldInfo(obj: Pick<ProjectObject, 'position' | 'rotation' | 'scale'>, mesh: MeshData): WorldInfo {
  const li = linearInfo(mesh, obj.rotation, obj.scale);
  const [px, py, pz] = obj.position;
  return {
    min: [li.min[0] + px, li.min[1] + py, li.min[2] + pz],
    max: [li.max[0] + px, li.max[1] + py, li.max[2] + pz],
    hull: li.hull.map((p) => [p[0] + px, p[1] + py] as Pt),
  };
}

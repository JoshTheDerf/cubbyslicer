/**
 * Pure helpers behind the Claude Code bridge tools: argument checks with
 * errors that name the valid options, mesh queries for scriptable painting
 * and "lay on largest face", paint map merging and layer snapping. No Vue,
 * no three, no app state (unit-tested in logic.test.ts).
 */
import type { ConfigValue, PaintMap } from '../engine/types';

type V3 = [number, number, number];

// ---- arguments ----------------------------------------------------------------------------

/** `value` if it is one of `allowed`, else an error naming them. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`"${name}" must be one of ${allowed.map((a) => `"${a}"`).join(', ')}${value === undefined ? '' : ` (got ${JSON.stringify(value)})`}.`);
}

/** A finite number within [min, max] (inclusive), or an error saying so. */
export function inRange(value: unknown, name: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${name}" must be a number.`);
  if (value < min || value > max) {
    const range = Number.isFinite(min) && Number.isFinite(max) ? `between ${min} and ${max}` : Number.isFinite(min) ? `at least ${min}` : `at most ${max}`;
    throw new Error(`"${name}" must be ${range} (got ${value}).`);
  }
  return value;
}

/** [x, y, z] of finite numbers, or null when absent. */
export function vec3(value: unknown, name: string): V3 | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length !== 3 || !value.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new Error(`"${name}" must be [x, y, z] (numbers).`);
  }
  return [value[0], value[1], value[2]];
}

/** A JSON setting value as the engine's serialized form (booleans → "1" / "0", lists stay lists). */
export function settingValue(raw: unknown): ConfigValue {
  if (typeof raw === 'boolean') return raw ? '1' : '0';
  if (Array.isArray(raw)) return raw.map((v) => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v)));
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'object') throw new Error('A setting value must be a string, number, boolean or a list of them.');
  return String(raw);
}

// ---- mesh queries -----------------------------------------------------------------------------

function apply(m: ArrayLike<number>, x: number, y: number, z: number): V3 {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

function triWorld(pos: ArrayLike<number>, idx: ArrayLike<number>, t: number, m: ArrayLike<number>): [V3, V3, V3] {
  const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
  return [apply(m, pos[a], pos[a + 1], pos[a + 2]), apply(m, pos[b], pos[b + 1], pos[b + 2]), apply(m, pos[c], pos[c + 1], pos[c + 2])];
}

/** Area-weighted normal (length = 2 × area) of a world triangle. */
function cross(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function det3(m: ArrayLike<number>): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

/**
 * Triangles whose world normal is within `maxAngleDeg` of `dir` (e.g. [0, 0, -1]
 * with 45° = the overhangs Orca highlights at a 45° threshold). `m` is the
 * column-major mesh → world matrix (a mirroring matrix flips the normals back).
 */
export function trianglesFacing(pos: ArrayLike<number>, idx: ArrayLike<number>, m: ArrayLike<number>, dir: V3, maxAngleDeg: number): number[] {
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(l > 0)) throw new Error('"direction" must not be [0, 0, 0].');
  const d: V3 = [dir[0] / l, dir[1] / l, dir[2] / l];
  const cosMax = Math.cos((Math.max(0, Math.min(180, maxAngleDeg)) * Math.PI) / 180);
  const flip = det3(m) < 0 ? -1 : 1;
  const out: number[] = [];
  const n = idx.length / 3;
  for (let t = 0; t < n; t++) {
    const [a, b, c] = triWorld(pos, idx, t, m);
    const nv = cross(a, b, c);
    const nl = Math.hypot(nv[0], nv[1], nv[2]);
    if (!(nl > 0)) continue;
    if ((flip * (nv[0] * d[0] + nv[1] * d[1] + nv[2] * d[2])) / nl >= cosMax - 1e-9) out.push(t);
  }
  return out;
}

/** Closest point to `p` on triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const sub = (x: V3, y: V3): V3 => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const dot = (x: V3, y: V3) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const at = (o: V3, u: V3, t: number): V3 => [o[0] + u[0] * t, o[1] + u[1] * t, o[2] + u[2] * t];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return at(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** The mesh triangle closest to world point `p`, the closest world point on it and the distance. */
export function nearestTriangle(pos: ArrayLike<number>, idx: ArrayLike<number>, m: ArrayLike<number>, p: V3): { tri: number; point: V3; distance: number } | null {
  let best = -1, bd = Infinity, bp: V3 = [0, 0, 0];
  const n = idx.length / 3;
  for (let t = 0; t < n; t++) {
    const [a, b, c] = triWorld(pos, idx, t, m);
    const q = closestOnTriangle(p, a, b, c);
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
    if (d < bd) { bd = d; best = t; bp = q; }
  }
  return best < 0 ? null : { tri: best, point: bp, distance: Math.sqrt(bd) };
}

/**
 * World normal of the object's largest flat face: triangle areas summed per
 * direction (normals quantised to ~2°), the biggest group wins. Used for
 * "lay on face" without a click.
 */
export function largestFaceNormal(pos: ArrayLike<number>, idx: ArrayLike<number>, m: ArrayLike<number>): V3 | null {
  const groups = new Map<string, { area: number; n: V3 }>();
  const flip = det3(m) < 0 ? -1 : 1;
  const q = (v: number) => Math.round(v * 30);
  const n = idx.length / 3;
  for (let t = 0; t < n; t++) {
    const [a, b, c] = triWorld(pos, idx, t, m);
    const nv = cross(a, b, c);
    const l = Math.hypot(nv[0], nv[1], nv[2]);
    if (!(l > 0)) continue;
    const u: V3 = [flip * nv[0] / l, flip * nv[1] / l, flip * nv[2] / l];
    const key = `${q(u[0])},${q(u[1])},${q(u[2])}`;
    const g = groups.get(key);
    if (g) { g.area += l / 2; g.n = [g.n[0] + u[0] * l, g.n[1] + u[1] * l, g.n[2] + u[2] * l]; }
    else groups.set(key, { area: l / 2, n: [u[0] * l, u[1] * l, u[2] * l] });
  }
  let best: { area: number; n: V3 } | null = null;
  for (const g of groups.values()) if (!best || g.area > best.area) best = g;
  if (!best) return null;
  const l = Math.hypot(best.n[0], best.n[1], best.n[2]);
  return l > 0 ? [best.n[0] / l, best.n[1] / l, best.n[2] / l] : null;
}

// ---- paint -------------------------------------------------------------------------------------

/**
 * Merge per-triangle paint strings: entries of `update` replace the same
 * triangle in `base`; triangles in `clear` lose their paint. Paint strings are
 * independent per triangle (Orca's FacetsAnnotation), so this is exact.
 */
export function mergePaint(base: PaintMap | undefined, update: PaintMap, clear: Iterable<number> = []): PaintMap {
  const out = new Map<number, string>();
  for (const [t, hex] of base ?? []) out.set(t, hex);
  for (const t of clear) out.delete(t);
  for (const [t, hex] of update) out.set(t, hex);
  return [...out.entries()].sort((a, b) => a[0] - b[0]);
}

// ---- layers ---------------------------------------------------------------------------------------

/** Index of the layer whose print Z is closest to `z` (null when there are no layers). */
export function nearestLayer(layerZ: ArrayLike<number>, z: number): number | null {
  let best = -1, bd = Infinity;
  for (let i = 0; i < layerZ.length; i++) { const d = Math.abs(layerZ[i] - z); if (d < bd) { bd = d; best = i; } }
  return best < 0 ? null : best;
}

/** Height bands of a layer height profile [z0, h0, z1, h1, …] → a short summary for results. */
export function profileSummary(profile: readonly number[]): { points: number; minHeight: number; maxHeight: number; top: number } | null {
  if (profile.length < 4) return null;
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < profile.length; i += 2) { lo = Math.min(lo, profile[i]); hi = Math.max(hi, profile[i]); }
  return { points: profile.length / 2, minHeight: lo, maxHeight: hi, top: profile[profile.length - 2] };
}

/**
 * First hit of a world ray on the mesh (Möller–Trumbore over every triangle).
 * Returns the world point and the hit face's world normal (facing the ray), or null.
 */
export function raycastMesh(pos: ArrayLike<number>, idx: ArrayLike<number>, m: ArrayLike<number>, origin: V3, dir: V3): { point: V3; normal: V3; distance: number } | null {
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(l > 0)) return null;
  const d: V3 = [dir[0] / l, dir[1] / l, dir[2] / l];
  let best: { point: V3; normal: V3; distance: number } | null = null;
  const n = idx.length / 3;
  for (let t = 0; t < n; t++) {
    const [a, b, c] = triWorld(pos, idx, t, m);
    const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p: V3 = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const s: V3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
    if (u < 0 || u > 1) continue;
    const q: V3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    if (dist <= 1e-9 || (best && dist >= best.distance)) continue;
    const nv = cross(a, b, c);
    const nl = Math.hypot(nv[0], nv[1], nv[2]) || 1;
    let nn: V3 = [nv[0] / nl, nv[1] / nl, nv[2] / nl];
    if (nn[0] * d[0] + nn[1] * d[1] + nn[2] * d[2] > 0) nn = [-nn[0], -nn[1], -nn[2]];
    best = { point: [origin[0] + d[0] * dist, origin[1] + d[1] * dist, origin[2] + d[2] * dist], normal: nn, distance: dist };
  }
  return best;
}

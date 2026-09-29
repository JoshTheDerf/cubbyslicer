/**
 * Mesh utilities: vertex welding, bounding boxes, recentring. All typed-array
 * based and allocation-conscious so they can run on multi-million-triangle
 * meshes inside the import worker.
 */
import type { BBox3 } from './types';

/** Hard limits. Over these, imports fail with a user-facing message instead of OOM-ing the tab. */
export const LIMITS = {
  maxTriangles: 12_000_000,
  maxFileBytes: 1024 * 1024 * 1024,
};

export class ImportError extends Error {
  constructor(message: string) { super(message); this.name = 'ImportError'; }
}

export function checkTriangleBudget(n: number): void {
  if (n > LIMITS.maxTriangles) {
    throw new ImportError(
      `Model has ${n.toLocaleString()} triangles; the limit is ${LIMITS.maxTriangles.toLocaleString()}. Decimate it and try again.`,
    );
  }
}

/** Growable Float32 / Uint32 buffers (amortised doubling). */
export class GrowF32 {
  data: Float32Array;
  length = 0;
  constructor(initial = 1024) { this.data = new Float32Array(Math.max(16, initial)); }
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) this.grow(this.length + 3);
    const d = this.data, l = this.length;
    d[l] = a; d[l + 1] = b; d[l + 2] = c;
    this.length = l + 3;
  }
  private grow(min: number): void {
    const n = new Float32Array(Math.max(min, this.data.length * 2));
    n.set(this.data.subarray(0, this.length));
    this.data = n;
  }
  toArray(): Float32Array { return this.data.length === this.length ? this.data : this.data.slice(0, this.length); }
}

export class GrowU32 {
  data: Uint32Array;
  length = 0;
  constructor(initial = 1024) { this.data = new Uint32Array(Math.max(16, initial)); }
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) this.grow(this.length + 3);
    const d = this.data, l = this.length;
    d[l] = a; d[l + 1] = b; d[l + 2] = c;
    this.length = l + 3;
  }
  private grow(min: number): void {
    const n = new Uint32Array(Math.max(min, this.data.length * 2));
    n.set(this.data.subarray(0, this.length));
    this.data = n;
  }
  toArray(): Uint32Array { return this.data.length === this.length ? this.data : this.data.slice(0, this.length); }
}

export interface WeldResult {
  positions: Float32Array;
  indices: Uint32Array;
  /** Triangles dropped because they were degenerate or had non-finite vertices. */
  dropped: number;
  /** The `triData` argument filtered to the kept triangles. */
  triData?: Uint32Array;
}

/**
 * Merge coincident vertices (within `epsilon` mm) and drop degenerate
 * triangles. `indices` null means `positions` is a triangle soup (9 floats per
 * triangle, e.g. STL).
 */
export function weldVertices(positions: Float32Array, indices: Uint32Array | null, epsilon = 1e-5, triData?: Uint32Array): WeldResult {
  const vcount = Math.floor(positions.length / 3);
  const inv = 1 / epsilon;
  let cap = 1;
  while (cap < vcount * 2) cap <<= 1;
  cap = Math.max(cap, 16);
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const remap = new Uint32Array(vcount);
  const out = new Float32Array(vcount * 3);
  const qx = new Float64Array(vcount), qy = new Float64Array(vcount), qz = new Float64Array(vcount);
  const INVALID = 0xffffffff;
  let unique = 0;

  for (let v = 0; v < vcount; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { remap[v] = INVALID; continue; }
    const ix = Math.round(x * inv), iy = Math.round(y * inv), iz = Math.round(z * inv);
    let h = (Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(iz | 0, 83492791)) & mask;
    for (;;) {
      const e = table[h];
      if (e === -1) {
        table[h] = unique;
        qx[unique] = ix; qy[unique] = iy; qz[unique] = iz;
        out[unique * 3] = x; out[unique * 3 + 1] = y; out[unique * 3 + 2] = z;
        remap[v] = unique++;
        break;
      }
      if (qx[e] === ix && qy[e] === iy && qz[e] === iz) { remap[v] = e; break; }
      h = (h + 1) & mask;
    }
  }

  const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(vcount / 3);
  const outIdx = new Uint32Array(triCount * 3);
  // Optional per-triangle payload (e.g. OBJ colour groups) follows the kept triangles.
  const outData = triData ? new Uint32Array(triCount) : null;
  let t = 0, dropped = 0;
  for (let i = 0; i < triCount; i++) {
    let a: number, b: number, c: number;
    if (indices) {
      const ia = indices[i * 3], ib = indices[i * 3 + 1], ic = indices[i * 3 + 2];
      if (ia >= vcount || ib >= vcount || ic >= vcount) { dropped++; continue; }
      a = remap[ia]; b = remap[ib]; c = remap[ic];
    } else {
      a = remap[i * 3]; b = remap[i * 3 + 1]; c = remap[i * 3 + 2];
    }
    if (a === INVALID || b === INVALID || c === INVALID || a === b || b === c || a === c) { dropped++; continue; }
    if (outData) outData[t / 3] = triData![i];
    outIdx[t++] = a; outIdx[t++] = b; outIdx[t++] = c;
  }
  return {
    positions: unique * 3 === out.length ? out : out.slice(0, unique * 3),
    indices: t === outIdx.length ? outIdx : outIdx.slice(0, t),
    dropped,
    ...(outData ? { triData: outData.length === t / 3 ? outData : outData.slice(0, t / 3) } : {}),
  };
}

export function computeBBox(positions: Float32Array): BBox3 {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (minX === Infinity) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Translate positions in place so the bbox centre is at the origin. Returns the removed offset. */
export function recenter(positions: Float32Array): [number, number, number] {
  const b = computeBBox(positions);
  const c: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  if (c[0] === 0 && c[1] === 0 && c[2] === 0) return c;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= c[0]; positions[i + 1] -= c[1]; positions[i + 2] -= c[2];
  }
  return c;
}

/** Apply a column-major affine transform to positions in place. */
export function transformPositions(positions: Float32Array, m: number[]): void {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    positions[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    positions[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    positions[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
}

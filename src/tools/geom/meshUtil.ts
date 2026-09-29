/** Small mesh helpers shared by the tools (closedness / volume checks, compaction, transforms). */
import type { MeshArrays } from './extrude';

/** Signed volume (positive for an outward-wound closed mesh). */
export function signedVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/** Every directed edge is matched by exactly one opposite edge (closed, consistently wound, 2-manifold edges). */
export function isClosedManifold(indices: ArrayLike<number>): boolean {
  const edges = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k], b = indices[t + ((k + 1) % 3)];
      const key = `${a},${b}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of edges) {
    if (n !== 1) return false;
    const [a, b] = key.split(',');
    if (edges.get(`${b},${a}`) !== 1) return false;
  }
  return true;
}

/** Drop unreferenced vertices (after simplification / booleans). */
export function compactMesh(positions: Float32Array, indices: Uint32Array): MeshArrays {
  const remap = new Int32Array(positions.length / 3).fill(-1);
  let n = 0;
  const idx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (remap[v] < 0) remap[v] = n++;
    idx[i] = remap[v];
  }
  const pos = new Float32Array(n * 3);
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v];
    if (r >= 0) { pos[r * 3] = positions[v * 3]; pos[r * 3 + 1] = positions[v * 3 + 1]; pos[r * 3 + 2] = positions[v * 3 + 2]; }
  }
  return { positions: pos, indices: idx };
}

/** Apply a column-major 4x4 to a copy of the positions. */
export function transformed(positions: Float32Array, m: ArrayLike<number>): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/** Winding-flipped copy of an index buffer (for mirroring transforms). */
export function flipped(indices: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) { out[i] = indices[i]; out[i + 1] = indices[i + 2]; out[i + 2] = indices[i + 1]; }
  return out;
}

/** Concatenate meshes into one buffer pair. */
export function mergeMeshes(list: MeshArrays[]): MeshArrays {
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const m of list) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    vo += m.positions.length; io += m.indices.length;
  }
  return { positions, indices };
}

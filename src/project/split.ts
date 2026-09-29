/**
 * Split a mesh into its connected pieces (OrcaSlicer "Split to objects" /
 * "Split to parts", TriangleMesh::split). Meshes are stored welded, so two
 * triangles belong to the same piece when they share a vertex. Pure.
 */

export interface MeshPiece {
  positions: Float32Array;
  indices: Uint32Array;
  /** Piece bbox centre in the source mesh's local coordinates. */
  center: [number, number, number];
}

function find(parent: Uint32Array, x: number): number {
  while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
  return x;
}

/**
 * Connected components, largest first. Each piece is re-centred on its bbox
 * centre (returned in `center`) so it can become an object of its own. Pieces
 * with fewer than `minTriangles` triangles (stray slivers) are dropped unless
 * that would drop everything.
 */
export function splitMesh(positions: Float32Array, indices: Uint32Array, minTriangles = 1): MeshPiece[] {
  const vc = positions.length / 3;
  const parent = new Uint32Array(vc);
  for (let i = 0; i < vc; i++) parent[i] = i;
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(parent, indices[t]), b = find(parent, indices[t + 1]), c = find(parent, indices[t + 2]);
    if (a !== b) parent[b] = a;
    const r = find(parent, a);
    if (r !== c) parent[c] = r;
  }
  // Group triangles by root.
  const triRoot = new Uint32Array(indices.length / 3);
  const counts = new Map<number, number>();
  for (let t = 0; t < triRoot.length; t++) {
    const r = find(parent, indices[t * 3]);
    triRoot[t] = r;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let roots = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  const kept = roots.filter((r) => (counts.get(r) ?? 0) >= minTriangles);
  if (kept.length) roots = kept;
  if (roots.length <= 1) {
    const c = centerOf(positions);
    return [{ positions: recenter(positions.slice(), c), indices: indices.slice(), center: c }];
  }
  const slot = new Map<number, number>(roots.map((r, i) => [r, i]));
  const tris: number[][] = roots.map(() => []);
  for (let t = 0; t < triRoot.length; t++) { const s = slot.get(triRoot[t]); if (s !== undefined) tris[s].push(t); }
  const remap = new Int32Array(vc);
  return tris.map((list) => {
    remap.fill(-1);
    const idx = new Uint32Array(list.length * 3);
    const pos: number[] = [];
    let n = 0;
    list.forEach((t, k) => {
      for (let j = 0; j < 3; j++) {
        const v = indices[t * 3 + j];
        if (remap[v] < 0) { remap[v] = n++; pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); }
        idx[k * 3 + j] = remap[v];
      }
    });
    const p = new Float32Array(pos);
    const c = centerOf(p);
    return { positions: recenter(p, c), indices: idx, center: c };
  });
}

function centerOf(p: Float32Array): [number, number, number] {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) { const v = p[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  }
  return [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
}

function recenter(p: Float32Array, c: [number, number, number]): Float32Array {
  for (let i = 0; i < p.length; i += 3) { p[i] -= c[0]; p[i + 1] -= c[1]; p[i + 2] -= c[2]; }
  return p;
}

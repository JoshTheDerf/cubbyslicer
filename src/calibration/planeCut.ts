/**
 * Horizontal plane cut of a closed triangle mesh (Orca Plater::cut_horizontal
 * with ModelObjectCutAttribute::KeepLower / KeepUpper): keeps the part below
 * or above `z` and closes the opening with a flat cap, so the result is still
 * a closed solid the engine can slice.
 *
 * Intersection points are shared per edge (the cut stays watertight), loops
 * are chained from the cut segments, nested loops become holes (even depth =
 * outline, odd = hole) and every region is triangulated with earcut
 * (three.js ShapeUtils).
 */
import { ShapeUtils, Vector2 } from 'three';

export interface CutMesh { positions: Float32Array; indices: Uint32Array }

type Pt = [number, number];

export function cutHorizontal(mesh: CutMesh, z: number, keep: 'lower' | 'upper'): CutMesh {
  const { positions: P, indices: I } = mesh;
  const nv = P.length / 3;
  // Signed distance to the plane, oriented so "kept" is d < 0. Vertices on the
  // plane are pushed to the discarded side (no zero-length segments).
  const sign = keep === 'lower' ? 1 : -1;
  const d = new Float64Array(nv);
  const eps = 1e-6;
  for (let i = 0; i < nv; i++) {
    const v = (P[i * 3 + 2] - z) * sign;
    d[i] = Math.abs(v) < eps ? eps : v;
  }

  const outPos: number[] = [];
  const remap = new Int32Array(nv).fill(-1);
  const keepVertex = (i: number): number => {
    if (remap[i] < 0) { remap[i] = outPos.length / 3; outPos.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); }
    return remap[i];
  };
  const edgePoint = new Map<string, number>();
  const cross = (a: number, b: number): number => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let id = edgePoint.get(key);
    if (id === undefined) {
      const t = d[a] / (d[a] - d[b]);
      id = outPos.length / 3;
      outPos.push(P[a * 3] + (P[b * 3] - P[a * 3]) * t, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * t, z);
      edgePoint.set(key, id);
    }
    return id;
  };

  const outIdx: number[] = [];
  const segments: Array<[number, number]> = [];
  for (let t = 0; t < I.length; t += 3) {
    const v = [I[t], I[t + 1], I[t + 2]];
    const inside = v.map((x) => d[x] < 0);
    const n = inside.filter(Boolean).length;
    if (n === 3) { outIdx.push(keepVertex(v[0]), keepVertex(v[1]), keepVertex(v[2])); continue; }
    if (n === 0) continue;
    // Rotate so the lone vertex (kept one when n = 1, dropped one when n = 2) comes first; winding is preserved.
    const lone = n === 1 ? inside.indexOf(true) : inside.indexOf(false);
    const a = v[lone], b = v[(lone + 1) % 3], c = v[(lone + 2) % 3];
    const pab = cross(a, b), pca = cross(c, a);
    if (n === 1) {
      outIdx.push(keepVertex(a), pab, pca);
    } else {
      const kb = keepVertex(b), kc = keepVertex(c);
      outIdx.push(pab, kb, kc, pab, kc, pca);
    }
    segments.push([pab, pca]);
  }

  // ---- cap ------------------------------------------------------------------------
  const loops = chainLoops(segments);
  const poly = loops.map((l) => l.map((id): Pt => [outPos[id * 3], outPos[id * 3 + 1]]));
  const areas = poly.map(signedArea);
  const depth = poly.map((p, i) => {
    if (Math.abs(areas[i]) < 1e-12) return -1;
    let k = 0;
    for (let j = 0; j < poly.length; j++) if (j !== i && Math.abs(areas[j]) > Math.abs(areas[i]) && pointInPolygon(p[0], poly[j])) k++;
    return k;
  });
  const capUp = keep === 'lower'; // the lower part's cap faces +Z
  for (let i = 0; i < loops.length; i++) {
    if (depth[i] < 0 || depth[i] % 2 !== 0) continue;
    // Holes: loops directly inside this one (depth + 1) that are inside it.
    const holes = loops.map((_, j) => j).filter((j) => depth[j] === depth[i] + 1 && pointInPolygon(poly[j][0], poly[i]));
    const contourIds = areas[i] >= 0 ? loops[i] : loops[i].slice().reverse(); // CCW
    const holeIds = holes.map((j) => (areas[j] <= 0 ? loops[j] : loops[j].slice().reverse())); // CW
    const toV = (ids: number[]) => ids.map((id) => new Vector2(outPos[id * 3], outPos[id * 3 + 1]));
    const tris = ShapeUtils.triangulateShape(toV(contourIds), holeIds.map(toV));
    const flat = [contourIds, ...holeIds].flat();
    for (const [a, b, c] of tris) {
      if (capUp) outIdx.push(flat[a], flat[b], flat[c]);
      else outIdx.push(flat[a], flat[c], flat[b]);
    }
  }

  return compact(new Float32Array(outPos), outIdx);
}

/** Chain undirected segments into closed loops of point ids. Open chains are dropped. */
function chainLoops(segments: Array<[number, number]>): number[][] {
  const adj = new Map<number, number[]>();
  const add = (a: number, b: number) => { const l = adj.get(a); if (l) l.push(b); else adj.set(a, [b]); };
  for (const [a, b] of segments) { if (a === b) continue; add(a, b); add(b, a); }
  const used = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const loops: number[][] = [];
  for (const [a, b] of segments) {
    if (a === b || used.has(key(a, b))) continue;
    const loop = [a];
    used.add(key(a, b));
    let prev = a, cur = b;
    let closed = false;
    for (let guard = 0; guard < segments.length + 2; guard++) {
      if (cur === a) { closed = true; break; }
      loop.push(cur);
      const next = (adj.get(cur) ?? []).find((n) => n !== prev && !used.has(key(cur, n)))
        ?? (adj.get(cur) ?? []).find((n) => !used.has(key(cur, n)));
      if (next === undefined) break;
      used.add(key(cur, next));
      prev = cur; cur = next;
    }
    if (closed && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function signedArea(p: Pt[]): number {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] * p[i][1] - p[i][0] * p[j][1]);
  return s / 2;
}

function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Drop unreferenced vertices and degenerate triangles. */
function compact(pos: Float32Array, idx: number[]): CutMesh {
  const used = new Int32Array(pos.length / 3).fill(-1);
  const out: number[] = [];
  const indices: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a === b || b === c || a === c) continue;
    for (const v of [a, b, c]) {
      if (used[v] < 0) { used[v] = out.length / 3; out.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); }
      indices.push(used[v]);
    }
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(indices) };
}

/** Axis-aligned bounds of a mesh. */
export function meshBounds(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) { const v = positions[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  }
  return { min, max };
}

import { describe, expect, it } from 'vitest';
import { cutHorizontal, meshBounds, type CutMesh } from './planeCut';

function box(sx: number, sy: number, sz: number): CutMesh {
  const v = [[0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0], [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()) };
}

/** Square tube (outer 20, inner 10) made of 4 boxes glued as one closed surface via a ring extrusion. */
function tube(h: number): CutMesh {
  const ring = (r: number) => [[-r, -r], [r, -r], [r, r], [-r, r]];
  const outer = ring(10), inner = ring(5);
  const pos: number[] = [];
  for (const z of [0, h]) for (const p of [...outer, ...inner]) pos.push(p[0], p[1], z);
  // indices: bottom 0..7 (outer 0-3, inner 4-7), top 8..15
  const idx: number[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    // outer wall (outward)
    idx.push(i, j, 8 + j, i, 8 + j, 8 + i);
    // inner wall (facing the hole)
    idx.push(4 + j, 4 + i, 12 + i, 4 + j, 12 + i, 12 + j);
    // bottom ring (facing -Z)
    idx.push(i, 4 + i, 4 + j, i, 4 + j, j);
    // top ring (facing +Z)
    idx.push(8 + i, 8 + j, 12 + j, 8 + i, 12 + j, 12 + i);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Every directed edge must have exactly one opposite twin (closed, consistently oriented). */
function isClosed(m: CutMesh): boolean {
  const key = (a: number[], b: number[]) => `${a.map((x) => x.toFixed(4))}|${b.map((x) => x.toFixed(4))}`;
  const P = (i: number) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
  const edges = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = P(m.indices[t + k]), b = P(m.indices[t + ((k + 1) % 3)]);
      const f = key(a, b);
      edges.set(f, (edges.get(f) ?? 0) + 1);
    }
  }
  for (const [e, n] of edges) {
    const [a, b] = e.split('|');
    if (n !== 1 || edges.get(`${b}|${a}`) !== 1) return false;
  }
  return true;
}

function volume(m: CutMesh): number {
  let v = 0;
  const P = m.positions, I = m.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  return v;
}

describe('cutHorizontal', () => {
  it('keeps the lower part of a box as a closed solid', () => {
    const r = cutHorizontal(box(10, 20, 30), 12, 'lower');
    const b = meshBounds(r.positions);
    expect(b.max[2]).toBeCloseTo(12, 5);
    expect(isClosed(r)).toBe(true);
    expect(volume(r)).toBeCloseTo(10 * 20 * 12, 3);
  });

  it('keeps the upper part of a box', () => {
    const r = cutHorizontal(box(10, 20, 30), 12, 'upper');
    const b = meshBounds(r.positions);
    expect(b.min[2]).toBeCloseTo(12, 5);
    expect(isClosed(r)).toBe(true);
    expect(volume(r)).toBeCloseTo(10 * 20 * 18, 3);
  });

  it('caps a hollow cross-section with a hole', () => {
    const t = tube(40);
    expect(isClosed(t)).toBe(true);
    const full = volume(t);
    expect(full).toBeCloseTo((400 - 100) * 40, 3);
    const lo = cutHorizontal(t, 15, 'lower');
    expect(isClosed(lo)).toBe(true);
    expect(volume(lo)).toBeCloseTo(300 * 15, 3);
    const hi = cutHorizontal(t, 15, 'upper');
    expect(isClosed(hi)).toBe(true);
    expect(volume(hi)).toBeCloseTo(300 * 25, 3);
  });

  it('leaves a mesh below the plane untouched', () => {
    const r = cutHorizontal(box(5, 5, 5), 50, 'lower');
    expect(r.indices.length).toBe(36);
    expect(volume(r)).toBeCloseTo(125, 5);
  });
});

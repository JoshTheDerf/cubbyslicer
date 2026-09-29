import { describe, expect, it } from 'vitest';
import { splitMesh } from './split';

function box(x: number, y: number, z: number, s: number): { p: number[]; i: number[] } {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]].map(([a, b, c]) => [a + x, b + y, c + z]);
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { p: v.flat(), i: f };
}

function merge(...bs: Array<{ p: number[]; i: number[] }>) {
  const p: number[] = [], i: number[] = [];
  for (const b of bs) { const off = p.length / 3; p.push(...b.p); i.push(...b.i.map((x) => x + off)); }
  return { positions: new Float32Array(p), indices: new Uint32Array(i) };
}

describe('splitMesh', () => {
  it('splits disconnected shells, re-centred with their centres', () => {
    const m = merge(box(0, 0, 0, 10), box(50, 0, 0, 20));
    const pieces = splitMesh(m.positions, m.indices);
    expect(pieces).toHaveLength(2);
    expect(pieces.map((p) => p.center).sort((a, b) => a[0] - b[0])).toEqual([[5, 5, 5], [60, 10, 10]]);
    for (const pc of pieces) {
      expect(pc.indices.length).toBe(36);
      expect(pc.positions.length).toBe(24);
      expect(Math.max(...pc.indices)).toBeLessThan(8);
      const xs = [...pc.positions].filter((_, k) => k % 3 === 0);
      expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0);
    }
  });
  it('returns the whole mesh as one piece when connected', () => {
    const m = merge(box(0, 0, 0, 10));
    expect(splitMesh(m.positions, m.indices)).toHaveLength(1);
  });
});

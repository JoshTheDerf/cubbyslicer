import { describe, expect, it } from 'vitest';
import { arrange, type ArrangeItem } from './arrange';
import { bedFromConfig } from '../app/state';

const bed = bedFromConfig({ printable_area: '0x0,200x0,200x200,0x200', printable_height: '200' });

function applied(items: ArrangeItem[], moves: Map<string, [number, number]>) {
  return items.map((it) => {
    const [dx, dy] = moves.get(it.id)!;
    return { id: it.id, minX: it.minX + dx, minY: it.minY + dy, maxX: it.maxX + dx, maxY: it.maxY + dy };
  });
}

describe('arrange', () => {
  it('packs items within the bed without overlaps', () => {
    const items: ArrangeItem[] = Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, minX: -20, minY: -15, maxX: 20 + (i % 3) * 5, maxY: 15 }));
    const r = arrange(items, bed, { spacing: 5 });
    expect(r.unplaced).toEqual([]);
    const rs = applied(items, r.moves);
    for (const a of rs) {
      expect(a.minX).toBeGreaterThanOrEqual(-1e-6);
      expect(a.minY).toBeGreaterThanOrEqual(-1e-6);
      expect(a.maxX).toBeLessThanOrEqual(200 + 1e-6);
      expect(a.maxY).toBeLessThanOrEqual(200 + 1e-6);
    }
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      const sep = a.maxX + 5 <= b.minX + 1e-6 || b.maxX + 5 <= a.minX + 1e-6 || a.maxY + 5 <= b.minY + 1e-6 || b.maxY + 5 <= a.minY + 1e-6;
      expect(sep).toBe(true);
    }
  });

  it('reports items that do not fit and parks them off the bed', () => {
    const items: ArrangeItem[] = [
      { id: 'big', minX: 0, minY: 0, maxX: 250, maxY: 10 },
      { id: 'ok', minX: 0, minY: 0, maxX: 10, maxY: 10 },
    ];
    const r = arrange(items, bed);
    expect(r.unplaced).toEqual(['big']);
    const big = applied(items, r.moves).find((x) => x.id === 'big')!;
    expect(big.minX).toBeGreaterThan(200);
  });

  it('avoids obstacles and exclude areas', () => {
    const b2 = { ...bed, excludeAreas: [[[0, 0], [100, 0], [100, 100], [0, 100]] as Array<[number, number]>] };
    const items: ArrangeItem[] = [{ id: 'a', minX: 0, minY: 0, maxX: 40, maxY: 40 }];
    const r = arrange(items, b2, { obstacles: [{ minX: 100, minY: 0, maxX: 200, maxY: 100 }], center: false });
    const a = applied(items, r.moves)[0];
    expect(a.minY).toBeGreaterThanOrEqual(100);
  });

  it('works on a circular (delta) bed', () => {
    const pts = Array.from({ length: 64 }, (_, i) => {
      const t = (i / 64) * Math.PI * 2;
      return `${(100 * Math.cos(t)).toFixed(3)}x${(100 * Math.sin(t)).toFixed(3)}`;
    }).join(',');
    const round = bedFromConfig({ printable_area: pts });
    const items: ArrangeItem[] = Array.from({ length: 4 }, (_, i) => ({ id: `o${i}`, minX: 0, minY: 0, maxX: 40, maxY: 40 }));
    const r = arrange(items, round);
    expect(r.unplaced).toEqual([]);
    for (const a of applied(items, r.moves)) {
      for (const [x, y] of [[a.minX, a.minY], [a.maxX, a.maxY], [a.minX, a.maxY], [a.maxX, a.minY]]) {
        expect(Math.hypot(x, y)).toBeLessThanOrEqual(100.01);
      }
    }
  });
});

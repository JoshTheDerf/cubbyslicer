import { describe, expect, it } from 'vitest';
import type { BedShape } from '../app/state';
import { plateBed, plateCols, plateIndexAt, plateOffset, plateShift } from './plates';

const bed: BedShape = { polygon: [[0, 0], [200, 0], [200, 100], [0, 100]], min: [0, 0], max: [200, 100], maxHeight: 200, excludeAreas: [] };

describe('plate layout', () => {
  it('lays plates out row-major in a ceil(sqrt(n)) grid with a 1/5 gap, rows towards -Y', () => {
    expect(plateCols(1)).toBe(1);
    expect(plateCols(2)).toBe(2);
    expect(plateCols(5)).toBe(3);
    expect(plateOffset(0, 1, bed)).toEqual([0, 0]);
    expect(plateOffset(1, 2, bed)).toEqual([240, 0]);
    expect(plateOffset(2, 4, bed)).toEqual([0, -120]);
    expect(plateOffset(3, 4, bed)).toEqual([240, -120]);
  });
  it('translates the bed and finds the plate under a point', () => {
    const b = plateBed(bed, 1, 2);
    expect(b.min).toEqual([240, 0]);
    expect(b.polygon[2]).toEqual([440, 100]);
    expect(plateIndexAt(100, 50, 2, bed)).toBe(0);
    expect(plateIndexAt(300, 50, 2, bed)).toBe(1);
    expect(plateIndexAt(220, 50, 2, bed)).toBe(-1); // in the gap
  });
  it('computes the shift that keeps an object on its plate when the grid changes', () => {
    // 4 → 5 plates: columns 2 → 3, so plate 2 moves from row 1 col 0 to row 0 col 2.
    expect(plateShift(bed, 2, 4, 2, 5)).toEqual([480, 120]);
    // Deleting plate 0 of 2: plate 1 becomes plate 0.
    expect(plateShift(bed, 1, 2, 0, 1)).toEqual([-240, 0]);
  });
});

import { describe, expect, it } from 'vitest';
import { weldVertices, computeBBox } from './mesh';
import { cubeSoup } from './testutil';

describe('vertex welding', () => {
  it('merges coincident soup vertices', () => {
    const w = weldVertices(cubeSoup(10), null);
    expect(w.positions.length / 3).toBe(8);
    expect(w.indices.length / 3).toBe(12);
    expect(w.dropped).toBe(0);
    for (const i of w.indices) expect(i).toBeLessThan(8);
  });

  it('merges within epsilon but keeps distinct vertices', () => {
    const p = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0.000001, 0, 0, 1, 0, 0, 0, 1, 0.5]);
    const w = weldVertices(p, null, 1e-4);
    expect(w.positions.length / 3).toBe(4);
    expect(Array.from(w.indices)).toEqual([0, 1, 2, 0, 1, 3]);
  });

  it('re-indexes an indexed mesh and drops out-of-range / degenerate triangles', () => {
    const p = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0]);
    const w = weldVertices(p, new Uint32Array([0, 1, 2, 0, 3, 2, 0, 1, 3, 0, 1, 7]));
    expect(w.positions.length / 3).toBe(3);
    expect(Array.from(w.indices)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(w.dropped).toBe(2);
  });

  it('computes bboxes', () => {
    expect(computeBBox(cubeSoup(3, [1, 2, 3]))).toEqual({ min: [1, 2, 3], max: [4, 5, 6] });
  });
});

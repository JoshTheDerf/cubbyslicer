import { describe, expect, it } from 'vitest';
import { compactMesh, flipped, mergeMeshes, signedVolume, transformed } from './meshUtil';

describe('meshUtil', () => {
  it('compactMesh drops unreferenced vertices in first-use order', () => {
    const pos = new Float32Array([9, 9, 9, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const { positions, indices } = compactMesh(pos, new Uint32Array([3, 1, 2]));
    expect([...indices]).toEqual([0, 1, 2]);
    expect([...positions]).toEqual([0, 1, 0, 0, 0, 0, 1, 0, 0]);
  });
  it('compactMesh keeps degenerate triangles unless asked', () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const idx = [0, 0, 1, 0, 1, 2];
    expect(compactMesh(pos, idx).indices.length).toBe(6);
    const c = compactMesh(pos, idx, { dropDegenerate: true });
    expect([...c.indices]).toEqual([0, 1, 2]);
    expect(c.positions.length).toBe(9);
  });
  it('transformed applies a column-major matrix to a copy', () => {
    const pos = new Float32Array([1, 2, 3]);
    const m = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
    expect([...transformed(pos, m)]).toEqual([12, 22, 33]);
    expect([...pos]).toEqual([1, 2, 3]);
  });
  it('mergeMeshes offsets indices; flipped reverses winding', () => {
    const a = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const m = mergeMeshes([a, a]);
    expect([...m.indices]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...flipped(a.indices)]).toEqual([0, 2, 1]);
    // A unit tetrahedron, outward wound: +1/6.
    const tet = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) };
    expect(signedVolume(tet.positions, tet.indices)).toBeCloseTo(1 / 6);
  });
});

import { describe, expect, it } from 'vitest';
import { boxMesh, cylinderMesh, primitiveFor, sphereMesh } from './primitives';

/** Signed volume (divergence theorem): positive for outward-facing closed meshes. */
function volume(p: Float32Array, ix: Uint32Array): number {
  let v = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
}

describe('primitives', () => {
  it('are closed, outward-facing and the right size', () => {
    const b = boxMesh(10, 20, 30);
    expect(volume(b.positions, b.indices)).toBeCloseTo(6000);
    const c = cylinderMesh(5, 10, 256);
    expect(volume(c.positions, c.indices)).toBeCloseTo(Math.PI * 25 * 10, -1);
    const s = sphereMesh(10, 64, 128);
    expect(volume(s.positions, s.indices) / ((4 / 3) * Math.PI * 1000)).toBeGreaterThan(0.98);
  });
  it('sizes generic sub-objects from the object bbox', () => {
    const slab = primitiveFor('slab', [100, 50, 20]);
    const xs = [...slab.positions].filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(120);
  });
});

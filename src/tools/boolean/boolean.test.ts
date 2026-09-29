import { describe, expect, it } from 'vitest';
import { meshBoolean, BooleanError } from './boolean';
import { simplifyMesh, targetFromRatio } from '../simplify/simplify';
import { boxMesh, sphereMesh } from '../../project/primitives';
import { signedVolume, isClosedManifold } from '../geom/meshUtil';

const shifted = (m: { positions: Float32Array; indices: Uint32Array }, dx: number) => {
  const p = m.positions.slice();
  for (let i = 0; i < p.length; i += 3) p[i] += dx;
  return { positions: p, indices: m.indices };
};

describe('mesh boolean (manifold-3d)', () => {
  const a = boxMesh(10, 10, 10);
  const b = shifted(boxMesh(10, 10, 10), 5);

  it('union / difference / intersection volumes', async () => {
    const u = await meshBoolean('union', a, [b]);
    const d = await meshBoolean('difference', a, [b]);
    const i = await meshBoolean('intersection', a, [b]);
    expect(signedVolume(u.positions, u.indices)).toBeCloseTo(1500, 3);
    expect(signedVolume(d.positions, d.indices)).toBeCloseTo(500, 3);
    expect(signedVolume(i.positions, i.indices)).toBeCloseTo(500, 3);
    expect(isClosedManifold(u.indices)).toBe(true);
  });

  it('reports empty intersections and open meshes', async () => {
    await expect(meshBoolean('intersection', a, [shifted(boxMesh(10, 10, 10), 50)])).rejects.toBeInstanceOf(BooleanError);
    const open = { positions: a.positions, indices: a.indices.slice(0, 30) };
    await expect(meshBoolean('union', open, [b])).rejects.toBeInstanceOf(BooleanError);
  });
});

describe('simplify (meshoptimizer)', () => {
  it('reduces a sphere to about the target triangle count', async () => {
    const s = sphereMesh(10, 48, 96);
    const tris = s.indices.length / 3;
    const target = targetFromRatio(tris, 0.25);
    const r = await simplifyMesh(s.positions, s.indices, target);
    const got = r.indices.length / 3;
    expect(got).toBeLessThanOrEqual(target);
    expect(got).toBeGreaterThan(target * 0.5);
    // Unreferenced vertices were compacted away.
    expect(r.positions.length / 3).toBeLessThan(s.positions.length / 3);
    // Volume roughly preserved.
    expect(signedVolume(r.positions, r.indices) / signedVolume(s.positions, s.indices)).toBeGreaterThan(0.95);
  });

  it('keeps the mesh when the target is not below the current count', async () => {
    const s = boxMesh(1, 1, 1);
    const r = await simplifyMesh(s.positions, s.indices, 100);
    expect(r.indices).toBe(s.indices);
  });
});

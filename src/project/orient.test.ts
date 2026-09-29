import { describe, expect, it, vi } from 'vitest';
import { composeTRS, quatFromAxisAngle, transformPoint, type Quat, type Vec3 } from './math';
import { composeOrientation, orientInput, orientObjects, rotationMatrixToQuat, type Orienter } from './orient';
import type { MeshData, ProjectObject } from './types';

/** Row-major 3x3 rotation about a unit axis. */
function rowMajor(axis: Vec3, angle: number): number[] {
  const m = composeTRS([0, 0, 0], quatFromAxisAngle(axis, angle), [1, 1, 1]); // column-major 4x4
  return [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
}
const apply = (q: Quat, v: Vec3) => transformPoint(composeTRS([0, 0, 0], q, [1, 1, 1]), v);
const close = (a: Vec3, b: Vec3) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 6));

const mesh: MeshData = {
  id: 'm1',
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  bbox: { min: [0, 0, 0], max: [10, 10, 10] },
  vertexCount: 4,
  triangleCount: 4,
};
function obj(id: string, rotation: Quat, scale: Vec3 = [1, 1, 1]): ProjectObject {
  return { id, name: id, meshId: 'm1', position: [50, 60, 7], rotation, scale, visible: true, printable: true, overrides: {}, color: '' };
}

describe('auto-orient matrix composition', () => {
  it('converts a row-major rotation to the matching quaternion', () => {
    const r = rowMajor([0, 0, 1], Math.PI / 2);
    // Row-major: first row is (cos, -sin, 0) → +X maps to +Y.
    expect(r[1]).toBeCloseTo(-1);
    close(apply(rotationMatrixToQuat(r), [1, 0, 0]), [0, 1, 0]);
    for (const [axis, a] of [[[1, 0, 0], 2.5], [[0, 1, 0], -3.0], [[0.6, 0, 0.8], 1.2]] as Array<[Vec3, number]>) {
      const q = rotationMatrixToQuat(rowMajor(axis, a));
      close(apply(q, [0.3, -0.2, 0.9]), apply(quatFromAxisAngle(axis, a), [0.3, -0.2, 0.9]));
    }
  });

  it('PRE-multiplies onto the current rotation (R_new = R * R_cur)', () => {
    const cur = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const R = rowMajor([1, 0, 0], Math.PI / 2);
    const next = composeOrientation(cur, R);
    // Local +X → (cur) +Y → (R about X) +Z. Post-multiplying would give +Y.
    close(apply(next, [1, 0, 0]), [0, 0, 1]);
  });

  it('undoes a 30° tilt when the orienter returns the inverse tilt', () => {
    const tilted = quatFromAxisAngle([1, 0, 0], Math.PI / 6);
    const next = composeOrientation(tilted, rowMajor([1, 0, 0], -Math.PI / 6));
    close(apply(next, [0, 0, 1]), [0, 0, 1]);
    close(apply(next, [0, 1, 0]), [0, 1, 0]);
  });

  it('re-orthonormalises slightly noisy matrices', () => {
    const r = rowMajor([0, 1, 0], 0.7).map((v, i) => v + (i % 2 ? 1e-5 : -1e-5));
    const q = rotationMatrixToQuat(r);
    expect(Math.hypot(...q)).toBeCloseTo(1, 9);
    expect(() => rotationMatrixToQuat([1, 0, 0, 0, NaN, 0, 0, 0, 1])).toThrow();
  });
});

describe('orientInput', () => {
  it('sends rotation*scale with no translation', () => {
    const q = quatFromAxisAngle([0, 1, 0], 0.4);
    const inp = orientInput(obj('a', q, [2, 1, 1]), mesh);
    expect(inp.transform.slice(12, 15)).toEqual([0, 0, 0]);
    close(transformPoint(inp.transform, [1, 0, 0]), apply(q, [2, 0, 0]));
    expect(inp.positions).toBe(mesh.positions); // no copy of the mesh
    expect(inp.indices).toBe(mesh.indices);
  });

  it('flips the winding for mirrored objects', () => {
    const inp = orientInput(obj('a', [0, 0, 0, 1], [-1, 1, 1]), mesh);
    expect(Array.from(inp.indices.slice(0, 3))).toEqual([0, 1, 2]);
  });
});

describe('orientObjects (mocked engine)', () => {
  it('orients sequentially, reports progress, skips identity and collects failures', async () => {
    const tilt = rowMajor([1, 0, 0], -Math.PI / 6);
    const calls: string[] = [];
    let inflight = 0;
    const orient: Orienter = vi.fn(async (o) => {
      inflight++;
      expect(inflight).toBe(1);
      calls.push(o.id);
      await Promise.resolve();
      inflight--;
      if (o.id === 'bad') throw new Error('does not support auto-orient');
      return o.id === 'flat' ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : tilt;
    });
    const progress: number[] = [];
    const objs = [obj('a', quatFromAxisAngle([1, 0, 0], Math.PI / 6)), obj('flat', [0, 0, 0, 1]), obj('bad', [0, 0, 0, 1])];
    const r = await orientObjects(objs, () => mesh, orient, { onProgress: (p) => progress.push(p.done) });
    expect(calls).toEqual(['a', 'flat', 'bad']);
    expect(progress).toEqual([0, 1, 2, 3]);
    expect(r.unchanged).toEqual(['flat']);
    expect(r.failed).toEqual([{ id: 'bad', name: 'bad', error: 'does not support auto-orient' }]);
    expect(r.rotations).toHaveLength(1);
    close(apply(r.rotations[0].rotation, [0, 0, 1]), [0, 0, 1]);
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    const orient: Orienter = async () => { ac.abort(); return [1, 0, 0, 0, 1, 0, 0, 0, 1]; };
    const r = await orientObjects([obj('a', [0, 0, 0, 1]), obj('b', [0, 0, 0, 1])], () => mesh, orient, { signal: ac.signal });
    expect(r.cancelled).toBe(true);
    expect(r.unchanged).toEqual(['a']);
  });
});

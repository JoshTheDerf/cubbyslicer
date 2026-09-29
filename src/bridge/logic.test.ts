import { describe, expect, it } from 'vitest';
import { closestOnTriangle, inRange, largestFaceNormal, mergePaint, nearestLayer, nearestTriangle, oneOf, profileSummary, raycastMesh, settingValue, trianglesFacing, vec3 } from './logic';
import { boxMesh } from '../project/primitives';
import { composeTRS } from '../project/math';

const I = composeTRS([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
/** A 10 × 20 × 4 box: its largest faces are the top and bottom. */
const box = boxMesh(10, 20, 4);

describe('argument helpers', () => {
  it('oneOf names the valid options', () => {
    expect(oneOf('b', ['a', 'b'] as const, 'x')).toBe('b');
    expect(() => oneOf('c', ['a', 'b'], 'x')).toThrow('"x" must be one of "a", "b" (got "c").');
    expect(() => oneOf(undefined, ['a'], 'x')).toThrow('"x" must be one of "a".');
  });
  it('inRange and vec3 validate', () => {
    expect(inRange(2, 'n', 0, 5)).toBe(2);
    expect(() => inRange(9, 'n', 0, 5)).toThrow('between 0 and 5');
    expect(() => inRange('1', 'n')).toThrow('must be a number');
    expect(vec3([1, 2, 3], 'p')).toEqual([1, 2, 3]);
    expect(vec3(undefined, 'p')).toBeNull();
    expect(() => vec3([1, 2], 'p')).toThrow('[x, y, z]');
  });
  it('settingValue serialises like the engine expects', () => {
    expect(settingValue(true)).toBe('1');
    expect(settingValue(false)).toBe('0');
    expect(settingValue(0.2)).toBe('0.2');
    expect(settingValue('15%')).toBe('15%');
    expect(settingValue([0.4, true])).toEqual(['0.4', '1']);
    expect(() => settingValue({ a: 1 })).toThrow();
  });
});

describe('mesh queries', () => {
  it('finds the faces pointing down / up', () => {
    const down = trianglesFacing(box.positions, box.indices, I, [0, 0, -1], 10);
    const up = trianglesFacing(box.positions, box.indices, I, [0, 0, 1], 10);
    expect(down).toHaveLength(2);
    expect(up).toHaveLength(2);
    expect(down.some((t) => up.includes(t))).toBe(false);
    expect(trianglesFacing(box.positions, box.indices, I, [0, 0, -1], 91)).toHaveLength(10); // everything but the top
  });
  it('follows the object transform (and mirroring)', () => {
    const flipped = composeTRS([0, 0, 0], [1, 0, 0, 0], [1, 1, 1]); // 180° about X
    const up = trianglesFacing(box.positions, box.indices, I, [0, 0, 1], 10);
    const downAfter = trianglesFacing(box.positions, box.indices, flipped, [0, 0, -1], 10);
    expect(downAfter.sort()).toEqual(up.sort());
    const mirrored = composeTRS([0, 0, 0], [0, 0, 0, 1], [1, 1, -1]);
    expect(trianglesFacing(box.positions, box.indices, mirrored, [0, 0, -1], 10).sort()).toEqual(up.sort());
  });
  it('largest face normal is a big side', () => {
    const n = largestFaceNormal(box.positions, box.indices, I)!;
    expect(Math.abs(n[2])).toBeCloseTo(1, 5);
    const tall = boxMesh(4, 20, 10);
    const m = largestFaceNormal(tall.positions, tall.indices, I)!;
    expect(Math.abs(m[0])).toBeCloseTo(1, 5);
  });
  it('closest point on a triangle', () => {
    const a: [number, number, number] = [0, 0, 0], b: [number, number, number] = [10, 0, 0], c: [number, number, number] = [0, 10, 0];
    expect(closestOnTriangle([2, 2, 5], a, b, c)).toEqual([2, 2, 0]);
    expect(closestOnTriangle([-3, -3, 0], a, b, c)).toEqual(a);
    expect(closestOnTriangle([6, 6, 0], a, b, c).map((v) => +v.toFixed(6))).toEqual([5, 5, 0]);
  });
  it('nearest triangle and ray cast', () => {
    const hit = nearestTriangle(box.positions, box.indices, I, [0, 0, 5])!;
    expect(trianglesFacing(box.positions, box.indices, I, [0, 0, 1], 1)).toContain(hit.tri);
    expect(hit.point[2]).toBeCloseTo(2, 5);
    expect(hit.distance).toBeCloseTo(3, 5);
    const moved = composeTRS([100, 50, 2], [0, 0, 0, 1], [1, 1, 1]);
    const r = raycastMesh(box.positions, box.indices, moved, [100, 50, 50], [0, 0, -1])!;
    expect(r.point[2]).toBeCloseTo(4, 5);
    expect(r.normal).toEqual([0, 0, 1].map((v) => expect.closeTo(v, 5)));
    expect(raycastMesh(box.positions, box.indices, moved, [0, 0, 50], [0, 0, -1])).toBeNull();
    const side = raycastMesh(box.positions, box.indices, moved, [200, 50, 2], [-1, 0, 0])!;
    expect(side.point[0]).toBeCloseTo(105, 5);
    expect(side.normal[0]).toBeCloseTo(1, 5);
  });
});

describe('paint and layers', () => {
  it('merges per-triangle paint', () => {
    expect(mergePaint([[1, 'A'], [3, 'B'], [5, 'C']], [[3, 'X'], [4, 'Y']], [5])).toEqual([[1, 'A'], [3, 'X'], [4, 'Y']]);
    expect(mergePaint(undefined, [[2, 'Z']])).toEqual([[2, 'Z']]);
  });
  it('snaps to the nearest layer', () => {
    const z = new Float32Array([0.2, 0.4, 0.6, 0.8]);
    expect(nearestLayer(z, 0.45)).toBe(1);
    expect(nearestLayer(z, 5)).toBe(3);
    expect(nearestLayer(new Float32Array(0), 1)).toBeNull();
  });
  it('summarises a profile', () => {
    expect(profileSummary([0, 0.2, 5, 0.1, 10, 0.3])).toEqual({ points: 3, minHeight: 0.1, maxHeight: 0.3, top: 10 });
    expect(profileSummary([])).toBeNull();
  });
});

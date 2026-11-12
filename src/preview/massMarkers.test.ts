import { describe, expect, it } from 'vitest';
import type { SliceObjectMass } from '../engine/types';
import { previewMassMarkers, transformSum } from './massMarkers';
import { centerOf, inertiaOf } from '../viewport/massProps';

/** A point mass `m` at p, per layer id (cumulative, as finalize_object_masses leaves it). */
function point(m: number, p: [number, number, number]) {
  const [x, y, z] = p;
  return [m, m / 1.24, m * x, m * y, m * z, m * x * x, m * y * y, m * z * z, m * x * y, m * x * z, m * y * z];
}
const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
const mass = (layers: number[][], box: number[] | null = [0, 0, 0, 10, 10, 10]): SliceObjectMass => ({ layers: layers.flat(), box, beltBox: [1, 2, 3, 4, 5, 6], assembly: false });

describe('previewMassMarkers (CenterOfMass::render, preview)', () => {
  const l0 = point(100, [0, 0, 0.1]);
  const l1 = add(l0, point(100, [10, 0, 0.3]));
  const m = { plate: mass([l0, l1]), objects: [mass([l0, l1])], bodies: [], supports: [] };

  it('shows the finished print at the last layer', () => {
    const out = previewMassMarkers(m, 1, 2, null);
    expect(out.map((o) => [o.kind, o.stage, o.alpha])).toEqual([['plate', 0, 1], ['object', 0, 1]]);
    expect(centerOf(out[0].sum)).toEqual([5, 0, 0.2]);
    expect(out[0].note).toBe('Finished print');
    expect(out[0].box).toEqual({ min: [0, 0, 0], max: [10, 10, 10] });
  });

  it('adds what is printed up to a lower layer, the finished markers faded', () => {
    const out = previewMassMarkers(m, 0, 2, null);
    expect(out.map((o) => [o.kind, o.stage, o.alpha])).toEqual([['plate', 0, 0.4], ['plate', 1, 1], ['object', 0, 0.4], ['object', 1, 1]]);
    expect(centerOf(out[1].sum)).toEqual([0, 0, 0.1]);
    expect(out[1].note).toBe('Printed up to layer 1');
  });

  it('a top layer past an object\'s last shows its whole mass', () => {
    const short = { ...m, objects: [mass([l0])] };
    const out = previewMassMarkers(short, 1, 3, null).filter((o) => o.kind === 'object');
    expect(out.map((o) => o.sum.mass)).toEqual([100, 100]);
  });

  it('nothing without masses', () => {
    expect(previewMassMarkers(undefined, 0, 1, null)).toEqual([]);
  });

  it('a belt designed view moves the sums by the back-transform and the boxes to the belt box (ObjectMass::transform)', () => {
    // 90° about Z, then +100 in X (column-major).
    const T = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1];
    const out = previewMassMarkers(m, 1, 2, T);
    const c = centerOf(out[0].sum);
    expect(c[0]).toBeCloseTo(100); expect(c[1]).toBeCloseTo(5); expect(c[2]).toBeCloseTo(0.2);
    expect(out[0].box).toEqual({ min: [101, 2, 3], max: [104, 5, 6] });
    // Moments of inertia about the centre swap X and Y under the rotation.
    const before = inertiaOf(previewMassMarkers(m, 1, 2, null)[0].sum), after = inertiaOf(out[0].sum);
    expect(after[0]).toBeCloseTo(before[1]); expect(after[1]).toBeCloseTo(before[0]); expect(after[2]).toBeCloseTo(before[2]);
  });

  it('transformSum keeps the second moments of a point mass consistent', () => {
    const s = transformSum({ mass: 2, volume: 1, moment: [2, 4, 6], second: [2, 8, 18], cross: [4, 6, 12] }, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1]);
    // Point at (1,2,3) moved to (2,3,4).
    expect(s.moment).toEqual([4, 6, 8]);
    expect(s.second).toEqual([8, 18, 32]);
    expect(s.cross).toEqual([12, 16, 24]);
  });
});

import { describe, expect, it } from 'vitest';
import { area, autoEarPoints, cornerPoints, defaultHeadDiameter, detectionRadiusMax, douglasPeucker, invalidEars, sliceAtZ, type Loop } from './brimEars';
import { boxMesh, cylinderMesh } from '../../project/primitives';
import type { Pt } from '../../project/math';

function lift(positions: Float32Array, dz: number): Float32Array {
  const out = positions.slice();
  for (let i = 2; i < out.length; i += 3) out[i] += dz;
  return out;
}

describe('brim ears', () => {
  it('slices a box into one CCW outer loop', () => {
    const b = boxMesh(20, 10, 5);
    const loops = sliceAtZ(lift(b.positions, 2.5), b.indices, 0.1);
    expect(loops.length).toBe(1);
    expect(loops[0].hole).toBe(false);
    expect(area(loops[0].pts)).toBeCloseTo(200, 3);
  });

  it('auto-generates one ear per box corner (Orca defaults: 125°, r=1)', () => {
    const b = boxMesh(20, 10, 5);
    const loops = sliceAtZ(lift(b.positions, 2.5), b.indices, 0.1);
    const ears = autoEarPoints(loops, 1, 125);
    expect(ears.length).toBe(4);
    const xs = ears.map((p) => Math.round(Math.abs(p[0])));
    expect(new Set(xs)).toEqual(new Set([10]));
  });

  it('puts no ears on a smooth cylinder, but a tighter angle limit catches nothing either', () => {
    const c = cylinderMesh(10, 10, 64);
    const loops = sliceAtZ(lift(c.positions, 5), c.indices, 0.1);
    expect(loops.length).toBe(1);
    expect(autoEarPoints(loops, 1, 125).length).toBe(0);
  });

  it('hole corners: only corners where the material points into the hole get ears (Orca concave_points of the reversed hole)', () => {
    // Square frame: outer 40x40, inner 20x20 hole.
    const outer: Pt[] = [[-20, -20], [20, -20], [20, 20], [-20, 20]];
    const hole: Pt[] = [[-10, -10], [-10, 10], [10, 10], [10, -10]]; // CW
    const loops: Loop[] = [{ pts: outer, hole: false }, { pts: hole, hole: true }];
    // Square hole: its corners are inner (concave) material corners → no ears; the 4 outer corners get ears.
    expect(autoEarPoints(loops, 0, 125).length).toBe(4);
    // A hole with a material spike poking into it: the spike tip gets an ear.
    const spiky: Pt[] = [[-10, -10], [-10, 10], [0, 10], [0, 0], [1, 10], [10, 10], [10, -10]].reverse() as Pt[];
    const withSpike = autoEarPoints([{ pts: outer, hole: false }, { pts: spiky.reverse(), hole: true }], 0, 125);
    expect(withSpike.some((p) => p[0] === 0 && p[1] === 0)).toBe(true);
  });

  it('corner filter respects the threshold', () => {
    // Triangle-ish obtuse corner (150° interior) is skipped by 125° but kept by 170°.
    const pts: Pt[] = [[0, 0], [10, 0], [20, 5.77], [0, 20]];
    const t = (max: number) => ((180 - max) * Math.PI) / 180;
    const obtuse = (list: Pt[]) => list.some((p) => p[0] === 10);
    expect(obtuse(cornerPoints(pts, t(125), true))).toBe(false);
    expect(obtuse(cornerPoints(pts, t(170), true))).toBe(true);
  });

  it('douglas-peucker keeps corners', () => {
    const pts: Pt[] = [];
    for (let i = 0; i < 10; i++) pts.push([i, 0]);
    for (let i = 0; i < 10; i++) pts.push([10, i]);
    for (let i = 10; i > 0; i--) pts.push([i, 10]);
    for (let i = 10; i > 0; i--) pts.push([0, i]);
    expect(douglasPeucker(pts, 0.5).length).toBe(4);
  });

  it('flags ears that miss the first layer', () => {
    const loops: Loop[] = [{ pts: [[0, 0], [10, 0], [10, 10], [0, 10]], hole: false }];
    const bad = invalidEars([{ p: [10, 10], r: 2 }, { p: [30, 30], r: 2 }, { p: [13, 5], r: 3.5 }, { p: [18, 5], r: 2 }], loops);
    // #3 touches #2 (chained) which touches the square; #1 is far away.
    expect([...bad]).toEqual([1]);
  });

  it('defaults and limits', () => {
    expect(defaultHeadDiameter(0.5, 0.4)).toBe(8);
    expect(defaultHeadDiameter(2, 0.4)).toBe(20);
    expect(detectionRadiusMax([])).toBe(100);
  });
});

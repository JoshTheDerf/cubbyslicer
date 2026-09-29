import { describe, expect, it } from 'vitest';
import { analyzeMesh, circleFrom3, ensurePlaneBorder, pickFeature, splitBorder, transformFeature, type V3 } from './features';
import { measure } from './measure';
import { boxMesh, cylinderMesh } from '../../project/primitives';

describe('measure: features', () => {
  it('segments a box into 6 planes with 4 edges each', () => {
    const b = boxMesh(20, 10, 5);
    const m = analyzeMesh(b.positions, b.indices);
    expect(m.planes.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      const pl = ensurePlaneBorder(m, i);
      expect(pl.edges!.length).toBe(4);
      expect(pl.circles!.length).toBe(0);
    }
  });

  it('finds the circle on a cylinder cap and picks centre / circle / plane', () => {
    const c = cylinderMesh(10, 20, 48);
    const m = analyzeMesh(c.positions, c.indices);
    // A cap triangle: normal ±Z.
    let tri = -1;
    for (let t = 0; t < m.planeOfTri.length; t++) if (Math.abs(m.planes[m.planeOfTri[t]].normal[2]) > 0.99) { tri = t; break; }
    const pl = ensurePlaneBorder(m, m.planeOfTri[tri]);
    expect(pl.circles!.length).toBe(1);
    expect(pl.circles![0].r).toBeCloseTo(10, 1);
    const z = pl.origin[2];
    expect(pickFeature(m, tri, [0.1, 0, z], 0.5).type).toBe('point');
    expect(pickFeature(m, tri, [9.9, 0.1, z], 0.5).type).toBe('circle');
    expect(pickFeature(m, tri, [4, 1, z], 0.5).type).toBe('plane');
    expect(pickFeature(m, tri, [4, 1, z], 0.5, true)).toEqual({ type: 'point', p: [4, 1, z] });
  });

  it('splits a rounded slot into edges and arcs', () => {
    // Rectangle 40 x 10 with semicircular ends of radius 5 (tessellated in 12 steps each).
    const pts: V3[] = [];
    for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + (Math.PI * i) / 12; pts.push([20 + 5 * Math.cos(a), 5 * Math.sin(a), 0]); }
    for (let i = 0; i <= 12; i++) { const a = Math.PI / 2 + (Math.PI * i) / 12; pts.push([-20 + 5 * Math.cos(a), 5 * Math.sin(a), 0]); }
    const r = splitBorder(pts, [0, 0, 1]);
    expect(r.circles.length).toBe(2);
    for (const c of r.circles) expect(c.r).toBeCloseTo(5, 3);
    expect(r.edges.length).toBe(2);
  });

  it('computes circumcircles', () => {
    const c = circleFrom3([1, 0, 0], [0, 1, 0], [-1, 0, 0])!;
    expect(c.r).toBeCloseTo(1);
    expect(c.c[0]).toBeCloseTo(0); expect(c.c[1]).toBeCloseTo(0);
    expect(circleFrom3([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBeNull();
  });

  it('transforms features (translation + uniform scale)', () => {
    const m = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 0, 0, 1];
    const c = transformFeature({ type: 'circle', c: [0, 0, 0], n: [0, 0, 1], r: 3 }, m);
    expect(c).toMatchObject({ type: 'circle', c: [10, 0, 0], r: 6 });
    const pl = transformFeature({ type: 'plane', o: [0, 0, 1], n: [0, 0, 1], plane: 0 }, m);
    expect(pl).toMatchObject({ o: [10, 0, 2], n: [0, 0, 1] });
  });
});

describe('measure: measurements', () => {
  it('point-point gives distance and delta', () => {
    const r = measure({ type: 'point', p: [0, 0, 0] }, { type: 'point', p: [3, 4, 12] });
    expect(r.strict!.value).toBeCloseTo(13);
    expect(r.delta).toEqual([3, 4, 12]);
  });

  it('point-edge strict vs infinite', () => {
    const r = measure({ type: 'point', p: [20, 5, 0] }, { type: 'edge', a: [0, 0, 0], b: [10, 0, 0] });
    expect(r.infinite!.value).toBeCloseTo(5);
    expect(r.strict!.value).toBeCloseTo(Math.hypot(10, 5));
  });

  it('parallel planes give their distance; perpendicular faces 90°', () => {
    const top = { type: 'plane' as const, o: [0, 0, 10] as V3, n: [0, 0, 1] as V3, plane: 0 };
    const bottom = { type: 'plane' as const, o: [0, 0, 0] as V3, n: [0, 0, -1] as V3, plane: 1 };
    const side = { type: 'plane' as const, o: [5, 0, 5] as V3, n: [1, 0, 0] as V3, plane: 2 };
    expect(measure(top, bottom).infinite!.value).toBeCloseTo(10);
    expect(measure(top, side).angle!.deg).toBeCloseTo(90);
    // A 45° chamfer next to the top face: interior angle 135°.
    const chamfer = { type: 'plane' as const, o: [6, 0, 9] as V3, n: [Math.SQRT1_2, 0, Math.SQRT1_2] as V3, plane: 3 };
    expect(measure(top, chamfer).angle!.deg).toBeCloseTo(135, 3);
  });

  it('edge-edge angle and distance', () => {
    const r = measure({ type: 'edge', a: [0, 0, 0], b: [10, 0, 0] }, { type: 'edge', a: [0, 0, 0], b: [0, 10, 0] });
    expect(r.angle!.deg).toBeCloseTo(90);
    expect(r.strict!.value).toBeCloseTo(0);
    const skew = measure({ type: 'edge', a: [0, 0, 0], b: [10, 0, 0] }, { type: 'edge', a: [5, -5, 3], b: [5, 5, 3] });
    expect(skew.strict!.value).toBeCloseTo(3);
  });

  it('circle-circle centre distance; point-circle distance to the rim', () => {
    const a = { type: 'circle' as const, c: [0, 0, 0] as V3, n: [0, 0, 1] as V3, r: 2 };
    const b = { type: 'circle' as const, c: [10, 0, 0] as V3, n: [0, 0, 1] as V3, r: 3 };
    expect(measure(a, b).strict!.value).toBeCloseTo(10);
    expect(measure({ type: 'point', p: [5, 0, 0] }, a).strict!.value).toBeCloseTo(3);
  });

  it('swaps endpoints back when the arguments were reordered', () => {
    const r = measure({ type: 'plane', o: [0, 0, 0], n: [0, 0, 1], plane: 0 }, { type: 'point', p: [1, 1, 5] });
    expect(r.infinite!.from).toEqual([1, 1, 0]);
    expect(r.infinite!.to).toEqual([1, 1, 5]);
    expect(r.delta).toEqual([0, 0, 5]);
  });
});

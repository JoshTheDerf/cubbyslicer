import { describe, expect, it } from 'vitest';
import {
  clampAnchor, convexHull, moveBoxInsidePolygon, nearestClearAnchor, offsetConvex, pointInPolygon, relocateAnchor, rotatePoly,
  type Box2, type P2, type Poly,
} from './wipeTowerPlace';

// Orca's tests/libslic3r/test_wipe_tower_estimate.cpp fixtures.
const square = (s: number): Poly => [[0, 0], [s, 0], [s, s], [0, s]];
const box = (x0: number, y0: number, x1: number, y1: number): Poly => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const plateAnchors: Box2 = { min: [0, 0], max: [90, 90] };

/** Shoelace overlap check by sampling: the footprint at `a` has no interior point inside an obstacle. */
function clearOf(fp: Poly, a: P2, obstacles: Poly[]): boolean {
  const moved = fp.map(([x, y]) => [x + a[0], y + a[1]] as P2);
  const xs = moved.map((p) => p[0]), ys = moved.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let i = 1; i < 20; i++) for (let j = 1; j < 20; j++) {
    const p: P2 = [x0 + ((x1 - x0) * i) / 20, y0 + ((y1 - y0) * j) / 20];
    if (!pointInPolygon(moved, p)) continue;
    for (const o of obstacles) {
      const h = convexHull(o);
      let inside = true;
      for (let k = 0; k < h.length; k++) {
        const a2 = h[k], b2 = h[(k + 1) % h.length];
        if ((b2[0] - a2[0]) * (p[1] - a2[1]) - (b2[1] - a2[1]) * (p[0] - a2[0]) <= 1e-6) { inside = false; break; }
      }
      if (inside) return false;
    }
  }
  return true;
}

describe('nearestClearAnchor (nearest_clear_wipe_tower_anchor)', () => {
  it('a tower already clear of every object stays where it is', () => {
    expect(nearestClearAnchor(plateAnchors, square(10), [box(40, 0, 60, 100)], [10, 70])).toEqual([10, 70]);
  });
  it('a tower that lands on an object moves to the nearest side of it', () => {
    const obs = [box(40, 0, 60, 100)];
    const a = nearestClearAnchor(plateAnchors, square(10), obs, [42, 50])!;
    expect(clearOf(square(10), a, obs)).toBe(true);
    expect(a[0]).toBeCloseTo(30, 3);
    expect(a[1]).toBeCloseTo(50, 3);
  });
  it('is placed nearest its saved position even when that is off the plate', () => {
    const obs = [box(0, 60, 30, 100)];
    const a = nearestClearAnchor(plateAnchors, square(10), obs, [20, 120])!;
    expect(clearOf(square(10), a, obs)).toBe(true);
    expect(a[0]).toBeCloseTo(30, 3);
    expect(a[1]).toBeCloseTo(90, 3);
  });
  it('a rotated tower keeps its turned footprint off the objects', () => {
    const fp = rotatePoly(square(10), 90);
    const obs = [box(40, 0, 60, 100)];
    const a = nearestClearAnchor(plateAnchors, fp, obs, [65, 50])!;
    expect(clearOf(fp, a, obs)).toBe(true);
    expect(a[0]).toBeCloseTo(70, 3);
  });
  it('a plate with no room reports that no anchor is clear', () => {
    expect(nearestClearAnchor(plateAnchors, square(10), [box(-5, -5, 105, 105)], [50, 50])).toBeNull();
  });
  it('a tower pinned to one coordinate by a cramped plate can still move along the other', () => {
    const a = nearestClearAnchor({ min: [0, 0], max: [0, 90] }, square(10), [box(-5, 42, 15, 62)], [0, 45])!;
    expect(a[0]).toBeCloseTo(0, 3);
    expect(a[1]).toBeCloseTo(32, 3);
  });
  it('a single anchor is kept when clear and refused when taken', () => {
    const spot: P2 = [10, 10];
    expect(nearestClearAnchor({ min: spot, max: spot }, square(10), [box(40, 0, 60, 100)], spot)).toEqual(spot);
    expect(nearestClearAnchor({ min: spot, max: spot }, square(10), [box(15, 0, 60, 100)], spot)).toBeNull();
  });
  it('a tower slides off a slanted side of an object', () => {
    const obs: Poly[] = [[[40, 0], [60, 0], [50, 40]]];
    const t: P2 = [45, 5];
    const a = nearestClearAnchor(plateAnchors, square(10), obs, t)!;
    expect(clearOf(square(10), a, obs)).toBe(true);
    expect(Math.hypot(a[0] - t[0], a[1] - t[1])).toBeCloseTo(13.75 / Math.sqrt(1 + 1 / 16), 3);
  });
});

describe('moveBoxInsidePolygon (WipeTower::move_box_inside_polygon)', () => {
  const at = (x: number, y: number, s: number): Box2 => ({ min: [x, y], max: [x + s, y + s] });
  const squareBed: Poly[] = [box(0, 0, 200, 200)];
  const hexBed: Poly[] = [Array.from({ length: 6 }, (_, i) => [100 * Math.cos((i * Math.PI) / 3), 100 * Math.sin((i * Math.PI) / 3)] as P2)];
  const landsInside = (b: Box2, m: P2, pad: number) => {
    const c: P2[] = [[b.min[0] + m[0] - pad, b.min[1] + m[1] - pad], [b.max[0] + m[0] + pad, b.min[1] + m[1] - pad],
      [b.max[0] + m[0] + pad, b.max[1] + m[1] + pad], [b.min[0] + m[0] - pad, b.max[1] + m[1] + pad]];
    return c.every((p) => pointInPolygon(hexBed[0], p));
  };
  it('a rectangular bed is left to the bounding box clamp', () => expect(moveBoxInsidePolygon(at(50, 50, 30), squareBed, 1)).toEqual([0, 0]));
  it('only the violated axis is clamped', () => {
    const m = moveBoxInsidePolygon(at(185, 50, 30), squareBed, 1);
    expect(m[0]).toBeCloseTo(-16, 6);
    expect(m[1]).toBeCloseTo(0, 6);
  });
  it('a footprint already inside the outline is left alone', () => expect(moveBoxInsidePolygon(at(-15, -15, 30), hexBed, 1)).toEqual([0, 0]));
  it('a footprint in the bounding box corner is pulled onto the bed', () => {
    const b = at(55, 50, 30);
    expect(landsInside(b, [0, 0], 1)).toBe(false);
    expect(landsInside(b, moveBoxInsidePolygon(b, hexBed, 1), 0.99)).toBe(true);
  });
  it('a footprint too large for the bed is left alone', () => expect(moveBoxInsidePolygon(at(-200, -200, 400), hexBed, 1)).toEqual([0, 0]));
});

describe('clampAnchor / relocateAnchor (PartPlate::estimate_wipe_tower_polygon)', () => {
  const size = { width: 35, depth: 20, brim: 3, cone: 0, rotation: 0 };
  it('keeps a valid position and snaps a slightly-out drop onto the bound', () => {
    expect(clampAnchor(100, 100, size, 256, 256)).toMatchObject({ x: 100, y: 100, replaced: false });
    // x_hi = 256 - 35 - 4 = 217; 220 is within the 5 mm tolerance.
    expect(clampAnchor(220, 100, size, 256, 256)).toMatchObject({ x: 217, replaced: false });
  });
  it('re-places a far-out position with the 15 mm comfort margin', () => {
    // margin_c = 15 + 3 = 18 → x_hi_c = 256 - 35 - 18 = 203
    expect(clampAnchor(300, 100, size, 256, 256)).toMatchObject({ x: 203, y: 100, replaced: true });
  });
  it('a re-placed tower moves off the objects to the nearest clear spot', () => {
    // The re-placed spot (203, 100) sits on an object: the keep-out (brim 3) needs x ≥ 203 + ... → nearest clear.
    const obstacles = [offsetConvex(box(150, 50, 256, 160), 1)];
    const r = relocateAnchor(300, 100, size, 256, 256, () => obstacles);
    expect(r.moved).toBe(true);
    expect(r.overlapsObjects).toBe(false);
    // Clear above the object: y ≥ 161 + 3 = 164 (comfort bounds allow up to 256 - 20 - 18 = 218).
    expect(r.y).toBeCloseTo(164, 3);
    expect(r.x).toBeCloseTo(203, 3);
  });
  it('a plate with no free room leaves the tower on an object', () => {
    const r = relocateAnchor(300, 100, size, 256, 256, () => [box(-10, -10, 270, 270)]);
    expect(r).toMatchObject({ moved: true, overlapsObjects: true, x: 203, y: 100 });
  });
  it('a valid position is never relocated, even on an object (desktop keeps the user’s choice)', () => {
    const r = relocateAnchor(100, 100, size, 256, 256, () => [box(0, 0, 256, 256)]);
    expect(r).toMatchObject({ moved: false, x: 100, y: 100 });
  });
});

describe('offsetConvex', () => {
  it('grows a square by delta with mitred corners', () => {
    const o = offsetConvex(box(0, 0, 10, 10), 2);
    const xs = o.map((p) => p[0]), ys = o.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(-2);
    expect(Math.max(...ys)).toBeCloseTo(12);
    expect(o).toHaveLength(4);
  });
});

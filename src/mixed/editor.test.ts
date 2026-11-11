import { describe, expect, it } from 'vitest';
import { linearCurve, parseGradientCurve, sampleGradientCurve, serializeGradientCurve } from './mixer';
import { slotValues, readMixedSlots, typeMismatchMessage, type MixedDef } from './model';
import {
  dataToPx, deleteAnchor, dragAnchor, hitAnchor, hitCurve, normalizePoints, plotRect, press, pxToData, reversePoints, sameCurve, toVisualY,
} from './curveEdit';
import {
  applyDraggedTriangleRatio, applyManualRatio, barRatio, parseRatioText, triangleDrag, trianglePoint, triangleVertices, triBarycentric, triContains, weightsFromRatios,
} from './ratioEdit';

describe('gradient curve editor (GradientCurveEditor.cpp)', () => {
  const r = plotRect(300, 230);
  it('lays the plot out as a square from the Orca ratios', () => {
    expect(r).toEqual({ x: 9, y: 35, width: 160, height: 160 });
    expect(dataToPx(r, 0, 1)).toEqual({ x: 9, y: 35 });
    expect(pxToData(r, 9 + 80, 35 + 40)).toEqual({ x: 0.5, y: 0.75 });
    expect(pxToData(r, -50, 999)).toEqual({ x: 0, y: 0 });
  });

  it('presses an anchor: drag it, clear its tangents, report a change only when there were tangents', () => {
    const pts = parseGradientCurve('0,0.9|0.5,0.5,-1.2000,-0.8000|1,0.1');
    const a = dataToPx(r, 0.5, 0.5);
    const res = press(pts, r, 0, a.x + 2, a.y - 1);
    expect(res.kind).toBe('anchor');
    if (res.kind !== 'anchor') return;
    expect(res.index).toBe(1);
    expect(res.changed).toBe(true);
    expect(Number.isNaN(res.points[1].mIn) && Number.isNaN(res.points[1].mOut)).toBe(true);
    const again = press(res.points, r, 0, a.x, a.y);
    expect(again.kind === 'anchor' && again.changed).toBe(false);
  });

  it('presses the selected line: inserts an anchor on the curve at that x', () => {
    const pts = linearCurve('ab');
    const q = dataToPx(r, 0.25, sampleGradientCurve(pts, 0.25));
    const res = press(pts, r, 0, q.x, q.y);
    expect(res.kind).toBe('anchor');
    if (res.kind !== 'anchor') return;
    expect(res.index).toBe(1);
    expect(res.points).toHaveLength(3);
    expect(res.points[1].x).toBeCloseTo(0.25, 2);
    expect(res.points[1].y).toBeCloseTo(0.7, 2);
  });

  it('presses the other curve: selects it; component 2 is drawn at 1 − y', () => {
    const pts = linearCurve('ab'); // 0.9 → 0.1; curve 1 runs 0.1 → 0.9
    const q = dataToPx(r, 0.25, toVisualY(1, sampleGradientCurve(pts, 0.25)));
    expect(press(pts, r, 0, q.x, q.y)).toEqual({ kind: 'select', curve: 1 });
    expect(hitCurve(pts, r, 1, q.x, q.y)?.curve).toBe(1);
    expect(press(pts, r, 0, r.x + 80, r.y + 2)).toEqual({ kind: 'none' });
  });

  it('drags: endpoints keep x, interior anchors stay between neighbours, y stays in the 10–90 % band', () => {
    const pts = parseGradientCurve('0,0.9|0.5,0.5|1,0.1');
    expect(dragAnchor(pts, 0, 0, 0.4, 1)[0]).toMatchObject({ x: 0, y: 0.9 });
    const mid = dragAnchor(pts, 1, 0, 1.5, 0);
    expect(mid[1].x).toBeCloseTo(1 - 1e-4, 6);
    expect(mid[1].y).toBe(0.1);
    // On curve 1 a drag to visual 0.7 stores 0.3.
    expect(dragAnchor(pts, 1, 1, 0.5, 0.7)[1].y).toBeCloseTo(0.3, 9);
  });

  it('deletes interior anchors only', () => {
    const pts = parseGradientCurve('0,0.9|0.5,0.5|1,0.1');
    expect(deleteAnchor(pts, 0)).toBeNull();
    expect(deleteAnchor(pts, 2)).toBeNull();
    expect(deleteAnchor(pts, 1)).toHaveLength(2);
    const a = dataToPx(r, 0.5, 0.5);
    expect(hitAnchor(pts, r, 0, a.x + 6, a.y)).toBe(1);
    expect(hitAnchor(pts, r, 0, a.x + 7, a.y)).toBe(-1);
  });

  it('reverses: mirrors y and flips tangents, so a direction switch keeps the shape', () => {
    const pts = parseGradientCurve('0,0.8|0.3,0.6,0.5000,|1,0.2');
    const rev = reversePoints(pts);
    expect(rev.map((p) => p.y)).toEqual([0.19999999999999996, 0.4, 0.8]);
    expect(rev[1].mIn).toBe(-0.5);
    expect(Number.isNaN(rev[1].mOut)).toBe(true);
    expect(reversePoints(reversePoints(linearCurve('ab'))).map((p) => p.y)).toEqual([0.9, 0.09999999999999998]);
    expect(sameCurve(linearCurve('ab'), linearCurve('ab'))).toBe(true);
    // The straight A→B line reversed is the B→A line, which is stored as "no custom curve".
    const d: MixedDef = { components: [1, 2], ratios: [50, 50], gradient: true, direction: 'ba', curve: reversePoints(linearCurve('ab')), perPart: false };
    expect(slotValues(d).filament_mixed_gradient_curve).toBe('');
  });

  it('normalises like set_points', () => {
    const n = normalizePoints([{ x: 0.7, y: 0.95, mIn: NaN, mOut: NaN }, { x: 0.2, y: 0.05, mIn: NaN, mOut: NaN }]);
    expect(n.map((p) => [p.x, p.y])).toEqual([[0, 0.1], [1, 0.9]]);
  });

  it('round-trips a desktop curve with tangents untouched', () => {
    const s = '0.0000,0.9000|0.3000,0.7500,-0.4000,|0.6500,0.2000,,1.2500|1.0000,0.1000';
    const settings = {
      filament_is_mixed: ['0', '0', '1'], filament_mixed_components: ['', '', '1,2'], filament_mixed_sublayer_ratios: ['', '', '0.5000,0.5000'],
      filament_mixed_gradient: ['0', '0', '1'], filament_mixed_gradient_range: ['', '', '0.9000,0.1000'], filament_mixed_gradient_curve: ['', '', s],
      filament_mixed_gradient_per_part: ['0', '0', '0'],
    };
    const def = readMixedSlots(settings)[0].def;
    // The editor copies anchors as they are.
    const copy = { ...def, curve: def.curve.map((a) => ({ ...a })) };
    expect(slotValues(copy).filament_mixed_gradient_curve).toBe(s);
    expect(serializeGradientCurve(def.curve)).toBe(s);
  });
});

describe('ratio editing (MixedFilamentDialog)', () => {
  it('ratio bar: left is all of the first filament, clamped to 10–90', () => {
    expect(barRatio(0, 200)).toBe(90);
    expect(barRatio(50, 200)).toBe(75);
    expect(barRatio(199, 200)).toBe(10);
  });

  it('apply_manual_ratio with two components', () => {
    expect(applyManualRatio([50, 50], 0, 70)).toEqual([70, 30]);
    expect(applyManualRatio([50, 50], 1, 95)).toEqual([10, 90]);
    expect(applyManualRatio([50, 50], 0, 3)).toEqual([10, 90]);
  });

  it('apply_manual_ratio with three components: the others keep their proportion', () => {
    expect(applyManualRatio([25, 25, 50], 2, 40)).toEqual([30, 30, 40]);
    expect(applyManualRatio([20, 30, 50], 0, 60)).toEqual([60, 15, 25]);
    expect(applyManualRatio([10, 10, 80], 2, 80)).toEqual([10, 10, 80]);
    expect(applyManualRatio([34, 33, 33], 0, 99)).toEqual([80, 10, 10]);
    const r = applyManualRatio([33, 33, 34], 1, 45);
    expect(r[1]).toBe(45);
    expect(r.reduce((a, b) => a + b)).toBe(100);
  });

  it('apply_dragged_triangle_ratio: each ≥ 10, sum 100', () => {
    expect(applyDraggedTriangleRatio(100, 0, 0)).toEqual([80, 10, 10]);
    expect(applyDraggedTriangleRatio(33, 33, 34)).toEqual([33, 33, 34]);
    expect(applyDraggedTriangleRatio(50, 50, 0)).toEqual([45, 45, 10]);
  });

  it('triangle geometry: vertices, containment, barycentric clamp', () => {
    const v = triangleVertices(160, 160);
    expect(v[0]).toEqual({ x: 80, y: (160 - 120 * Math.sqrt(3) / 2) / 2 });
    expect(v[1].x).toBe(20);
    expect(v[2].x).toBe(140);
    const c = trianglePoint([1 / 3, 1 / 3, 1 / 3], v);
    expect(triContains(c, ...v)).toBe(true);
    expect(triContains({ x: 2, y: 2 }, ...v)).toBe(false);
    const w = triBarycentric(c, ...v);
    w.forEach((x) => expect(x).toBeCloseTo(1 / 3, 9));
    // Dragging onto the top corner: all of component 1, then the 10 % floor.
    expect(triangleDrag(v[0], v).ratios).toEqual([80, 10, 10]);
    expect(triangleDrag(c, v).ratios).toEqual([33, 33, 34]);
    // A point outside snaps in.
    const out = triangleDrag({ x: 80, y: 159 }, v);
    expect(out.weights.reduce((a, b) => a + b)).toBeCloseTo(1, 9);
    expect(weightsFromRatios([25, 25, 50])).toEqual([0.25, 0.25, 0.5]);
  });

  it('parses the inline editor text', () => {
    expect(parseRatioText(' 45 ')).toBe(45);
    expect(parseRatioText('45%')).toBe(45);
    expect(parseRatioText('abc')).toBeNull();
    expect(parseRatioText('')).toBeNull();
  });

  it('type warning wording and grouping', () => {
    expect(typeMismatchMessage([1, 2], ['PLA', 'PLA'])).toBeNull();
    expect(typeMismatchMessage([1, 3, 2], ['PLA', 'PETG', 'PLA'])).toBe(
      'Different filament types cannot be mixed: Slot 2 (PETG); Slot 1, 3 (PLA). Please select the same filament type.');
  });
});

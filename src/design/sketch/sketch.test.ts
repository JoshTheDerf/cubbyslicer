/**
 * Slice 3 of the Design tab — the sketcher: 2D geometry, snapping / inference, the drawing tools'
 * shapes, constraint planning and guards, inline values, and the session on the fake kernel
 * (one app undo step per sketch, sketch-level undo inside, conflicts naming the constraint they
 * clash with, editing an existing sketch, recovery after a kernel reset).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import * as S from '../../project/store';
import { resolvedConfig } from '../../app/state';
import { setOrcaCadRecipe } from '../../project/persistence/passthrough';
import { undoOverride, doUndo } from '../../app/shell/commands/edit';
import { FakeKernel } from '../kernel/fake';
import { design, designKernel, designReady, editBlocker, setDesignBackend } from '../session';
import { arc, arcThrough, circleThrough, cons, entity, line, nearestOn, splineAt, tangentArc, inSweep, type V2 } from './model';
import { axisHint, snapPoint } from './infer';
import { anchorConstraints, DRAW_TOOL_BY_ID, type BuildOpts } from './shapes';
import { duplicateOf, fromWire, guard, planLocal, refsPoint, toWire, describeConstraint } from './constraints';
import { evalValue } from './expr';
import * as K from './session';
import { sk } from './session';
import { getActionScope, setActionScope } from '../../app/actions/dispatch';
import { liveQuotes, quoteEdit, quotedEntity, quoteText } from './quotes';

const close = (a: V2, b: V2, eps = 1e-9) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
const opts = (o: Partial<BuildOpts> = {}): BuildOpts => ({ base: 0, entities: [], snaps: [], axes: [], construction: false, polygonSides: 6, polygonCircumscribed: false, final: true, ...o });

describe('sketch geometry', () => {
  it('builds arcs through three points and tangent arcs that leave in the given direction', () => {
    const a = arcThrough([10, 0], [-10, 0], [0, 10])!;
    expect(a.radius).toBeCloseTo(10);
    expect(close(a.center, [0, 0], 1e-9)).toBe(true);
    expect(inSweep(a, Math.PI / 2)).toBe(true);
    expect(inSweep(a, -Math.PI / 2)).toBe(false);
    const t = tangentArc([0, 0], [1, 0], [10, 10])!;
    expect(t.radius).toBeCloseTo(10);
    expect(close(t.center, [0, 10], 1e-9)).toBe(true);
    expect(t.end_angle - t.start_angle).toBeGreaterThan(0); // CCW: centre on the left of travel
    expect(circleThrough([0, 0], [1, 1], [2, 2])).toBeNull();
  });
  it('finds nearest points on lines / arcs / circles and evaluates clamped B-splines', () => {
    expect(nearestOn(line([0, 0], [10, 0]), [3, 4]).d).toBeCloseTo(4);
    expect(nearestOn(entity('circle', { center: [0, 0], radius: 5 }), [10, 0]).d).toBeCloseTo(5);
    const q = arc([0, 0], 5, 0, Math.PI / 2);
    expect(nearestOn(q, [-5, -5]).t).toBe(0); // off the sweep: the nearer end
    expect(close(splineAt([[0, 0], [5, 5], [10, 0]], 0), [0, 0])).toBe(true);
    expect(close(splineAt([[0, 0], [5, 5], [10, 0]], 1 - 1e-12), [10, 0], 1e-6)).toBe(true);
  });
});

describe('snapping and inference (Orca SketchInference)', () => {
  const ents = [line([0, 0], [10, 0]), entity('circle', { center: [20, 0], radius: 3 })];
  it('prefers ends, then centres, then the origin, then midpoints, then edges', () => {
    expect(snapPoint(ents, [10.2, 0.1], 1)).toMatchObject({ kind: 'end', entity: 0, role: 'p1' });
    expect(snapPoint(ents, [20.1, 0.1], 1)).toMatchObject({ kind: 'center', entity: 1, role: 'center' });
    expect(snapPoint(ents, [5.1, 0.2], 1)).toMatchObject({ kind: 'midpoint', entity: 0 });
    expect(snapPoint(ents, [7, 0.3], 1)).toMatchObject({ kind: 'edge', entity: 0 });
    expect(snapPoint(ents, [0.2, 0.1], 1)).toMatchObject({ kind: 'end', entity: 0 }); // an end beats the origin
    expect(snapPoint([], [0.2, 0.1], 1)).toMatchObject({ kind: 'origin', entity: -2 });
    expect(snapPoint(ents, [50, 50], 1).kind).toBe('none');
  });
  it('infers H / V within 3°', () => {
    expect(axisHint([0, 0], [10, 0.4])).toBe('horizontal');
    expect(axisHint([0, 0], [0.3, 10])).toBe('vertical');
    expect(axisHint([0, 0], [10, 3])).toBeNull();
  });
  it('turns click snaps into Coincident / Midpoint / Point on object on the built shape', () => {
    const t = DRAW_TOOL_BY_ID.get('line')!;
    const b = t.build([[0, 0], [10, 5]], opts({ base: 2 }))!;
    const ex = [line([0, 0], [10, 0]), line([10, 0], [10, 10])];
    const c = anchorConstraints(b, [{ kind: 'origin', p: [0, 0], entity: -2, role: 'p0' }, { kind: 'midpoint', p: [10, 5], entity: 1 }], ex);
    expect(c).toEqual([cons('coincident', 2, 'p0', -2, 'p0'), cons('midpoint', 2, 'p1', 1)]);
  });
});

describe('drawing tools (shapes)', () => {
  it('a corner rectangle is 4 lines, 4 corner joins, H / V, and a Width / Height queue', () => {
    const b = DRAW_TOOL_BY_ID.get('rect')!.build([[0, 0], [40, 20]], opts())!;
    expect(b.entities.map((e) => e.type)).toEqual(['line', 'line', 'line', 'line']);
    expect(b.constraints.filter((c) => c.type === 'coincident')).toHaveLength(4);
    expect(b.constraints.filter((c) => c.type === 'horizontal' || c.type === 'vertical')).toHaveLength(4);
    expect(b.dims.map((d) => [d.label, d.constraint.value])).toEqual([['Width', 40], ['Height', 20]]);
  });
  it('a slot keeps its caps tangent and equal; a polygon is equal sides on a construction circle', () => {
    const s = DRAW_TOOL_BY_ID.get('slot')!.build([[0, 0], [30, 0], [10, 4]], opts())!;
    expect(s.entities.map((e) => `${e.type}${e.construction ? '*' : ''}`)).toEqual(['line', 'arc', 'line', 'arc', 'line*']);
    expect(s.constraints.filter((c) => c.type === 'tangent')).toHaveLength(4);
    expect(s.entities[1].radius).toBeCloseTo(4);
    const p = DRAW_TOOL_BY_ID.get('polygon')!.build([[0, 0], [10, 0]], opts({ polygonSides: 5 }))!;
    expect(p.entities.filter((e) => e.type === 'line')).toHaveLength(5);
    expect(p.entities[5]).toMatchObject({ type: 'circle', construction: true, radius: 10 });
    expect(p.constraints.filter((c) => c.type === 'equal_length')).toHaveLength(4);
    const circ = DRAW_TOOL_BY_ID.get('polygon')!.build([[0, 0], [10, 0]], opts({ polygonSides: 6, polygonCircumscribed: true }))!;
    expect(circ.entities[6].radius).toBeCloseTo(10 / Math.cos(Math.PI / 6));
  });
  it('an arc slot is Orca’s four arcs: closed, tangent, concentric, with a Radius / Width queue', () => {
    const t = DRAW_TOOL_BY_ID.get('arc-slot')!;
    // Orca's click_snaps: only the start (the second click) snaps.
    expect([0, 1, 2, 3].map((n) => t.snapClick!(n))).toEqual([false, true, false, false]);
    // Rubber band: the centre-line circle, then the centre-line arc (counter-clockwise).
    expect(t.build([[0, 0], [20, 0]], opts({ final: false }))!.entities[0]).toMatchObject({ type: 'circle', construction: true, radius: 20 });
    const cl = t.build([[0, 0], [20, 0], [0, 5]], opts({ final: false }))!.entities[0];
    expect(cl).toMatchObject({ type: 'arc', construction: true });
    expect(cl.end_angle - cl.start_angle).toBeCloseTo(Math.PI / 2);
    const b = t.build([[0, 0], [20, 0], [0, 5], [23, 0]], opts({ base: 3 }))!;
    expect(b.entities.map((e) => e.type)).toEqual(['arc', 'arc', 'arc', 'arc']);
    expect(b.entities.map((e) => +e.radius.toFixed(6))).toEqual([23, 3, 17, 3]);
    for (let i = 0; i < 4; i++) expect(close(b.entities[i].p1, b.entities[(i + 1) % 4].p0, 1e-9), `joint ${i}`).toBe(true);
    expect(b.entities[2].end_angle - b.entities[2].start_angle).toBeCloseTo(-Math.PI / 2); // the inner arc runs back, as Orca's
    expect(close(b.entities[3].center, [20, 0], 1e-9) && close(b.entities[1].center, [0, 20], 1e-9)).toBe(true);
    expect(b.constraints.filter((c) => c.type === 'coincident' && c.ra === 'p1')).toHaveLength(4);
    expect(b.constraints.filter((c) => c.type === 'tangent')).toHaveLength(4);
    expect(b.constraints).toContainEqual(cons('coincident', 5, 'center', 3, 'center'));
    expect(b.constraints.every((c) => !guard(c, [line([0, 0], [1, 0]), line([0, 0], [1, 0]), line([0, 0], [1, 0]), ...b.entities]))).toBe(true);
    expect(b.dims.map((d) => [d.label, d.constraint.type, +d.constraint.value.toFixed(6)])).toEqual([['Radius', 'distance', 20], ['Width', 'diameter', 6]]);
    // The start's snap lands on the start cap's centre (the centre-line start).
    expect(anchorConstraints(b, [null, { kind: 'end', p: [20, 0], entity: 0, role: 'p1' }], [line([0, 0], [20, 0])])).toEqual([cons('coincident', 6, 'center', 0, 'p1')]);
    // make_arc_slot needs 0 < width < radius; a zero sweep makes nothing.
    expect(t.build([[0, 0], [20, 0], [0, 5], [41, 0]], opts())).toBeNull();
    expect(t.build([[0, 0], [20, 0], [30, 0], [23, 0]], opts())).toBeNull();
  });
  it('every tool builds from its click count; degenerate clicks build nothing', () => {
    const pts: V2[] = [[0, 0], [20, 3], [7, 12], [3, 9], [-4, 6]];
    for (const [id, t] of DRAW_TOOL_BY_ID) {
      if (id === 'arc-tangent') continue;
      const n = typeof t.clicks === 'number' ? t.clicks : 3;
      const b = t.build(pts.slice(0, n), opts({ snaps: [] }));
      expect(b, id).not.toBeNull();
      expect(b!.entities.length, id).toBeGreaterThan(0);
    }
    expect(DRAW_TOOL_BY_ID.get('rect')!.build([[0, 0], [0, 10]], opts())).toBeNull();
    const ta = DRAW_TOOL_BY_ID.get('arc-tangent')!.build([[10, 0], [20, 10]], opts({ base: 1, entities: [line([0, 0], [10, 0])], snaps: [{ kind: 'end', p: [10, 0], entity: 0, role: 'p1' }] }))!;
    expect(ta.constraints).toEqual([cons('tangent', 0, 'p0', 1, 'p0')]);
  });
});

describe('constraint planning and guards', () => {
  const ents = [line([0, 0], [10, 0]), line([10, 0], [10, 5]), entity('circle', { center: [5, 5], radius: 2 }), entity('point', { p0: [3, 3] })];
  it('plans vertex selections locally (Orca planner rules)', () => {
    expect(planLocal('coincident', [{ e: 0, role: 'p0' }, { e: 3 }], ents)).toEqual({ kind: 'apply', constraints: [cons('coincident', 0, 'p0', 3, 'p0')] });
    expect(planLocal('coincident', [{ e: 3 }, { e: 2 }], ents)).toEqual({ kind: 'apply', constraints: [cons('point_on_object', 3, 'p0', 2)] });
    expect(planLocal('midpoint', [{ e: 3 }, { e: 0 }], ents)).toEqual({ kind: 'apply', constraints: [cons('midpoint', 3, 'p0', 0)] });
    expect(planLocal('distance', [{ e: 0 }], ents)).toMatchObject({ kind: 'ask_value', prefill: 10 });
    expect(planLocal('distance', [{ e: 2 }], ents)).toMatchObject({ kind: 'ask_value', prefill: 4, constraints: [{ type: 'diameter' }] });
    const dx = planLocal('distance_x', [{ e: 1, role: 'p0' }, { e: 0, role: 'p0' }], ents);
    expect(dx).toMatchObject({ kind: 'ask_value', prefill: 10, constraints: [{ ea: 0, eb: 1 }] }); // reordered: non-negative
    expect(planLocal('parallel', [{ e: 0 }, { e: 1 }], ents)).toBeNull(); // entities only: the kernel's planner
    expect(planLocal('point_on_line', [{ e: 3 }, { e: 0 }], ents)).toMatchObject({ kind: 'ask_value', prefill: 3 });
  });
  it('refuses requests that trap the kernel (radius / equal radius on a line) and duplicates', () => {
    expect(guard(cons('radius', 0, 'center', -1, 'p0', 3), ents)).toMatch(/arc or a circle/);
    expect(guard(cons('equal_radius', 0, 'p0', 2), ents)).toMatch(/two arcs/);
    expect(guard(cons('tangent', 0, 'p0', 1), ents)).toMatch(/Tangent/);
    expect(guard(cons('radius', 2, 'center', -1, 'p0', 3), ents)).toBeNull();
    const list = [cons('horizontal', 0, 'p0', 0, 'p1')];
    expect(duplicateOf(cons('horizontal', 0, 'p1', 0, 'p0'), list)).toBe(0);
    expect(duplicateOf(cons('vertical', 0, 'p0', 0, 'p1'), list)).toBe(-1);
  });
  it('angles are degrees on the wire and in the UI (kernel v1.2)', () => {
    // kernel v1.2: angles are degrees on the wire
    expect(toWire('angle', 90)).toBe(90);
    expect(fromWire('angle', 60)).toBe(60);
    expect(toWire('distance', 5)).toBe(5);
    expect(describeConstraint(cons('angle', 0, 'p0', 1, 'p0', 45), ents)).toBe('Angle 45° on line 1 and line 2');
  });
  it('knows which constraints hold the end a trim moves', () => {
    expect(refsPoint(cons('coincident', 0, 'p1', 1, 'p0'), 0, 'p1')).toBe(true);
    expect(refsPoint(cons('horizontal', 0, 'p0', 0, 'p1'), 0, 'p1')).toBe(false);
  });
});

describe('inline values', () => {
  it('reads numbers, commas and expressions over variables', () => {
    expect(evalValue('12,5')).toEqual({ value: 12.5 });
    expect(evalValue('w / 2 + 1', { w: 40 })).toEqual({ value: 21 });
    expect(evalValue('2^3*sqrt(4)')).toEqual({ value: 16 });
    expect(evalValue('10 mm')).toEqual({ value: 10 });
    expect(evalValue('q + 1')).toEqual({ error: 'Unknown variable q' });
    expect(evalValue('12x')).toEqual({ error: 'Not a number' });
    expect(evalValue('')).toEqual({ error: 'Enter a number' });
  });
});

describe('live measurement labels (Orca’s render_live_quotes)', () => {
  const ents = [line([0, 0], [30, 40]), entity('circle', { center: [0, 0], radius: 5 }), arc([0, 0], 10, 0, Math.PI / 2), entity('ellipse_arc', { center: [0, 0], radius: 8, rminor: 3, rotation: 0, start_angle: 0, end_angle: Math.PI })];
  it('formats like Orca’s dim_text', () => {
    expect(quoteText('length', 50)).toBe('50 mm');
    expect(quoteText('length', 12.345)).toBe('12.35 mm');
    expect(quoteText('radius', 5.1)).toBe('R5.1 mm');
    expect(quoteText('angle', 53.130102)).toBe('53.13°');
    expect(quoteText('sweep', -0.001)).toBe('0°');
  });
  it('a line shows its Length and Angle; a circle its Radius; an arc Radius and sweep; an ellipse arc its axes and sweep', () => {
    const k = (i: number) => liveQuotes(ents, [], i, 2).map((q) => `${q.kind}:${q.text}`);
    expect(k(0)).toEqual(['length:50 mm', 'angle:53.13°']);
    expect(k(1)).toEqual(['radius:R5 mm']);
    expect(k(2)).toEqual(['radius:R10 mm', 'sweep:90°']);
    expect(k(3)).toEqual(['major:8 mm', 'minor:3 mm', 'sweep:180°']);
    expect(liveQuotes([line([0, 0], [-10, 0])], [], 0, 2)[1].text).toBe('180°');
  });
  it('skips what a dimension already drives', () => {
    const q = liveQuotes(ents, [cons('distance', 0, 'p0', 0, 'p1', 50), cons('radius', 2, 'center', -1, 'p0', 10)], 0, 2);
    expect(q.map((x) => x.kind)).toEqual(['angle']);
    expect(liveQuotes(ents, [cons('radius', 2, 'center', -1, 'p0', 10)], 2, 2).map((x) => x.kind)).toEqual(['sweep']);
  });
  it('is for a lone selected (or dragged) entity, and not under the edit / transform tools', () => {
    expect(quotedEntity([{ e: 2 }], 'select')).toBe(2);
    expect(quotedEntity([{ e: 2, role: 'p0' } as { e: number }, { e: 2 }], 'select')).toBe(2);
    expect(quotedEntity([{ e: 1 }, { e: 2 }], 'select')).toBe(-1);
    expect(quotedEntity([{ e: 2 }], 'fillet')).toBe(-1);
    expect(quotedEntity([{ e: 2 }], 'move')).toBe(-1);
  });
  it('typed values edit the geometry as Orca does (and refuse what Orca refuses)', () => {
    const l = quoteEdit(ents[0], 'angle', 90) as typeof ents[0];
    expect(l.p1[0]).toBeCloseTo(0); expect(l.p1[1]).toBeCloseTo(50);
    const a = quoteEdit(ents[2], 'sweep', 45) as typeof ents[0];
    expect(a.end_angle).toBeCloseTo(Math.PI / 4); expect(a.p1[0]).toBeCloseTo(10 * Math.SQRT1_2);
    expect(quoteEdit(ents[2], 'sweep', 360)).toBe('The angle must be between 0° and 360°');
    expect(quoteEdit(ents[3], 'minor', 9)).toBe('The semi-major axis cannot be shorter than the semi-minor axis');
    expect((quoteEdit(ents[3], 'major', 10) as typeof ents[0]).p1[0]).toBeCloseTo(-10);
  });
});

// ---- the session on the fake kernel ---------------------------------------------------------------

let fake: FakeKernel;
async function settle(): Promise<void> { for (let i = 0; i < 4; i++) { await nextTick(); await designReady(); } }
async function idle(): Promise<void> { await designKernel().run('wait', async () => {}, { quiet: true }); await nextTick(); }

beforeEach(async () => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  fake = new FakeKernel();
  setDesignBackend(() => fake);
  if (sk.open) await K.cancelSketch();
  S.resetProject();
  setOrcaCadRecipe(null);
  await settle();
});

describe('sketch session', () => {
  it('is one app undo step; edits are blocked meanwhile; Ctrl+Z inside is sketch undo', async () => {
    expect(await K.beginSketch({ plane: 'XY' })).toBe(true);
    expect(sk.open).toBe(true);
    expect(editBlocker()).toMatch(/Finish or cancel the sketch/);
    expect(undoOverride.value).not.toBeNull();
    setActionScope('design');
    expect(getActionScope()).toBe('sketch');
    await K.addEntities([line([0, 0], [10, 0]), line([10, 0], [10, 5])], [cons('coincident', 0, 'p1', 1, 'p0'), cons('horizontal', 0, 'p0', 0, 'p1')]);
    expect(sk.entities).toHaveLength(2);
    expect(sk.constraints).toHaveLength(2);
    expect(sk.undo).toEqual([2]); // add + constrain = one entry
    await K.addConstraints([cons('distance', 0, 'p0', 0, 'p1', 10)]);
    expect(sk.constraints).toHaveLength(3);
    doUndo(); await idle();
    expect(sk.constraints).toHaveLength(2);
    expect(sk.redo).toEqual([1]);
    await K.sketchRedo();
    expect(sk.constraints).toHaveLength(3);
    const steps = S.historyState.value.undo;
    const r = await K.finishSketch();
    expect(r).toMatchObject({ ok: true, index: 0 });
    expect(sk.open).toBe(false);
    expect(undoOverride.value).toBeNull();
    expect(getActionScope()).toBe('design');
    expect(design.features.map((f) => f.type)).toEqual(['Sketch']);
    expect(sk.finished).toMatchObject({ index: 0 });
    expect(S.historyState.value.undo).not.toBe(steps);
    S.undo(); await settle();
    expect(design.features).toHaveLength(0);
  });

  it('a gesture (drag) is one sketch undo entry however many solver steps it took', async () => {
    await K.beginSketch({ plane: 'XY' });
    await K.addEntities([line([0, 0], [10, 0])], []);
    K.beginGesture('Drag');
    for (let i = 1; i <= 5; i++) K.drag({ kind: 'point', entity: 0, role: 'p1', to: [10 + i, i] });
    await K.endGesture();
    expect(sk.entities[0].p1).toEqual([15, 5]); // coalesced: the last target wins
    expect(sk.undo).toHaveLength(2);
    await K.sketchUndo();
    expect(sk.entities[0].p1).toEqual([10, 0]);
  });

  it('a refused constraint names what it conflicts with; Replace / Keep both', async () => {
    await K.beginSketch({ plane: 'XY' });
    await K.addEntities([line([0, 0], [10, 0])], [cons('distance', 0, 'p0', 0, 'p1', 10)]);
    const err = await K.addConstraints([cons('distance', 0, 'p0', 0, 'p1', 12)]);
    expect(err).toMatch(/Distance 12 mm on line 1 conflicts with Distance 10 mm on line 1 \(#1\)/);
    expect(sk.conflict?.offenders).toEqual([0]);
    expect(sk.constraints).toHaveLength(1);
    await K.resolveConflict('replace');
    expect(sk.constraints.map((c) => c.value)).toEqual([12]);
    expect(sk.solveOk).toBe(true);
    await K.addConstraints([cons('distance', 0, 'p0', 0, 'p1', 9)]);
    await K.resolveConflict('keep');
    expect(sk.solveOk).toBe(false);
    expect(sk.bad).toEqual([1]);
    expect(await K.addConstraints([cons('radius', 0, 'center', -1, 'p0', 3)])).toMatch(/arc or a circle/);
    expect(fake.calls.filter((m) => m === 'sketch_constrain').length).toBeGreaterThan(0);
  });

  it('edits an existing sketch in place (one undo step) and recovers the session after a kernel reset', async () => {
    await K.beginSketch({ plane: 'XY' });
    await K.addEntities([line([0, 0], [10, 0])], []);
    await K.finishSketch();
    expect(await K.beginSketch({ feature: 0 })).toBe(true);
    expect(sk.entities).toHaveLength(1);
    expect(sk.feature).toBe(0);
    await K.addEntities([line([10, 0], [10, 10])], [cons('coincident', 0, 'p1', 1, 'p0')]);
    // The kernel instance dies: the document reopens from the saved bytes, the session is rebuilt from the page's copy.
    (designKernel() as unknown as { reset(r: string): void }).reset('crash'); // as a trap / memory recycle does
    await settle();
    expect(fake.sketches.sessions.size).toBe(0);
    await K.addConstraints([cons('vertical', 1, 'p0', 1, 'p1')]);
    expect(sk.entities).toHaveLength(2);
    expect(sk.constraints.map((c) => c.type)).toEqual(['coincident', 'vertical']);
    const r = await K.finishSketch();
    expect(r).toMatchObject({ ok: true, index: 0 });
    expect(design.features).toHaveLength(1);
    const doc = [...fake.docs.keys()][0];
    const f = (await designKernel().run('read', async (c) => (await c.call<{ feature: { entities: unknown[] } }>('get_feature', { doc, index: 0 })).result, { quiet: true }));
    expect(f.feature.entities).toHaveLength(2);
  });

  it('an arc slot lands as one undo entry with its shape constraints', async () => {
    await K.beginSketch({ plane: 'XY' });
    const b = DRAW_TOOL_BY_ID.get('arc-slot')!.build([[0, 0], [20, 0], [0, 5], [23, 0]], opts())!;
    const r = await K.addEntities(b.entities, b.constraints, 'Arc slot');
    expect(r).toMatchObject({ first: 0, dropped: [] });
    expect(sk.entities.map((e) => e.type)).toEqual(['arc', 'arc', 'arc', 'arc']);
    expect(sk.constraints).toHaveLength(9);
    expect(sk.loops?.closed_loops).toHaveLength(1);
    expect(sk.undo).toEqual([2]);
    await K.addConstraints([{ ...b.dims[0].constraint, value: 25 }, { ...b.dims[1].constraint, value: 8 }]);
    expect(sk.constraints.slice(-2).map((c) => [c.type, c.value])).toEqual([['distance', 25], ['diameter', 8]]);
  });

  it('a plain click on a constraint badge deletes it (Select tool); Shift+click or another tool selects it', async () => {
    await K.beginSketch({ plane: 'XY' });
    await K.addEntities([line([0, 0], [10, 0]), line([10, 0], [10, 5])], [cons('coincident', 0, 'p1', 1, 'p0'), cons('horizontal', 0, 'p0', 0, 'p1'), cons('vertical', 1, 'p0', 1, 'p1')]);
    await K.badgeClick(1, true);
    expect(sk.selCons).toEqual([1]);
    expect(sk.constraints).toHaveLength(3);
    sk.tool = 'line';
    await K.badgeClick(2, false);
    expect(sk.selCons).toEqual([2]);
    expect(sk.constraints).toHaveLength(3);
    sk.tool = 'select';
    await K.badgeClick(1, false);
    expect(sk.constraints.map((c) => c.type)).toEqual(['coincident', 'vertical']);
    expect(design.status?.text ?? '').toMatch(/Deleted Horizontal/);
    expect(sk.undo).toEqual([2, 1]); // one sketch undo entry
    await K.sketchUndo();
    expect(sk.constraints).toHaveLength(3);
  });

  it('text / SVG outlines: the centre handle moves them, a corner scales them about the opposite corner; Finish writes both', async () => {
    await K.beginSketch({ plane: 'XY' });
    const sq: V2[] = [[-5, -2], [5, -2], [5, 2], [-5, 2]];
    expect(K.placeRegions([[sq]], 'SVG')).toBeNull();
    expect(K.regionCorners()).toEqual([[-5, -2], [5, -2], [5, 2], [-5, 2]]);
    K.dragRegionHandle(4, [0, 0], [10, 20]); // the centre: moved by the pointer's travel
    expect(sk.regions).toMatchObject({ offset: [10, 20], scale: [1, 1] });
    const c = K.regionCorners()!;
    K.dragRegionHandle(2, c[0], [25, 26]); // the max / max corner to (25, 26); min / min (5, 18) stays
    expect(sk.regions!.scale[0]).toBeCloseTo(2);
    expect(sk.regions!.scale[1]).toBeCloseTo(2);
    const after = K.regionCorners()!;
    expect(close(after[0], [5, 18], 1e-9) && close(after[2], [25, 26], 1e-9)).toBe(true);
    expect(close(K.regionPoint([5, 2]), [25, 26], 1e-9)).toBe(true);
    const r = await K.finishSketch();
    expect(r.ok).toBe(true);
    const doc = [...fake.docs.keys()][0];
    const f = (await designKernel().run('read', async (k) => (await k.call<{ feature: Record<string, unknown> }>('get_feature', { doc, index: r.index })).result, { quiet: true })).feature;
    expect(f).toMatchObject({ import_scale_x: 2, import_scale_y: 2 });
    expect(f.import_offset).toEqual([15, 22]);
  });

  it('a click on a live quote: Length / Radius become driving dimensions with their editor; a line angle rotates it (its H dropped)', async () => {
    await K.beginSketch({ plane: 'XY' });
    await K.addEntities([line([0, 0], [20, 0]), entity('circle', { center: [40, 0], radius: 4 })], [cons('horizontal', 0, 'p0', 0, 'p1')]);
    const [len, ang] = liveQuotes(sk.entities, sk.constraints, 0, 2);
    await K.promoteQuote(len);
    expect(sk.constraints.at(-1)).toMatchObject({ type: 'distance', ea: 0, ra: 'p0', eb: 0, rb: 'p1', value: 20 });
    expect(sk.value).toMatchObject({ label: 'Length', value: 20, unit: 'mm' });
    expect(await sk.value!.submit(25)).toBeNull();
    expect(sk.constraints.at(-1)!.value).toBe(25);
    sk.value = null;
    expect(liveQuotes(sk.entities, sk.constraints, 0, 2).map((q) => q.kind)).toEqual(['angle']);
    await K.promoteQuote(liveQuotes(sk.entities, sk.constraints, 1, 2)[0]);
    expect(sk.constraints.at(-1)).toMatchObject({ type: 'radius', ea: 1, value: 4 });
    expect(sk.value).toMatchObject({ label: 'Radius' });
    sk.value = null;
    const undo0 = sk.undo.length, L = Math.hypot(sk.entities[0].p1[0] - sk.entities[0].p0[0], sk.entities[0].p1[1] - sk.entities[0].p0[1]);
    await K.promoteQuote(ang);
    expect(sk.value).toMatchObject({ label: 'Angle (°)', unit: '°' });
    expect(await sk.value!.submit(90)).toBeNull();
    expect(sk.constraints.some((c) => c.type === 'horizontal')).toBe(false);
    expect(sk.entities[0].p1[0]).toBeCloseTo(sk.entities[0].p0[0]); expect(sk.entities[0].p1[1]).toBeCloseTo(sk.entities[0].p0[1] + L);
    expect(sk.undo.length).toBe(undo0 + 1); // one sketch undo entry: H dropped + the line turned
  });

  it('cancel leaves the design unchanged; trim drops the constraints on the moved end first', async () => {
    await K.beginSketch({ plane: 'XY' });
    await K.addEntities([line([0, 0], [10, 0]), line([10, 0], [10, 5])], [cons('coincident', 0, 'p1', 1, 'p0')]);
    expect(await K.trimExtend('trim', 0, [8, 0])).toBe(true);
    expect(sk.constraints).toHaveLength(0);
    expect(sk.entities[0].p1).toEqual([8, 0]);
    await K.cancelSketch();
    expect(sk.open).toBe(false);
    expect(design.features).toHaveLength(0);
  });
});

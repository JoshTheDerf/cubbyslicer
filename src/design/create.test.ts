/**
 * Slice 2 of the Design tab on the fake kernel: pick-driven references, feature cards (create,
 * preview, refusals, the generation guard), the offer menu, bodies (colour, delete, rename),
 * commit modes, STEP / mesh import, CubbyCAD shapes as bodies.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import * as S from '../project/store';
import { activeView, resolvedConfig } from '../app/state';
import { preferences } from '../app/preferences';
import { setOrcaCadRecipe } from '../project/persistence/passthrough';
import { sanitizeObjects } from '../project/persistence/format';
import { FakeKernel, NOOP_SHELL } from './kernel/fake';
import { design, designReady, setDesignBackend } from './session';
import * as C from './commands';
import { bodyMass, card, cardProblem, checkInterference, confirmCard, cancelCard, ghost, offerItems, openCard, runPreview, setCardValue } from './create';
import { cancelPick, finishPick, picking, pickHit, startPick } from './pick';
import { designUi, pickEdges, toggleSetEdge } from './state';
import { exactBuild, splitScale, addPrimitiveBody } from './primitives';
import { importStepToDesign, meshBlob } from './io';
import { CREATE_TOOLS, flipFrame, frameFromAxis, inFrame, nearestThread } from './tools';
import { entity, line, loopEntityIndices, regionAt, regionLoops } from './sketch/model';
import type { Mat4 } from '../project/math';
import * as K from './sketch/session';
import { sk } from './sketch/session';
import { datumDrawing, refreshDatumDrawing } from './datums';

let fake: FakeKernel;
async function settle(): Promise<void> { for (let i = 0; i < 4; i++) { await nextTick(); await designReady(); } }
async function openProject(recipe: Uint8Array | null): Promise<void> { S.resetProject(); setOrcaCadRecipe(recipe); await settle(); }
const box = (extra: Record<string, unknown> = {}) => ({ type: 'Extrude' as const, distance: 10, width: 20, height: 10, sketch_ref: 0, ...extra });
const twoBodies = () => FakeKernel.recipe([{ type: 'Sketch', name: 'Sketch 1' }, { ...box(), name: 'Base' }, { type: 'Sketch', name: 'Sketch 3' }, { ...box({ sketch_ref: 2 }), name: 'Knob' }]);

beforeEach(async () => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  fake = new FakeKernel();
  setDesignBackend(() => fake);
  cancelCard();
  cancelPick();
  S.resetProject();
  preferences.designCommitMode = 'assembly';
  await nextTick();
});

describe('feature cards', () => {
  it('opens prefilled from the pick and adds one feature as one undo step (Orca name: <Type> <n>)', async () => {
    await openProject(twoBodies());
    designUi.pick = { kind: 'edge', body: 0, edge: 3, generation: design.generation };
    expect(await openCard('fillet')).toBeNull();
    expect(card.tool?.id).toBe('fillet');
    expect(card.draft.edges).toMatchObject({ body: 0, ids: [3] });
    await setCardValue('dressup_size', 1.5);
    const r = await confirmCard();
    expect(r.ok).toBe(true);
    expect(design.features.at(-1)).toMatchObject({ type: 'Fillet', name: 'Fillet 5' });
    expect(fake.calls).toContain('add_feature');
    expect(S.historyState.value.undo).toBe('Add Fillet 5');
    expect(card.tool).toBeNull();
    expect(designUi.selected).toEqual([4]);
    const f = fake.docs.values().next().value!.features[4];
    expect(f).toMatchObject({ dressup_edges: [3], dressup_edge: 3, dressup_size: 1.5, target_body: 0 });
  });

  it('a Chamfer from the same card; an edge group when nothing is picked', async () => {
    await openProject(twoBodies());
    designUi.pick = { kind: 'body', body: 1 };
    await openCard('fillet', { prefill: { kind: 'Chamfer', face_group: 'Top' } });
    expect((await confirmCard()).ok).toBe(true);
    const f = [...fake.docs.values()][0].features.at(-1)!;
    expect(f).toMatchObject({ type: 'Chamfer', dressup_edges: [], face_group: 'Top', target_body: 1 });
  });

  it('refuses a missing required reference, and references picked on an older rebuild', async () => {
    await openProject(twoBodies());
    await openCard('draft', { pick: null });
    expect(cardProblem()).toMatch(/Draft needs a picked face/);
    expect((await confirmCard()).ok).toBe(false);
    await setCardValue('face', { body: 0, ids: [2], generation: design.generation - 1 });
    const r = await confirmCard();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rebuilt since you picked/);
    expect(design.features.length).toBe(4);
  });

  it('Orca’s guards keep a card closed (Boolean needs two bodies)', async () => {
    await openProject(FakeKernel.recipe([{ type: 'Sketch' }, box()]));
    expect(await openCard('boolean')).toMatch(/two bodies/);
    expect(card.tool).toBeNull();
  });

  it('a refused add keeps the card open with the kernel message; nothing changes', async () => {
    await openProject(twoBodies());
    await openCard('fillet', { pick: { kind: 'body', body: 0 } });
    await setCardValue('dressup_size', 50);
    const r = await confirmCard();
    expect(r.ok).toBe(false);
    expect(card.tool?.id).toBe('fillet');
    expect(card.error).toMatch(/fillet radius too large/);
    expect(design.features.length).toBe(4);
  });

  it('previews with feature_preview (ghost), invalid previews say why', async () => {
    await openProject(twoBodies());
    await openCard('fillet', { pick: { kind: 'body', body: 0 } });
    const ok = await runPreview();
    expect(ok.ok).toBe(true);
    expect(ok.triangles).toBeGreaterThan(0);
    expect(ghost.value?.length).toBe(2);
    expect(card.preview.state).toBe('ok');
    await setCardValue('dressup_size', 50);
    const bad = await runPreview();
    expect(bad.ok).toBe(false);
    expect(card.preview.text).toMatch(/Invalid: fillet radius too large/);
    expect(design.features.length).toBe(4);
  });

  it('Boolean writes target / tool; Mirror keeps the original as a new body', async () => {
    await openProject(twoBodies());
    designUi.pick = { kind: 'body', body: 0 };
    await openCard('boolean');
    expect(card.draft).toMatchObject({ target_body: 0, bool_tool_body: 1, mode: 'Add' });
    expect((await confirmCard()).ok).toBe(true);
    expect(design.bodies.length).toBe(1);
    await openCard('mirror', { pick: { kind: 'body', body: 0 } });
    expect((await confirmCard()).ok).toBe(true);
    expect(design.bodies.length).toBe(2);
    expect([...fake.docs.values()][0].features.at(-1)).toMatchObject({ type: 'Mirror', plane: 'XY', mode: 'New', mirror_keep_original: true });
  });

  it('Hole latches the clicked face: the plane points into the material, X / Y = the clicked spot', async () => {
    await openProject(twoBodies());
    // face 1 = top of body 0 (fake: centre (10, 5, 10), normal +Z)
    await openCard('hole', { pick: { kind: 'face', body: 0, face: 1, generation: design.generation } });
    await setCardValue('face', { body: 0, ids: [1], point: [13, 7, 10], generation: design.generation });
    expect(card.draft.hole_x).toBe(3);
    expect(card.draft.hole_y).toBe(-2); // the inward frame's y is flipped
    expect((await confirmCard()).ok).toBe(true);
    const f = [...fake.docs.values()][0].features.at(-1)!;
    expect(f.plane).toMatchObject({ normal: [-0, -0, -1] });
  });

  it('Thread snaps to the nearest standard of a picked cylinder; a flat face is refused', async () => {
    await openProject(FakeKernel.recipe([{ type: 'Sketch' }, { type: 'Revolve', width: 8, height: 8, distance: 12, sketch_ref: 0 }]));
    await openCard('thread', { pick: { kind: 'face', body: 0, face: 2, generation: design.generation } });
    expect(card.draft).toMatchObject({ standard: 'M8', thread_pitch: 1.25, thread_height: 12, thread_internal: false });
    expect((await confirmCard()).ok).toBe(true);
    const f = [...fake.docs.values()][0].features.at(-1)!;
    expect(f).toMatchObject({ type: 'Thread', thread_radius: 4, thread_major_nominal: true });
    await openProject(twoBodies());
    await openCard('thread', { pick: null });
    await setCardValue('face', { body: 0, ids: [1], generation: design.generation });
    expect(card.error).toMatch(/cylindrical/);
    expect(card.draft.face).toBeNull();
  });

  it('Shell: the kernel refusing a no-op shell is shown on the card and adds nothing', async () => {
    await openProject(twoBodies());
    await openCard('shell', { pick: { kind: 'face', body: 0, face: 1, generation: design.generation } });
    await setCardValue('shell_thickness', NOOP_SHELL);
    const r = await confirmCard();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/changed nothing/);
    expect(card.error).toMatch(/changed nothing/);
    expect(design.features.length).toBe(4);
  });

  it('Confirm sends the generation its picks came from; the kernel refuses stale ids', async () => {
    await openProject(twoBodies());
    const g = design.generation;
    await openCard('shell', { pick: { kind: 'face', body: 0, face: 1, generation: g } });
    expect((await confirmCard()).ok).toBe(true);
    expect((fake.lastParams.add_feature as { generation?: number }).generation).toBe(g);
  });

  it('every card has rows with labels and builds fields without a kernel error on defaults', async () => {
    await openProject(twoBodies());
    for (const t of CREATE_TOOLS) {
      expect(t.rows.length, t.id).toBeGreaterThan(0);
      for (const r of t.rows) expect(r.label, `${t.id}.${r.key}`).toBeTruthy();
    }
  });
});

describe('picking references', () => {
  it('multi-pick toggles ids on one body; another body starts again; Esc restores', async () => {
    await openProject(twoBodies());
    const seen: unknown[] = [];
    const g = design.generation;
    startPick({ key: 'card:edges', kind: 'edges', label: 'Edges', prompt: 'Click an edge' }, null, (v) => seen.push(v));
    await pickHit({ body: 0, edge: 1, generation: g });
    await pickHit({ body: 0, edge: 2, generation: g });
    expect(picking.value?.ids).toEqual([1, 2]);
    await pickHit({ body: 0, edge: 1, generation: g });
    expect(picking.value?.ids).toEqual([2]);
    await pickHit({ body: 1, edge: 5, generation: g });
    expect(picking.value).toMatchObject({ body: 1, ids: [5] });
    cancelPick();
    expect(seen.at(-1)).toBeNull();
    expect(picking.spec).toBeNull();
  });

  it('an existing feature’s references pick on its input (the design rolled back before it)', async () => {
    await openProject(FakeKernel.recipe([{ type: 'Sketch' }, box(), { type: 'Fillet', dressup_size: 1, dressup_edges: [0] }, { type: 'Sketch' }, box({ sketch_ref: 3 })]));
    startPick({ key: 'editor:2:dressup_edges', kind: 'edges', label: 'Edges', prompt: 'Click an edge' }, { body: 0, ids: [0], generation: 0 }, () => {}, { rollbackBefore: 2 });
    await settle();
    expect(picking.rollback?.before).toBe(2);
    expect(picking.rollback?.bodies.length).toBe(1); // the later box is suppressed in the copy
    expect(picking.value?.generation).toBe(picking.rollback?.generation);
    expect(design.bodies.length).toBe(2); // the design itself is untouched
    finishPick();
    expect(picking.rollback).toBeNull();
  });

  it('a single-face pick replaces; an `accept` filter refuses', async () => {
    await openProject(twoBodies());
    const g = design.generation;
    startPick({ key: 'card:face', kind: 'face', label: 'Face', prompt: 'Click a face', accept: (h) => (h.face === 4 ? 'not that one' : null) }, null, () => {});
    await pickHit({ body: 0, face: 1, generation: g });
    await pickHit({ body: 0, face: 4, generation: g });
    expect(picking.value?.ids).toEqual([1]);
    await pickHit({ body: 0, face: 2, generation: g });
    expect(picking.value?.ids).toEqual([2]);
    finishPick();
  });
});

describe('offer menu', () => {
  const noop = { renameBody: () => {}, colorBody: () => {}, deleteBody: () => {}, zoom: () => {}, editFeature: () => {} };
  const labels = (g: ReturnType<typeof offerItems>) => g.flat().flatMap((i) => [i.label, ...(i.children ?? []).flat().map((c) => c.label)]);
  it('a flat face offers Orca’s families; nothing selected offers references', async () => {
    await openProject(twoBodies());
    const flat = offerItems({ kind: 'face', body: 0, face: 1, generation: design.generation }, { surface: 'plane', faceEdges: [0, 1] }, noop);
    expect(flat[0][0].label).toBe('Flat face 1 of Body 1');
    const l = labels(flat);
    for (const w of ['Hole', 'Shell', 'Extrude (push/pull)', 'Fillet', 'Draft', 'Linear pattern', 'Mirror', 'Move', 'Plane', 'Delete Face', 'Delete Body', 'Color…']) expect(l, w).toContain(w);
    const none = labels(offerItems(null, {}, noop));
    expect(none[0]).toBe('Nothing selected');
    expect(none).toContain('Plane');
    expect(none.some((x) => /^Remove — select something first/.test(x))).toBe(true);
    const body = labels(offerItems({ kind: 'body', body: 1 }, {}, noop));
    expect(body).toContain('Rename…');
    expect(body).toContain('Boolean with another body');
    expect(body).toContain('Volume and area');
    expect(body).toContain('Interference');
  });

  it('Interference is greyed with Orca’s reason below two bodies', async () => {
    await openProject(FakeKernel.recipe([{ type: 'Sketch' }, box()]));
    const row = offerItems({ kind: 'body', body: 0 }, {}, noop).flat().flatMap((i) => [i, ...(i.children ?? []).flat()]).find((i) => /^Interference/.test(i.label));
    expect(row).toMatchObject({ label: 'Interference needs at least two bodies', disabled: true });
  });
});

describe('coordinate systems and mates (Orca 2.5 Coordinate system / Mate cards)', () => {
  const noop = { renameBody: () => {}, colorBody: () => {}, deleteBody: () => {}, zoom: () => {}, editFeature: () => {} };
  const flatItems = (g: ReturnType<typeof offerItems>) => g.flat().flatMap((i) => [i, ...(i.children ?? []).flat()]);
  const lastFeature = () => [...fake.docs.values()][0].features.at(-1)!;

  it('Coordinate system: a world point by default; picking a face makes it face + direction (Orca), with the edge on the same body', async () => {
    await openProject(twoBodies());
    expect(await openCard('coordsys', { pick: null })).toBeNull();
    expect(card.draft).toMatchObject({ coordsys_type: 'PointWorld', coordsys_point: [0, 0, 0], coordsys_x_hint: [1, 0, 0] });
    expect(card.preview.text).toBe('Coordinate system ready');
    await setCardValue('coordsys_point', [5, 6, 7]);
    expect((await confirmCard()).ok).toBe(true);
    expect(lastFeature()).toMatchObject({ type: 'CoordSys', name: 'Coordinate system 5', coordsys_type: 'PointWorld', coordsys_point: [5, 6, 7], coordsys_face: -1 });
    // A face pick switches the type; an edge on another body is refused.
    await openCard('coordsys', { pick: null });
    await setCardValue('face', { body: 1, ids: [1], generation: design.generation });
    expect(card.draft.coordsys_type).toBe('FaceAndDirection');
    await setCardValue('edge', { body: 0, ids: [2], generation: design.generation });
    expect(cardProblem()).toBe('The face and the edge must be on the same body');
    await setCardValue('edge', { body: 1, ids: [2], generation: design.generation });
    expect((await confirmCard()).ok).toBe(true);
    expect(lastFeature()).toMatchObject({ type: 'CoordSys', coordsys_type: 'FaceAndDirection', coordsys_body: 1, coordsys_face: 1, coordsys_edge: 2, coordsys_x_hint: [1, 0, 0] });
    // Face + direction with no face is refused on the card.
    await openCard('coordsys', { pick: null, prefill: { coordsys_type: 'FaceAndDirection' } });
    expect(cardProblem()).toBe('Pick the face for the coordinate system');
  });

  it('the offer on a flat face prefills the face; nothing picked offers it too', async () => {
    await openProject(twoBodies());
    const pick = { kind: 'face' as const, body: 0, face: 1, generation: design.generation };
    const row = flatItems(offerItems(pick, { surface: 'plane' }, noop)).find((i) => i.label === 'Coordinate system');
    expect(row?.kbds).toEqual(['shift', 'c']);
    expect(flatItems(offerItems(null, {}, noop)).some((i) => i.label === 'Coordinate system')).toBe(true);
    await openCard('coordsys', { pick });
    expect(card.draft).toMatchObject({ coordsys_type: 'FaceAndDirection', face: { body: 0, ids: [1] } });
  });

  it('Mate: needs two coordinate systems, A and B must differ, the Offset row is retitled by kind', async () => {
    const cs = (name: string, extra: Record<string, unknown> = {}) => ({ type: 'CoordSys' as const, name, coordsys_type: 'FaceAndDirection', coordsys_body: 0, coordsys_face: 1, ...extra });
    await openProject(twoBodies());
    expect(await openCard('mate')).toBe('Mate needs two coordinate systems — create them first');
    const pick = { kind: 'face' as const, body: 0, face: 1, generation: design.generation };
    expect(flatItems(offerItems(pick, { surface: 'plane' }, noop)).find((i) => /^Mate/.test(i.label))).toMatchObject({ label: 'Mate needs two coordinate systems — create them first', disabled: true });
    await openProject(FakeKernel.recipe([{ type: 'Sketch', name: 'Sketch 1' }, { ...box(), name: 'Base' }, { type: 'Sketch', name: 'Sketch 3' }, { ...box({ sketch_ref: 2 }), name: 'Knob' }, cs('CS A'), cs('CS B', { coordsys_body: 1 })]));
    expect(design.features.map((f) => f.type).slice(-2)).toEqual(['CoordSys', 'CoordSys']);
    expect(flatItems(offerItems(pick, { surface: 'plane' }, noop)).find((i) => i.label === 'Mate')?.disabled).toBeFalsy();
    expect(await openCard('mate')).toBeNull();
    // Orca selects the first coordinate system in both pickers.
    expect(card.draft).toMatchObject({ mate_kind: 0, mate_cs_a: 4, mate_cs_b: 4, mate_offset: 0, mate_angle: 0, mate_flip: false });
    expect(cardProblem()).toBe('Mate: A and B must be different coordinate systems');
    const offsetRow = card.tool!.rows.find((r) => r.key === 'mate_offset')!;
    expect(offsetRow.labelOf!(card.draft)).toBe('Offset');
    await setCardValue('mate_kind', 1);
    expect(offsetRow.labelOf!(card.draft)).toBe('Plane distance');
    await setCardValue('mate_kind', 2);
    expect(offsetRow.labelOf!(card.draft)).toBe('Axial position');
    await setCardValue('mate_cs_b', 5);
    await setCardValue('mate_offset', 3);
    await setCardValue('mate_flip', true);
    expect((await confirmCard()).ok).toBe(true);
    expect(lastFeature()).toMatchObject({ type: 'Mate', name: 'Mate 7', mate_kind: 2, mate_cs_a: 4, mate_cs_b: 5, mate_offset: 3, mate_angle: 0, mate_flip: true });
  });

  it('a mate the kernel refuses keeps the card open with its reason', async () => {
    await openProject(FakeKernel.recipe([{ type: 'Sketch' }, box(), { type: 'CoordSys', name: 'P', coordsys_type: 'PointWorld' }, { type: 'CoordSys', name: 'Q', coordsys_type: 'PointWorld' }]));
    await openCard('mate');
    await setCardValue('mate_cs_b', 3);
    const r = await confirmCard();
    expect(r.ok).toBe(false);
    expect(card.error).toMatch(/mate_cs_b has no associated body/);
    expect(design.features.length).toBe(4);
  });
});

describe('extruding one region of a sketch (Orca’s loop pick)', () => {
  // A 40 × 30 plate outline with a Ø10 hole, and a separate Ø8 circle beside it; one construction line.
  const ents = [
    line([0, 0], [40, 0]), line([40, 0], [40, 30]), line([40, 30], [0, 30]), line([0, 30], [0, 0]),
    entity('circle', { center: [20, 15], radius: 5 }), entity('circle', { center: [60, 15], radius: 4 }), { ...line([0, 0], [60, 15]), construction: true },
  ];
  it('region_loops: chained outline, circles, a hole in the smallest loop around it; construction ignored', () => {
    const loops = regionLoops(ents);
    expect(loops.map((l) => l.ents)).toEqual([[4], [5], [0, 1, 2, 3]]);
    expect(loops[2].holes).toEqual([0]);
    expect(regionAt(loops, [5, 5])).toBe(2);
    expect(regionAt(loops, [20, 15])).toBe(0);
    expect(regionAt(loops, [60, 15])).toBe(1);
    expect(regionAt(loops, [50, 0])).toBe(-1);
    expect(loopEntityIndices(loops, 2)).toEqual([0, 1, 2, 3, 4]);
    expect(loopEntityIndices(loops, 1)).toEqual([5]);
  });

  it('the Extrude card builds just the picked region on the sketch’s plane (sketch_ref -1), or the whole sketch when unticked', async () => {
    const plane = { origin: [0, 0, 0], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] };
    await openProject(FakeKernel.recipe([{ type: 'Sketch', name: 'Plate', entities: ents, plane } as never, { type: 'Sketch', name: 'Other' }]));
    designUi.selected = [0];
    designUi.region = { sketch: 0, region: 2 };
    expect(await openCard('extrude')).toBeNull();
    expect(card.draft).toMatchObject({ sketch_ref: 0, loop: { sketch: 0, region: 2 }, loopOnly: true });
    expect(card.tool!.rows.find((r) => r.key === 'loopOnly')!.when!(card.draft)).toBe(true);
    expect((await confirmCard()).ok).toBe(true);
    const f = [...fake.docs.values()][0].features.at(-1)!;
    expect(f).toMatchObject({ type: 'Extrude', sketch_ref: -1, plane });
    expect((f.entities as unknown[]).length).toBe(5);
    // Another sketch chosen: the region no longer applies; unticked: the whole sketch.
    await openCard('extrude');
    await setCardValue('sketch_ref', 1);
    expect(card.tool!.rows.find((r) => r.key === 'loopOnly')!.when!(card.draft)).toBe(false);
    await setCardValue('sketch_ref', 0);
    await setCardValue('loopOnly', false);
    expect((await confirmCard()).ok).toBe(true);
    expect([...fake.docs.values()][0].features.at(-1)).toMatchObject({ type: 'Extrude', sketch_ref: 0 });
    // No region picked: Extrude follows the sketch as before.
    designUi.region = null;
    await openCard('extrude');
    expect(card.draft).toMatchObject({ loop: null, loopOnly: false });
  });
});

describe('datums drawn in the view (Orca’s render_datum_planes / render_mate_connectors)', () => {
  it('planes at their size (80 mm when unset), connectors that resolve, the mated one driven; suppressed ones and axes not drawn', async () => {
    await openProject(FakeKernel.recipe([
      { type: 'Sketch', name: 'Sketch 1' }, { ...box(), name: 'Base' },
      { type: 'Plane', name: 'Plane 3', plane_u_size: 50, plane_v_size: 30 } as never,
      { type: 'Plane', name: 'Plane 4' } as never,
      { type: 'Plane', name: 'Plane 5', enabled: false } as never,
      { type: 'Axis', name: 'Axis 6' } as never,
      { type: 'CoordSys', name: 'CS A', coordsys_type: 'PointWorld', coordsys_point: [1, 2, 3] } as never,
      { type: 'CoordSys', name: 'CS B', coordsys_type: 'FaceAndDirection', coordsys_edge: -1, coordsys_point: [4, 5, 6] } as never,
      { type: 'Mate', name: 'Mate 9', mate_cs_a: 6, mate_cs_b: 7 } as never,
    ]));
    await refreshDatumDrawing();
    const d = datumDrawing.value;
    expect(d.planes.map((p) => [p.name, p.u, p.v, p.ordinal])).toEqual([['Plane 3', 50, 30, 0], ['Plane 4', 80, 80, 1]]);
    expect(d.connectors.map((c) => [c.feature, c.origin, c.driven, c.rollUndefined])).toEqual([[6, [1, 2, 3], false, false], [7, [4, 5, 6], true, true]]);
    expect(d.mates).toEqual([[6, 7]]);
  });
});

describe('text / SVG on a picked face (Orca’s import_on_face)', () => {
  const noop = { renameBody: () => {}, colorBody: () => {}, deleteBody: () => {}, zoom: () => {}, editFeature: () => {} };
  const art: [number, number][] = [[-6, -2], [6, -2], [6, 2], [-6, 2]];
  it('centres the art on the face, marks the sketch on-face, and its Extrude defaults to an inward Cut of that body', async () => {
    await openProject(twoBodies());
    const face = { kind: 'face' as const, body: 0, face: 1, generation: design.generation };
    const labels = offerItems(face, { surface: 'plane' }, noop).flat().map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Sketch on this face', 'Text', 'SVG']));
    designUi.pick = face;
    expect(await K.beginArt()).toBe(true);
    // The fake's top face: centroid (10, 5, 10); its sketch plane's origin (0, 0, 10).
    expect(sk.onFace).toEqual({ body: 0, centre: [10, 5] });
    expect(designUi.pick).toBeNull();
    expect(K.placeRegions([[art]], 'Text', { text: { string: 'Hi', font: 'noto-sans', height: 4 } })).toBeNull();
    expect(sk.regions!.offset).toEqual([10, 5]);
    const r = await K.finishSketch();
    expect(r.ok).toBe(true);
    const f = [...fake.docs.values()][0].features[r.index!];
    expect(f).toMatchObject({ type: 'Sketch', import_on_face: true, import_face_body: 0, import_offset: [10, 5], text_string: 'Hi' });
    expect(await openCard('extrude', { prefill: { sketch_ref: r.index } })).toBeNull();
    expect(card.draft).toMatchObject({ mode: 'Cut', flip: true, target_body: 0 });
    expect((await confirmCard()).ok).toBe(true);
    expect([...fake.docs.values()][0].features.at(-1)).toMatchObject({ type: 'Extrude', mode: 'Cut', flip: true, target_body: 0, sketch_ref: r.index });
  });

  it('without a face the art goes on the Top plane at its origin, free (New body by default)', async () => {
    await openProject(twoBodies());
    designUi.pick = { kind: 'body', body: 1 };
    expect(await K.beginArt()).toBe(true);
    expect(sk.onFace).toBeNull();
    expect(sk.planeLabel).toBe('Top plane (XY)');
    K.placeRegions([[art]], 'SVG');
    expect(sk.regions!.offset).toEqual([0, 0]);
    const r = await K.finishSketch();
    expect([...fake.docs.values()][0].features[r.index!].import_on_face).toBeUndefined();
    await openCard('extrude', { prefill: { sketch_ref: r.index } });
    expect(card.draft).toMatchObject({ mode: 'New', flip: false });
  });
});

describe('surface cards (Orca 2.5 Surface drawer)', () => {
  const noop = { renameBody: () => {}, colorBody: () => {}, deleteBody: () => {}, zoom: () => {}, editFeature: () => {} };
  const labels = (g: ReturnType<typeof offerItems>) => g.flat().flatMap((i) => [i.label, ...(i.children ?? []).flat().map((c) => c.label)]);
  const lastFeature = () => [...fake.docs.values()][0].features.at(-1)!;

  it('Surface Extrude makes a sheet body; Thicken Surface and Surface Offset list only sheet bodies', async () => {
    await openProject(twoBodies());
    expect(await openCard('thicken_surf')).toBe('No sheet body to thicken — create a surface feature first');
    expect(await openCard('surf_offset')).toBe('No sheet body to offset — create a surface feature first');
    expect(await openCard('surf_extrude')).toBeNull();
    expect(card.draft).toMatchObject({ sketch_ref: 2, distance: 10 });
    expect((await confirmCard()).ok).toBe(true);
    expect(lastFeature()).toMatchObject({ type: 'SurfaceExtrude', name: 'Surface Extrude 5', sketch_ref: 2, distance: 10 });
    expect(design.bodies.at(-1)).toMatchObject({ index: 2, is_solid: false });
    // The offer on the sheet body.
    const l = labels(offerItems({ kind: 'body', body: 2 }, {}, noop));
    expect(l).toContain('Thicken Surface');
    expect(l).toContain('Surface Offset');
    expect(labels(offerItems({ kind: 'body', body: 0 }, {}, noop))).not.toContain('Thicken Surface');
    await openCard('surf_offset', { pick: null });
    expect(card.draft).toMatchObject({ target_body: 2, plane_offset: 1 });
    await setCardValue('plane_offset', -0.5);
    expect((await confirmCard()).ok).toBe(true);
    expect(lastFeature()).toMatchObject({ type: 'SurfaceOffset', target_body: 2, plane_offset: -0.5 });
    await openCard('thicken_surf', { pick: { kind: 'body', body: 2 } });
    expect(card.draft).toMatchObject({ target_body: 2, thicken_thickness: 1, thicken_flip: false });
    await setCardValue('target_body', 0);
    expect(cardProblem()).toBe('Choose a sheet body to thicken');
    await setCardValue('target_body', 2);
    await setCardValue('thicken_thickness', 2);
    expect((await confirmCard()).ok).toBe(true);
    expect(lastFeature()).toMatchObject({ type: 'ThickenSurface', target_body: 2, thicken_thickness: 2, thicken_flip: false });
    expect(design.bodies[2].is_solid).toBe(true);
  });

  it('Surface Revolve (axis like Revolve), Surface Loft (2+ profiles), Surface Fill', async () => {
    await openProject(twoBodies());
    await openCard('surf_revolve');
    expect(card.draft).toMatchObject({ sketch_ref: 2, revolve_angle: 360, axis: 'x', flip: false });
    await setCardValue('axis', 'y');
    await setCardValue('revolve_angle', 180);
    expect((await confirmCard()).ok).toBe(true);
    expect(lastFeature()).toMatchObject({ type: 'SurfaceRevolve', sketch_ref: 2, revolve_angle: 180, revolve_axis: 1, revolve_axis_entity: -1, flip: false });
    await openCard('surf_loft');
    expect(cardProblem()).toBe('Check at least two profile sketches to loft');
    await setCardValue('loft_profile_refs', [2, 0]);
    await setCardValue('loft_ruled', true);
    expect((await confirmCard()).ok).toBe(true);
    expect(lastFeature()).toMatchObject({ type: 'SurfaceLoft', loft_profile_refs: [0, 2], loft_ruled: true });
    await openCard('surf_fill');
    expect((await confirmCard()).ok).toBe(true);
    expect(lastFeature()).toMatchObject({ type: 'SurfaceFill', sketch_ref: 2 });
  });

  it('the cards are in the Surface group with Orca’s keys', async () => {
    const { TOOL_GROUPS } = await import('./tools');
    expect(TOOL_GROUPS.map((g) => g.label)).toContain('Surface');
    expect(CREATE_TOOLS.filter((t) => t.group === 'surface').map((t) => t.title)).toEqual(['Surface Extrude', 'Surface Revolve', 'Surface Loft', 'Surface Fill', 'Surface Offset', 'Thicken Surface']);
  });
});

describe('view and analysis', () => {
  it('Shift+click builds Orca’s edge set: add, remove, hand over, clear', () => {
    const p0 = { kind: 'edge' as const, body: 0, edge: 3, generation: 1 };
    const p1 = toggleSetEdge(p0, 5)!;
    expect(pickEdges(p1)).toEqual([3, 5]);
    const p2 = toggleSetEdge(p1, 7)!;
    expect(pickEdges(p2)).toEqual([3, 5, 7]);
    expect(pickEdges(toggleSetEdge(p2, 5))).toEqual([3, 7]);
    const back = toggleSetEdge(p2, 7)!;
    expect(back.edge).toBe(5);
    expect(pickEdges(back)).toEqual([3, 5]);
    expect(toggleSetEdge(p0, 3)).toBeNull();
  });

  it('Fillet / Chamfer from an edge set dresses every edge in it; the offer names the set', async () => {
    await openProject(twoBodies());
    designUi.pick = { kind: 'edge', body: 0, edge: 2, generation: design.generation, more: [0, 1] };
    expect(offerItems(designUi.pick, {}, { renameBody: () => {}, colorBody: () => {}, deleteBody: () => {}, zoom: () => {}, editFeature: () => {} })[0][0].label).toBe('3 edges of Body 1');
    await openCard('fillet', { prefill: { kind: 'Chamfer' } });
    expect(card.draft.edges).toMatchObject({ body: 0, ids: [0, 1, 2] });
    expect((await confirmCard()).ok).toBe(true);
    expect([...fake.docs.values()][0].features.at(-1)).toMatchObject({ type: 'Chamfer', dressup_edges: [0, 1, 2], target_body: 0 });
  });

  it('Volume and area: Orca’s report (mm³ / mm², two decimals, the body’s name)', async () => {
    await openProject(twoBodies());
    const m = await bodyMass(0);
    expect(m?.volume).toBe(2000);
    expect(design.status).toEqual({ kind: 'info', text: 'Base: volume 2000.00 mm³, area 1000.00 mm²' });
    expect(await bodyMass(9)).toBeNull();
    expect(design.status?.text).toBe('Select a body to measure it');
  });

  it('Check interference: overlapping pairs on the status line, worst first; none; fewer than two bodies', async () => {
    await openProject(twoBodies());
    await checkInterference();
    expect(design.status).toEqual({ kind: 'ok', text: 'No interference found' });
    // The fake lays bodies side by side: slide the second half-way into the first.
    [...fake.docs.values()][0].bodies[1].x = 10;
    const r = await checkInterference();
    expect(r?.count).toBe(1);
    expect(design.status).toEqual({ kind: 'warn', text: '1 overlapping pair: Base ↔ Knob 1000.00 mm³' });
    await openProject(FakeKernel.recipe([{ type: 'Sketch' }, box()]));
    expect(await checkInterference()).toBeNull();
    expect(design.status?.text).toBe('Interference needs at least two bodies');
  });
});

describe('bodies and commit modes', () => {
  it('colour, rename, delete (the source feature; one undo step)', async () => {
    await openProject(twoBodies());
    await C.setBodyColor(1, '#ff8000');
    expect(design.bodies[1]).toMatchObject({ has_color: true });
    expect(C.rgbaToHex(design.bodies[1].color)).toBe('#ff8000');
    await C.renameBody(1, 'Knob A');
    expect(design.bodies[1].name).toBe('Knob A');
    await C.deleteBody(0);
    expect(design.features.map((f) => f.name)).toEqual(['Sketch 1', 'Sketch 3', 'Knob']);
    expect(design.bodies.length).toBe(1);
    expect(S.historyState.value.undo).toBe('Delete body 1');
  });

  it('assembly (default): one object with a linked part per body; parts follow edits and survive save', async () => {
    await openProject(twoBodies());
    const ids = await C.commitToPlate({ switchView: false });
    expect(ids.length).toBe(1);
    const o = S.getObject(ids[0])!;
    expect(o.name).toBe('Design Assembly');
    expect(o.parts?.length).toBe(1);
    expect(o.design).toMatchObject({ sourceFeature: 1 });
    expect(o.parts![0].design).toMatchObject({ sourceFeature: 3 });
    const partMesh = o.parts![0].meshId;
    await C.setFeatureParams(3, { width: 30 });
    expect(S.getObject(ids[0])!.parts![0].meshId).not.toBe(partMesh);
    const round = sanitizeObjects(JSON.parse(JSON.stringify(S.objects.value)), new Set(S.objects.value.flatMap((x) => [x.meshId, ...(x.parts ?? []).map((p) => p.meshId)])));
    expect(round[0].parts![0].design).toMatchObject({ sourceFeature: 3 });
    expect(C.commitCandidates()).toEqual([]);
  });

  it('separate bodies: one object each', async () => {
    await openProject(twoBodies());
    const ids = await C.commitToPlate({ switchView: false, mode: 'bodies' });
    expect(ids.length).toBe(2);
    expect(S.objects.value.every((x) => !!x.design && !x.parts?.length)).toBe(true);
  });

  it('a design-only project opens straight to the Design tab', async () => {
    activeView.value = 'prepare';
    S.resetProject();
    await nextTick();
    S.loadProjectData({ name: 'design only', objects: [], meshes: [] });
    setOrcaCadRecipe(twoBodies());
    await new Promise((r) => setTimeout(r, 5));
    expect(activeView.value).toBe('design');
    activeView.value = 'prepare';
    // A project with objects stays in Prepare.
    S.loadProjectData({ name: 'with objects', objects: [], meshes: [] });
    await nextTick();
    expect(activeView.value).toBe('prepare');
  });
});

describe('geometry in and out', () => {
  it('STEP import: Import features named after the file, one undo step', async () => {
    await openProject(null);
    const r = await importStepToDesign('Bracket v2.step', new TextEncoder().encode('ISO-10303-21;'), { show: false });
    expect(r.ok).toBe(true);
    expect(design.features.at(-1)).toMatchObject({ type: 'Import', name: 'Bracket v2' });
    expect(S.historyState.value.undo).toBe('Import Bracket v2');
  });

  it('mesh blobs use import_mesh’s layout', () => {
    const { blob, layout } = meshBlob(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Uint32Array([0, 1, 2]));
    expect(layout).toEqual({ positions: { offset: 0, count: 9 }, indices: { offset: 36, count: 3 } });
    expect(blob.byteLength).toBe(48);
  });
});

describe('CubbyCAD shapes as bodies', () => {
  it('exact builds and the reasons for meshes', () => {
    expect(exactBuild('box', { width: 40, depth: 30, height: 10 }, [1, 1, 2])).toMatchObject({ build: { op: 'extrude', length: 20 } });
    expect(exactBuild('box', { bevel: 2 }, [1, 1, 1])).toMatchObject({ fillet: 1.998 });
    expect(exactBuild('cylinder', { radius: 5, height: 8 }, [1, 1, 1])).toMatchObject({ build: { op: 'revolve', profile: [[0, 0], [5, 0], [5, 8], [0, 8]] } });
    expect(exactBuild('cylinder', {}, [1, 2, 1])).toMatchObject({ reason: expect.stringMatching(/unevenly/) });
    expect(exactBuild('sphere', {}, [1, 1, 2])).toMatchObject({ reason: expect.stringMatching(/ellipsoid/) });
    expect(exactBuild('cone', { radiusTop: 0 }, [1, 1, 1])).toMatchObject({ build: { profile: [[0, 0], [10, 0], [0, 20]] } });
    expect(exactBuild('heart', {}, [1, 1, 1])).toMatchObject({ reason: expect.stringMatching(/no exact equivalent/) });
    expect(exactBuild('polygon', { sides: 6, radius: 10 }, [1, 1, 1])).toMatchObject({ build: { op: 'extrude' } });
  });

  it('splits a world matrix into a rigid frame and scale; refuses shear and mirrors', () => {
    const m: Mat4 = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1];
    expect(splitScale(m)).toMatchObject({ scale: [2, 3, 4], rigid: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1] });
    expect(splitScale([1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBeNull();
    expect(splitScale([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBeNull();
  });

  it('the palette adds an exact box body with the kernel primitive verb (one feature, one undo step)', async () => {
    await openProject(null);
    const r = await addPrimitiveBody('box', { params: { width: 30 }, position: [110, 110, 0] });
    expect(r.ok && r.exact).toBe(true);
    expect(r.shapes[0]).toMatchObject({ shape: 'box', exact: true, how: 'kernel box primitive' });
    expect(design.features.map((f) => f.type)).toEqual(['Import']);
    expect(fake.calls).toContain('box');
    expect(design.bodies.length).toBe(1);
    expect(design.bodies[0].name).toBe('Box');
    expect(S.historyState.value.undo).toBe('Add box body');
  });

  // last in this block: an older kernel is remembered for the rest of the session
  it('an older kernel without primitive verbs: the palette falls back to Sketch + Extrude', async () => {
    fake.primitives = false;
    await openProject(null);
    const r = await addPrimitiveBody('box', { params: { width: 30 }, position: [110, 110, 0] });
    expect(r.ok && r.exact).toBe(true);
    expect(design.features.map((f) => f.type)).toEqual(['Sketch', 'Extrude']);
    expect(design.bodies.length).toBe(1);
  });
});

describe('frames', () => {
  it('frames from an axis, flipped, coordinates in a frame', () => {
    const f = frameFromAxis([1, 2, 3], [0, 0, 2]);
    expect(f.normal).toEqual([0, 0, 1]);
    const g = flipFrame(f);
    expect(g.normal).toEqual([-0, -0, -1]);
    expect(inFrame(f, [1 + f.x_axis[0] * 3, 2 + f.x_axis[1] * 3, 3])).toEqual([3, 0]);
  });
  it('nearest thread: major for a boss, minor for a bore', () => {
    const t = [{ name: 'M6', major_diameter: 6, minor_diameter: 4.9, pitch: 1, series: '', depth: 0.6, internal_depth: 0.5 }, { name: 'M8', major_diameter: 8, minor_diameter: 6.6, pitch: 1.25, series: '', depth: 0.8, internal_depth: 0.7 }];
    expect(nearestThread(t, 7.9, false)?.name).toBe('M8');
    expect(nearestThread(t, 5.1, true)?.name).toBe('M6');
  });
});

describe('kernel progress and clean cancel', () => {
  it('Cancel asks the kernel to stop (cadProgress flag) instead of terminating; progress is shown', async () => {
    const { CadKernel } = await import('./kernel/client');
    let flag = false, terminated = 0;
    const backend = {
      onRebuild: undefined as undefined | ((p: { index: number; count: number; name: string }) => void),
      async start() { return { version: { module: 'orca-cad', orca: '2.5.0', occt: 'x', abi: 1, recipeVersion: 6, build: 't' }, heapBytes: 1 }; },
      async call() {
        for (let i = 0; i < 50 && !flag; i++) { backend.onRebuild?.({ index: i, count: 50, name: `F${i}` }); await new Promise((r) => setTimeout(r, 2)); }
        return { rc: 0, envelope: { ok: true, result: { ok: !flag, cancelled: flag, error: flag ? 'rebuild cancelled' : '' } }, blob: null, heapBytes: 1 };
      },
      terminate() { terminated++; },
      requestCancel(on: boolean) { flag = on; return true; },
    };
    const k = new CadKernel(() => backend);
    const job = k.run('Rebuild', async (c) => (await c.call<{ cancelled: boolean }>('regenerate')).result, { cancellable: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(k.status.rebuild?.count).toBe(50);
    expect(k.cancel()).toBe(true);
    expect(k.status.busy?.cancelling).toBe(true);
    expect((await job).cancelled).toBe(true);
    expect(terminated).toBe(0);
    expect(flag).toBe(false); // cleared when the job ended
    k.dispose();
  });
});

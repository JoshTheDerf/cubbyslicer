import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as C from './commands';
import * as S from '../project/store';
import { resolvedConfig } from '../app/state';
import { composeTRS, quatFromEuler, transformPoint, type Vec3 } from '../project/math';
import { weldVertices, recenter } from '../project/mesh';
import { cubeSoup } from '../project/testutil';
import { signedVolume } from '../tools/geom/meshUtil';
import { RENDER_TO_ZUP, createPrimitiveNode, isCadGroup, transformToMatrix, type CadGroupNode, type CadNode } from './api';
import { ensureCadWasm } from './build';
import { cadTransformToTrs, renderToZupMatrix, trsToCadTransform, zupToRenderMatrix } from './frames';
import { applyNodeSettings, applyTransformArgs, findIn, mapNode, parentFrameMatrix, removeNodeFrom as removeNode, supportMap } from './tree';
import { supportIssues } from './build';

const close = (a: number[], b: number[], d = 5) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], d));
const vol = (id: string) => { const o = S.getObject(id)!; const m = S.getMesh(o.meshId)!; return signedVolume(m.positions, m.indices); };
const box = (w: number, d: number, h: number, extra: Partial<CadNode> = {}) => ({ ...createPrimitiveNode('box', { params: { width: w, depth: d, height: h } }), ...extra }) as CadNode;

beforeAll(async () => { await ensureCadWasm(); });
beforeEach(() => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  S.resetProject();
});

describe('frames', () => {
  it('RENDER_TO_ZUP maps render +Y (up) to bed +Z and render +Z to bed −Y', () => {
    close(transformPoint(RENDER_TO_ZUP, [0, 1, 0]), [0, 0, 1]);
    close(transformPoint(RENDER_TO_ZUP, [0, 0, 1]), [0, -1, 0]);
    close(transformPoint(RENDER_TO_ZUP, [1, 0, 0]), [1, 0, 0]);
  });

  it('a slicer TRS round-trips through a CubbyCAD transform', () => {
    const q = quatFromEuler(0.4, -0.2, 1.3);
    const t = trsToCadTransform({ position: [110, 90, 5], rotation: q, scale: [2, 1, 0.5] }, [100, 100, 0]);
    const back = cadTransformToTrs(t, 1, [100, 100, 0]);
    expect(back.exact).toBe(true);
    const a = composeTRS([110, 90, 5], q, [2, 1, 0.5]), b = composeTRS(back.position, back.rotation, back.scale);
    close(b, a);
  });

  it('conjugation keeps world placement: R · T · E  ==  M · R · E', () => {
    const q = quatFromEuler(0.1, 0.7, -0.3);
    const M = composeTRS([5, -3, 2], q, [1, 2, 3]);
    const T = zupToRenderMatrix(M);
    const e: Vec3 = [1.5, -2, 0.25]; // a render-frame point of the subtree
    close(transformPoint(RENDER_TO_ZUP, transformPoint(T, e)), transformPoint(M, transformPoint(RENDER_TO_ZUP, e)));
    close(renderToZupMatrix(T), M);
  });

  it('a CubbyCAD position in cm lands in mm, Y-up → Z-up', () => {
    const t = cadTransformToTrs({ position: [1, 2, 3] }, 10);
    close(t.position, [10, -30, 20]);
    close(t.scale, [10, 10, 10]);
  });
});

describe('CAD objects in the store', () => {
  it('adds a primitive as an object whose mesh is the evaluated tree (Z-up, on the bed)', () => {
    const [id] = S.addCadObjects([{ node: box(20, 10, 30) }]);
    const o = S.getObject(id)!;
    expect(o.cad?.node.type).toBe('primitive');
    const info = S.objectInfo.value.get(id)!;
    close([info.max[0] - info.min[0], info.max[1] - info.min[1], info.max[2] - info.min[2]], [20, 10, 30], 3);
    expect(info.min[2]).toBeCloseTo(0);
    expect(vol(id)).toBeCloseTo(6000, 0);
  });

  it('param edits re-evaluate, give a new (unpainted) mesh and undo in one step', () => {
    const [id] = S.addCadObjects([{ node: box(20, 20, 20) }]);
    const o = S.getObject(id)!;
    const m0 = o.meshId;
    S.setMeshPaint(m0, 'seam', [[0, '4']]);
    const n0 = o.cad!.node;
    for (const w of [25, 30, 35]) S.setCadNode(id, applyNodeSettings(S.getObject(id)!.cad!.node, { id: n0.id, params: { width: w } }).root, { label: 'Change width', mergeKey: 'w' });
    const o1 = S.getObject(id)!;
    expect(o1.meshId).not.toBe(m0);
    expect(S.getMeshPaint(o1.meshId)).toEqual({});
    expect(vol(id)).toBeCloseTo(35 * 400, 0);
    S.undo();
    const o2 = S.getObject(id)!;
    expect(o2.meshId).toBe(m0);
    expect((o2.cad!.node as unknown as { geometry: { params: { width: number } } }).geometry.params.width).toBe(20);
    expect(S.getMeshPaint(m0).seam).toBeTruthy();
    S.redo();
    expect(vol(id)).toBeCloseTo(35 * 400, 0);
  });

  it('groups objects into a manifold group; a hole subtracts; ungroup restores the pieces in place', () => {
    const [a] = S.addCadObjects([{ node: box(40, 40, 10), position: [100, 100, 0] }], { keepPlacement: true });
    const [h] = S.addCadObjects([{ node: box(10, 10, 30, { contribution: 'subtract' }) }]);
    S.setTransforms([{ id: h, position: [100, 100, 0] }]);
    const before = S.objectInfo.value.get(a)!;
    const g = S.groupObjects([a, h]);
    const go = S.getObject(g)!;
    expect(isCadGroup(go.cad!.node)).toBe(true);
    expect((go.cad!.node as CadGroupNode).children.map((c) => c.contribution ?? 'add')).toEqual(['add', 'subtract']);
    expect(vol(g)).toBeCloseTo(40 * 40 * 10 - 10 * 10 * 10, 0);
    const gi = S.objectInfo.value.get(g)!;
    close([gi.min[0], gi.min[1], gi.max[0], gi.max[1]], [before.min[0], before.min[1], before.max[0], before.max[1]], 3);
    const back = S.ungroupObject(g);
    expect(back).toHaveLength(2);
    const ai = S.objectInfo.value.get(back[0])!;
    close([ai.min[0], ai.min[1], ai.max[0]], [before.min[0], before.min[1], before.max[0]], 3);
    expect(S.getObject(back[1])!.cad!.node.contribution).toBe('subtract');
    S.undo(); S.undo();
    expect(S.objects.value.map((o) => o.id)).toEqual([a, h]);
  });

  it('groups a rotated, scaled mesh object with a CAD shape exactly (TRS → child transform)', () => {
    const w = weldVertices(cubeSoup(10), null);
    recenter(w.positions);
    const [m] = S.addParsedObjects([{ name: 'Cube', positions: w.positions, indices: w.indices, transform: null }]);
    S.setTransforms([{ id: m, position: [60, 60, 0], rotation: quatFromEuler(0, 0, Math.PI / 4), scale: [2, 1, 1] }], 'Move', { drop: true });
    const [b] = S.addCadObjects([{ node: box(10, 10, 10), position: [150, 150, 0] }], { keepPlacement: true });
    const mi = S.objectInfo.value.get(m)!, bi = S.objectInfo.value.get(b)!;
    const g = S.groupObjects([m, b]);
    const gi = S.objectInfo.value.get(g)!;
    close([gi.min[0], gi.min[1], gi.max[0], gi.max[1], gi.max[2]], [Math.min(mi.min[0], bi.min[0]), Math.min(mi.min[1], bi.min[1]), Math.max(mi.max[0], bi.max[0]), Math.max(mi.max[1], bi.max[1]), 10], 3);
    expect(vol(g)).toBeCloseTo(2000 + 1000, 0);
    // Ungroup turns the baked mesh back into a mesh object.
    const [m2] = S.ungroupObject(g);
    expect(S.getObject(m2)!.cad).toBeUndefined();
    const m2i = S.objectInfo.value.get(m2)!;
    close([m2i.min[0], m2i.min[1], m2i.max[0], m2i.max[1]], [mi.min[0], mi.min[1], mi.max[0], mi.max[1]], 3);
  });

  it('slider edits (queueParam) evaluate in turn and close as one undo step', async () => {
    const [id] = S.addCadObjects([{ node: box(20, 20, 20) }]);
    const nid = S.getObject(id)!.cad!.node.id;
    const width = () => (S.getObject(id)!.cad!.node as unknown as { geometry: { params: { width: number } } }).geometry.params.width;
    for (const w of [22, 24, 26]) C.queueParam(id, nid, 'width', w);
    C.commitParams();
    await vi.waitFor(() => expect(width()).toBe(26));
    expect(vol(id)).toBeCloseTo(26 * 400, 0);
    S.undo();
    expect(width()).toBe(20);
    expect(S.historyState.value.undo).toBe('Add Box');
  });

  it('an async edit rebuilds from the current tree when it changed meanwhile', async () => {
    const [id] = S.addCadObjects([{ node: box(20, 20, 20) }]);
    const nid = S.getObject(id)!.cad!.node.id;
    const p = C.editNodeOrThrow(id, { id: nid, params: { depth: 30 } });
    S.setCadNode(id, applyNodeSettings(S.getObject(id)!.cad!.node, { id: nid, params: { height: 5 } }).root, { label: 'x' });
    await p;
    const g = (S.getObject(id)!.cad!.node as unknown as { geometry: { params: { depth: number; height: number } } }).geometry.params;
    expect([g.depth, g.height]).toEqual([30, 5]);
  });

  it('a top-level hole shows as a ghost and is not sliced', () => {
    S.addCadObjects([{ node: box(10, 10, 10, { contribution: 'subtract' }) }]);
    expect(S.getSliceObjects()).toHaveLength(0);
  });

  it('refuses edits that would leave nothing to show, changing nothing', () => {
    const [id] = S.addCadObjects([{ node: box(10, 10, 10) }]);
    const n = S.getObject(id)!.cad!.node;
    expect(() => S.setCadNode(id, { ...n, children: [] , type: 'group' } as CadNode, { label: 'x' })).toThrow(/Nothing to show/);
    expect(S.historyState.value.undo).toBe('Add Box');
  });
});

describe('tree helpers', () => {
  const tree = (): CadGroupNode => ({
    id: 'g', type: 'group', children: [
      { id: 'a', type: 'primitive', geometry: { type: 'box', params: { width: 10, height: 10, depth: 10 } }, transform: { position: [5, 0, 0] } },
      { id: 'sub', type: 'group', transform: { position: [0, 10, 0] }, children: [
        { id: 'b', type: 'primitive', geometry: { type: 'box', params: { width: 10 } }, locked: true },
      ] },
      { id: 's', type: 'group', csgMode: 'sdf', children: [{ id: 'c', type: 'primitive', geometry: { type: 'sphere', params: {} } }] },
      { id: 'u', type: 'primitive', geometry: { type: 'user', shapeId: 'x', params: {} } },
    ],
  });

  it('edits immutably and shares untouched subtrees', () => {
    const t = tree();
    const r = applyNodeSettings(t, { id: 'a', params: { width: 12 }, hole: true, name: 'A' });
    expect(r.changed).toBe(true);
    const a = findIn(r.root, 'a')!.node as unknown as { geometry: { params: { width: number } }; contribution?: string; name?: string };
    expect([a.geometry.params.width, a.contribution, a.name]).toEqual([12, 'subtract', 'A']);
    expect((t.children[0] as unknown as { geometry: { params: { width: number } } }).geometry.params.width).toBe(10);
    expect((r.root as CadGroupNode).children[1]).toBe(t.children[1]);
  });

  it('refuses locked and unsupported nodes, and unknown params', () => {
    const t = tree();
    const sup = supportMap(t, supportIssues(t));
    expect(() => applyNodeSettings(t, { id: 'b', params: { width: 3 } }, sup)).toThrow(/locked/);
    expect(applyNodeSettings(t, { id: 'b', locked: false }, sup).changed).toBe(true);
    expect(() => applyNodeSettings(t, { id: 'c', hidden: true }, sup)).toThrow(/can’t be edited/);
    expect(() => applyNodeSettings(t, { id: 'u', name: 'x' }, sup)).toThrow(/can’t be edited/);
    expect(() => applyNodeSettings(t, { id: 'a', params: { nope: 1 } }, sup)).toThrow(/Unknown box parameter/);
    expect(sup.get('s')?.editable).toBe(false);
    expect(sup.get('c')?.editable).toBe(false);
    expect(sup.get('a')?.editable).toBe(true);
  });

  it('composes a child frame through its ancestors (not the root)', () => {
    const t = { ...tree(), transform: { position: [100, 100, 100] as [number, number, number] } };
    close(parentFrameMatrix(t, 'b'), transformToMatrix({ position: [0, 10, 0] }));
    close(parentFrameMatrix(t, 'a'), transformToMatrix(undefined));
  });

  it('removes and maps nodes', () => {
    const t = tree();
    expect(findIn(removeNode(t, 'b')!, 'b')).toBeNull();
    expect(removeNode(t, 'g')).toBeNull();
    expect(() => mapNode(t, 'zz', (n) => n)).toThrow();
  });

  it('applies transform_node set / offset like CubbyCAD', () => {
    const s = applyTransformArgs({ position: [1, 2, 3] }, { position: [4, 5, 6] });
    close(s.position!, [4, 5, 6]);
    const o = applyTransformArgs({ position: [1, 2, 3], scale: [2, 2, 2] }, { mode: 'offset', position: [1, 1, 1], scale: [2, 1, 1], rotationDeg: [0, 90, 0] });
    close(o.position!, [2, 3, 4]);
    close(o.scale!, [4, 2, 2]);
    close(o.rotation!, [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  });
});

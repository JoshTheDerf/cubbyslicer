import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolvedConfig } from '../app/state';
import * as S from '../project/store';
import { buildOrca3mf, CUBBY_META } from '../project/persistence/orca3mfWriter';
import { CUBBY_CAD_META } from '../project/persistence/format';
import { parseOrca3mf } from '../project/import/orca3mf';
import { openOrcaProject } from '../project/orcaOpen';
import { createPrimitiveNode, isCadGroup, type CadGroupNode, type CadNode } from './api';
import { ensureCadWasm } from './build';
import { cubbySceneOf, editNodeOrThrow, importCadNodes } from './commands';
import { parseCubbyScene, restoreOriginals } from './cubby';
import { encodeMesh as encodeMeshGeometry, findIn, zupToRenderPositions } from './tree';
import { signedVolume } from '../tools/geom/meshUtil';
import { boxMesh } from '../project/primitives';

const box = (w: number, d: number, h: number, extra: Partial<CadNode> = {}) => ({ ...createPrimitiveNode('box', { params: { width: w, depth: d, height: h } }), ...extra }) as CadNode;
const close = (a: number[], b: number[], d = 3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], d));
const vol = (id: string) => { const o = S.getObject(id)!; const m = S.getMesh(o.meshId)!; return signedVolume(m.positions, m.indices); };
const bytes = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

beforeAll(async () => { await ensureCadWasm(); });
beforeEach(() => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  S.resetProject();
});

/** A blended (SDF) group CubbyCAD baked for the slicer: a `mesh` stand-in keeping the original. */
function bakedSdf(): CadNode {
  const m = boxMesh(8, 8, 8);
  const original = { id: 'sdf1', type: 'group', csgMode: 'sdf', name: 'Blob', children: [{ id: 's1', type: 'primitive', geometry: { type: 'sphere', params: { radius: 5 } } }] };
  // boxMesh is centred on the origin; lift it onto the floor, then into the render frame.
  const p = m.positions.slice();
  for (let i = 2; i < p.length; i += 3) p[i] += 4;
  return { id: 'sdf1', type: 'primitive', name: 'Blob', geometry: encodeMeshGeometry(zupToRenderPositions(p), m.indices), cubbyOriginal: original, transform: { position: [30, 0, 0] } } as CadNode;
}

describe('project 3MF', () => {
  it('keeps the trees in Metadata/cubby_cad.json, reopens them editable; stock Orca sees meshes', async () => {
    const [a] = S.addCadObjects([{ node: box(30, 30, 10) }]);
    const [h] = S.addCadObjects([{ node: box(10, 10, 20, { contribution: 'subtract' }) }]);
    S.setTransforms([{ id: h, position: [...S.getObject(a)!.position] }]);
    const g = S.groupObjects([a, h], 'Plate with hole');
    const file = buildOrca3mf();
    const zip = unzipSync(file);
    expect(zip[CUBBY_CAD_META]).toBeDefined();
    const meta = JSON.parse(strFromU8(zip[CUBBY_META]));
    expect(meta.objects[0].cad).toBeUndefined();
    const trees = JSON.parse(strFromU8(zip[CUBBY_CAD_META]));
    expect(trees.objects[g].children).toHaveLength(2);
    // Stock Orca reads the geometry as an ordinary mesh.
    const orca = parseOrca3mf(bytes(file));
    expect(orca.objects).toHaveLength(1);
    expect(orca.objects[0].volumes[0].indices.length).toBeGreaterThan(0);

    const before = S.getObject(g)!;
    const volBefore = vol(g);
    S.resetProject();
    await openOrcaProject('p.3mf', bytes(file));
    const o = S.objects.value[0];
    expect(o.name).toBe('Plate with hole');
    expect(isCadGroup(o.cad!.node)).toBe(true);
    close(o.position, before.position);
    expect(vol(o.id)).toBeCloseTo(volBefore, 0);
    // Still editable: widen the hole.
    const hole = (o.cad!.node as CadGroupNode).children[1];
    await editNodeOrThrow(o.id, { id: hole.id, params: { width: 20 } });
    expect(vol(S.objects.value[0].id)).toBeCloseTo(30 * 30 * 10 - 20 * 10 * 10, 0);
  });
});

describe('.cubby import / export', () => {
  it('one object per top-level node, Y-up → Z-up, laid out as in CubbyCAD (a unit converts to mm)', async () => {
    const scene = { version: 1, unit: 'cm', children: [
      box(2, 1, 3, { id: 'a', name: 'A', transform: { position: [-3, 0, 0] } }),
      box(1, 1, 1, { id: 'b', name: 'B', transform: { position: [3, 0, 2] } }),
    ] };
    const parsed = parseCubbyScene(JSON.stringify(scene));
    // A .cubby is mm whatever its display unit; slicer_import_cad callers may pass one.
    const mm = await importCadNodes(parsed.nodes);
    close(S.getObject(mm.ids[0])!.scale, [1, 1, 1]);
    S.resetProject();
    const r = await importCadNodes(parsed.nodes, { unit: 'cm' });
    expect(r.ids).toHaveLength(2);
    const [ia, ib] = r.ids.map((id) => S.objectInfo.value.get(id)!);
    close([ia.max[0] - ia.min[0], ia.max[1] - ia.min[1], ia.max[2] - ia.min[2]], [20, 10, 30]);
    expect(ia.min[2]).toBeCloseTo(0);
    // CubbyCAD +X stays +X; CubbyCAD +Z (towards the viewer) is bed −Y.
    expect((ib.min[0] + ib.max[0]) / 2 - (ia.min[0] + ia.max[0]) / 2).toBeCloseTo(60, 3);
    expect((ib.min[1] + ib.max[1]) / 2 - (ia.min[1] + ia.max[1]) / 2).toBeCloseTo(-20, 3);
    // The tree is verbatim (params in the scene unit; the object scale carries cm → mm).
    close(S.getObject(r.ids[0])!.scale, [10, 10, 10]);
  });

  it('exports back to a scene that reproduces the layout', async () => {
    const [a] = S.addCadObjects([{ node: box(20, 20, 20, { name: 'A' }) }]);
    S.setTransforms([{ id: a, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }]);
    const [b] = S.addCadObjects([{ node: box(10, 10, 5, { name: 'B' }) }]);
    const infoA = S.objectInfo.value.get(a)!, infoB = S.objectInfo.value.get(b)!;
    const scene = cubbySceneOf(S.objects.value, 'Two');
    expect(scene.unit).toBe('mm');
    expect(scene.children.map((c) => c.name)).toEqual(['A', 'B']);
    S.resetProject();
    const r = await importCadNodes(parseCubbyScene(JSON.stringify(scene)).nodes, { unit: 'mm' });
    const [ra, rb] = r.ids.map((id) => S.objectInfo.value.get(id)!);
    close([...ra.min, ...ra.max], [...infoA.min, ...infoA.max]);
    close([...rb.min, ...rb.max], [...infoB.min, ...infoB.max]);
  });

  it('shows CubbyCAD-only content from its baked mesh, carries it through and exports the original', async () => {
    const tree: CadGroupNode = { id: 'root', type: 'group', name: 'Mixed', children: [box(10, 10, 10, { id: 'bx' }), bakedSdf(),
      { id: 'script', type: 'primitive', name: 'Gear', geometry: { type: 'user', shapeId: 'gear', params: { teeth: 12 } } } as CadNode] };
    const r = await importCadNodes([tree]);
    expect(r.ids).toHaveLength(1);
    expect(vol(r.ids[0])).toBeCloseTo(1000 + 512, 0);
    const scene = cubbySceneOf(S.objects.value);
    const back = scene.children[0] as CadGroupNode;
    const sdf = findIn(back, 'sdf1')!.node as CadGroupNode;
    expect(sdf.csgMode).toBe('sdf');
    close(sdf.transform!.position!, [30, 0, 0]);
    expect((findIn(back, 'script')!.node as unknown as { geometry: { params: { teeth: number } } }).geometry.params.teeth).toBe(12);
    expect(restoreOriginals(bakedSdf()).id).toBe('sdf1');
  });

  it('skips top-level nodes it cannot show at all, with a reason', async () => {
    const r = await importCadNodes([{ id: 't', type: 'primitive', name: 'Label', geometry: { type: 'text', params: { text: 'hi' } } } as CadNode, box(5, 5, 5)]);
    expect(r.ids).toHaveLength(1);
    expect(r.warnings.join(' ')).toMatch(/Skipped “Label”/);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import * as S from './store';
import { resolvedConfig, sliceInputRevision } from '../app/state';
import { composeTRS, quatFromEuler, transformPoint, decomposeTRS, type Vec3 } from './math';
import { weldVertices, recenter } from './mesh';
import { cubeSoup } from './testutil';
import type { ParsedObject } from './types';
import type { ArrangeResult } from '../engine/types';

function cube(name = 'Cube', size = 20): ParsedObject {
  const w = weldVertices(cubeSoup(size), null);
  recenter(w.positions);
  return { name, positions: w.positions, indices: w.indices, transform: null };
}

beforeEach(() => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  S.resetProject();
});

describe('transform math', () => {
  it('composeTRS is column-major T*R*S', () => {
    const q = quatFromEuler(0, 0, Math.PI / 2);
    const m = composeTRS([10, 20, 30], q, [2, 3, 4]);
    // local +X scaled by 2, rotated 90° about Z → +Y*2, then translated
    const p = transformPoint(m, [1, 0, 0]);
    expect(p[0]).toBeCloseTo(10);
    expect(p[1]).toBeCloseTo(22);
    expect(p[2]).toBeCloseTo(30);
    expect(m.slice(12, 16)).toEqual([10, 20, 30, 1]);
  });

  it('decomposes back to the same TRS', () => {
    const q = quatFromEuler(0.3, -0.7, 1.1);
    const d = decomposeTRS(composeTRS([1, 2, 3], q, [1.5, 2, 0.5]));
    expect(d.exact).toBe(true);
    d.scale.forEach((s, i) => expect(s).toBeCloseTo([1.5, 2, 0.5][i]));
    const back = composeTRS(d.position, d.rotation, d.scale);
    const orig = composeTRS([1, 2, 3], q, [1.5, 2, 0.5]);
    back.forEach((v, i) => expect(v).toBeCloseTo(orig[i]));
  });
});

describe('project store', () => {
  it('adds objects on the bed, centred and dropped', () => {
    const [id] = S.addParsedObjects([cube()]);
    const o = S.getObject(id)!;
    expect(o.position[0]).toBeCloseTo(110);
    expect(o.position[1]).toBeCloseTo(110);
    const info = S.objectInfo.value.get(id)!;
    expect(info.min[2]).toBeCloseTo(0);
    expect(S.selectedIds.value).toEqual([id]);
  });

  it('getSliceObjects emits column-major world transforms with min Z = 0', () => {
    const [id] = S.addParsedObjects([cube()]);
    S.setTransforms([{ id, position: [50, 60, 40], rotation: quatFromEuler(0, 0, Math.PI / 4), scale: [2, 1, 1] }], 'Test', { drop: false });
    const [so] = S.getSliceObjects();
    expect(so.id).toBe(id);
    expect(so.transform).toHaveLength(16);
    // min Z of transformed vertices is 0 even though the object was lifted
    let minZ = Infinity;
    for (let i = 0; i < so.positions.length; i += 3) {
      const p = transformPoint(so.transform, [so.positions[i], so.positions[i + 1], so.positions[i + 2]] as Vec3);
      minZ = Math.min(minZ, p[2]);
    }
    expect(minZ).toBeCloseTo(0);
    expect(so.transform[12]).toBeCloseTo(50);
    expect(so.transform[13]).toBeCloseTo(60);
  });

  it('skips non-printable objects and passes per-object overrides', () => {
    const [a, b] = S.addParsedObjects([cube('A'), cube('B')]);
    S.setPrintable([b], false);
    S.setObjectOverride(a, 'wall_loops', '5');
    const objs = S.getSliceObjects();
    expect(objs.map((o) => o.id)).toEqual([a]);
    expect(objs[0].config).toEqual({ wall_loops: '5' });
    S.setObjectOverride(a, 'wall_loops', undefined);
    expect(S.getSliceObjects()[0].config).toBeUndefined();
  });

  it('flips winding for mirrored objects', () => {
    const [id] = S.addParsedObjects([cube()]);
    const before = S.getSliceObjects()[0].indices;
    S.mirrorObjects(0, [id]);
    const so = S.getSliceObjects()[0];
    expect(so.indices).not.toBe(before);
    expect([so.indices[0], so.indices[1], so.indices[2]]).toEqual([before[0], before[2], before[1]]);
  });

  it('marks slice inputs changed on edits', () => {
    const [id] = S.addParsedObjects([cube()]);
    const r0 = sliceInputRevision.value;
    S.setTransforms([{ id, position: [30, 30, 0] }]);
    expect(sliceInputRevision.value).toBeGreaterThan(r0);
    const r1 = sliceInputRevision.value;
    S.renameObject(id, 'Renamed');
    expect(sliceInputRevision.value).toBe(r1); // rename doesn't affect slicing
  });

  it('undo/redo restores add, remove, transform and rename', () => {
    const [id] = S.addParsedObjects([cube()]);
    S.setTransforms([{ id, position: [40, 40, 0] }]);
    S.renameObject(id, 'X');
    S.removeObjects([id]);
    expect(S.objects.value).toHaveLength(0);
    expect(S.historyState.value.undo).toMatch(/Delete/);
    S.undo();
    expect(S.getObject(id)?.name).toBe('X');
    S.undo();
    expect(S.getObject(id)?.name).toBe('Cube');
    S.undo();
    expect(S.getObject(id)?.position[0]).toBeCloseTo(110);
    S.undo();
    expect(S.objects.value).toHaveLength(0);
    expect(S.undo()).toBeNull();
    S.redo();
    expect(S.objects.value).toHaveLength(1);
    expect(S.getMesh(S.objects.value[0].meshId)).toBeTruthy(); // mesh kept alive for redo
    S.redo(); S.redo(); S.redo();
    expect(S.objects.value).toHaveLength(0);
    // a new action clears redo
    S.undo();
    S.addParsedObjects([cube('Other')]);
    expect(S.historyState.value.redo).toBeNull();
  });

  it('coalesces rapid override edits into one undo step', () => {
    const [id] = S.addParsedObjects([cube()]);
    S.setObjectOverride(id, 'layer_height', '0.1');
    S.setObjectOverride(id, 'layer_height', '0.12');
    S.setObjectOverride(id, 'layer_height', '0.16');
    S.undo();
    expect(S.getObjectOverrides(id).layer_height).toBeUndefined();
  });

  it('duplicates as instances sharing the mesh and without overlap', () => {
    const [id] = S.addParsedObjects([cube()]);
    const copies = S.duplicateObjects([id], 3);
    expect(copies).toHaveLength(3);
    const meshIds = new Set(S.objects.value.map((o) => o.meshId));
    expect(meshIds.size).toBe(1);
    expect(S.objectIssues.value.size).toBe(0);
  });

  it('flags out-of-bed, too tall, and overlapping objects', () => {
    const [a, b] = S.addParsedObjects([cube('A'), cube('B')]);
    S.setTransforms([{ id: a, position: [300, 100, 0] }]);
    expect(S.objectIssues.value.get(a)).toContain('outside');
    S.setTransforms([{ id: a, position: [100, 100, 10] }, { id: b, position: [105, 100, 10] }]);
    expect(S.objectIssues.value.get(a)).toContain('overlap');
    S.setTransforms([{ id: b, scale: [1, 1, 20] }]);
    expect(S.objectIssues.value.get(b)).toContain('height');
  });

  it('lay on face rotates the chosen normal to face down', () => {
    const [id] = S.addParsedObjects([cube()]);
    S.layOnFace(id, [1, 0, 0]);
    const o = S.getObject(id)!;
    const m = composeTRS([0, 0, 0], o.rotation, [1, 1, 1]);
    const n = transformPoint(m, [1, 0, 0]);
    expect(n[2]).toBeCloseTo(-1);
    expect(S.objectInfo.value.get(id)!.min[2]).toBeCloseTo(0);
  });

  it('scale to fit stays within the build volume', () => {
    const [id] = S.addParsedObjects([cube('Small', 5)]);
    S.scaleToFit([id]);
    const i = S.objectInfo.value.get(id)!;
    expect(i.max[0] - i.min[0]).toBeGreaterThan(200);
    expect(S.objectIssues.value.size).toBe(0);
  });
});

describe('clipboard + nudge', () => {
  it('pastes copies that survive the originals being cut (mesh kept alive)', () => {
    const [id] = S.addParsedObjects([cube('A')]);
    const clip = S.copyObjects([id])!;
    expect(clip.objects).toHaveLength(1);
    S.removeObjects([id]);
    expect(S.objects.value).toHaveLength(0);
    // Drop the undo history holding the mesh, as a long session would.
    S.resetProject();
    expect(S.getMesh(clip.objects[0].meshId)).toBeUndefined();
    const ids = S.pasteObjects(clip);
    expect(ids).toHaveLength(1);
    expect(S.objects.value[0].name).toBe('A');
    expect(S.getMesh(S.objects.value[0].meshId)).toBeDefined();
    expect(S.selectedIds.value).toEqual(ids);
    // Pasting again makes independent objects.
    const again = S.pasteObjects(clip);
    expect(again[0]).not.toBe(ids[0]);
    expect(S.objects.value).toHaveLength(2);
  });

  it('coalesces repeated arrow nudges into one undo step', () => {
    const [id] = S.addParsedObjects([cube('A')]);
    const x0 = S.getObject(id)!.position[0];
    S.translateObjects([10, 0, 0], [id]);
    S.translateObjects([10, 0, 0], [id]);
    S.translateObjects([0, -1, 0], [id]);
    expect(S.getObject(id)!.position[0]).toBeCloseTo(x0 + 20);
    S.undo();
    expect(S.getObject(id)!.position[0]).toBeCloseTo(x0);
  });
});

describe('multiple plates', () => {
  const bedW = 220 * 1.2; // plate pitch: bed + 1/5 gap

  it('adds plates (active), puts imports on the active plate and slices plates separately', () => {
    S.addParsedObjects([cube('A')]);
    expect(S.addPlate()).toBe(1);
    expect(S.activePlate.value).toBe(1);
    const [b] = S.addParsedObjects([cube('B')]);
    expect(S.plateOf(b)).toBe(1);
    expect(S.getObject(b)!.position[0]).toBeGreaterThan(bedW);
    // Engine coordinates are plate-relative.
    const s1 = S.getSliceObjects(1);
    expect(s1.map((o) => o.name)).toEqual(['B']);
    expect(s1[0].transform[12]).toBeGreaterThan(0);
    expect(s1[0].transform[12]).toBeLessThan(220);
    expect(S.getSliceObjects(0).map((o) => o.name)).toEqual(['A']);
    expect(S.objectIssues.value.size).toBe(0);
  });

  it('keeps objects on their plate when the grid re-lays out, and deleting a plate deletes its objects', () => {
    S.addParsedObjects([cube('A')]);
    S.addPlate(); const [b] = S.addParsedObjects([cube('B')]);
    S.addPlate(); const [c] = S.addParsedObjects([cube('C')]);
    expect(S.plates.value).toHaveLength(3);
    expect([S.plateOf(b), S.plateOf(c)]).toEqual([1, 2]);
    // 3 → 4 → 5 plates changes the column count; objects follow their plates.
    S.addPlate(); S.addPlate();
    expect([S.plateOf(b), S.plateOf(c)]).toEqual([1, 2]);
    S.deletePlate(1);
    expect(S.getObject(b)).toBeUndefined();
    expect(S.plateOf(c)).toBe(1);
    S.undo();
    expect(S.plates.value).toHaveLength(5);
    expect(S.plateOf(b)).toBe(1);
  });

  it('moves objects to another plate', () => {
    const [a] = S.addParsedObjects([cube('A')]);
    S.addPlate();
    S.moveObjectsToPlate([a], 1);
    expect(S.plateOf(a)).toBe(1);
    expect(S.getSliceObjects(0)).toHaveLength(0);
  });
});

describe('instances and split', () => {
  it('sets the number of instances (adds next to it, removes newest first)', () => {
    const [a] = S.addParsedObjects([cube('A')]);
    S.setInstanceCount([a], 4);
    expect(S.instancesOf(a)).toHaveLength(4);
    expect(S.objectIssues.value.size).toBe(0);
    S.setInstanceCount([a], 2);
    expect(S.instancesOf(a)).toHaveLength(2);
    expect(S.getObject(a)).toBeDefined();
    S.removeInstance([a]);
    expect(S.instancesOf(a)).toHaveLength(1);
  });

  it('splits disconnected shells into objects in place', () => {
    const w1 = weldVertices(cubeSoup(10, [0, 0, 0]), null), w2 = weldVertices(cubeSoup(10, [30, 0, 0]), null);
    const positions = new Float32Array([...w1.positions, ...w2.positions]);
    const off = w1.positions.length / 3;
    const indices = new Uint32Array([...w1.indices, ...[...w2.indices].map((i) => i + off)]);
    const [id] = S.addParsedObjects([{ name: 'Pair', positions, indices, transform: null }]);
    const before = S.objectInfo.value.get(id)!;
    expect(S.splitToObjects([id])).toBe(2);
    const parts = S.objects.value.filter((o) => o.name.startsWith('Pair_'));
    expect(parts).toHaveLength(2);
    const xs = parts.map((o) => S.objectInfo.value.get(o.id)!).flatMap((i) => [i.min[0], i.max[0]]);
    expect(Math.min(...xs)).toBeCloseTo(before.min[0], 3);
    expect(Math.max(...xs)).toBeCloseTo(before.max[0], 3);
  });
});

describe('Orca arrange I/O', () => {
  const moved = (plate: number, x: number, y: number, dRot = 0) => ({ moved: true as const, plate, x, y, dRot });
  const result = (r: Partial<ArrangeResult> & Pick<ArrangeResult, 'items'>): ArrangeResult => ({
    plates: S.plates.value.length, unplaced: [], warnings: [], order: [], seqPrint: false, ...r,
  });

  it('gives plate-local, dropped transforms and the per-object / per-plate facts', () => {
    const [a] = S.addParsedObjects([cube('A')]);
    S.addPlate();
    const [b] = S.addParsedObjects([cube('B')]);
    S.setTransforms([{ id: b, position: [S.getObject(b)!.position[0], 100, 30] }], 'Lift', { drop: false });
    S.setPrintable([b], false);
    S.setPlateLocked(1, true);
    S.mutate('Plate settings', () => { S.plates.value[0].config = { print_sequence: 'by object', imex_parallel_mode: 'mirror' }; });
    const inp = S.arrangeInputs([b]);
    expect(inp.ids).toEqual([a, b]);
    expect(inp.objects.map((o) => o.id)).toEqual([a, b]);
    // Plate 1's object is given relative to its own plate, dropped to z = 0.
    expect(inp.objects[1].transform[12]).toBeCloseTo(110);
    expect(inp.objects[1].transform[13]).toBeCloseTo(100);
    expect(inp.objects[1].transform[14]).toBeCloseTo(10);
    expect(inp.items).toEqual([
      { plate: 0, printable: true, selected: false },
      { plate: 1, printable: false, selected: true },
    ]);
    expect(inp.plates).toEqual([
      // The plate's own IDEX/IQEX mode; '' = the process preset's applies.
      { locked: false, seq: 'by object', toolChanges: [], imexMode: 'mirror' },
      { locked: true, seq: '', toolChanges: [], imexMode: '' },
    ]);
  });

  it('counts imported objects on no plate as on the active plate', () => {
    const [a] = S.addParsedObjects([cube('A')]);
    S.setTransforms([{ id: a, position: [-500, 110, 10] }]);
    expect(S.arrangeInputs().items[0].plate).toBe(-1);
    expect(S.arrangeInputs([], [a]).items[0].plate).toBe(0);
  });

  it('applies a result in one undo step, appending plates and rotating about Z', () => {
    const [a, b] = S.addParsedObjects([cube('A'), cube('B')]);
    const [x0, , z] = S.getObject(a)!.position;
    const inp = S.arrangeInputs();
    const out = S.applyArrange(inp.ids, result({ plates: 2, items: [moved(0, 40, 50, Math.PI / 2), moved(1, 60, 70)] }), 'all');
    expect(out).toEqual({ moved: 2, unplaced: 0, imex: false });
    expect(S.applyArrange(inp.ids, result({ items: [{ moved: false }, { moved: false }], unplaced: ['B'], imex: true }), 'plate')).toEqual({ moved: 0, unplaced: 1, imex: true });
    expect(S.plates.value).toHaveLength(2);
    expect(S.getObject(a)!.position).toEqual([40, 50, z]);
    expect(S.plateOf(b)).toBe(1);
    expect(S.getSliceObjects(1)[0].transform[12]).toBeCloseTo(60);
    // 90° about Z: local +X now points along +Y.
    const r = transformPoint(composeTRS([0, 0, 0], S.getObject(a)!.rotation, [1, 1, 1]), [1, 0, 0]);
    expect(r[1]).toBeCloseTo(1);
    expect(S.historyState.value.undo).toBe('Arrange');
    S.undo();
    expect(S.plates.value).toHaveLength(1);
    expect(S.getObject(a)!.position[0]).toBeCloseTo(x0);
  });

  it('after "Arrange all", drops trailing plates left empty or with nothing printable', () => {
    S.addParsedObjects([cube('A')]);
    S.addPlate(); const [b] = S.addParsedObjects([cube('B')]);
    S.addPlate();
    S.setPrintable([b], false);
    const inp = S.arrangeInputs();
    S.applyArrange(inp.ids, result({ items: [{ moved: false }, { moved: false }] }), 'all');
    expect(S.plates.value).toHaveLength(1);
    // Not for "Arrange plate".
    S.undo();
    S.applyArrange(inp.ids, result({ items: [{ moved: false }, { moved: false }] }), 'plate');
    expect(S.plates.value).toHaveLength(3);
  });

  it('takes the arrange order as the object order for by-object printing', () => {
    const [a, b, c] = S.addParsedObjects([cube('A'), cube('B'), cube('C')]);
    const inp = S.arrangeInputs();
    S.applyArrange(inp.ids, result({ items: inp.ids.map(() => ({ moved: false })), order: [2, 0, 1], seqPrint: true }), 'plate');
    expect(S.objects.value.map((o) => o.id)).toEqual([c, a, b]);
  });
});

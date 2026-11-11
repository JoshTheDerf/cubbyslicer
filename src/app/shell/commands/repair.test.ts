import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as S from '../../../project/store';
import { resolvedConfig } from '../../state';
import { recenter, weldVertices } from '../../../project/mesh';
import { cubeSoup } from '../../../project/testutil';
import type { ParsedObject } from '../../../project/types';
import type { RepairMeshResult } from '../../../engine/tools';
import { repairObjects, repairSummary, repairTargets, type RepairCall } from './repair';

function cube(name: string, size = 20): ParsedObject {
  const w = weldVertices(cubeSoup(size), null);
  recenter(w.positions);
  return { name, positions: w.positions, indices: w.indices, transform: null };
}
const stats = { weldedVertices: 4, removedTriangles: 0, reversedShells: 0, filledHoles: 2, removedShells: 0, selfIntersections: 0 };
const res = (over: Partial<RepairMeshResult>): RepairMeshResult => ({ repaired: true, modified: true, error: null, triangles: 12, vertices: 8, stats, ...over });

beforeEach(() => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  S.resetProject();
});

describe('Fix model / Fix All', () => {
  it('repairs each model-part mesh once (instances share it), not modifiers', () => {
    const [a] = S.addParsedObjects([cube('A')]);
    const m = cube('mod', 5);
    S.addPart(a, 'modifier', 'Mod', m.positions, m.indices);
    const p = cube('part', 5);
    S.addPart(a, 'part', 'Part', p.positions, p.indices);
    const t = repairTargets(S.objects.value);
    expect(t).toHaveLength(2);
    expect(t.every((x) => x.objects[0] === 'A')).toBe(true);
  });

  it('commits the changed meshes in one undo step with their re-projected paint and drops them to the bed', async () => {
    const [a, b] = S.addParsedObjects([cube('A'), cube('B')]);
    const meshA = S.getObject(a)!.meshId, meshB = S.getObject(b)!.meshId;
    S.setMeshPaint(meshA, 'color', [[0, '8']]);
    S.setTransforms([{ id: a, position: [50, 50, 30] }], 'Lift', { drop: false });
    const lifted = S.getObject(a)!.position[2];
    const before = S.historyState.value.undo;
    const call = vi.fn<RepairCall>(async (mesh, args) => (args.paint
      ? { result: res({ paint: { color: [[0, '8'], [1, '8']] } }), mesh: { positions: mesh.positions.slice(), indices: mesh.indices.slice() } }
      : { result: res({ modified: false }), mesh }));
    const out = await repairObjects(S.objects.value, 'Fix all', call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][1]).toEqual({ paint: { color: [[0, '8']] }, keepPainting: true });
    expect(out.fixed.map((f) => f.objects)).toEqual([['A']]);
    expect(out.clean).toBe(1);
    const next = S.getObject(a)!.meshId;
    expect(next).not.toBe(meshA);
    expect(S.getObject(b)!.meshId).toBe(meshB);
    expect(S.getMeshPaint(next).color).toEqual([[0, '8'], [1, '8']]);
    expect(S.getObject(a)!.position[2]).toBeLessThan(lifted);
    expect(S.historyState.value.undo).toMatch(/Fix all/);
    S.undo();
    expect(S.getObject(a)!.meshId).toBe(meshA);
    expect(S.historyState.value.undo).toBe(before);
  });

  it('a mesh no solid can be built from stays as it was and is reported', async () => {
    const [a] = S.addParsedObjects([cube('A')]);
    const meshA = S.getObject(a)!.meshId;
    const out = await repairObjects(S.objects.value, 'Fix model', async (mesh) => ({ result: res({ repaired: false, error: 'not a solid' }), mesh }));
    expect(S.getObject(a)!.meshId).toBe(meshA);
    expect(out.failed).toEqual([{ objects: ['A'], error: 'not a solid' }]);
  });

  it('summarises what was fixed and what failed', () => {
    expect(repairSummary({ fixed: [{ meshId: 'm', objects: ['A'], stats }], failed: [], clean: 1 }))
      .toEqual({ kind: 'success', title: 'Repaired 1 object.', detail: 'Repaired: A (4 vertices welded, 2 holes filled).' });
    expect(repairSummary({ fixed: [], failed: [], clean: 2 }).title).toMatch(/No errors found/);
    const mixed = repairSummary({ fixed: [{ meshId: 'm', objects: ['A'], stats }], failed: [{ objects: ['B'], error: 'not a solid' }], clean: 0 });
    expect(mixed.kind).toBe('warn');
    expect(mixed.detail).toContain('Couldn’t repair B: not a solid');
  });
});

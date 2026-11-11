import { beforeEach, describe, expect, it } from 'vitest';
import * as S from '../store';
import { resolvedConfig } from '../../app/state';
import { recenter, weldVertices } from '../mesh';
import { cubeSoup } from '../testutil';

function cube() {
  const w = weldVertices(cubeSoup(20), null);
  recenter(w.positions);
  return { name: 'Cube', positions: w.positions, indices: w.indices, transform: null };
}

beforeEach(() => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  S.resetProject();
});

describe('precise seam parts (Orca 2.5)', () => {
  it('adds a seam as an inert modifier and changes its subtype immutably', () => {
    const [id] = S.addParsedObjects([cube()]);
    const small = weldVertices(cubeSoup(4), null);
    const pid = S.addPart(id, 'modifier', 'Seam', small.positions, small.indices, [0, 0, 0], 'precise_seam_center')!;
    const p0 = S.getObject(id)!.parts![0];
    expect(p0).toMatchObject({ id: pid, type: 'modifier', overrides: {}, preciseSeam: { type: 'precise_seam_center', config: {} } });
    const before = p0.preciseSeam;
    S.setPreciseSeamType(id, pid, 'precise_seam_blocked');
    const p1 = S.getObject(id)!.parts![0];
    expect(p1.preciseSeam?.type).toBe('precise_seam_blocked');
    expect(before?.type).toBe('precise_seam_center'); // the old value was replaced, not mutated
    // The generic "Precise Seam" entry keeps an existing subtype.
    S.setPreciseSeamType(id, pid, 'precise_seam_center', true);
    expect(S.getObject(id)!.parts![0].preciseSeam?.type).toBe('precise_seam_blocked');
    // Any other type ends the seam; undo brings it back.
    S.setPartType(id, pid, 'modifier');
    expect(S.getObject(id)!.parts![0].preciseSeam).toBeUndefined();
    S.undo();
    expect(S.getObject(id)!.parts![0].preciseSeam?.type).toBe('precise_seam_blocked');
  });
  it('turning a modifier into a seam drops its settings', () => {
    const [id] = S.addParsedObjects([cube()]);
    const small = weldVertices(cubeSoup(4), null);
    const pid = S.addPart(id, 'modifier', 'Mod', small.positions, small.indices)!;
    S.setPartOverride(id, pid, 'wall_loops', '5');
    S.setPreciseSeamType(id, pid, 'precise_seam_left', true);
    expect(S.getObject(id)!.parts![0]).toMatchObject({ type: 'modifier', overrides: {}, preciseSeam: { type: 'precise_seam_left' } });
  });
});

import { describe, expect, it } from 'vitest';
import { fixRowName, gridTiles, loadRows, modeData, nextTileRole, removedNames, suggestedModeNames } from './imexModes';

const idex = { cols: 2, rows: 1, layout: 0 };
const iqex = { cols: 2, rows: 2, layout: 0 };

describe('IMEXModesCtrl model', () => {
  it('loads Primary first (its saved row or T0 → Primary) and writes the three lists back', () => {
    const rows = loadRows(['copy', 'mirror'], ['0:P,1:C', '0:P,1:M'], ['SET_PRINT_MODE MODE=COPY', '']);
    expect(rows.map((r) => r.name)).toEqual(['primary', 'copy', 'mirror']);
    expect(modeData(rows)).toEqual({
      names: ['primary', 'copy', 'mirror'], tools: ['0:P', '0:P,1:C', '0:P,1:M'], gcodes: ['', 'SET_PRINT_MODE MODE=COPY', ''],
    });
    // A legacy bare index is the Primary.
    expect(modeData(loadRows(['copy'], ['0,1:C'], [''])).tools[1]).toBe('0:P,1:C');
  });
  it('tiles cycle Inactive → Copy → Mirror → Inactive on an IDEX (no Span with one gantry)', () => {
    const [, row] = loadRows(['copy'], ['0:P'], ['']);
    const seq: Array<string | null> = [];
    for (let i = 0; i < 3; i++) { const n = nextTileRole(row, 1, idex); seq.push(n); if (n) row.roles.set(1, n); else row.roles.delete(1); }
    expect(seq).toEqual(['C', 'M', null]);
  });
  it('Span only on the Primary’s gantry of a multi-gantry printer', () => {
    const [, row] = loadRows(['mc'], ['0:P'], ['']);
    row.roles.set(1, 'M');
    expect(nextTileRole(row, 1, iqex)).toBe('S'); // same gantry as T0
    row.roles.set(2, 'M');
    expect(nextTileRole(row, 2, iqex)).toBeNull(); // second gantry: Mirror → Inactive
  });
  it('lays the tiles out from T0’s corner, rear gantry on top', () => {
    expect(gridTiles(iqex)).toEqual([[2, 3], [0, 1]]);
    expect(gridTiles({ cols: 2, rows: 2, layout: 3 })).toEqual([[1, 0], [3, 2]]);
  });
  it('fixes empty, reserved and duplicate names on leaving the field', () => {
    const rows = loadRows(['copy', 'copy', 'Primary', ''], ['', '', '', ''], ['', '', '', '']);
    expect(rows[4].name).toBe('mode 2'); // an empty name arriving from a preset gets one at load
    expect(fixRowName(rows, 2)).toBe('copy 2'); // the row left with a taken name is renamed
    expect(fixRowName(rows, 3)).toBe('mode 3'); // "Primary" in any case is reserved
    expect(fixRowName(rows, 4)).toBeNull();
  });
  it('suggests the modes the grid can express that no row uses', () => {
    expect(suggestedModeNames(loadRows(['copy'], [''], ['']), idex)).toEqual(['mirror']);
    expect(suggestedModeNames(loadRows([], [], []), iqex)).toEqual(['copy', 'mirror', 'iq-copy', 'iq-mirror', 'mc-copy', 'mc-mirror']);
  });
  it('a removed row reports every name plates may hold for it', () => {
    const rows = loadRows(['copy', 'mirror'], ['', ''], ['', '']);
    rows[1].name = 'copy fast';
    expect(removedNames(rows, 1)).toEqual(['copy', 'copy fast']);
    rows[2].name = 'copy';
    expect(removedNames(rows, 1)).toEqual(['copy fast']); // "copy" still names the other row
  });
});

describe('IDEX/IQEX head filaments (resolve_filament_for_head, effective_physical_extruder_map)', () => {
  it('follows physical_extruder_map; a plate override must name a routable slot', async () => {
    const { effectivePhysicalExtruderMap, headLanes, imexHeadFilament } = await import('./imex');
    // Two heads; four filament lanes, two per head (an MMU on each carriage).
    const pem = effectivePhysicalExtruderMap({ nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'], physical_extruder_map: ['0', '0', '1', '1'] });
    expect(pem).toEqual([0, 0, 1, 1]);
    expect(headLanes(pem, 1)).toEqual([2, 3]);
    expect(imexHeadFilament(1, undefined, 4, pem)).toBe(3);
    expect(imexHeadFilament(1, { imex_head_filament_map: '1:4' }, 4, pem)).toBe(4);
    expect(imexHeadFilament(1, { imex_head_filament_map: '1:9' }, 4, pem)).toBe(3); // out of range: as if absent
    // A map that doesn't match the nozzle count: identity.
    expect(effectivePhysicalExtruderMap({ nozzle_diameter: ['0.4', '0.4'], physical_extruder_map: ['0'] })).toEqual([0, 1]);
  });
});

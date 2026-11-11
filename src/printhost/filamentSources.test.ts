/**
 * The Orca 2.5 filament sources that have no hardware here: Happy Hare's `mmu` object and a
 * Creality Hi's `box` object (MoonrakerPrinterAgent), the Qidi Box (QidiPrinterAgent), and the
 * Creality K-series CFS mapping at print start (CrealityPrint + its send dialog). The replies are
 * shaped after what Orca's own parsing code reads; none of this was run against a printer.
 */
import { describe, expect, it } from 'vitest';
import { matchLane, parseCrealityBox, parseHappyHare, parseQidiDict, parseQidiSlots, qidiSeriesId, qidiSlotItems, qidiType, QIDI_SLOT_QUERY, type FilamentCandidate } from './filamentSync';
import { crealityGcodeDir, crealityMultiColour, crealityStartCommands, defaultCfsMapping, parseCfsSlots } from './hosts/creality';

describe('Happy Hare mmu object (fetch_hh_filament_info)', () => {
  const reply = (mmu: unknown) => ({ result: { status: { mmu } } });
  it('takes gates with status > 0 and a material, keeping the gate index', () => {
    const lanes = parseHappyHare(reply({
      num_gates: 4, gate_status: [1, 0, 2, -1], gate_material: ['PLA', 'PETG', 'ABS', 'TPU'],
      gate_color: ['ff0000', '00ff00', '#0000FF', 'ffffff'], gate_temperature: [210, 240, 250, 220],
    }));
    expect(lanes.map((l) => [l.index, l.material, l.colour, l.nozzleTemp])).toEqual([[0, 'PLA', '#FF0000', 210], [2, 'ABS', '#0000FF', 250]]);
  });
  it('is nothing without Happy Hare (empty mmu, no num_gates, non-array fields)', () => {
    expect(parseHappyHare(reply({}))).toEqual([]);
    expect(parseHappyHare(reply({ gate_status: [1] }))).toEqual([]);
    expect(parseHappyHare(reply({ num_gates: 1, gate_status: 1, gate_material: [], gate_color: [], gate_temperature: [] }))).toEqual([]);
    expect(parseHappyHare({ result: { status: {} } })).toEqual([]);
    expect(parseHappyHare(null)).toEqual([]);
  });
});

describe('Creality CFS on Moonraker: the box object (parse_creality_cfs_response)', () => {
  it('reads connected boxes T1…T4, maps material ids, strips the leading 0 of colours', () => {
    const lanes = parseCrealityBox({ result: { status: { box: {
      T1: { state: 'connect', material_type: ['000001', '', '005001', '000009'], color_value: ['0FF0000', '000000', '000FF00', '0123456'] },
      T2: { state: 'disconnect', material_type: ['000001'], color_value: ['0FFFFFF'] },
      T3: { state: 'connect', material_type: ['999999', '000004'], color_value: ['0000000', '0FFFFFF'] },
      same_material: [['005001', '00FF00', [2], 'PLA'], ['bad']],
    } } } });
    expect(lanes.map((l) => [l.index, l.material, l.colour])).toEqual([[0, 'PLA', '#FF0000'], [2, 'PLA', '#00FF00'], [3, 'PETG-CF', '#123456'], [9, 'TPU', '#FFFFFF']]);
    expect(parseCrealityBox({ result: { status: {} } })).toEqual([]);
  });
});

describe('Qidi Box (QidiPrinterAgent)', () => {
  const dict = parseQidiDict('[colordict]\n1 = #FFFFFF\n2=#FF0000\n; comment\n[fila1]\nfilament = PLA Rapido\n[fila11]\nfilament=ABS-GF\n[other]\nfilament = x\n');
  it('reads the colour dictionary and the [filaN] names', () => {
    expect([...dict.colors]).toEqual([[1, '#FFFFFF'], [2, '#FF0000']]);
    expect([...dict.filaments]).toEqual([[1, 'PLA Rapido'], [11, 'ABS-GF']]);
  });
  it('infers the series id and normalises types as Orca', () => {
    expect(['Qidi Q2', 'QIDI X-Max 4', 'X-Plus4', '7', 'Plus3', ''].map(qidiSeriesId)).toEqual(['1', '3', '0', '7', '', '']);
    expect(['pla rapido', 'ABS-GF', 'Nylon', 'PC-ABS', 'HIPS'].map(qidiType)).toEqual(['PLA', 'ABS', 'PA', 'ABS', 'HIPS']);
  });
  it('queries the save_variables, the controller names and 16 runout sensors', () => {
    expect(QIDI_SLOT_QUERY).toMatch(/^printer\/objects\/query\?save_variables=variables&multi_color_controller=box&box_stepper%20slot0=runout_button/);
    expect(QIDI_SLOT_QUERY.match(/box_stepper%20slot\d+=runout_button/g)).toHaveLength(16);
  });
  it('builds box_count × 4 slots: loaded by runout sensor, type from the dictionary or newer firmware, setting id QD_<series>_<vendor>_<n>', () => {
    const json = { result: { status: {
      save_variables: { variables: { box_count: 1, color_slot0: 2, filament_slot0: 11, vendor_slot0: 1, color_slot1: ['00FF00FF'], filament_slot1: 'x', filament_slot2: 1 } },
      multi_color_controller: { box: { box0_filament_info_1_filament_type: 'PETG Basic' } },
      'box_stepper slot0': { runout_button: 0 }, 'box_stepper slot1': { runout_button: 0 }, 'box_stepper slot2': { runout_button: 1 }, 'box_stepper slot3': { runout_button: null },
    } } };
    const r = parseQidiSlots(json, dict, '1')!;
    expect(r.boxCount).toBe(1);
    expect(r.slots.map((s) => [s.index, s.loaded, s.material, s.colour, s.settingId])).toEqual([
      [0, true, 'ABS', '#FF0000', 'QD_1_1_11'], [1, true, 'PETG', '#00FF00', 'QD_1_0_41'], [2, false, '', '', ''], [3, false, '', '', ''],
    ]);
    // Without a numeric series the type's default Qidi id; an unknown type none.
    expect(parseQidiSlots(json, dict, '')!.slots[0].settingId).toBe('QD_1_0_11');
    expect(parseQidiSlots({ result: { status: {} } }, dict, '1')).toBeNull();
    expect(qidiSlotItems(r).map((x) => x.label)).toEqual(['Box 1 · slot 1 — ABS #FF0000', 'Box 1 · slot 2 — PETG #00FF00', 'Box 1 · slot 3 — empty', 'Box 1 · slot 4 — empty']);
    expect(qidiSlotItems(null)).toHaveLength(16);
  });
  it('a slot’s setting id picks the preset with that filament_id, else the type', () => {
    const c: FilamentCandidate[] = [{ id: 'g', name: 'Generic ABS @System', filamentType: 'ABS', system: true }, { id: 'q', name: 'QIDI ABS-GF', filamentType: 'ABS', system: true, filamentId: 'QD_1_1_11' }];
    expect(matchLane({ index: 0, colour: '', material: 'ABS', filamentId: 'QD_1_1_11', nozzleTemp: 0, bedTemp: 0 }, c)?.id).toBe('q');
    expect(matchLane({ index: 0, colour: '', material: 'ABS', filamentId: 'QD_9_0_1', nozzleTemp: 0, bedTemp: 0 }, c)?.id).toBe('g');
  });
});

describe('Creality K-series CFS mapping (CrealityPrint, its send dialog)', () => {
  const reply = { boxsInfo: { materialBoxs: [
    { id: 0, type: 1, state: 0, materials: [{ id: 0, type: 'PLA', color: '#0FFFFFF' }] },
    { id: 1, type: 0, state: 1, materials: [{ id: 0, type: 'PLA', color: '#0FF0000' }, { id: 1, type: 'PETG', color: '#000FF00' }] },
    { id: 2, type: 0, state: 0, materials: [{ id: 0, type: 'ABS', color: '#0000000' }] },
  ] } };
  const slots = parseCfsSlots(reply);
  it('lists active CFS slots and the spool holder', () => {
    expect(slots.map((s) => [s.toolId, s.type, s.colour, s.boxId, s.materialId])).toEqual([['T0A', 'PLA', '#FFFFFF', 0, 0], ['T1A', 'PLA', '#FF0000', 1, 0], ['T1B', 'PETG', '#00FF00', 1, 1]]);
  });
  it('defaults: CFS type + colour, CFS type, spool holder, else by position', () => {
    expect(defaultCfsMapping([{ type: 'PLA', colour: '#ff0000' }, { type: 'PLA', colour: '#123456' }, { type: 'PETG', colour: '#00FF00' }, { type: 'TPU', colour: '#000000' }], slots)).toEqual([1, 1, 2, 0]);
  });
  it('a CFS mapping sends colorMatch (ids by G-code tool) then multiColorPrint; the spool holder or no mapping a plain start', () => {
    const path = `${crealityGcodeDir('F008')}/a.gcode`;
    expect(path).toBe('/mnt/UDISK/printer_data/gcodes/a.gcode');
    expect(crealityGcodeDir('K1C_CFS-C')).toBe('/usr/data/printer_data/gcodes');
    expect(crealityStartCommands(true, path, { mapping: [slots[2], slots[1]], selfTest: true })).toEqual([
      { method: 'set', params: { colorMatch: { path, list: [{ id: 'T1A', type: 'PETG', color: '#00FF00', boxId: 1, materialId: 1 }, { id: 'T1B', type: 'PLA', color: '#FF0000', boxId: 1, materialId: 0 }] } } },
      { method: 'set', params: { multiColorPrint: { gcode: path, enableSelfTest: 1 } } },
    ]);
    expect(crealityStartCommands(true, path, { mapping: [slots[1], slots[0]], selfTest: false })).toEqual([{ method: 'set', params: { opGcodeFile: `printprt:${path}`, enableSelfTest: 0 } }]);
    expect(crealityStartCommands(true, path, { mapping: [], selfTest: false })).toEqual([{ method: 'set', params: { opGcodeFile: `printprt:${path}`, enableSelfTest: 0 } }]);
    expect(crealityStartCommands(false, path)).toEqual([{ method: 'set', params: { opGcodeFile: `printprt:${path}` } }]);
    expect([crealityMultiColour('F016'), crealityMultiColour('K1 Max'), crealityMultiColour('CR-10'), crealityMultiColour(undefined)]).toEqual([true, true, false, false]);
  });
});

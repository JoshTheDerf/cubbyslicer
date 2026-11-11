import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConfigValue } from '../../engine/types';
import { AUTO_CHECKS, bedExcludeVolumeOffer, inputShaperTypes, isBedExclusionVolumeSyntax, materialRange, MSG, PA_MSG, runAutoChanges, runPresetChecks, validateAdaptivePaModel, type Answer, type AutoContext, type Prompt } from './autoChanges';
import type { RuleFamily } from './types';

function ctx(family: RuleFamily, values: Record<string, ConfigValue>, o: Partial<AutoContext> & { printerValues?: Record<string, ConfigValue> } = {}): AutoContext {
  const { printerValues = {}, ...rest } = o;
  return {
    family, get: (k) => values[k], printer: (k) => printerValues[k], isGlobal: true, isBBL: false, mode: 2, variantIndex: 0,
    filamentCount: 2, isMixedSlot: () => false, filament: (i) => (i >= 0 && i < 2 ? { type: 'PLA', isSupport: false, soluble: false } : null),
    modelFilamentTypes: ['PLA'], platerValue: () => 0, hasVariableLayerHeight: false, appFlag: () => false, memo: {}, ...rest,
  };
}
/** Answers in order; records the prompts. */
function answers(...list: Answer[]) {
  const asked: Prompt[] = [];
  return { asked, ask: async (p: Prompt) => { asked.push(p); return p.buttons === 'ok' ? 'ok' : list.shift() ?? p.dismiss; } };
}
const SPIRAL_OK = { wall_loops: '1', top_shell_layers: '0', sparse_infill_density: '0%', enable_support: '0', enforce_support_layers: '0', detect_thin_wall: '0',
  overhang_reverse: '0', timelapse_type: '0', enable_wrapping_detection: '0' };

describe('process: update_print_fff_config', () => {
  it('spiral vase: Yes conforms the settings, No turns spiral mode off; per-object settings get an OK message', async () => {
    const base = { ...SPIRAL_OK, spiral_mode: '1', wall_loops: '3', sparse_infill_density: '15%', layer_height: '0.2' };
    let a = answers('yes');
    expect(await runAutoChanges(ctx('print', base), { key: 'spiral_mode', value: '1' }, a.ask)).toMatchObject(SPIRAL_OK);
    expect(a.asked[0].message).toBe(`${MSG.spiral}\n\n${MSG.spiralAsk}`);
    expect(a.asked[0].buttons).toBe('yesno');
    a = answers('no');
    expect(await runAutoChanges(ctx('print', base), { key: 'spiral_mode', value: '1' }, a.ask)).toEqual({ spiral_mode: '0' });
    a = answers();
    expect(await runAutoChanges(ctx('print', base, { isGlobal: false }), { key: 'spiral_mode', value: '1' }, a.ask)).toMatchObject(SPIRAL_OK);
    expect(a.asked[0]).toMatchObject({ buttons: 'ok', message: MSG.spiral });
    // i3 printers: the timelapse note.
    a = answers('no');
    await runAutoChanges(ctx('print', base, { printerValues: { printer_structure: 'i3' } }), { key: 'wall_loops', value: '3' }, a.ask);
    expect(a.asked[0].message).toContain(MSG.spiralI3);
    // Already conforming: nothing.
    a = answers();
    expect(await runAutoChanges(ctx('print', { ...SPIRAL_OK, spiral_mode: '1', layer_height: '0.2' }), { key: 'spiral_mode', value: '1' }, a.ask)).toEqual({});
    expect(a.asked).toHaveLength(0);
  });

  it('resets invalid values with a message', async () => {
    const a = answers();
    const w = await runAutoChanges(ctx('print', {
      layer_height: '0', ironing_spacing: '0.01', initial_layer_print_height: '0', xy_hole_compensation: '3', elefant_foot_compensation: '1.5',
      seam_slope_type: 'all', seam_slope_start_height: '50%', infill_lock_depth: '3', skin_infill_depth: '2',
    }), { key: 'layer_height', value: '0' }, a.ask);
    expect(w).toMatchObject({ layer_height: '0.2', ironing_spacing: '0.1', initial_layer_print_height: '0.2', xy_hole_compensation: '0', elefant_foot_compensation: '0', infill_lock_depth: '1' });
    // seam slope 50 % of the (reset) 0.2 layer = 0.1 < 0.2: kept.
    expect(w.seam_slope_start_height).toBeUndefined();
    expect(a.asked.map((p) => p.message)).toEqual([MSG.layerHeight, MSG.ironingSpacing, MSG.firstLayer, MSG.xyCompensation, MSG.elephantFoot, MSG.lockDepth]);
    const b = answers();
    expect(await runAutoChanges(ctx('print', { layer_height: '0.2', seam_slope_type: 'external', seam_slope_start_height: '0.3' }), { key: 'x', value: '' }, b.ask))
      .toEqual({ seam_slope_start_height: '0' });
  });

  it('belt printers drop raft and draft shield', async () => {
    const a = answers();
    expect(await runAutoChanges(ctx('print', { layer_height: '0.2', raft_layers: '2', draft_shield: 'enabled' }, { printerValues: { belt_printer: '1' } }), { key: 'raft_layers', value: '2' }, a.ask))
      .toEqual({ raft_layers: '0', draft_shield: 'disabled' });
    expect(a.asked[0].message).toBe(MSG.belt);
  });

  it('alternate extra wall vs. ensure vertical shell thickness All', async () => {
    const v = { layer_height: '0.2', alternate_extra_wall: '1', ensure_vertical_shell_thickness: 'ensure_all' };
    expect(await runAutoChanges(ctx('print', v), { key: 'alternate_extra_wall', value: '1' }, answers('yes').ask))
      .toEqual({ ensure_vertical_shell_thickness: 'ensure_moderate', alternate_extra_wall: '1' });
    expect(await runAutoChanges(ctx('print', v), { key: 'alternate_extra_wall', value: '1' }, answers('no').ask))
      .toEqual({ ensure_vertical_shell_thickness: 'ensure_all', alternate_extra_wall: '0' });
  });

  it('fuzzy skin Extrusion / Combined needs Arachne', async () => {
    const v = { layer_height: '0.2', fuzzy_skin_mode: 'extrusion', wall_generator: 'classic' };
    expect(await runAutoChanges(ctx('print', v), { key: 'wall_generator', value: 'classic' }, answers('yes').ask)).toEqual({ wall_generator: 'arachne' });
    expect(await runAutoChanges(ctx('print', v), { key: 'wall_generator', value: 'classic' }, answers('no').ask)).toEqual({ fuzzy_skin_mode: 'displacement' });
  });

  it('silent fixes: support style, BBL cone tower, overhang detection once, filament ids, reverse-internal threshold', async () => {
    const memo = {};
    const v = { layer_height: '0.2', enable_support: '1', support_type: 'tree(auto)', support_style: 'grid', detect_overhang_wall: '0',
      enable_prime_tower: '1', wipe_tower_wall_type: 'cone', support_filament: '5', wipe_tower_filament: '2', outer_wall_filament_id: '2',
      overhang_reverse_internal_only: '1', overhang_reverse_threshold: '50%' };
    const w = await runAutoChanges(ctx('print', v, { isBBL: true, memo, isMixedSlot: (n) => n === 2, platerValue: () => 1 }), { key: 'enable_support', value: '1' }, answers().ask);
    expect(w).toEqual({ support_style: 'default', wipe_tower_wall_type: 'rectangle', detect_overhang_wall: '1', support_filament: '1', wipe_tower_filament: '0', overhang_reverse_threshold: '0%' });
    // Asked once while support stays on.
    expect((await runAutoChanges(ctx('print', v, { memo }), { key: 'x', value: '' }, answers().ask)).detect_overhang_wall).toBeUndefined();
  });

  it('mixed sublayers with variable layer height: once per enabling, with "don\'t show again"', async () => {
    const memo = {};
    const c = ctx('print', { layer_height: '0.2', enable_mixed_color_sublayer: '1' }, { memo, hasVariableLayerHeight: true });
    const a = answers();
    await runAutoChanges(c, { key: 'enable_mixed_color_sublayer', value: '1' }, a.ask);
    await runAutoChanges(c, { key: 'enable_mixed_color_sublayer', value: '1' }, a.ask);
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0]).toMatchObject({ message: MSG.mixedSublayer, dontShowKey: 'no_warn_mixed_sublayer_variable_layer' });
  });
});

describe('process: Tab::on_value_change', () => {
  it('prime tower off with smooth timelapse: No keeps it on', async () => {
    const v = { layer_height: '0.2', enable_prime_tower: '0', timelapse_type: '1' };
    const a = answers('no');
    expect(await runAutoChanges(ctx('print', v), { key: 'enable_prime_tower', value: '0' }, a.ask)).toEqual({ enable_prime_tower: '1' });
    expect(a.asked.map((p) => [p.title, p.message])).toEqual([['Warning', MSG.towerTimelapseOff]]);
    // Yes: off; then clumping detection is asked next.
    const b = answers('yes', 'no');
    expect(await runAutoChanges(ctx('print', { ...v, enable_wrapping_detection: '1' }, { isBBL: true }), { key: 'enable_prime_tower', value: '0' }, b.ask)).toEqual({ enable_prime_tower: '1' });
    expect(b.asked.map((p) => p.message)).toEqual([MSG.towerTimelapseOff, MSG.towerClumpingOff]);
  });

  it('prime tower off: a No to the nozzle ask keeps it on and the timelapse ask still follows (desktop repeats)', async () => {
    const rack = { isBBL: true, printerValues: { extruder_max_nozzle_count: ['1', '6'] } };
    const v = { layer_height: '0.2', enable_prime_tower: '0', timelapse_type: '1', enable_wrapping_detection: '1' };
    // No, then Yes to timelapse: clumping is still asked (only a No to the timelapse ask skips it).
    let a = answers('no', 'yes', 'yes');
    expect(await runAutoChanges(ctx('print', v, rack), { key: 'enable_prime_tower', value: '0' }, a.ask)).toEqual({ enable_prime_tower: '1' });
    expect(a.asked.map((p) => p.message)).toEqual([MSG.towerNozzles, MSG.towerTimelapseOff, MSG.towerClumpingOff]);
    // A No to the timelapse ask: no clumping ask.
    a = answers('yes', 'no');
    expect(await runAutoChanges(ctx('print', v, rack), { key: 'enable_prime_tower', value: '0' }, a.ask)).toEqual({ enable_prime_tower: '1' });
    expect(a.asked.map((p) => p.message)).toEqual([MSG.towerNozzles, MSG.towerTimelapseOff]);
    // Every Yes: off, three asks.
    a = answers('yes', 'yes', 'yes');
    expect(await runAutoChanges(ctx('print', v, rack), { key: 'enable_prime_tower', value: '0' }, a.ask)).toEqual({});
    expect(a.asked).toHaveLength(3);
  });

  it('prime tower off on a nozzle-rack printer asks first', async () => {
    const a = answers('yes');
    await runAutoChanges(ctx('print', { layer_height: '0.2', enable_prime_tower: '0' }, { printerValues: { extruder_max_nozzle_count: ['1', '6'] } }), { key: 'enable_prime_tower', value: '0' }, a.ask);
    expect(a.asked[0].message).toBe(MSG.towerNozzles);
  });

  it('prime tower on with precise Z height', async () => {
    const a = answers('no');
    expect(await runAutoChanges(ctx('print', { layer_height: '0.2', enable_prime_tower: '1', precise_z_height: '1' }), { key: 'enable_prime_tower', value: '1' }, a.ask)).toEqual({ enable_prime_tower: '0' });
    expect(a.asked).toHaveLength(1);
  });

  it('smooth timelapse: "No sparse layers" off (OK), then asks to enable the tower', async () => {
    const a = answers('yes');
    const w = await runAutoChanges(ctx('print', { layer_height: '0.2', timelapse_type: '1', wipe_tower_no_sparse_layers: '1', enable_prime_tower: '0' }), { key: 'timelapse_type', value: '1' }, a.ask);
    expect(w).toEqual({ wipe_tower_no_sparse_layers: '0', enable_prime_tower: '1' });
    expect(a.asked.map((p) => p.message)).toEqual([MSG.smoothNoSparse, MSG.smoothTower]);
    const b = answers();
    expect(await runAutoChanges(ctx('print', { layer_height: '0.2', timelapse_type: '1', wipe_tower_no_sparse_layers: '1', enable_prime_tower: '1' }), { key: 'wipe_tower_no_sparse_layers', value: '1' }, b.ask))
      .toEqual({ timelapse_type: '0' });
  });

  it('layer height limits: Adjust / Ignore', async () => {
    const printerValues = { min_layer_height: ['0.08', '0.07'], max_layer_height: ['0.28', '0.3'] };
    const a = answers('yes');
    expect(await runAutoChanges(ctx('print', { layer_height: '0.4' }, { printerValues }), { key: 'layer_height', value: '0.4' }, a.ask)).toEqual({ layer_height: '0.3' });
    expect(a.asked[0]).toMatchObject({ yesLabel: 'Adjust', noLabel: 'Ignore', message: `${MSG.layerOutOfRange}\n\n${MSG.layerAdjust(0.3)}` });
    expect(MSG.layerAdjust(0.3)).toBe('Adjust it to the limit (0.3 mm) automatically?');
    expect(await runAutoChanges(ctx('print', { layer_height: '0.05' }, { printerValues }), { key: 'layer_height', value: '0.05' }, answers('no').ask)).toEqual({});
  });

  it('support filaments: non-soluble base, interface suggestion', async () => {
    const filament = (i: number) => (i === 1 ? { type: 'PLA-S', isSupport: true, soluble: false } : i === 0 ? { type: 'PLA', isSupport: false, soluble: false } : null);
    const a = answers('no');
    expect(await runAutoChanges(ctx('print', { layer_height: '0.2', support_filament: '2' }, { filament }), { key: 'support_filament', value: '2' }, a.ask)).toEqual({ support_filament: '0' });
    expect(a.asked[0].message).toBe(MSG.supportBase);
    const b = answers('yes');
    expect(await runAutoChanges(ctx('print', { layer_height: '0.2', support_filament: '0', support_interface_filament: '2', support_top_z_distance: '0.2' }, { filament }),
      { key: 'support_interface_filament', value: '2' }, b.ask))
      .toEqual({ support_top_z_distance: '0', support_interface_spacing: '0', support_interface_pattern: 'rectilinear_interlaced', independent_support_layer_height: '0' });
    expect(b.asked[0]).toMatchObject({ title: 'Suggestion', message: `${MSG.interfaceSupport}\n\n${MSG.interfaceAsk}` });
  });

  it('make overhang printable and the rotate template ask with Enable / Cancel', async () => {
    const a = answers('no');
    expect(await runAutoChanges(ctx('print', { layer_height: '0.2', make_overhang_printable: '1' }), { key: 'make_overhang_printable', value: '1' }, a.ask)).toEqual({ make_overhang_printable: '0' });
    expect(a.asked[0]).toMatchObject({ yesLabel: 'Enable', noLabel: 'Cancel' });
    const memo = {};
    const b = answers('yes', 'yes');
    await runAutoChanges(ctx('print', { layer_height: '0.2', sparse_infill_pattern: 'gyroid', sparse_infill_rotate_template: '0,90' }, { memo }), { key: 'sparse_infill_rotate_template', value: '0,90' }, b.ask);
    // Changing it again while one is set: no second ask.
    await runAutoChanges(ctx('print', { layer_height: '0.2', sparse_infill_pattern: 'gyroid', sparse_infill_rotate_template: '0,45' }, { memo }), { key: 'sparse_infill_rotate_template', value: '0,45' }, b.ask);
    expect(b.asked).toHaveLength(1);
  });

  it('on-change checks are for the global settings only', async () => {
    expect(await runAutoChanges(ctx('print', { layer_height: '0.2', make_overhang_printable: '1' }, { isGlobal: false }), { key: 'make_overhang_printable', value: '1' }, answers('no').ask)).toEqual({});
  });
});

describe('filament and printer', () => {
  it('recommended temperature range (MaterialType table)', async () => {
    expect(materialRange('PLA', 'nozzle')).toEqual([180, 240, true]);
    expect(materialRange('Nope', 'chamber')).toEqual([0, 100, false]);
    const a = answers();
    await runAutoChanges(ctx('filament', { filament_type: ['PLA'], nozzle_temperature_range_low: ['170'], nozzle_temperature_range_high: ['250'] }), { key: 'nozzle_temperature_range_low', value: ['170'] }, a.ask);
    expect(a.asked[0].message).toBe('A minimum temperature above 180℃ is recommended for PLA.\nA maximum temperature below 240℃ is recommended for PLA.\nPlease check.\n');
    const b = answers();
    await runAutoChanges(ctx('filament', { filament_type: ['PLA'], nozzle_temperature_range_low: ['190'], nozzle_temperature_range_high: ['230'], nozzle_temperature: ['250'] }), { key: 'nozzle_temperature', value: ['250'] }, b.ask);
    expect(b.asked[0].message).toBe(`${MSG.nozzleRange}The recommended nozzle temperature for this filament type is [190, 230] degrees Celsius.`);
  });

  it('filament resets: max volumetric speed, ironing spacing, first layer fan, chamber minimal', async () => {
    const w = await runAutoChanges(ctx('filament', {
      filament_max_volumetric_speed: ['0.2'], filament_ironing_spacing: ['nil', '0.01'], close_fan_the_first_x_layers: ['1'], initial_layer_fan_speed: ['30', '40'],
      chamber_temperature: ['40'], chamber_minimal_temperature: ['50'],
    }), { key: 'chamber_minimal_temperature', value: ['50'] }, answers().ask);
    expect(w).toEqual({ filament_max_volumetric_speed: ['0.5'], filament_ironing_spacing: ['nil', '0.1'], initial_layer_fan_speed: ['-1', '-1'], chamber_minimal_temperature: ['40'] });
  });

  it('firmware retraction asks to set retract before wipe to 100 %', async () => {
    const v = { use_firmware_retraction: '1', wipe: ['1', '1'], retract_before_wipe: ['70%', '70%'], gcode_flavor: 'klipper', input_shaping_type: 'Default' };
    const a = answers('yes');
    expect(await runAutoChanges(ctx('printer', v), { key: 'use_firmware_retraction', value: '1' }, a.ask)).toEqual({ wipe: ['0', '0'], retract_before_wipe: ['100%', '100%'] });
    expect(a.asked[0]).toMatchObject({ title: 'Firmware Retraction', message: MSG.firmwareRetraction });
    expect(await runAutoChanges(ctx('printer', v), { key: 'use_firmware_retraction', value: '1' }, answers('no').ask)).toEqual({ use_firmware_retraction: '0' });
  });

  it('printer silent fixes: input shaper per firmware, manual filament change, SEMM purge', async () => {
    expect(inputShaperTypes('marlin2')[0]).toBe('ZV');
    expect(await runAutoChanges(ctx('printer', { gcode_flavor: 'marlin2', input_shaping_type: 'MZV', single_extruder_multi_material: '0', manual_filament_change: '1', purge_in_prime_tower: '1' }),
      { key: 'single_extruder_multi_material', value: '0' }, answers().ask))
      .toEqual({ manual_filament_change: '0', purge_in_prime_tower: '0', input_shaping_type: 'ZV' });
  });

  it('single extruder multi-material: one nozzle diameter for every extruder (not on BBL)', async () => {
    const v = { single_extruder_multi_material: '1', nozzle_diameter: ['0.4', '0.6'] };
    let a = answers('yes');
    expect(await runAutoChanges(ctx('printer', v, { variantIndex: 1 }), { key: 'nozzle_diameter', value: ['0.4', '0.6'] }, a.ask)).toEqual({ nozzle_diameter: ['0.6', '0.6'] });
    expect(a.asked[0]).toMatchObject({ title: MSG.semmNozzleTitle, message: MSG.semmNozzle, buttons: 'yesno' });
    a = answers('no');
    expect(await runAutoChanges(ctx('printer', v, { variantIndex: 1 }), { key: 'nozzle_diameter', value: ['0.4', '0.6'] }, a.ask)).toEqual({ nozzle_diameter: ['0.4', '0.4'] });
    a = answers();
    await runAutoChanges(ctx('printer', v, { variantIndex: 1, isBBL: true }), { key: 'nozzle_diameter', value: ['0.4', '0.6'] }, a.ask);
    await runAutoChanges(ctx('printer', { ...v, single_extruder_multi_material: '0' }, { variantIndex: 1 }), { key: 'nozzle_diameter', value: ['0.4', '0.6'] }, a.ask);
    expect(a.asked).toHaveLength(0);
  });

  it('adaptive PA model validation (AdaptivePAProcessor::validate_adaptive_pa_model)', async () => {
    expect(validateAdaptivePaModel('')).toBe('');
    expect(validateAdaptivePaModel('0.02, 1, 1000\n0.03,2,3000\n\n')).toBe('');
    expect(validateAdaptivePaModel('0.02,1,1000\n0.0a,1,1000')).toBe('Line 2: only numbers, commas and dots are allowed');
    expect(validateAdaptivePaModel('0.02,1')).toBe(PA_MSG.count.replace('%1%', '1'));
    expect(validateAdaptivePaModel('2,3,4')).toBe('Line 1: PA value must be less than 2');
    expect(validateAdaptivePaModel('0.5,0.4,4')).toBe('Line 1: flow value must be greater than PA value');
    expect(validateAdaptivePaModel('0.5,4,4')).toBe('Line 1: acceleration value must be greater than flow value');
    expect(validateAdaptivePaModel('.,1,2')).toBe('Line 1: invalid numeric value');
    expect(validateAdaptivePaModel('0.1,,2')).toBe('Line 1: invalid numeric value');
    // Only the edited variant's model.
    const a = answers();
    await runAutoChanges(ctx('filament', { adaptive_pressure_advance_model: ['0.02,1,1000', 'x'] }, { variantIndex: 1 }), { key: 'adaptive_pressure_advance_model', value: '' }, a.ask);
    expect(a.asked.map((p) => p.message)).toEqual([`${MSG.adaptivePa}Line 1: only numbers, commas and dots are allowed`]);
    const b = answers();
    await runAutoChanges(ctx('filament', { adaptive_pressure_advance_model: ['0.02,1,1000', 'x'] }), { key: 'adaptive_pressure_advance_model', value: '' }, b.ask);
    expect(b.asked).toHaveLength(0);
  });

  it('collision-volume text in the excluded bed area', () => {
    expect(isBedExclusionVolumeSyntax('0x0,10x0,10x10')).toBe(false);
    expect(isBedExclusionVolumeSyntax('0..5;0x0,10x0,10x10')).toBe(true);
    expect(isBedExclusionVolumeSyntax('0x0,1x0,1x1|2x2,3x2,3x3')).toBe(true);
    const invalid = bedExcludeVolumeOffer('x', false, () => undefined);
    expect('prompt' in invalid && invalid.prompt).toMatchObject({ message: MSG.bedVolumeInvalid, buttons: 'ok', writes: {} });
    const shared = bedExcludeVolumeOffer('0..5;0x0,10x0,10x10', true, (k) => ({ bed_exclude_volumes: 'A' } as Record<string, ConfigValue>)[k]);
    expect('prompt' in shared && shared.prompt).toMatchObject({ title: MSG.bedVolumeTitle, message: MSG.bedVolumeAsk, writes: { yes: { bed_exclude_volumes: 'A|0..5;0x0,10x0,10x10' } } });
    const per = bedExcludeVolumeOffer('D', true, (k) => ({ bed_exclude_volume_mode: 'per_extruder', extruder_bed_exclude_volumes: ['A'], nozzle_diameter: ['0.4', '0.4'] } as Record<string, ConfigValue>)[k]);
    expect('prompt' in per && per.prompt.writes.yes).toEqual({ extruder_bed_exclude_volumes: ['A|D', 'D'] });
  });

  it('preset selection runs the update checks only, and seeds the overhang flag from a saved user preset', async () => {
    // On-change handlers (layer height limits, prime tower) don't run; update_print_fff_config does.
    const a = answers();
    expect(await runPresetChecks(ctx('print', { layer_height: '0', enable_prime_tower: '0', timelapse_type: '1' }), a.ask)).toEqual({ layer_height: '0.2' });
    expect(a.asked.map((p) => p.message)).toEqual([MSG.layerHeight]);
    const sup = { layer_height: '0.2', enable_support: '1', detect_overhang_wall: '0', support_style: 'default', support_type: 'normal(auto)' };
    expect(await runPresetChecks(ctx('print', sup), answers().ask)).toEqual({ detect_overhang_wall: '1' });
    expect(await runPresetChecks(ctx('print', sup, { userSavedPreset: true }), answers().ask)).toEqual({});
    // Filament: max volumetric speed reset, not the temperature on-change checks.
    expect(await runPresetChecks(ctx('filament', { filament_max_volumetric_speed: ['0.1'], nozzle_temperature: ['500'], nozzle_temperature_range_low: ['190'], nozzle_temperature_range_high: ['230'] }), answers().ask))
      .toEqual({ filament_max_volumetric_speed: ['0.5'] });
  });

  it('every check id is unique', () => {
    const ids = Object.values(AUTO_CHECKS).flat().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/** The messages are Orca's own: each static one appears in the 2.5.0 sources (joined string literals, unescaped). */
const ORCA_GIT = '/server/thederf/slicers/orcaslicer-wasm/orca';
describe.skipIf(!existsSync(ORCA_GIT))('messages match the Orca 2.5.0 source', () => {
  const read = (p: string) => { try { return execFileSync('git', ['-C', ORCA_GIT, 'show', `v2.5.0:${p}`], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return ''; } };
  const src = ['src/slic3r/GUI/ConfigManipulation.cpp', 'src/slic3r/GUI/Tab.cpp', 'src/libslic3r/GCode/AdaptivePAProcessor.cpp'].map(read).join('\n');
  // Adjacent literals joined ("a" "b" → "ab"), escapes resolved.
  const literals: string[] = [];
  const re = /"((?:[^"\\\n]|\\.)*)"(?:\s*"((?:[^"\\\n]|\\.)*)")*/g;
  for (const m of src.matchAll(re)) {
    const parts = [...m[0].matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((x) => x[1]);
    literals.push(parts.join('').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\?/g, '?').replace(/\\u2103/g, '℃'));
  }
  const all = literals.join('\u0000');
  it.skipIf(!src)('static messages', () => {
    for (const [k, v] of [...Object.entries(MSG), ...Object.entries(PA_MSG)]) {
      if (typeof v !== 'string') continue;
      expect(all.includes(v), `${k}: ${JSON.stringify(v)}`).toBe(true);
    }
  });
});

/**
 * Calibration planners against Orca 2.5 Plater::calib_* / CalibUtils (values
 * read from the v2.5.0 source; see each case).
 */
import { describe, expect, it } from 'vitest';
import type { ConfigValue, FlatConfig } from '../engine/types';
import type { PresetKind } from '../presets/types';
import { Edits, objectOverrides, type PresetSource, type PresetWrite } from './edits';
import { mm3PerMm } from './flowMath';
import { vfaAdjust } from './forms';
import { beltRowShifts, beltSectionShifts, EPSILON, type CalibPlan, type PlanContext } from './plan';
import { planFlowRate } from './prints/flow';
import { planCornering, planInputShaping } from './prints/motion';
import { PA_BELT_MESSAGE, planPA } from './prints/pa';
import { planRetraction } from './prints/retraction';
import { planMaxVolSpeed, planVFA } from './prints/speed';
import { BELT_TEMP_RANGES, planTemp } from './prints/temp';

/** Orca 2.5 per-variant process keys used here (vectors in the schema). */
const VECTOR = new Set([
  'outer_wall_speed', 'inner_wall_speed', 'internal_solid_infill_speed', 'top_surface_speed', 'initial_layer_speed', 'outer_wall_acceleration',
  'inner_wall_acceleration', 'default_acceleration', 'default_jerk', 'outer_wall_jerk', 'inner_wall_jerk', 'top_surface_jerk', 'infill_jerk',
  'travel_jerk', 'default_junction_deviation', 'enable_overhang_speed', 'top_solid_infill_flow_ratio', 'print_extruder_variant', 'print_extruder_id',
  // printer / filament vectors
  'nozzle_diameter', 'max_layer_height', 'min_layer_height', 'machine_max_jerk_x', 'machine_max_jerk_y', 'machine_max_speed_x', 'machine_max_speed_y',
  'machine_max_acceleration_extruding', 'machine_max_junction_deviation', 'wipe', 'retract_when_changing_layer', 'extruder_type', 'nozzle_volume_type',
  'filament_max_volumetric_speed', 'filament_flow_ratio', 'slow_down_layer_time', 'slow_down_min_speed', 'slow_down_for_layer_cooling',
  'nozzle_temperature', 'nozzle_temperature_initial_layer', 'enable_pressure_advance', 'pressure_advance', 'adaptive_pressure_advance',
  'filament_retract_when_changing_layer', 'filament_wipe', 'filament_extruder_variant',
]);

type Tabs = Record<PresetKind, FlatConfig>;

const base = (): Tabs => ({
  printer: {
    nozzle_diameter: ['0.4'], max_layer_height: ['0.28', '0.28'], gcode_flavor: 'klipper', machine_max_jerk_x: ['8', '8'], machine_max_jerk_y: ['8', '8'],
    machine_max_speed_x: ['500', '200'], machine_max_speed_y: ['400', '200'], machine_max_acceleration_extruding: ['10000', '1500'],
    machine_max_junction_deviation: ['0'], extruder_type: ['Direct Drive'], nozzle_volume_type: ['Standard'], belt_printer: '0', resonance_avoidance: '1',
    printable_area: ['0x0', '250x0', '250x210', '0x210'],
  },
  process: {
    layer_height: '0.2', initial_layer_print_height: '0.25', line_width: '0.45', print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
    print_extruder_id: ['1', '1'], outer_wall_speed: ['200', '300'], inner_wall_speed: ['250', '350'], internal_solid_infill_speed: ['250', '300'],
    top_surface_speed: ['200', '250'], outer_wall_acceleration: ['5000', '8000'], inner_wall_acceleration: ['0', '0'], default_acceleration: ['6000', '9000'],
    default_jerk: ['9', '9'], outer_wall_jerk: ['0', '0'], inner_wall_jerk: ['7', '7'], initial_layer_speed: ['50', '60'], enable_overhang_speed: ['1', '1'],
    skirt_loops: '1', wall_loops: '2',
  },
  filament: {
    filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'], filament_max_volumetric_speed: ['12', '30'],
    filament_flow_ratio: ['0.98', '0.98'], nozzle_temperature: ['220', '220'], enable_pressure_advance: ['0', '1'], pressure_advance: ['0.04', '0.03'],
    adaptive_pressure_advance: ['1', '0'], slow_down_layer_time: ['8', '8'],
  },
});

function source(tabs: Tabs, schemaKeys?: Set<string>): PresetSource {
  const resolved: FlatConfig = { ...tabs.printer, ...tabs.process, ...tabs.filament };
  return {
    option: (k) => (schemaKeys && !schemaKeys.has(k) ? undefined : { vector: VECTOR.has(k) }),
    value: (kind, key) => tabs[kind][key],
    resolved,
  };
}

const ctx: PlanContext = { bed: () => ({ min: [0, 0], max: [250, 210] }) };

function writes(plan: CalibPlan): Record<string, ConfigValue> {
  return Object.fromEntries(plan.edits.writes.map((w: PresetWrite) => [`${w.kind}.${w.key}`, w.value]));
}

describe('Edits', () => {
  it('fills vectors (set_config_values), writes one variant (setAt), reads the extruder variant', () => {
    const e = new Edits(source(base()));
    e.print('outer_wall_speed', 120);
    e.setAt('process', 'inner_wall_speed', 0, 99.5);
    e.print('skirt_loops', 0);
    expect(writes({ edits: e } as CalibPlan)).toEqual({
      'process.outer_wall_speed': ['120', '120'], 'process.inner_wall_speed': ['99.5', '350'], 'process.skirt_loops': '0',
    });
    expect(e.num('process', 'outer_wall_acceleration', 0)).toBe(5000);
    const hf = base(); hf.printer.nozzle_volume_type = ['High Flow'];
    expect(new Edits(source(hf)).num('process', 'outer_wall_acceleration', 0)).toBe(8000);
    expect(new Edits(source(hf)).num('filament', 'filament_max_volumetric_speed', 0)).toBe(30);
  });

  it('skips unknown keys and shapes object overrides by option type', () => {
    const src = source(base(), new Set(['enable_overhang_speed', 'wall_loops']));
    const e = new Edits(src);
    e.print('wipe_inward', false);
    expect(e.writes).toEqual([]);
    expect(objectOverrides(src, { enable_overhang_speed: false, wall_loops: 1, nope: 1 })).toEqual({ enable_overhang_speed: ['0'], wall_loops: '1' });
  });
});

describe('pressure advance (calib_pa)', () => {
  it('tower: speeds from update_speed_parameter into the variant, cut at ceil(range/step)+1', () => {
    const plan = planPA(source(base()), { mode: 'pa_tower', start: 0, end: 0.1, step: 0.002 }, ctx);
    const w = writes(plan);
    const speed = 12 / mm3PerMm(0.45, 0.2);
    expect(w['process.outer_wall_speed']).toEqual([String(Math.round(speed * 1e6) / 1e6), '300']);
    expect(w['process.inner_wall_speed']).toEqual([String(Math.round(speed * 1e6) / 1e6), '350']);
    expect(w['process.wipe_inward']).toBe('0');
    expect(w['filament.slow_down_layer_time']).toEqual(['1', '1']);
    expect(w['printer.resonance_avoidance']).toBe('0');
    const o = plan.objects[0];
    expect(o.cuts).toEqual([{ z: 51, keep: 'lower' }]);
    expect(o.overrides).toMatchObject({ seam_position: 'back', wall_loops: '2', brim_type: 'brim_ears', brim_width: '6', brim_ears_max_angle: '135' });
    expect(o.overrides).not.toHaveProperty('outer_wall_speed');
  });

  it('pattern: accel / jerk fallbacks per variant, suggested config, one object per speed × accel', () => {
    const plan = planPA(source(base()), { mode: 'pa_pattern', start: 0, end: 0.08, step: 0.005, speeds: [100, 200], accelerations: [3000] }, ctx);
    const w = writes(plan);
    expect(w['process.outer_wall_acceleration']).toEqual(['3000', '3000']);
    expect(w['process.default_jerk']).toEqual(['7', '7']); // outer 0 → inner 7
    expect(w['process.initial_layer_speed']).toEqual(['30', '30']);
    expect(w['process.line_width']).toBe('0.45');
    expect(w['process.initial_layer_line_width']).toBe('0.56');
    expect(w['process.print_sequence']).toBe('by layer');
    expect(plan.objects.map((o) => o.name)).toEqual(['pa_pattern_100_3000', 'pa_pattern_200_3000']);
    expect(plan.objects[1].overrides).toEqual({ outer_wall_speed: ['200'] });
    expect(plan.params).toMatchObject({ speeds: [100, 200], accelerations: [3000] });
  });

  it('pattern defaults: outer wall acceleration and the optimal speed, with notes', () => {
    const plan = planPA(source(base()), { mode: 'pa_pattern', start: 0, end: 0.08, step: 0.005 }, ctx);
    expect(plan.params?.accelerations).toEqual([5000]);
    expect(plan.params?.speeds).toEqual([Math.floor(12 / mm3PerMm(0.45, 0.2))]);
    expect(plan.notes).toHaveLength(2);
  });

  it('pattern: accel / jerk at the bare extruder element (get_abs_value_at), not the variant', () => {
    // A High Flow extruder 0 has variant column 1, but Orca reads element 0.
    const t = base(); t.printer.nozzle_volume_type = ['High Flow'];
    const plan = planPA(source(t), { mode: 'pa_pattern', start: 0, end: 0.08, step: 0.005, speeds: [100] }, ctx);
    expect(plan.params?.accelerations).toEqual([5000]);
    // find_optimal_PA_speed: outer_wall_speed[0] (200 → max(100, 200)), capped by the volumetric limit.
    const t2 = base(); t2.filament.filament_max_volumetric_speed = ['500', '500'];
    t2.process.outer_wall_speed = ['150', '300'];
    expect(planPA(source(t2), { mode: 'pa_pattern', start: 0, end: 0.08, step: 0.005 }, ctx).params?.speeds).toEqual([150]);
  });

  it('unset volumetric limit: speeds kept (Orca would write 0, which the engine refuses)', () => {
    const t = base(); t.filament.filament_max_volumetric_speed = ['0', '0'];
    const w = writes(planPA(source(t), { mode: 'pa_tower', start: 0, end: 0.1, step: 0.002 }, ctx));
    expect(w['process.outer_wall_speed']).toBeUndefined();
    expect(planPA(source(t), { mode: 'pa_pattern', start: 0, end: 0.08, step: 0.005 }, ctx).params?.speeds).toEqual([200]);
  });

  it('belt printers only run the tower', () => {
    const t = base(); Object.assign(t.printer, { belt_printer: '1', belt_slice_rotation: 'x', belt_slice_rotation_angle: '45' });
    expect(() => planPA(source(t), { mode: 'pa_line', start: 0, end: 0.1, step: 0.002 }, ctx)).toThrow(PA_BELT_MESSAGE);
    const plan = planPA(source(t), { mode: 'pa_tower', start: 0, end: 0.1, step: 0.002 }, ctx);
    expect(plan.belt).toEqual({ mode: 'counter-rotate', tilt: { angle: -Math.PI / 4, axis: 'x' } });
    expect(writes(plan)['process.skirt_loops']).toBe('0');
  });
});

describe('flow ratio (adjust_settings_for_flowrate_calib)', () => {
  it('YOLO: z scale, per-object flow and speeds capped by generate_max_speed_parameter_value', () => {
    const parts = [{ name: 'flowrate_0.01', centre: [0, 0] as [number, number] }, { name: 'flowrate_m0.02', centre: [40, 0] as [number, number] }];
    const plan = planFlowRate(source(base()), { linear: true, pass: 1, pattern: 'monotonic' }, parts);
    expect(plan.params).toBeNull();
    const cap = Math.floor(12 / ((mm3PerMm(0.48, 0.2) * (0.98 + 0.05)) / 0.98));
    const o = plan.objects[1];
    expect(o.scale).toEqual([1, 1, (0.25 + 9 * 0.2) / 2]);
    expect(o.offset).toEqual([20, 0]);
    expect(o.overrides).toMatchObject({
      print_flow_ratio: String(Math.round(((0.98 - 0.02) / 0.98) * 1e6) / 1e6), top_surface_pattern: 'monotonic',
      internal_solid_infill_speed: [String(Math.min(250, cap))], top_surface_speed: [String(Math.min(200, cap))],
      top_solid_infill_flow_ratio: ['1'], center_of_surface_pattern: 'each_surface', separated_infills: '0', top_surface_fill_order: 'default',
    });
    expect(writes(plan)).toMatchObject({ 'process.layer_height': '0.2', 'process.initial_layer_print_height': '0.25', 'process.reduce_crossing_wall': '1' });
  });
});

describe('temperature tower (calib_temp)', () => {
  it('cuts by the 500 °C indexing, scales with the nozzle, temps into every variant', () => {
    const t = base(); t.printer.nozzle_diameter = ['0.6'];
    const plan = planTemp(source(t), { mode: 'temp_tower', start: 230, end: 190, step: 5 });
    const o = plan.objects[0];
    expect(o.cuts).toEqual([{ z: 63 * 10 - EPSILON, keep: 'lower' }, { z: 54 * 10 + EPSILON, keep: 'upper' }]);
    o.scale!.forEach((v) => expect(v).toBeCloseTo(1.5, 9));
    expect(o.overrides).toMatchObject({ layer_height: '0.3', brim_type: 'outer_only', brim_width: '5' });
    expect(writes(plan)).toMatchObject({ 'filament.nozzle_temperature': ['230', '230'], 'process.initial_layer_print_height': '0.3' });
  });

  it('without auto-scale prints the reference model as-is', () => {
    const t = base(); t.printer.nozzle_diameter = ['0.6'];
    const plan = planTemp(source(t), { mode: 'temp_tower', start: 230, end: 190, step: 5, nozzleBasedResize: false });
    expect(plan.objects[0].scale).toBeUndefined();
    expect(plan.objects[0].overrides).not.toHaveProperty('layer_height');
    expect(writes(plan)).not.toHaveProperty('process.initial_layer_print_height');
  });

  it('belt: sectioned blocks named temp_<°C>, or the Overhang tower with M104 steps', () => {
    const t = base(); Object.assign(t.printer, { belt_printer: '1', belt_slice_rotation: 'x', belt_slice_rotation_angle: '45' });
    const s = planTemp(source(t), { mode: 'temp_tower', start: 230, end: 220, step: 5 });
    expect(s.objects.map((o) => o.name)).toEqual(['temp_230', 'temp_225', 'temp_220']);
    expect(s.objects[0].cuts).toEqual([{ z: 550 - EPSILON, keep: 'lower', when: 550 }, { z: 540 + EPSILON, keep: 'upper', when: -Infinity }]);
    expect(s.belt?.mode).toBe('sections');
    const ov = planTemp(source(t), { mode: 'temp_tower', start: 230, end: 190, step: 5, testModel: 1 });
    expect(ov.params).toBeNull();
    expect(ov.objects[0].model).toBe('temperature_tower/belt_temp_tower_230_190.stl');
    expect(ov.customGcodes).toHaveLength(8);
    expect(ov.customGcodes![0]).toEqual({ z: 74.718 * Math.cos(Math.PI / 4) + 70 * 0.2, type: 'custom', extruder: 1, extra: 'M104 S225 ; belt temp zone 225' });
    expect(() => planTemp(source(t), { mode: 'temp_tower', start: 235, end: 190, step: 5, testModel: 1 })).toThrow(/No belt temperature tower/);
    expect(BELT_TEMP_RANGES).toHaveLength(6);
  });
});

describe('max volumetric speed (calib_max_vol_speed)', () => {
  it('raises every max layer height, keeps a higher volumetric limit, converts the range', () => {
    const t = base(); t.printer.max_layer_height = ['0.28', '0.4'];
    const plan = planMaxVolSpeed(source(t), { mode: 'vol_speed_tower', start: 5, end: 20, step: 0.5 }, ctx);
    const w = writes(plan);
    expect(w['printer.max_layer_height']).toEqual(['0.32', '0.4']);
    expect(w['filament.filament_max_volumetric_speed']).toEqual(['200', '200']);
    const perMm = mm3PerMm(0.7, 0.32) * 0.98;
    expect(plan.params!.start).toBeCloseTo(5 / perMm, 9);
    expect(plan.params!.end).toBeCloseTo(20 / perMm, 9);
    expect(plan.objects[0]).toMatchObject({ fitWidth: 240, cuts: [{ z: 32, keep: 'lower' }] });
    expect(plan.objects[0].overrides).toMatchObject({ enable_overhang_speed: ['0'], outer_wall_line_width: '0.7', layer_height: '0.32' });
  });
});

describe('VFA (calib_VFA)', () => {
  it('cuts the base model by 5 mm blocks, scales to 25 layers per block', () => {
    const t = base(); t.printer.nozzle_diameter = ['0.6'];
    const plan = planVFA(source(t), { mode: 'vfa_tower', start: 40, end: 200, step: 10 });
    expect(plan.objects[0].cuts).toEqual([{ z: 5 * 17 - EPSILON, keep: 'lower' }]);
    plan.objects[0].scale!.forEach((v, i) => expect(v).toBeCloseTo([1.5, 1.5, (25 * 0.3) / 5][i], 9));
    expect(plan.params!.vfaLayerHeight).toBeCloseTo(0.3, 9);
    expect(writes(plan)).toMatchObject({ 'process.enable_overhang_speed': ['0', '0'], 'process.initial_layer_print_height': '0.3' });
    const asIs = planVFA(source(t), { mode: 'vfa_tower', start: 40, end: 200, step: 10, nozzleBasedResize: false });
    expect(asIs.objects[0].scale).toBeUndefined();
    expect(asIs.params).toMatchObject({ vfaLayerHeight: 0 });
  });

  it('auto-adjust picks the largest profile layer height that reaches the end speed', async () => {
    const f = { nozzle: 0.4, presetLayerHeight: 0.2, maxVolSpeed: 12, minLayerHeight: 0.08, maxLayerHeight: 0.28, lineWidth: 0.45 };
    expect((await vfaAdjust({ start: 40, end: 100, step: 10 }, true, true, f, () => [])).kind).toBe('ok');
    const r = await vfaAdjust({ start: 40, end: 200, step: 10 }, true, true, f, () => [0.28, 0.2, 0.12, 0.08, 0.06]);
    expect(r).toMatchObject({ kind: 'reduced', layerHeight: 0.12 });
    const low = await vfaAdjust({ start: 40, end: 400, step: 10 }, true, true, f, () => [0.2, 0.12]);
    expect(low).toMatchObject({ kind: 'lower-end', layerHeight: 0.12, end: Math.floor(12 / mm3PerMm(0.45, 0.12) / 10) * 10 });
    expect((await vfaAdjust({ start: 40, end: 200, step: 10 }, false, true, f, () => [])).kind).toBe('clamp');
  });
});

describe('retraction (calib_retraction)', () => {
  it('layer height by nozzle, scarf off, inward wipe off', () => {
    const plan = planRetraction(source(base()), { mode: 'retraction_tower', start: 0, end: 2, step: 0.1 });
    expect(plan.objects[0].cuts).toEqual([{ z: 1.4 + 20 - EPSILON, keep: 'lower' }]);
    expect(plan.objects[0].overrides).toMatchObject({ layer_height: '0.2', seam_slope_type: 'none', wall_sequence: 'inner wall/outer wall' });
    expect(writes(plan)).toMatchObject({ 'process.wipe_inward': '0', 'printer.use_firmware_retraction': '0', 'printer.max_layer_height': ['0.28', '0.28'] });
  });
});

describe('input shaping and cornering', () => {
  it('IS: printer max speed / acceleration, jerk floor, PA zeroed where disabled, accel_to_decel 100 %', () => {
    const plan = planInputShaping(source(base()), { mode: 'input_shaping_freq', start: 0.15, end: 0, step: 0, testModel: 0 });
    const w = writes(plan);
    expect(w['process.outer_wall_speed']).toEqual(['400', '400']);
    expect(w['process.default_acceleration']).toEqual(['10000', '10000']);
    expect(w['printer.machine_max_jerk_x']).toEqual(['8', '8']); // max(8, klipper 5)
    expect(w['process.default_jerk']).toEqual(['0', '0']);
    expect(w['filament.enable_pressure_advance']).toEqual(['1', '1']);
    expect(w['filament.pressure_advance']).toEqual(['0', '0.03']);
    expect(w['filament.adaptive_pressure_advance']).toEqual(['0', '0']);
    expect(w['process.accel_to_decel_factor']).toBe('100%');
    expect(w['process.layer_height']).toBe('0.2');
    expect(planInputShaping(source(base()), { mode: 'input_shaping_damp', start: 0, end: 0.4, step: 0 }).edits.writes.some((x) => x.key === 'layer_height')).toBe(false);
    expect(plan.objects[0]).toMatchObject({ model: 'input_shaping/ringing_tower.stl', turn: false });
    // Unset limits: acceleration 0 is written as Orca does; a 0 speed is not (engine min 1).
    const t = base(); Object.assign(t.printer, { machine_max_speed_x: ['0'], machine_max_acceleration_extruding: ['0'] });
    const z = writes(planInputShaping(source(t), { mode: 'input_shaping_freq', start: 0.15, end: 0, step: 0, testModel: 0 }));
    expect(z['process.outer_wall_speed']).toBeUndefined();
    expect(z['process.default_acceleration']).toEqual(['0', '0']);
    expect(z['process.outer_wall_acceleration']).toEqual(['0', '0']);
  });

  it('cornering: jerk = end, shaping disabled, volumetric ≥ 200, belt flips the ringing tower', () => {
    const t = base(); Object.assign(t.printer, { belt_printer: '1', belt_slice_rotation: 'y', belt_slice_rotation_angle: '30' });
    const plan = planCornering(source(t), { mode: 'cornering', start: 1, end: 15, step: 0, testModel: 0 });
    const w = writes(plan);
    expect(w['printer.machine_max_jerk_x']).toEqual(['15', '15']);
    expect(w['printer.input_shaping_type']).toBe('Disable');
    expect(w['filament.filament_max_volumetric_speed']).toEqual(['200', '200']);
    expect(w).not.toHaveProperty('process.accel_to_decel_enable');
    expect(plan.objects[0].turn).toBe(true);
    expect(plan.belt?.tilt.axis).toBe('y');
  });
});

describe('belt layouts', () => {
  it('rows keep together and open up by the wedge', () => {
    const s = beltRowShifts([{ offsetY: 0, minY: -5, maxY: 5 }, { offsetY: 0.5, minY: -4, maxY: 4 }, { offsetY: 30, minY: 25, maxY: 35 }], -Math.PI / 4);
    expect(s[0]).toBe(0);
    expect(s[1]).toBe(0);
    expect(s[2]).toBeCloseTo(-5 + 10 * 2 + 5 - 25, 9);
  });
  it('sections start at Y = 20 and clear each slicing plane', () => {
    const s = beltSectionShifts([{ minY: -10, sizeY: 20, sizeZ: 10 }, { minY: -10, sizeY: 20, sizeZ: 10 }], -Math.PI / 4);
    expect(s[0]).toBe(30);
    expect(s[1]).toBeCloseTo(20 + 20 + 10 + 5 + 10, 9);
  });
});

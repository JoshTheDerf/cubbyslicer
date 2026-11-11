/**
 * Input shaping (frequency / damping) and cornering: Orca 2.5
 * Plater::calib_input_shaping_freq, calib_input_shaping_damp and
 * Calib_Cornering.
 */
import { asList, toBool } from '../../lib/configValue';
import { Edits, objectOverrides, type PresetSource } from '../edits';
import { counterRotate, type CalibPlan, type CalibRequest } from '../plan';

const RINGING = 'input_shaping/ringing_tower.stl';
const FAST = 'input_shaping/fast_tower_test.stl';

/**
 * zero_pressure_advance_where_disabled: every filament variant with pressure
 * advance off gets it on at 0 (non-adaptive), so the test prints without PA.
 */
export function zeroPressureAdvance(e: Edits): void {
  const en = asList(e.tab('filament', 'enable_pressure_advance')).slice();
  const pa = asList(e.tab('filament', 'pressure_advance')).slice();
  const ad = asList(e.tab('filament', 'adaptive_pressure_advance')).slice();
  if (!en.length || !pa.length || !ad.length || en.every((s) => toBool(s))) return;
  while (pa.length < en.length) pa.push(pa[pa.length - 1]);
  while (ad.length < en.length) ad.push(ad[ad.length - 1]);
  en.forEach((s, i) => { if (!toBool(s)) { en[i] = '1'; pa[i] = '0'; ad[i] = '0'; } });
  e.setList('filament', 'enable_pressure_advance', en);
  e.setList('filament', 'pressure_advance', pa);
  e.setList('filament', 'adaptive_pressure_advance', ad);
}

/** Settings every motion test shares (spiral single wall at the printer's limits). */
function motionSettings(e: Edits): void {
  e.filament('slow_down_layer_time', 0);
  e.filament('slow_down_min_speed', 0);
  e.filament('slow_down_for_layer_cooling', false);
  e.print('enable_overhang_speed', false);
  e.print('timelapse_type', '0');
  e.print('wall_loops', 1);
  e.print('top_shell_layers', 0);
  e.print('bottom_shell_layers', 1);
  e.print('sparse_infill_density', '0%');
  e.print('detect_thin_wall', false);
  e.print('spiral_mode', true);
  e.print('spiral_mode_smooth', false);
  e.print('bottom_surface_pattern', 'rectilinear');
  // 2.5: the printer's own limits instead of fixed 200 mm/s and 20000 / 2000 mm/s², as Orca writes them
  // (an unset acceleration limit gives 0 = the firmware's own). An unset speed limit keeps the profile's
  // outer wall speed: Orca would write 0, which the engine refuses (min 1).
  const speed = Math.min(e.first('printer', 'machine_max_speed_x'), e.first('printer', 'machine_max_speed_y'));
  const accel = e.first('printer', 'machine_max_acceleration_extruding');
  if (speed > 0) e.print('outer_wall_speed', speed);
  e.print('default_acceleration', accel);
  e.print('outer_wall_acceleration', accel);
  e.print('precise_z_height', false);
}

function towerPlan(src: PresetSource, e: Edits, title: string, params: CalibRequest, model: string, flip: boolean): CalibPlan {
  const belt = counterRotate(e);
  return {
    title, edits: e, params,
    objects: [{
      name: model.split('/').pop()!.replace('.stl', ''), model, turn: flip && !!belt,
      overrides: objectOverrides(src, { brim_type: 'outer_only', brim_width: 3, brim_object_gap: 0 }),
    }],
    belt,
  };
}

export function planInputShaping(src: PresetSource, params: CalibRequest): CalibPlan {
  const e = new Edits(src, params.extruderId ?? 0);
  const freq = params.mode === 'input_shaping_freq';
  const ringing = (params.testModel ?? 0) < 1;
  if (e.hasJunctionDeviation()) {
    e.printer('machine_max_junction_deviation', Math.max(e.first('printer', 'machine_max_junction_deviation'), 0.25));
    e.print('default_junction_deviation', 0);
  } else {
    const jerk = e.str('gcode_flavor') === 'klipper' ? 5 : 10;
    e.printer('machine_max_jerk_x', Math.max(e.first('printer', 'machine_max_jerk_x'), jerk));
    e.printer('machine_max_jerk_y', Math.max(e.first('printer', 'machine_max_jerk_y'), jerk));
    e.print('default_jerk', 0);
  }
  zeroPressureAdvance(e);
  e.printer('resonance_avoidance', false);
  e.printer('input_shaping_emit', false);
  if (freq) e.print('layer_height', 0.2);
  // A 100 % factor sends Klipper MINIMUM_CRUISE_RATIO=0 with every acceleration change, for the whole test.
  e.print('accel_to_decel_enable', true);
  e.print('accel_to_decel_factor', '100%');
  motionSettings(e);
  return towerPlan(src, e, freq ? 'Input shaping Frequency test' : 'Input shaping Damping test', params, ringing ? RINGING : FAST, ringing);
}

export function planCornering(src: PresetSource, params: CalibRequest): CalibPlan {
  const e = new Edits(src, params.extruderId ?? 0);
  const tm = params.testModel ?? 0;
  const model = tm === 0 ? RINGING : tm === 1 ? FAST : 'cornering/SCV-V2.stl';
  if (e.hasJunctionDeviation()) {
    e.printer('machine_max_junction_deviation', params.end);
    e.print('default_junction_deviation', 0);
  } else {
    e.printer('machine_max_jerk_x', params.end);
    e.printer('machine_max_jerk_y', params.end);
    e.print('default_jerk', 0);
  }
  zeroPressureAdvance(e);
  e.printer('resonance_avoidance', false);
  e.printer('input_shaping_emit', true);
  e.printer('input_shaping_type', 'Disable');
  e.filament('filament_max_volumetric_speed', Math.max(e.el('filament', 'filament_max_volumetric_speed', 0), 200));
  motionSettings(e);
  return towerPlan(src, e, 'Cornering test', params, model, tm === 0);
}

/**
 * Pressure advance: Orca 2.5 Plater::calib_pa, _calib_pa_tower,
 * _calib_pa_pattern and CalibUtils update_speed_parameter.
 */
import { boxMesh } from '../../project/primitives';
import { Edits, objectOverrides, type PresetSource } from '../edits';
import { autoExtrusionWidth, findOptimalPASpeed, mm3PerMm, PAPatternGeometry } from '../flowMath';
import { beltTilt, counterRotate, type CalibPlan, type CalibRequest, type PlanContext, type PlanObject } from '../plan';

export const PA_BELT_MESSAGE = 'PA Line and PA Pattern tests are not enabled yet on belt printers. Please use the PA Tower method instead.';

/** calib_pa: refuses PA line / pattern on belt printers before anything changes. */
export function planPA(src: PresetSource, params: CalibRequest, ctx: PlanContext): CalibPlan {
  const e = new Edits(src, params.extruderId ?? 0);
  if (beltTilt(e) && params.mode !== 'pa_tower') throw new Error(PA_BELT_MESSAGE);
  e.print('overhang_reverse', false);
  e.print('precise_z_height', false);
  e.print('wipe_inward', false);
  e.printer('resonance_avoidance', false);
  const title = 'Pressure Advance Test';
  if (params.mode === 'pa_line') {
    return { title, edits: e, params, objects: [{ name: 'pressure_advance_test', model: 'pressure_advance/pressure_advance_test.stl' }] };
  }
  if (params.mode === 'pa_pattern') return { title, edits: e, ...paPattern(e, src, params, ctx) };
  return { title, edits: e, ...paTower(e, src, params) };
}

/**
 * CalibUtils update_speed_parameter: per extruder, the speed the filament's
 * max volumetric speed allows at the process line width / layer height,
 * written into that extruder's variant of the process preset. An unset
 * volumetric limit (0) leaves the speed alone: Orca would write 0, which the
 * engine refuses (speeds have min 1).
 */
export function maxSpeedParameter(e: Edits, key: string): void {
  const nozzle = e.nozzle(0);
  const layer = e.num('process', 'layer_height', 0);
  let width = e.num('process', 'line_width', 0, 0, nozzle);
  if (width <= 0) width = autoExtrusionWidth(nozzle);
  const perMm = mm3PerMm(width, layer);
  for (let i = 0; i < e.extruderCount(); i++) {
    const maxVol = e.num('filament', 'filament_max_volumetric_speed', i);
    if (maxVol > 0 && perMm > 0) e.setAt('process', key, i, maxVol / perMm);
  }
}

function paTower(e: Edits, src: PresetSource, params: CalibRequest): Pick<CalibPlan, 'objects' | 'params' | 'belt'> {
  e.print('enable_wrapping_detection', false);
  e.filament('slow_down_layer_time', 1);
  maxSpeedParameter(e, 'outer_wall_speed');
  maxSpeedParameter(e, 'inner_wall_speed');
  e.print('max_volumetric_extrusion_rate_slope', 0);
  const height = Math.ceil((params.end - params.start) / params.step) + 1;
  return {
    params,
    objects: [{
      name: 'tower_with_seam', model: 'pressure_advance/tower_with_seam.stl', cuts: [{ z: height, keep: 'lower' }],
      overrides: objectOverrides(src, {
        alternate_extra_wall: false, seam_position: 'back', wall_loops: 2, top_shell_layers: 0, bottom_shell_layers: 0,
        sparse_infill_density: '0%', brim_type: 'brim_ears', brim_object_gap: 0, brim_ears_max_angle: 135, brim_width: 6,
        seam_slope_type: 'none',
      }),
    }],
    belt: counterRotate(e),
  };
}

function paPattern(e: Edits, src: PresetSource, params: CalibRequest, ctx: PlanContext): Pick<CalibPlan, 'objects' | 'params' | 'plates' | 'notes'> {
  const ext = params.extruderId ?? 0;
  const speeds = (params.speeds ?? []).slice();
  const accels = (params.accelerations ?? []).slice();
  const nozzle = e.nozzle(0);
  e.filament('filament_retract_when_changing_layer', false);
  e.filament('filament_wipe', false);
  e.printer('wipe', false);
  e.printer('retract_when_changing_layer', false);
  e.printer('resonance_avoidance', false);

  // Plater::_calib_pa_pattern: get_abs_value_at(key, extruder_id) — the bare element, not the variant.
  let accel = e.el('process', 'outer_wall_acceleration', ext);
  if (accel === 0) accel = e.el('process', 'inner_wall_acceleration', ext);
  if (accel === 0) accel = e.el('process', 'default_acceleration', ext);
  const notes: string[] = [];
  if (!accels.length) {
    accels.push(accel);
    notes.push(`No accelerations provided for calibration. Use default acceleration value ${Math.trunc(accel)} mm/s².`);
  } else accel = Math.max(...accels);
  e.print('outer_wall_acceleration', accel);
  e.print('print_sequence', 'by layer');

  if (!e.hasJunctionDeviation() && e.el('process', 'default_jerk', ext) > 0) {
    let jerk = e.el('process', 'outer_wall_jerk', ext);
    if (jerk === 0) jerk = e.el('process', 'inner_wall_jerk', ext);
    if (jerk === 0) jerk = e.el('process', 'default_jerk', ext);
    for (const k of ['default_jerk', 'outer_wall_jerk', 'inner_wall_jerk', 'top_surface_jerk', 'infill_jerk', 'travel_jerk']) e.print(k, jerk);
  }
  if (e.hasJunctionDeviation()) e.print('default_junction_deviation', 0);

  // SuggestedConfigCalibPAPattern
  e.print('initial_layer_speed', 30);
  e.print('line_width', (nozzle * 112.5) / 100);
  e.print('initial_layer_line_width', (nozzle * 140) / 100);
  e.print('skirt_loops', 0);
  e.print('wall_loops', 3);
  e.print('brim_type', 'no_brim');
  e.print('enable_wrapping_detection', false);

  if (!speeds.length) {
    const speed = findOptimalPASpeed(e.cfg, e.num('process', 'line_width', 0, 0, nozzle), e.num('process', 'layer_height', 0), 0, 0);
    e.print('outer_wall_speed', speed);
    speeds.push(speed);
    notes.push(`No speeds provided for calibration. Use default optimal speed ${Math.trunc(speed)} mm/s.`);
  } else if (speeds.length === 1) {
    e.print('outer_wall_speed', speeds[0]);
  }

  const g = new PAPatternGeometry(e.cfg, params.start, params.end, params.step, accel);
  const fw = g.printSizeX() + 4, fh = g.printSizeY() + 4;
  const offset = g.handlePosOffset();

  // Lay the N = speeds × accels footprints out in a grid, as many plates as needed.
  const count = speeds.length * accels.length;
  const b = ctx.bed(0);
  const cols = Math.max(1, Math.floor((b.max[0] - b.min[0] - 10) / fw)), rows = Math.max(1, Math.floor((b.max[1] - b.min[1] - 10) / fh));
  const perPlate = cols * rows;
  const plates = Math.ceil(count / perPlate);
  const cube = boxMesh(PAPatternGeometry.handleXY, PAPatternGeometry.handleXY, g.maxLayerZ());
  const objects: PlanObject[] = [];
  for (let t = 0; t < count; t++) {
    const plate = Math.floor(t / perPlate), k = t % perPlate;
    const n = Math.min(perPlate, count - plate * perPlate);
    const c = Math.min(cols, n), r = Math.ceil(n / cols);
    const col = k % cols, row = Math.floor(k / cols);
    const pb = ctx.bed(plate);
    const cx = (pb.min[0] + pb.max[0]) / 2 + (col - (c - 1) / 2) * fw;
    const cy = (pb.min[1] + pb.max[1]) / 2 + ((r - 1) / 2 - row) * fh;
    const spd = speeds[t % speeds.length], acc = accels[Math.floor(t / speeds.length)];
    const ov: Record<string, number> = {};
    if (speeds.length > 1) ov.outer_wall_speed = spd;
    if (accels.length > 1) ov.outer_wall_acceleration = acc;
    objects.push({
      name: `pa_pattern_${Math.trunc(spd)}_${Math.trunc(acc)}`,
      mesh: { positions: cube.positions.slice(), indices: cube.indices.slice() },
      at: [cx + offset[0], cy + offset[1]],
      overrides: objectOverrides(src, ov),
    });
  }
  return { objects, plates, notes, params: { ...params, speeds, accelerations: accels } };
}

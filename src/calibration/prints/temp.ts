/**
 * Temperature tower: Orca 2.5 Plater::calib_temp, including the belt-printer
 * variants (_calib_temp_belt_sectioned and the "Overhang" provini tower).
 */
import type { CustomGcodeItem } from '../../engine/types';
import { Edits, objectOverrides, type PresetSource } from '../edits';
import { beltTilt, EPSILON, isBeltPrinter, type CalibPlan, type CalibRequest, type PlanObject } from '../plan';

const BASE_NOZZLE = 0.4, BLOCK = 10, STEP = 5;
const TOWER = 'temperature_tower/temperature_tower.stl';

/** Ranges Orca 2.5 ships a belt "Overhang" tower for (resources/calib/temperature_tower/belt_temp_tower_<start>_<end>.stl). */
export const BELT_TEMP_RANGES: ReadonlyArray<readonly [number, number]> = [[230, 190], [240, 210], [250, 230], [270, 230], [280, 240], [320, 280]];

export function beltTempAsset(start: number, end: number): string | null {
  const s = Math.round(start), t = Math.round(end);
  return BELT_TEMP_RANGES.some(([a, b]) => a === s && b === t) ? `temperature_tower/belt_temp_tower_${s}_${t}.stl` : null;
}

/** The nozzle of Calib_Params::extruder_id (clamped), 0.4 when unset. */
function nozzleOf(e: Edits, params: CalibRequest): number { return e.nozzle(Math.max(params.extruderId ?? 0, 0)); }

export function planTemp(src: PresetSource, params: CalibRequest): CalibPlan {
  const e = new Edits(src, params.extruderId ?? 0);
  const title = 'Nozzle temperature test';
  if (isBeltPrinter(e)) {
    if ((params.testModel ?? 0) >= 1) return beltOverhang(e, src, params, title);
    return beltSectioned(e, src, params, title);
  }
  const resize = params.nozzleBasedResize !== false;
  const nozzle = nozzleOf(e, params);
  const scale = nozzle / BASE_NOZZLE;
  const cuts: PlanObject['cuts'] = [];
  // cut upper (EPSILON below the block's flat top), then the bottom
  let blocks = Math.round((500 - params.end) / STEP + 1);
  if (blocks > 0) cuts.push({ z: blocks * BLOCK - EPSILON, keep: 'lower' });
  blocks = Math.round((500 - params.start) / STEP);
  if (blocks > 0) cuts.push({ z: blocks * BLOCK + EPSILON, keep: 'upper' });
  const start = Math.round(params.start);
  e.printer('resonance_avoidance', false);
  e.filament('nozzle_temperature_initial_layer', start);
  e.filament('nozzle_temperature', start);
  e.print('enable_wrapping_detection', false);
  // Without resizing the 0.4 mm / 0.2 mm reference model prints as-is (preset layer height kept).
  if (resize) e.print('initial_layer_print_height', nozzle / 2);
  return {
    title, edits: e, params,
    objects: [{
      name: 'temperature_tower', model: TOWER, cuts,
      scale: resize && Math.abs(scale - 1) > EPSILON ? [scale, scale, scale] : undefined,
      overrides: objectOverrides(src, {
        ...(resize ? { layer_height: nozzle / 2 } : {}),
        brim_type: 'outer_only', brim_width: 5, brim_object_gap: 0, alternate_extra_wall: false, seam_slope_type: 'none',
        overhang_reverse: false, precise_z_height: false,
      }),
    }],
  };
}

/**
 * _calib_temp_belt_sectioned ("Standard" on a belt): one block of the tower
 * per temperature, named temp_<°C> (the engine sets each object's
 * temperature from its name), laid along the belt.
 */
function beltSectioned(e: Edits, src: PresetSource, params: CalibRequest, title: string): CalibPlan {
  const start = Math.round(params.start), end = Math.round(params.end);
  const n = Math.max(1, Math.trunc((start - end) / STEP) + 1);
  const nozzle = nozzleOf(e, params);
  const scale = nozzle / BASE_NOZZLE;
  const objects: PlanObject[] = [];
  for (let i = 0; i < n; i++) {
    const temp = start - i * STEP;
    const bottom = Math.round((500 - temp) / STEP) * BLOCK;
    const cuts: PlanObject['cuts'] = [{ z: bottom + BLOCK - EPSILON, keep: 'lower', when: bottom + BLOCK }];
    if (bottom > 0) cuts.push({ z: bottom + EPSILON, keep: 'upper', when: -Infinity });
    objects.push({
      name: `temp_${temp}`, model: TOWER, cuts,
      scale: Math.abs(scale - 1) > EPSILON ? [scale, scale, scale] : undefined,
      overrides: objectOverrides(src, {
        layer_height: nozzle / 2, alternate_extra_wall: false, seam_slope_type: 'none', overhang_reverse: false, precise_z_height: false,
      }),
    });
  }
  e.printer('resonance_avoidance', false);
  e.filament('nozzle_temperature_initial_layer', start);
  e.filament('nozzle_temperature', start);
  e.print('enable_wrapping_detection', false);
  e.print('initial_layer_print_height', nozzle / 2);
  e.print('skirt_loops', 0);
  return { title, edits: e, objects, params, belt: { mode: 'sections', tilt: beltTilt(e) ?? { angle: 0, axis: 'x' } } };
}

/** Designed-Y pitch of the provini in the belt towers (gen_belt_temp_tower.py PITCH). */
const PITCH_Y = 74.718;

/**
 * The belt "Overhang" model: Orca's pre-embossed provini tower for the range,
 * temperatures stepped by custom M104 G-code 70 layers into each provino. No
 * Calib_Params (its per-layer interpolation would overwrite the steps).
 */
function beltOverhang(e: Edits, src: PresetSource, params: CalibRequest, title: string): CalibPlan {
  const asset = beltTempAsset(params.start, params.end);
  if (!asset) {
    throw new Error(`No belt temperature tower is available for the range ${Math.round(params.start)} to ${Math.round(params.end)} °C. `
      + `Use a range the tower models cover: ${BELT_TEMP_RANGES.map(([a, b]) => `${a}–${b}`).join(', ')}.`);
  }
  const start = Math.round(params.start), end = Math.round(params.end);
  const temps: number[] = [];
  const step = start >= end ? -STEP : STEP;
  for (let t = start; step < 0 ? t >= end : t <= end; t += step) temps.push(t);
  if (!temps.length) temps.push(start);
  const angle = e.tab('printer', 'belt_slice_rotation_angle') !== undefined ? e.first('printer', 'belt_slice_rotation_angle') : 45;
  const zone = PITCH_Y * Math.cos((angle * Math.PI) / 180);
  const lh = e.tab('process', 'layer_height') !== undefined ? e.num('process', 'layer_height', 0) : 0.2;
  const customGcodes: CustomGcodeItem[] = temps.slice(1).map((t, k) => ({
    z: (k + 1) * zone + 70 * lh, type: 'custom', extruder: 1, extra: `M104 S${t} ; belt temp zone ${t}`,
  }));
  e.filament('nozzle_temperature_initial_layer', temps[0]);
  e.filament('nozzle_temperature', temps[0]);
  e.printer('resonance_avoidance', false);
  return {
    title, edits: e, params: null, customGcodes,
    objects: [{
      name: asset.split('/').pop()!.replace('.stl', ''), model: asset, beltEntry: true,
      overrides: objectOverrides(src, { brim_type: 'no_brim', seam_slope_type: 'none', overhang_reverse: false }),
    }],
  };
}

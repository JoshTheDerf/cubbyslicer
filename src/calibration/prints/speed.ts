/**
 * Max volumetric speed and VFA towers: Orca 2.5 Plater::calib_max_vol_speed
 * and Plater::calib_VFA.
 */
import { Edits, objectOverrides, type PresetSource } from '../edits';
import { mm3PerMm } from '../flowMath';
import { counterRotate, EPSILON, type CalibPlan, type CalibRequest, type PlanContext } from '../plan';

/** Raise every element of the printer's max_layer_height to at least `lh`. */
export function raiseMaxLayerHeight(e: Edits, lh: number): void {
  e.map('printer', 'max_layer_height', (s) => { const v = parseFloat(s ?? ''); return Number.isFinite(v) && v >= lh ? v : lh; });
}

export function planMaxVolSpeed(src: PresetSource, params: CalibRequest, ctx: PlanContext): CalibPlan {
  const e = new Edits(src, params.extruderId ?? 0);
  const b = ctx.bed(0);
  const nozzle = e.nozzle(0);
  const lineWidth = nozzle * 1.75;
  const layerHeight = nozzle * 0.8;
  raiseMaxLayerHeight(e, layerHeight);
  e.filament('filament_max_volumetric_speed', Math.max(e.el('filament', 'filament_max_volumetric_speed', 0), 200));
  e.filament('slow_down_layer_time', 0);
  e.printer('resonance_avoidance', false);
  e.print('timelapse_type', '0');
  e.print('spiral_mode', true);
  e.print('max_volumetric_extrusion_rate_slope', 0);
  e.print('enable_wrapping_detection', false);
  const height = (params.end - params.start + 1) / params.step;
  // The engine steps the outer wall speed by height: convert mm³/s to mm/s for the test's extrusion.
  const perMm = mm3PerMm(lineWidth, layerHeight) * (e.el('filament', 'filament_flow_ratio', 0, 1) || 1);
  return {
    title: 'Max volumetric speed test', edits: e,
    objects: [{
      name: 'SpeedTestStructure', model: 'volumetric_speed/SpeedTestStructure.stl', fitWidth: b.max[0] - b.min[0] - 10,
      cuts: [{ z: height, keep: 'lower' }],
      overrides: objectOverrides(src, {
        enable_overhang_speed: false, wall_loops: 1, alternate_extra_wall: false, top_shell_layers: 0, bottom_shell_layers: 0,
        sparse_infill_density: '0%', outer_wall_line_width: lineWidth, layer_height: layerHeight, brim_type: 'outer_and_inner',
        brim_width: 5, brim_object_gap: 0, precise_z_height: false,
      }),
    }],
    params: { ...params, start: params.start / perMm, end: params.end / perMm, step: params.step / perMm },
    belt: counterRotate(e),
  };
}

/** calib.hpp: 25 layers per speed block; the base model has 5 mm blocks for a 0.4 mm nozzle at 0.2 mm. */
export const VFA_LAYERS_PER_BLOCK = 25;
export const VFA_BASE_BLOCK = 5;
export const VFA_BASE_NOZZLE = 0.4;

export function planVFA(src: PresetSource, params: CalibRequest): CalibPlan {
  const e = new Edits(src, params.extruderId ?? 0);
  const resize = params.nozzleBasedResize !== false;
  const nozzle = e.nozzle(Math.max(params.extruderId ?? 0, 0));
  const layerHeight = (params.vfaLayerHeight ?? 0) > 0 ? params.vfaLayerHeight! : nozzle / 2;
  // Cut the unscaled model at the base block height; the scale then keeps one block = 25 layers.
  const height = VFA_BASE_BLOCK * ((params.end - params.start) / params.step + 1) - EPSILON;
  const xy = nozzle / VFA_BASE_NOZZLE, z = (VFA_LAYERS_PER_BLOCK * layerHeight) / VFA_BASE_BLOCK;
  const scaled = resize && (Math.abs(xy - 1) > EPSILON || Math.abs(z - 1) > EPSILON);
  e.printer('resonance_avoidance', false);
  e.filament('slow_down_layer_time', 0);
  e.print('enable_overhang_speed', false);
  e.print('timelapse_type', '0');
  e.print('wall_loops', 1);
  e.print('alternate_extra_wall', false);
  e.print('top_shell_layers', 0);
  e.print('bottom_shell_layers', 1);
  e.print('sparse_infill_density', '0%');
  e.print('detect_thin_wall', false);
  e.print('spiral_mode', true);
  e.print('enable_wrapping_detection', false);
  e.print('precise_z_height', false);
  if (resize) e.print('initial_layer_print_height', layerHeight);
  return {
    title: 'VFA test', edits: e,
    objects: [{
      name: 'vfa', model: 'vfa/vfa.stl', cuts: [{ z: height, keep: 'lower' }], scale: scaled ? [xy, xy, z] : undefined,
      overrides: objectOverrides(src, { ...(resize ? { layer_height: layerHeight } : {}), brim_type: 'outer_only', brim_width: 3, brim_object_gap: 0 }),
    }],
    params: { ...params, vfaLayerHeight: resize ? layerHeight : 0 },
    belt: counterRotate(e),
  };
}

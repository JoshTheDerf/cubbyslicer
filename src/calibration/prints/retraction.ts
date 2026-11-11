/** Retraction tower: Orca 2.5 Plater::calib_retraction. */
import { Edits, objectOverrides, type PresetSource } from '../edits';
import { counterRotate, EPSILON, type CalibPlan, type CalibRequest } from '../plan';
import { raiseMaxLayerHeight } from './speed';

export function planRetraction(src: PresetSource, params: CalibRequest): CalibPlan {
  const e = new Edits(src, params.extruderId ?? 0);
  e.print('enable_wrapping_detection', false);
  e.print('wipe_inward', false);
  const nozzle = e.nozzle(0);
  const lh = nozzle <= 0.1 ? 0.05 : nozzle <= 0.2 ? 0.1 : 0.2;
  raiseMaxLayerHeight(e, lh);
  e.printer('resonance_avoidance', false);
  e.printer('use_firmware_retraction', false);
  e.print('initial_layer_print_height', lh);
  const height = 1.0 + 0.4 + (params.end - params.start) / params.step - EPSILON;
  return {
    title: 'Retraction', edits: e, params,
    objects: [{
      name: 'retraction_tower', model: 'retraction/retraction_tower.stl', cuts: [{ z: height, keep: 'lower' }],
      overrides: objectOverrides(src, {
        wall_loops: 2, top_shell_layers: 0, bottom_shell_layers: 3, sparse_infill_density: '0%', layer_height: lh,
        alternate_extra_wall: false, seam_position: 'aligned', wall_sequence: 'inner wall/outer wall', overhang_reverse: false,
        precise_z_height: false, seam_slope_type: 'none',
      }),
    }],
    belt: counterRotate(e),
  };
}

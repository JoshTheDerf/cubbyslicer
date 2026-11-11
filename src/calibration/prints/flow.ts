/**
 * Flow ratio: Orca 2.5 Plater::calib_flowrate, adjust_settings_for_flowrate_calib
 * and CalibUtils generate_max_speed_parameter_value.
 */
import { Edits, objectOverrides, type PresetSource } from '../edits';
import { mm3PerMm } from '../flowMath';
import { counterRotate, type CalibPlan } from '../plan';

export type FlowPass = { linear: boolean; pass: 1 | 2; pattern: 'archimedeanchords' | 'monotonic' };

export function flowTitle(opt: FlowPass): string {
  return opt.linear ? `Orca YOLO Flow Calibration${opt.pass === 2 ? ' - Perfectionist version' : ''}` : `Flowrate Test - Pass${opt.pass}`;
}

export function flowModel(opt: FlowPass): string {
  return `filament_flow/${opt.linear ? (opt.pass === 1 ? 'Orca-LinearFlow.3mf' : 'Orca-LinearFlow_fine.3mf') : `flowrate-test-pass${opt.pass}.3mf`}`;
}

/**
 * generate_max_speed_parameter_value: per extruder, the process speed capped
 * by what the filament's max volumetric speed allows for the test's
 * extrusion (plus the flow the test adds), floored; each value repeated once
 * per extruder like Orca (extruder count × nozzle-volume-type count). An
 * unset volumetric limit (0) leaves the speed uncapped.
 */
export function maxSpeedValues(e: Edits, key: string, lineWidth: number, layerHeight: number, linear: boolean, pass: 1 | 2): number[] {
  const n = e.extruderCount();
  const perMm = mm3PerMm(lineWidth, layerHeight);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const maxVol = e.num('filament', 'filament_max_volumetric_speed', i);
    const flow = e.num('filament', 'filament_flow_ratio', i, 1) || 1;
    const maxSpeed = linear ? maxVol / ((perMm * (flow + (pass === 2 ? 0.035 : 0.05))) / flow) : maxVol / (perMm * (pass === 1 ? 1.2 : 1));
    const cur = e.num('process', key, i);
    const v = Math.floor(maxVol > 0 ? Math.min(cur, maxSpeed) : cur);
    for (let k = 0; k < n; k++) out.push(v);
  }
  return out;
}

/** One object of the flow-rate model file: its name (carries the flow offset) and XY centre in the file. */
export interface FlowPart { name: string; centre: [number, number] }

export function planFlowRate(src: PresetSource, opt: FlowPass, parts: FlowPart[]): CalibPlan {
  const e = new Edits(src, 0);
  // The model is made for a 0.4 nozzle; z scales to 10 layers (2 bottom, 5 top, 3 sparse).
  const nozzle = e.nozzle(0);
  const xyScale = nozzle / 0.6;
  const layerHeight = nozzle / 2;
  const firstLayer = Math.max(e.num('process', 'initial_layer_print_height', 0), layerHeight);
  const zScale = (firstLayer + 9 * layerHeight) / 2;
  const s = xyScale > 1.2 ? xyScale : 1; // only enlarge

  // adjust_settings_for_flowrate_calib: filament_flow_ratio get_at(0), the bare first element.
  const curFlow = e.el('filament', 'filament_flow_ratio', 0, 1) || 1;
  // Cap the speeds for the extrusion the test prints, not the profile's line width and layer height.
  const infillWidth = nozzle * 1.2;
  const internalSolid = maxSpeedValues(e, 'internal_solid_infill_speed', infillWidth, layerHeight, opt.linear, opt.pass);
  const top = maxSpeedValues(e, 'top_surface_speed', infillWidth, layerHeight, opt.linear, opt.pass);

  // Scaled about the group centre, like Orca's selection scale.
  const xs = parts.map((p) => p.centre[0]), ys = parts.map((p) => p.centre[1]);
  const gx = (Math.min(...xs) + Math.max(...xs)) / 2, gy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const objects = parts.map((p, part) => {
    let tag = p.name.length > 9 ? p.name.slice(9) : '';
    if (tag.startsWith('m')) tag = `-${tag.slice(1)}`;
    const parsed = parseFloat(tag);
    const modifier = Number.isFinite(parsed) ? parsed : 1;
    const flowRatio = opt.linear ? (curFlow + modifier) / curFlow : 1 + modifier / 100;
    return {
      name: p.name, model: flowModel(opt), part,
      offset: [(p.centre[0] - gx) * s, (p.centre[1] - gy) * s] as [number, number],
      scale: [s, s, zScale] as [number, number, number],
      overrides: objectOverrides(src, {
        wall_loops: 1, only_one_wall_top: true, thick_internal_bridges: false, enable_extra_bridge_layer: 'disabled',
        internal_bridge_density: '100%', sparse_infill_density: '35%', min_width_top_surface: '100%', bottom_shell_layers: 2,
        top_shell_layers: 5, top_shell_thickness: 0, bottom_shell_thickness: 0, detect_thin_wall: true, filter_out_gap_fill: 0,
        sparse_infill_pattern: 'rectilinear', top_surface_line_width: infillWidth, internal_solid_infill_line_width: infillWidth,
        top_surface_pattern: opt.pattern, top_solid_infill_flow_ratio: 1, infill_direction: 45, solid_infill_direction: 135,
        center_of_surface_pattern: 'each_surface', separated_infills: false, align_infill_direction_to_model: true,
        ironing_type: 'no ironing', internal_solid_infill_speed: internalSolid, top_surface_speed: top, seam_slope_type: 'none',
        gap_fill_target: 'nowhere', calib_flowrate_topinfill_special_order: true, top_surface_fill_order: 'default',
        print_flow_ratio: flowRatio,
      }),
    };
  });
  e.print('max_volumetric_extrusion_rate_slope', 0);
  e.print('layer_height', layerHeight);
  e.print('alternate_extra_wall', false);
  e.print('initial_layer_print_height', firstLayer);
  e.print('reduce_crossing_wall', true);
  e.print('enable_wrapping_detection', false);
  e.printer('resonance_avoidance', false);
  // Orca sets no Calib_Params for flow ratio (the per-object flow ratios do the work).
  return { title: flowTitle(opt), edits: e, objects, params: null, belt: counterRotate(e) };
}

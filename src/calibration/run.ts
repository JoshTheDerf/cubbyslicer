/**
 * Calibration menu entry points: ports of OrcaSlicer 2.5 Plater::calib_*
 * (Plater.cpp) and CalibUtils. Each test is planned purely in `prints/`
 * (models, cuts, scales, preset edits, per-object overrides, Calib_Params)
 * and applied by `apply.ts`; the dialogs' maths is in `forms.ts`.
 */
import { resolvedConfig } from '../app/state';
import type { CalibParams } from '../engine/types';
import { asList, cfgAbs, cfgBool, cfgNumber, cfgString, SCALAR } from '../lib/configValue';
import { currentPresets } from '../presets/store';
import { liveContext, livePresetSource, loadCalibModel, runCalibration, startCalibration, fileCentre } from './apply';
import { autoExtrusionWidth } from './flowMath';
import type { CalibRequest } from './plan';
import { planFlowRate, flowModel, type FlowPass } from './prints/flow';
import { planCornering, planInputShaping } from './prints/motion';
import { planPA } from './prints/pa';
import { planRetraction } from './prints/retraction';
import { planMaxVolSpeed, planVFA } from './prints/speed';
import { planTemp } from './prints/temp';

export { calibAssetUrl, loadCalibModel } from './apply';
export { addHandyModel, addToleranceTest, HANDY_MODELS, type HandyModel } from './handyModels';
export type { FlowPass } from './prints/flow';
export type { CalibRequest } from './plan';

export function calibPA(params: CalibParams): Promise<boolean> {
  return runCalibration('pressure advance test', () => startCalibration(() => planPA(livePresetSource(), params, liveContext)));
}

export function calibFlowRate(opt: FlowPass): Promise<boolean> {
  return runCalibration('flow ratio test', async () => {
    const parts = (await loadCalibModel(flowModel(opt))).map((p) => ({ name: p.name, centre: fileCentre(p) }));
    return startCalibration(() => planFlowRate(livePresetSource(), opt, parts));
  });
}

export function calibTemp(params: CalibRequest): Promise<boolean> {
  return runCalibration('temperature tower', () => startCalibration(() => planTemp(livePresetSource(), params)));
}

export function calibMaxVolSpeed(params: CalibParams): Promise<boolean> {
  return runCalibration('max flowrate test', () => startCalibration(() => planMaxVolSpeed(livePresetSource(), params, liveContext)));
}

export function calibRetraction(params: CalibParams): Promise<boolean> {
  return runCalibration('retraction test', () => startCalibration(() => planRetraction(livePresetSource(), params)));
}

export function calibVFA(params: CalibRequest): Promise<boolean> {
  return runCalibration('VFA test', () => startCalibration(() => planVFA(livePresetSource(), params)));
}

export function calibInputShapingFreq(params: CalibParams): Promise<boolean> {
  return runCalibration('input shaping test', () => startCalibration(() => planInputShaping(livePresetSource(), params)));
}
export const calibInputShapingDamp = calibInputShapingFreq;

export function calibCornering(params: CalibParams): Promise<boolean> {
  return runCalibration('cornering test', () => startCalibration(() => planCornering(livePresetSource(), params)));
}

/** Printer / filament facts the dialogs show and validate against (calib_dlg.cpp reads them from the edited presets). */
export interface CalibPrinterFacts {
  flavor: string;
  junctionDeviation: boolean;
  nozzle: number;
  nozzles: number;
  lineWidth: number;
  /** belt_printer: temperature tower "Test model" picker, PA tower only. */
  belt: boolean;
  /** VFA_Test_Dlg::on_start inputs. */
  vfa: { presetLayerHeight: number; maxVolSpeed: number; minLayerHeight: number; maxLayerHeight: number; wallLineWidth: number };
}

export function calibPrinterFacts(): CalibPrinterFacts {
  const cfg = resolvedConfig.value;
  const flavor = cfgString(cfg, 'gcode_flavor', SCALAR);
  const nozzle = cfgNumber(cfg, 'nozzle_diameter', SCALAR, 0.4) || 0.4;
  let wallLineWidth = cfgAbs(cfg, 'outer_wall_line_width', SCALAR, nozzle);
  if (wallLineWidth <= 0) wallLineWidth = cfgAbs(cfg, 'line_width', SCALAR, nozzle);
  if (wallLineWidth <= 0) wallLineWidth = nozzle;
  return {
    flavor,
    junctionDeviation: flavor === 'marlin2' && cfgNumber(cfg, 'machine_max_junction_deviation', SCALAR, 0) > 0,
    nozzle,
    nozzles: asList(cfg.nozzle_diameter).length || 1,
    lineWidth: cfgAbs(cfg, 'line_width', SCALAR, nozzle) || autoExtrusionWidth(nozzle),
    belt: cfgBool(cfg, 'belt_printer', SCALAR),
    vfa: {
      presetLayerHeight: cfgNumber(cfg, 'layer_height', SCALAR, 0),
      // calib_dlg reads the first filament's value at the extruder index (get_at(extruder_id)).
      maxVolSpeed: cfgNumber(cfg, 'filament_max_volumetric_speed', SCALAR, 0),
      minLayerHeight: cfgNumber(cfg, 'min_layer_height', SCALAR, 0),
      maxLayerHeight: cfgNumber(cfg, 'max_layer_height', SCALAR, 0),
      wallLineWidth,
    },
  };
}

/** Layer heights of the process presets compatible with the printer (VFA auto-adjust candidates). */
export async function compatibleLayerHeights(): Promise<number[]> {
  const p = currentPresets.value;
  const out: number[] = [];
  for (const info of p.compatible.value.process) {
    if (info.id === 'default') continue;
    const r = await p.resolvePreset('process', info.id).catch(() => null);
    const lh = parseFloat(String(asList(r?.values.layer_height)[0] ?? ''));
    if (lh > 0) out.push(lh);
  }
  return out;
}

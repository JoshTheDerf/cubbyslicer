/**
 * Calibration dialog models (calib_dlg.cpp): defaults, presets per filament /
 * extruder type, validation messages and Calib_Params building. Pure.
 */
import type { CalibParams } from '../engine/types';
import { mm3PerMm, parseIntList } from './flowMath';
import type { CalibRequest } from './plan';

// ---- temperature -------------------------------------------------------------------------

export const TEMP_FILAMENTS = ['PLA', 'ABS/ASA', 'PETG', 'PCTG', 'TPU', 'PA-CF', 'PET-CF', 'Custom'] as const;
export type TempFilament = (typeof TEMP_FILAMENTS)[number];

/** Temp_Calibration_Dlg::on_filament_type_changed (by label; Orca's index table is off by one after TPU). */
export function tempRangeFor(f: TempFilament): { start: number; end: number } {
  switch (f) {
    case 'ABS/ASA': return { start: 270, end: 230 };
    case 'PETG': return { start: 250, end: 230 };
    case 'PCTG': return { start: 280, end: 240 };
    case 'TPU': return { start: 240, end: 210 };
    case 'PA-CF': case 'PET-CF': return { start: 320, end: 280 };
    default: return { start: 230, end: 190 };
  }
}

/** Pick the dialog's filament type from the selected filament's `filament_type`. */
export function tempFilamentOf(type: string): TempFilament {
  const t = type.toUpperCase();
  if (t.startsWith('PLA')) return 'PLA';
  if (t.startsWith('ABS') || t.startsWith('ASA')) return 'ABS/ASA';
  if (t === 'PCTG') return 'PCTG';
  if (t.startsWith('PETG')) return 'PETG';
  if (t.startsWith('TPU') || t === 'FLEX') return 'TPU';
  if (t.startsWith('PA') && t.includes('CF')) return 'PA-CF';
  if (t.startsWith('PET') && t.includes('CF')) return 'PET-CF';
  return 'Custom';
}

/** Temp dialog field clamp on blur: 155…500, multiple of 5. */
export function snapTemp(t: number): number {
  if (!Number.isFinite(t)) return 155;
  return Math.floor(Math.max(155, Math.min(500, Math.round(t))) / 5) * 5;
}

/** Temp_Calibration_Dlg::on_start. `resize`: "Auto-scale for nozzle"; `model` (belt printers only): 0 Standard, 1 Overhang. */
export function tempParams(start: number, end: number, resize = true, model = 0): CalibRequest | string {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > 500 || end < 155 || end > start - 5) {
    return 'Please enter valid values: start ≤ 500 °C, end ≥ 155 °C and start ≥ end + 5 °C.';
  }
  return { mode: 'temp_tower', start: Math.round(start), end: Math.round(end), step: 5, nozzleBasedResize: resize, testModel: model };
}

// ---- pressure advance -------------------------------------------------------------------

export type PAMethod = 'pa_tower' | 'pa_line' | 'pa_pattern';
export interface PAForm { method: PAMethod; bowden: boolean; start: number; end: number; step: number; printNumbers: boolean; accels: string; speeds: string }

/** Belt printers only run the PA tower so far (calib_dlg.cpp is_belt_printer_selected). */
export function paMethodsFor(belt: boolean): PAMethod[] { return belt ? ['pa_tower'] : ['pa_tower', 'pa_line', 'pa_pattern']; }

/** PA_Calibration_Dlg::reset_params. */
export function paDefaults(method: PAMethod, bowden: boolean): Pick<PAForm, 'start' | 'end' | 'step' | 'printNumbers'> {
  let end = method === 'pa_pattern' ? 0.08 : 0.1;
  let step = method === 'pa_pattern' ? 0.005 : 0.002;
  if (bowden) { end = 1.0; step = method === 'pa_pattern' ? 0.05 : 0.02; }
  return { start: 0, end, step, printNumbers: method !== 'pa_tower' };
}

export function paParams(f: PAForm): CalibParams | string {
  if (![f.start, f.end, f.step].every(Number.isFinite) || f.start < 0 || f.step < 1e-3 - 1e-9 || f.end < f.start + f.step) {
    return 'Please enter valid values: start PA ≥ 0, PA step ≥ 0.001 and end PA > start PA + step.';
  }
  const accelerations = f.method === 'pa_pattern' ? parseIntList(f.accels) : [];
  const speeds = f.method === 'pa_pattern' ? parseIntList(f.speeds) : [];
  if (accelerations.length && speeds.length && Math.min(...accelerations) <= Math.max(...speeds)) {
    return 'Acceleration values must be greater than speed values. Please check the inputs.';
  }
  return { mode: f.method, start: f.start, end: f.end, step: f.step, printNumbers: f.method === 'pa_line' ? f.printNumbers : f.method === 'pa_pattern', accelerations, speeds };
}

// ---- simple ranges ------------------------------------------------------------------------

export function rangeParams(mode: 'retraction_tower' | 'vol_speed_tower' | 'vfa_tower', start: number, end: number, step: number): CalibParams | string {
  const bad = ![start, end, step].every(Number.isFinite) || step <= 0 || end < start + step
    || (mode === 'retraction_tower' ? start < 0 : mode === 'vol_speed_tower' ? start <= 0 : start <= 10);
  if (bad) {
    const min = mode === 'retraction_tower' ? 'start ≥ 0' : mode === 'vol_speed_tower' ? 'start > 0' : 'start > 10';
    return `Please enter valid values: ${min}, step > 0 and end ≥ start + step.`;
  }
  return { mode, start, end, step };
}

// ---- VFA auto-adjust (VFA_Test_Dlg::on_start) ----------------------------------------------

export interface VfaFacts {
  nozzle: number;
  /** Process layer height (used when not resizing). */
  presetLayerHeight: number;
  /** filament_max_volumetric_speed (0: no limit). */
  maxVolSpeed: number;
  /** Printer min / max layer height (0: unset). */
  minLayerHeight: number;
  maxLayerHeight: number;
  /** Outer wall line width, else line width, else the nozzle. */
  lineWidth: number;
}

export type VfaDecision =
  | { kind: 'ok' }
  /** The layer height was lowered to reach the end speed: tell the user. */
  | { kind: 'reduced'; layerHeight: number; message: string }
  /** Even the smallest layer height can't reach it: lower the end speed too, if the user agrees. */
  | { kind: 'lower-end'; layerHeight: number; end: number; message: string }
  /** The top blocks will be clamped: continue only if the user agrees. */
  | { kind: 'clamp'; message: string };

/** Max outer-wall speed at layer height `lh` within the filament's volumetric limit. */
export function vfaSpeedLimit(f: VfaFacts, lh: number): number {
  const perMm = mm3PerMm(f.lineWidth, lh);
  return perMm > 0 ? f.maxVolSpeed / perMm : 1e9;
}

/**
 * When the end speed exceeds what the filament's max volumetric speed allows,
 * the engine clamps the outer wall speed and the top blocks print at the same
 * speed. With auto-adjust (and resizing) pick the largest layer height of the
 * printer's compatible process presets (within the machine limits, never
 * above the default) that reaches the end speed; failing that, the smallest
 * one and a lower end speed. `candidates` is only called when needed.
 */
export async function vfaAdjust(p: { start: number; end: number; step: number }, resize: boolean, autoAdjust: boolean, f: VfaFacts,
  candidates: () => number[] | Promise<number[]>): Promise<VfaDecision> {
  const defaultLh = resize ? f.nozzle / 2 : (f.presetLayerHeight > 0 ? f.presetLayerHeight : f.nozzle / 2);
  if (!(f.maxVolSpeed > 0 && f.nozzle > 0 && p.end > vfaSpeedLimit(f, defaultLh))) return { kind: 'ok' };
  const over = `The end speed (${p.end.toFixed(0)} mm/s) exceeds the filament’s maximum volumetric speed (${f.maxVolSpeed.toFixed(1)} mm³/s)`;
  const clamp = (question: string): VfaDecision => ({
    kind: 'clamp',
    message: `${over}, which limits the outer wall to about ${vfaSpeedLimit(f, defaultLh).toFixed(0)} mm/s at this line width and layer height. `
      + `Speeds above this will be clamped, so the upper blocks of the tower will not print at the requested speed. ${question}`,
  });
  if (!(autoAdjust && resize)) {
    return clamp(resize ? 'Enable “Auto-adjust” to fix this automatically, or continue anyway?'
      : 'Enable “Auto-scale for nozzle” and “Auto-adjust” to fix this automatically, or continue anyway?');
  }
  const list = [...new Set((await candidates())
    .filter((lh) => lh > 0 && !(f.minLayerHeight > 0 && lh < f.minLayerHeight - 1e-6) && !(f.maxLayerHeight > 0 && lh > f.maxLayerHeight + 1e-6))
    .map((lh) => Math.round(lh * 1e6) / 1e6))].sort((a, b) => a - b);
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] > defaultLh + 1e-6) continue; // never raise the layer height above the default
    if (vfaSpeedLimit(f, list[i]) >= p.end) {
      return {
        kind: 'reduced', layerHeight: list[i],
        message: `${over} at the default layer height (${defaultLh.toFixed(2)} mm). The layer height has been reduced to ${list[i].toFixed(2)} mm (a value used by this printer’s profiles) so the tower can reach the requested speed.`,
      };
    }
  }
  if (!list.length) return clamp('Continue anyway?');
  const minLh = list[0];
  let end = Math.floor(vfaSpeedLimit(f, minLh) / p.step) * p.step; // snap down to a step multiple
  if (end < p.start + p.step) end = p.start + p.step;
  return {
    kind: 'lower-end', layerHeight: minLh, end,
    message: `Even at the smallest layer height used by this printer’s profiles (${minLh.toFixed(2)} mm) the end speed (${p.end.toFixed(0)} mm/s) exceeds the filament’s maximum volumetric speed (${f.maxVolSpeed.toFixed(1)} mm³/s). `
      + `The layer height will be set to ${minLh.toFixed(2)} mm and the end speed lowered to ${end.toFixed(0)} mm/s. Continue?`,
  };
}

// ---- input shaping / cornering ----------------------------------------------------------------

/** Tab.cpp input_shaper_types_for_flavor without "Disable". */
export function shaperTypesFor(flavor: string): string[] {
  switch (flavor) {
    case 'klipper': return ['Default', 'ZV', 'MZV', 'ZVD', 'EI', '2HUMP_EI', '3HUMP_EI'];
    case 'reprapfirmware': return ['Default', 'MZV', 'ZVD', 'ZVDD', 'ZVDDD', 'EI2', 'EI3', 'DAA'];
    case 'marlin2': return ['ZV'];
    default: return ['Default'];
  }
}

export interface ShapingFreqForm { model: 0 | 1; shaper: string; startX: number; endX: number; startY: number; endY: number; damp: number }
export function shapingFreqParams(f: ShapingFreqForm, reprap: boolean): CalibParams | string {
  const sy = reprap ? f.startX : f.startY, ey = reprap ? f.endX : f.endY;
  if (![f.startX, f.endX, sy, ey, f.damp].every(Number.isFinite) || f.startX < 0 || f.endX > 500 || sy < 0 || ey > 500 || f.startX >= f.endX || sy >= ey) {
    return 'Please enter valid values: 0 < start frequency < end frequency < 500 Hz.';
  }
  if (f.damp < 0 || f.damp >= 1) return 'Please enter a valid damping factor (0 ≤ damping < 1).';
  return { mode: 'input_shaping_freq', start: f.damp, end: 0, step: 0, freqStartX: f.startX, freqEndX: f.endX, freqStartY: sy, freqEndY: ey, shaperType: f.shaper, testModel: f.model };
}

export interface ShapingDampForm { model: 0 | 1; shaper: string; freqX: number; freqY: number; start: number; end: number }
export function shapingDampParams(f: ShapingDampForm, reprap: boolean): CalibParams | string {
  const fy = reprap ? f.freqX : f.freqY;
  if (![f.freqX, fy, f.start, f.end].every(Number.isFinite) || f.freqX < 0 || f.freqX > 500 || fy < 0 || fy > 500) {
    return 'Please enter valid values: 0 < frequency < 500 Hz.';
  }
  if (f.start < 0 || f.end > 1 || f.start >= f.end) return 'Please enter a valid damping range (0 ≤ start < end ≤ 1).';
  return { mode: 'input_shaping_damp', start: f.start, end: f.end, step: 0, freqStartX: f.freqX, freqStartY: fy, shaperType: f.shaper, testModel: f.model };
}

/** Cornering_Test_Dlg: junction deviation (mm) on Marlin 2 with JD > 0, else classic jerk (mm/s). */
export function corneringDefaults(junctionDeviation: boolean): { start: number; end: number; unit: string; max: number; warn: number } {
  return junctionDeviation ? { start: 0, end: 0.25, unit: 'mm', max: 0.3, warn: 0.25 } : { start: 1, end: 15, unit: 'mm/s', max: 100, warn: 20 };
}

export function corneringParams(start: number, end: number, model: number, junctionDeviation: boolean): { params: CalibParams; warning?: string } | string {
  const d = corneringDefaults(junctionDeviation);
  if (![start, end].every(Number.isFinite) || start < 0 || end > d.max || start >= end) return `Please enter valid values: 0 ≤ start < end ≤ ${d.max.toFixed(3)}.`;
  return { params: { mode: 'cornering', start, end, step: 0, testModel: model }, warning: end > d.warn ? `High values may cause layer shifts (> ${d.warn.toFixed(3)} ${d.unit}).` : undefined };
}

// ---- dialog defaults (calib_dlg.cpp) ----------------------------------------------------------

/** Retraction / max volumetric speed / VFA dialogs' start, end and step. */
export function rangeDefaults(mode: 'retraction_tower' | 'vol_speed_tower' | 'vfa_tower'): { start: number; end: number; step: number } {
  if (mode === 'retraction_tower') return { start: 0, end: 2, step: 0.1 };
  if (mode === 'vol_speed_tower') return { start: 5, end: 20, step: 0.5 };
  return { start: 40, end: 200, step: 10 };
}

export const SHAPING_FREQ_DEFAULTS: Omit<ShapingFreqForm, 'shaper'> = { model: 0, startX: 15, endX: 110, startY: 15, endY: 110, damp: 0.15 };
export const SHAPING_DAMP_DEFAULTS: Omit<ShapingDampForm, 'shaper'> = { model: 0, freqX: 30, freqY: 30, start: 0, end: 0.4 };

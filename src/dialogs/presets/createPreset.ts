/**
 * Orca CreatePresetsDialog (CreatePrinterPresetDialog / CreateFilamentPresetDialog)
 * value building: a custom printer (vendor, model, nozzle, bed, height) or
 * a custom filament (vendor, type, serial) as a user preset on top of a
 * template preset. Pure.
 */
import type { ConfigSchema } from '../../engine/types';
import type { PresetValues } from '../../presets/types';
import { asArray } from '../../presets/values';

export const NOZZLES = ['0.2', '0.25', '0.3', '0.35', '0.4', '0.5', '0.6', '0.75', '0.8', '1.0', '1.2'];

export interface PrinterForm {
  vendor: string;
  model: string;
  nozzle: string;
  width: number;
  depth: number;
  /** Orca BedShapeDialog origin: where (0,0) sits, measured from the bed's front-left corner. */
  originX: number;
  originY: number;
  height: number;
}

export function printerPresetName(f: Pick<PrinterForm, 'vendor' | 'model' | 'nozzle'>): string {
  return `${[f.vendor.trim(), f.model.trim()].filter(Boolean).join(' ') || 'My Printer'} ${f.nozzle} nozzle`;
}

/** Rectangle "XxY" points with Orca's origin convention (origin (10,10) → corner at -10,-10). */
export function rectBed(width: number, depth: number, originX: number, originY: number): string[] {
  const x0 = -originX, y0 = -originY;
  const f = (n: number) => String(Math.round(n * 1000) / 1000);
  return [`${f(x0)}x${f(y0)}`, `${f(x0 + width)}x${f(y0)}`, `${f(x0 + width)}x${f(y0 + depth)}`, `${f(x0)}x${f(y0 + depth)}`];
}

/**
 * Values a new printer preset gets on top of its template: model / variant,
 * every extruder's nozzle, the bed and the max height (Orca or preFlight keys).
 */
export function printerOverrides(f: PrinterForm, schema: ConfigSchema | null, templateNozzles: string[]): PresetValues {
  const has = (k: string) => !schema || !!schema.options[k];
  const out: PresetValues = {};
  const nozzles = Math.max(1, templateNozzles.length);
  const set = (k: string, v: PresetValues[string]) => { if (has(k)) out[k] = v; };
  set('printer_model', f.model.trim() || 'Custom');
  set('printer_variant', f.nozzle);
  set('nozzle_diameter', Array.from({ length: nozzles }, () => f.nozzle));
  const bed = rectBed(f.width, f.depth, f.originX, f.originY);
  if (schema?.options.printable_area || !schema) set('printable_area', bed);
  else set('bed_shape', bed);
  if (schema?.options.printable_height || !schema) set('printable_height', String(f.height));
  else set('max_print_height', String(f.height));
  return out;
}

export interface FilamentForm { vendor: string; type: string; serial: string; printers: string[] }

export function filamentPresetName(f: Pick<FilamentForm, 'vendor' | 'type' | 'serial'>): string {
  return [f.vendor.trim(), f.type.trim(), f.serial.trim()].filter(Boolean).join(' ') || 'My Filament';
}

/** Values a new filament preset gets on top of its base filament. */
export function filamentOverrides(f: FilamentForm, schema: ConfigSchema | null, base: PresetValues): PresetValues {
  const has = (k: string) => !schema || !!schema.options[k];
  const out: PresetValues = {};
  if (has('filament_vendor')) out.filament_vendor = [f.vendor.trim() || 'Generic'];
  if (has('filament_type') && f.type && asArray(base.filament_type)[0] !== f.type) out.filament_type = [f.type];
  // Chosen printers only; none = every printer (no list, no condition).
  out.compatible_printers = f.printers.slice();
  out.compatible_printers_condition = '';
  return out;
}

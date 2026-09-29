/**
 * Orca ExportConfigsDialog (CreatePresetsDialog.cpp) formats for user presets:
 *
 *   Printer config bundle (.orca_printer): bundle_structure.json +
 *     printer/<name>.json + filament/<name>.json + process/<name>.json
 *     (the printer and the user filament / process presets made for it);
 *   Filament bundle (.orca_filament): bundle_structure.json +
 *     <printer vendor>/<name>.json per filament preset;
 *   Printer / filament / process presets (.zip): flat <name>.json files.
 *
 * Preset JSON is Orca's user-preset file (userPresets.toOrcaJson) plus the
 * "version" Orca requires on import. bundleImport.readPresetFile reads all of
 * these back.
 */
import { zipSync, strToU8 } from 'fflate';
import type { PresetKind } from '../../presets/types';
import { toOrcaJson, type UserPreset } from '../../presets/userPresets';
import { asArray } from '../../presets/values';

export const ORCA_PRESET_VERSION = '2.4.2.0';

export type ExportKind = 'printer_bundle' | 'filament_bundle' | 'printer_presets' | 'filament_presets' | 'process_presets';

export const EXPORT_LABELS: Record<ExportKind, string> = {
  printer_bundle: 'Printer config bundle (.orca_printer)',
  filament_bundle: 'Filament bundle (.orca_filament)',
  printer_presets: 'Printer presets (.zip)',
  filament_presets: 'Filament presets (.zip)',
  process_presets: 'Process presets (.zip)',
};

/** Orca user-preset JSON for a stored user preset. */
export function presetJson(p: UserPreset): Record<string, unknown> {
  const json = toOrcaJson(p.kind, p.name, p.values, p.inherits);
  return { ...json, version: ORCA_PRESET_VERSION };
}

export function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').trim() || 'preset';
}

const json = (v: unknown) => strToU8(JSON.stringify(v, null, 4));

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Names a user filament / process preset is compatible with (empty = every printer). */
export function compatiblePrinters(p: UserPreset): string[] {
  return asArray(p.values.compatible_printers).filter(Boolean);
}

/** Whether a user filament / process preset belongs with printer `printerName` (Orca m_filament_presets / m_process_presets). */
export function belongsTo(p: UserPreset, printerName: string, printerParent?: string): boolean {
  const list = compatiblePrinters(p);
  if (list.length) return list.includes(printerName) || (!!printerParent && list.includes(printerParent));
  return false;
}

export interface BundleFile { filename: string; data: Uint8Array; count: number }

/** .orca_printer for one user printer preset and the user filament / process presets made for it. */
export function printerBundle(printer: UserPreset, all: UserPreset[], opts: { parentName?: string; now?: Date } = {}): BundleFile {
  const files: Record<string, Uint8Array> = {};
  const structure = {
    version: '',
    bundle_id: `offline_${printer.name}_${timestamp(opts.now)}`,
    bundle_type: 'printer config bundle',
    printer_preset_name: printer.name,
    printer_config: [] as string[],
    filament_config: [] as string[],
    process_config: [] as string[],
  };
  const add = (dir: string, p: UserPreset, list: string[]) => {
    const path = `${dir}/${safeName(p.name)}.json`;
    files[path] = json(presetJson(p));
    list.push(path);
  };
  add('printer', printer, structure.printer_config);
  for (const p of all) {
    if (p.kind === 'filament' && belongsTo(p, printer.name, opts.parentName)) add('filament', p, structure.filament_config);
    if (p.kind === 'process' && belongsTo(p, printer.name, opts.parentName)) add('process', p, structure.process_config);
  }
  files['bundle_structure.json'] = json(structure);
  return { filename: `${safeName(printer.name)}.orca_printer`, data: zipSync(files), count: Object.keys(files).length - 1 };
}

/** .orca_filament for user filament presets sharing a display name (grouped by printer vendor). */
export function filamentBundle(filamentName: string, presets: Array<{ preset: UserPreset; vendor: string }>, now?: Date): BundleFile {
  const files: Record<string, Uint8Array> = {};
  const byVendor = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const { preset, vendor } of presets) {
    const v = vendor || 'Custom';
    const key = `${v}|${preset.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const path = `${safeName(v)}/${safeName(preset.name)}.json`;
    files[path] = json(presetJson(preset));
    byVendor.set(v, [...(byVendor.get(v) ?? []), path]);
  }
  const structure = {
    version: '',
    bundle_id: `offline_${filamentName}_${timestamp(now)}`,
    bundle_type: 'filament config bundle',
    filament_name: filamentName,
    printer_vendor: [...byVendor.entries()].map(([vendor, filament_path]) => ({ vendor, filament_path })),
  };
  files['bundle_structure.json'] = json(structure);
  return { filename: `${safeName(filamentName)}.orca_filament`, data: zipSync(files), count: seen.size };
}

/** Flat zip of preset JSON files (Orca "Printer / Filament / Process presets (.zip)"). */
export function presetsZip(kind: PresetKind, presets: UserPreset[]): BundleFile {
  const files: Record<string, Uint8Array> = {};
  for (const p of presets) files[`${safeName(p.name)}.json`] = json(presetJson(p));
  const title = kind === 'printer' ? 'Printer' : kind === 'filament' ? 'Filament' : 'Process';
  return { filename: `${title} presets.zip`, data: zipSync(files), count: presets.length };
}

/** Orca groups filament presets by name without the "@printer" suffix. */
export function filamentBaseName(name: string): string {
  return name.replace(/\s*@.*$/, '').trim() || name;
}

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
 *
 * "Include custom bed texture and model" (Orca 2.5.0 append_printer_bed_assets,
 * PresetBundle.cpp): the printer's bed_custom_texture (.png / .svg) and
 * bed_custom_model (.stl) go in as bed/0/texture<ext> and bed/0/model.stl, and
 * bundle_structure.json gets
 *   "printer_asset": { "printer/<name>.json": { "bed_custom_texture": "bed/0/texture.png", ... } }.
 * The printer JSON keeps its own option value; the importer rewrites it.
 */
import { asList } from '../../lib/configValue';
import { zipSync, strToU8 } from 'fflate';
import { BED_ASSET_SLOTS, bedAssetExtension, type BedAssetFile, type BedAssetOption } from '../../presets/bundleImport';
import type { PresetKind } from '../../presets/types';
import { toOrcaJson, type UserPreset } from '../../presets/userPresets';


/** Orca's preset file version (`version`): the engine's version as four numbers; 2.5.0 when it isn't known. */
export const ORCA_PRESET_VERSION = '2.5.0.0';

/** "2.5.0" / "2.5.0-rc" → "2.5.0.0" (Semver of four parts, as Orca writes it). */
export function presetVersionTag(engineVersion: string | undefined): string {
  const nums = (engineVersion ?? '').match(/\d+/g)?.slice(0, 4) ?? [];
  if (nums.length < 2) return ORCA_PRESET_VERSION;
  while (nums.length < 4) nums.push('0');
  return nums.join('.');
}

export type ExportKind = 'printer_bundle' | 'filament_bundle' | 'printer_presets' | 'filament_presets' | 'process_presets';

export const EXPORT_LABELS: Record<ExportKind, string> = {
  printer_bundle: 'Printer config bundle (.orca_printer)',
  filament_bundle: 'Filament bundle (.orca_filament)',
  printer_presets: 'Printer presets (.zip)',
  filament_presets: 'Filament presets (.zip)',
  process_presets: 'Process presets (.zip)',
};

/** Orca user-preset JSON for a stored user preset. */
export function presetJson(p: UserPreset, version = ORCA_PRESET_VERSION): Record<string, unknown> {
  const json = toOrcaJson(p.kind, p.name, p.values, p.inherits);
  return { ...json, version };
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').trim() || 'preset';
}

const json = (v: unknown) => strToU8(JSON.stringify(v, null, 4));

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Names a user filament / process preset is compatible with (empty = every printer). */
export function compatiblePrinters(p: UserPreset): string[] {
  return asList(p.values.compatible_printers).filter(Boolean);
}

/** Whether a user filament / process preset belongs with printer `printerName` (Orca m_filament_presets / m_process_presets). */
function belongsTo(p: UserPreset, printerName: string, printerParent?: string): boolean {
  const list = compatiblePrinters(p);
  if (list.length) return list.includes(printerName) || (!!printerParent && list.includes(printerParent));
  return false;
}

export interface BundleFile { filename: string; data: Uint8Array; count: number }

/** .orca_printer for one user printer preset and the user filament / process presets made for it. */
export function printerBundle(printer: UserPreset, all: UserPreset[], opts: {
  parentName?: string; now?: Date; version?: string;
  /** The printer's custom bed files (name = the stored file name, which gives the extension); none when "Include custom bed texture and model" is off. */
  bedAssets?: Partial<Record<BedAssetOption, BedAssetFile>>;
} = {}): BundleFile {
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
    files[path] = json(presetJson(p, opts.version));
    list.push(path);
  };
  add('printer', printer, structure.printer_config);
  for (const p of all) {
    if (p.kind === 'filament' && belongsTo(p, printer.name, opts.parentName)) add('filament', p, structure.filament_config);
    if (p.kind === 'process' && belongsTo(p, printer.name, opts.parentName)) add('process', p, structure.process_config);
  }
  const count = Object.keys(files).length;
  const printerEntry = structure.printer_config[0];
  const assets: Partial<Record<BedAssetOption, string>> = {};
  for (const { option, stem } of BED_ASSET_SLOTS) {
    const f = opts.bedAssets?.[option];
    const ext = f ? bedAssetExtension(f.name, option) : '';
    if (!f || !ext) continue;
    const zipName = `bed/0/${stem}${ext}`;
    files[zipName] = f.data;
    assets[option] = zipName;
  }
  const manifest = Object.keys(assets).length ? { ...structure, printer_asset: { [printerEntry]: assets } } : structure;
  files['bundle_structure.json'] = json(manifest);
  return { filename: `${safeName(printer.name)}.orca_printer`, data: zipSync(files), count };
}

/** .orca_filament for user filament presets sharing a display name (grouped by printer vendor). */
export function filamentBundle(filamentName: string, presets: Array<{ preset: UserPreset; vendor: string }>, now?: Date, version?: string): BundleFile {
  const files: Record<string, Uint8Array> = {};
  const byVendor = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const { preset, vendor } of presets) {
    const v = vendor || 'Custom';
    const key = `${v}|${preset.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const path = `${safeName(v)}/${safeName(preset.name)}.json`;
    files[path] = json(presetJson(preset, version));
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
export function presetsZip(kind: PresetKind, presets: UserPreset[], version?: string): BundleFile {
  const files: Record<string, Uint8Array> = {};
  for (const p of presets) files[`${safeName(p.name)}.json`] = json(presetJson(p, version));
  const title = kind === 'printer' ? 'Printer' : kind === 'filament' ? 'Filament' : 'Process';
  return { filename: `${title} presets.zip`, data: zipSync(files), count: presets.length };
}

/** Orca groups filament presets by name without the "@printer" suffix. */
export function filamentBaseName(name: string): string {
  return name.replace(/\s*@.*$/, '').trim() || name;
}

/** Bytes of a data: URL (how the Bed shape dialog stores picked files). */
export function dataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) throw new Error('not a data URL');
  const head = dataUrl.slice(5, comma);
  const body = dataUrl.slice(comma + 1);
  if (/;base64$/i.test(head)) {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return strToU8(decodeURIComponent(body));
}

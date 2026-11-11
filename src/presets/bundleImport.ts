/**
 * Best-effort reader for preset files users drop in:
 *   - single preset JSON (Orca/Bambu user preset, or a system preset file)
 *   - JSON array of presets
 *   - flat bundle `{ "<name>": {type, inherits, ...}, ... }` (orca_system_profiles.json style)
 *   - zip archives (.zip, .orca_printer, .orca_filament, .bbscfg, .bbsflmt) → every .json inside
 * Returns raw presets with a known kind; the store resolves parents and converts keys.
 *
 * Printer config bundles may carry the printer's custom bed texture / model
 * (Orca 2.5.0 append_printer_bed_assets / pending_bed_assets, PresetBundle.cpp):
 * files `bed/<n>/texture.png|svg` and `bed/<n>/model.stl`, listed in
 * bundle_structure.json as
 *   "printer_asset": { "printer/<name>.json": { "bed_custom_texture": "bed/0/texture.png", ... } }.
 * They come back on that printer's ImportedRaw.bedAssets; the importer stores
 * them and points the printer's option at the stored copy.
 */
import type { RawPreset } from './inherit';
import { kindFromJsonType, type PresetKind } from './types';
import { isRecord } from './util';

export interface ImportedRaw {
  kind: PresetKind;
  name: string;
  raw: RawPreset;
  /** Source file (inside an archive) for messages. */
  source: string;
  /** Bed texture / model packed for this printer in a printer config bundle. */
  bedAssets?: Partial<Record<BedAssetOption, BedAssetFile>>;
}

/** The two bed files a printer bundle can carry (Orca k_bed_asset_slots). */
export type BedAssetOption = 'bed_custom_texture' | 'bed_custom_model';
export const BED_ASSET_SLOTS: ReadonlyArray<{ option: BedAssetOption; stem: string }> = [
  { option: 'bed_custom_texture', stem: 'texture' },
  { option: 'bed_custom_model', stem: 'model' },
];
/** A bed file inside a bundle: its file name (texture.png, model.stl…) and bytes. */
export interface BedAssetFile { name: string; data: Uint8Array }

/**
 * Extension (with the dot) of `path` when the bed dialog accepts it for
 * `option` (texture: .png / .svg, model: .stl, any case); '' otherwise
 * (Orca bed_asset_extension).
 */
export function bedAssetExtension(path: string, option: BedAssetOption): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot <= slash || dot + 1 >= path.length) return '';
  const ext = path.slice(dot);
  const ok = option === 'bed_custom_texture' ? /^\.(png|svg)$/i.test(ext) : /^\.stl$/i.test(ext);
  return ok ? ext : '';
}

/** Orca accepted_bed_zip_name: only bed/<digits>/<stem><ext>, no "..". Returns the normalised name or null. */
export function acceptedBedZipName(raw: string, option: BedAssetOption): string | null {
  const name = raw.replace(/\\/g, '/');
  if (name.includes('..')) return null;
  const m = /^bed\/(\d+)\/([^/]+)$/.exec(name);
  if (!m) return null;
  const stem = BED_ASSET_SLOTS.find((s) => s.option === option)!.stem;
  const ext = bedAssetExtension(m[2], option);
  return ext && m[2] === stem + ext ? name : null;
}

/** Bed files per printer zip entry, from bundle_structure.json "printer_asset" (Orca pending_bed_assets + stage_bed_asset). */
function bundleBedAssets(manifest: unknown, files: Record<string, Uint8Array>, warnings: string[]): Map<string, Partial<Record<BedAssetOption, BedAssetFile>>> {
  const out = new Map<string, Partial<Record<BedAssetOption, BedAssetFile>>>();
  if (!isRecord(manifest) || !isRecord(manifest.printer_asset)) return out;
  const entries = new Map(Object.entries(files).map(([k, v]) => [k.replace(/\\/g, '/'), v]));
  for (const [printerKey, perPrinter] of Object.entries(manifest.printer_asset)) {
    if (!entries.has(printerKey) || !isRecord(perPrinter)) continue;
    const got: Partial<Record<BedAssetOption, BedAssetFile>> = {};
    for (const { option } of BED_ASSET_SLOTS) {
      const raw = perPrinter[option];
      if (typeof raw !== 'string') continue;
      const zipName = acceptedBedZipName(raw, option);
      const data = zipName ? entries.get(zipName) : undefined;
      if (!zipName || !data) { warnings.push(`${printerKey}: bed file "${raw}" ${zipName ? 'is missing from the bundle' : 'is not a bed texture / model'}, skipped`); continue; }
      got[option] = { name: zipName.slice(zipName.lastIndexOf('/') + 1), data };
    }
    if (Object.keys(got).length) out.set(printerKey, got);
  }
  return out;
}

export interface ImportReadResult {
  presets: ImportedRaw[];
  warnings: string[];
}

const ZIP_EXT = /\.(zip|orca_printer|orca_filament|bbscfg|bbsflmt)$/i;

function guessKind(raw: RawPreset, path: string): PresetKind | null {
  const k = kindFromJsonType(raw.type);
  if (k) return k;
  const p = path.toLowerCase();
  if (/(^|\/)(machine|printer)s?\//.test(p)) return 'printer';
  if (/(^|\/)(process|print)s?\//.test(p)) return 'process';
  if (/(^|\/)filaments?\//.test(p)) return 'filament';
  if ('nozzle_diameter' in raw || 'printable_area' in raw || 'bed_shape' in raw) return 'printer';
  if ('filament_type' in raw || 'nozzle_temperature' in raw || 'temperature' in raw) return 'filament';
  if ('layer_height' in raw || 'wall_loops' in raw || 'perimeters' in raw) return 'process';
  return null;
}

function collect(json: unknown, source: string, out: ImportedRaw[], warnings: string[]): void {
  const pushOne = (raw: RawPreset, fallbackName: string) => {
    const kind = guessKind(raw, source);
    if (!kind) { warnings.push(`${source}: could not tell the preset type of "${fallbackName}"`); return; }
    const name = typeof raw.name === 'string' && raw.name ? raw.name : fallbackName;
    out.push({ kind, name, raw: { ...raw, name }, source });
  };
  if (Array.isArray(json)) {
    json.forEach((e, i) => { if (isRecord(e)) pushOne(e, `${baseName(source)} ${i + 1}`); });
    return;
  }
  if (!isRecord(json)) { warnings.push(`${source}: not a JSON object`); return; }
  const looksSingle = typeof json.type === 'string' || typeof json.inherits === 'string' || typeof json.name === 'string'
    || Object.values(json).some((v) => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')));
  if (looksSingle) { pushOne(json, baseName(source)); return; }
  // flat bundle
  for (const [k, v] of Object.entries(json)) if (isRecord(v)) pushOne(v, k);
}

function baseName(path: string): string {
  return path.split('/').pop()!.replace(/\.[^.]+$/, '');
}

export async function readPresetFile(name: string, data: Uint8Array): Promise<ImportReadResult> {
  const presets: ImportedRaw[] = [];
  const warnings: string[] = [];
  const dec = new TextDecoder();
  const isZip = ZIP_EXT.test(name) || (data[0] === 0x50 && data[1] === 0x4b);
  if (isZip) {
    let unzipSync: ((d: Uint8Array) => Record<string, Uint8Array>) | null = null;
    try { ({ unzipSync } = await import('fflate')); } catch { /* not bundled */ }
    if (!unzipSync) return { presets, warnings: ['Zip import is unavailable (fflate not bundled)'] };
    let files: Record<string, Uint8Array>;
    try { files = unzipSync(data); } catch (e) { return { presets, warnings: [`${name}: not a readable zip (${(e as Error).message})`] }; }
    let manifest: unknown = null;
    for (const [path, bytes] of Object.entries(files)) {
      if (path === 'bundle_structure.json') { try { manifest = JSON.parse(dec.decode(bytes)); } catch { /* no manifest */ } continue; }
      if (!/\.json$/i.test(path) || /bundle_structure\.json$/i.test(path) || /(^|\/)\._/.test(path)) continue;
      try { collect(JSON.parse(dec.decode(bytes)), path, presets, warnings); } catch { warnings.push(`${path}: invalid JSON`); }
    }
    for (const [entry, assets] of bundleBedAssets(manifest, files, warnings)) {
      for (const p of presets) if (p.kind === 'printer' && p.source.replace(/\\/g, '/') === entry) p.bedAssets = assets;
    }
    if (!presets.length) warnings.push(`${name}: no presets found in archive`);
    return { presets, warnings };
  }
  try { collect(JSON.parse(dec.decode(data)), name, presets, warnings); } catch { warnings.push(`${name}: invalid JSON`); }
  return { presets, warnings };
}

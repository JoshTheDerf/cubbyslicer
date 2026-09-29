/**
 * Best-effort reader for preset files users drop in:
 *   - single preset JSON (Orca/Bambu user preset, or a system preset file)
 *   - JSON array of presets
 *   - flat bundle `{ "<name>": {type, inherits, ...}, ... }` (orca_system_profiles.json style)
 *   - zip archives (.zip, .orca_printer, .orca_filament, .bbscfg, .bbsflmt) → every .json inside
 * Returns raw presets with a known kind; the store resolves parents and converts keys.
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
    for (const [path, bytes] of Object.entries(files)) {
      if (!/\.json$/i.test(path) || /bundle_structure\.json$/i.test(path) || /(^|\/)\._/.test(path)) continue;
      try { collect(JSON.parse(dec.decode(bytes)), path, presets, warnings); } catch { warnings.push(`${path}: invalid JSON`); }
    }
    if (!presets.length) warnings.push(`${name}: no presets found in archive`);
    return { presets, warnings };
  }
  try { collect(JSON.parse(dec.decode(data)), name, presets, warnings); } catch { warnings.push(`${name}: invalid JSON`); }
  return { presets, warnings };
}

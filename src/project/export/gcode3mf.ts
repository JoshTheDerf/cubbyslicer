/**
 * Sliced plates as a `.gcode.3mf`, the archive desktop OrcaSlicer 2.5.0 writes
 * for "Export plate sliced file" / "Export all sliced file"
 * (Plater::export_gcode_3mf → export_3mf with SplitModel | WithGcode |
 * SkipModel → bbs_3mf.cpp `_save_model_to_file`). Bambu printers read it.
 *
 * Entries, in desktop's order: [Content_Types].xml, the plate images,
 * a 3D/3dmodel.model with the model metadata only (no objects, empty build),
 * custom_gcode_per_layer.xml, project_settings.config, plate_N.gcode.md5,
 * plate_N.gcode, model_settings.config (plates only, with their gcode_file)
 * and its rels, slice_info.config, filament_sequence.json, _rels/.rels.
 *
 * Pure: everything comes in through `Gcode3mfInput`.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import type { ConfigValue, FlatConfig, SliceStats } from '../../engine/types';
import { asList, joinValue, NOZZLE_VOLUME_TYPE_IDS } from '../../lib/configValue';
import { md5Hex } from '../../printhost/md5';
import { escapeAttr } from '../import/xml';
import {
  BBS_COMPAT_VERSION, CUSTOM_GCODE_FILE, MODEL_FILE, MODEL_SETTINGS_FILE, ORCA_FORMAT_VERSION, PLATE_KEYS, PLATE_KEYS_NEED_MAP_MODE,
  PROJECT_SETTINGS_FILE, SLICE_INFO_FILE,
} from '../import/orcaFormat';
import { CORE_NS, MODEL_REL_TYPE, contentTypesXml, relsXml } from './xml3mf';
import { BAMBU_FILAMENT_IDS } from './bambuFilamentIds';
import type { PlateImages } from '../thumbnails';

export const GCODE_3MF_EXT = '.gcode.3mf';
export const MODEL_SETTINGS_RELS_FILE = 'Metadata/_rels/model_settings.config.rels';
export const FILAMENT_SEQUENCE_FILE = 'Metadata/filament_sequence.json';
/** PATTERN_CONFIG_FILE_FORMAT: a sliced plate's first-layer boxes (PlateBBoxData). */
export const plateJsonOf = (plate: number) => `Metadata/plate_${plate + 1}.json`;
const GCODE_REL_TYPE = 'http://schemas.bambulab.com/package/2021/gcode';
export const gcodeFileOf = (plate: number) => `Metadata/plate_${plate + 1}.gcode`;

/** What a pass over a plate's G-code tells (the parts of GCodeProcessorResult the 3MF needs). */
export interface GcodeScan {
  /** `; model label id:` (Bambu G-code): the sorted label ids of the printed instances; null when absent. */
  labelIds: number[] | null;
  /** 0-based filaments that extrude in model / support roles (print_statistics model_ / support_volumes_per_extruder). */
  modelFilaments: Set<number>;
  supportFilaments: Set<number>;
}

const SUPPORT_ROLES = new Set(['Support', 'Support interface', 'Support transition']);
const WIPE_TOWER_ROLE = 'Prime tower';

/**
 * Read a plate's G-code as GCodeProcessor would for the slice_info fields:
 * the label id header and, per extrusion (E increases while the head moves),
 * the active filament (`T<n>`) and the extrusion role (`; FEATURE:`): support
 * roles count as support, the prime tower as neither, everything else as model.
 */
export function scanGcode(gcode: Uint8Array): GcodeScan {
  const out: GcodeScan = { labelIds: null, modelFilaments: new Set(), supportFilaments: new Set() };
  let role = '';
  let tool = 0;
  let relE = false, relXYZ = false;
  let e = 0;
  const pos = [0, 0, 0];
  const n = gcode.length;
  let i = 0;
  while (i < n) {
    let end = gcode.indexOf(10, i);
    if (end < 0) end = n;
    const c0 = gcode[i];
    // Only the lines that matter are decoded (G / M / T commands and comments).
    if (c0 === 71 /* G */ || c0 === 77 /* M */ || c0 === 84 /* T */ || c0 === 59 /* ; */) {
      const line = String.fromCharCode.apply(null, gcode.subarray(i, Math.min(end, i + 60000)) as unknown as number[]).trim();
      if (c0 === 59) {
        if (line.startsWith('; FEATURE:')) role = line.slice(10).trim();
        else if (line.startsWith(';TYPE:')) role = line.slice(6).trim();
        else if (out.labelIds === null && line.startsWith('; model label id:')) {
          out.labelIds = line.slice(17).split(',').map((s) => Number(s.trim())).filter((x) => Number.isFinite(x));
        }
      } else if (c0 === 84) {
        const t = /^T(\d+)/.exec(line);
        if (t && Number(t[1]) < 255) tool = Number(t[1]);
      } else if (c0 === 77) {
        if (/^M82\b/.test(line)) relE = false;
        else if (/^M83\b/.test(line)) relE = true;
      } else {
        const code = /^G(\d+)/.exec(line)?.[1];
        const words = line.split(';')[0].split(/\s+/);
        const val = (axis: string) => { const w = words.find((x) => x[0] === axis); return w === undefined ? undefined : Number(w.slice(1)); };
        if (code === '90') relXYZ = false;
        else if (code === '91') relXYZ = true;
        else if (code === '92') { const v = val('E'); if (v !== undefined && Number.isFinite(v)) e = v; }
        else if (code === '0' || code === '1' || code === '2' || code === '3') {
          let moved = code === '2' || code === '3';
          ['X', 'Y', 'Z'].forEach((a, k) => {
            const v = val(a);
            if (v === undefined || !Number.isFinite(v)) return;
            const next = relXYZ ? pos[k] + v : v;
            if (next !== pos[k]) moved = true;
            pos[k] = next;
          });
          const v = val('E');
          if (v !== undefined && Number.isFinite(v)) {
            const dE = relE ? v : v - e;
            e = relE ? e + v : v;
            if (dE > 0 && moved && role !== WIPE_TOWER_ROLE) (SUPPORT_ROLES.has(role) ? out.supportFilaments : out.modelFilaments).add(tool);
          }
        }
      }
    }
    i = end + 1;
  }
  return out;
}

export interface Gcode3mfSliced {
  /** The G-code as written (after post-processing). */
  gcode: Uint8Array;
  stats: SliceStats | null;
  /** The config the plate was sliced with (support_used). */
  config: FlatConfig;
  /** The plate's printed instances in slice order: name + its id outside a Bambu label id header. */
  objects: Array<{ name: string; fallbackId: number }>;
  /** scanGcode(gcode), when the caller already has it. */
  scan?: GcodeScan;
}

export interface Gcode3mfPlate {
  name: string;
  locked: boolean;
  /** Per-plate settings (bed type, print sequence, filament map, …). */
  config?: Record<string, ConfigValue>;
  images?: PlateImages;
  /** Set for the plates in the export (sliced and current). */
  sliced?: Gcode3mfSliced;
}

export interface Gcode3mfInput {
  plates: Gcode3mfPlate[];
  /** The plate exported ("Export plate sliced file"), or null for "Export all sliced file". */
  exportPlate: number | null;
  /** The plate shown (desktop's current plate: its plate_N.json lists the exported filaments); default exportPlate ?? 0. */
  currentPlate?: number;
  /** The project's resolved config (desktop's full_config). */
  config: FlatConfig;
  /** The printer model's model_id (slice_info printer_model_id). */
  printerModelId: string;
  /** A Bambu Lab printer (vendor BBL): Bambu filament ids, raw object names. */
  bbl: boolean;
  /** 3D/3dmodel.model `<metadata>` lines, as the project writer makes them. */
  modelMetadataXml: string;
  projectSettings?: Record<string, unknown> | null;
  customGcodeXml?: string | null;
}

const meta = (indent: string, key: string, value: string) => `${indent}<metadata key="${escapeAttr(key)}" value="${escapeAttr(value)}"/>\n`;
/** GCodeProcessor.hpp NOT_GENERATE_TIMELAPSE. */
const NOT_GENERATE_TIMELAPSE = 'not_generate_timelapse';
const EXTRUDER_TYPE_IDS: Record<string, number> = { 'Direct Drive': 0, Bowden: 1 };
const LABELLED_FLAVORS = new Set(['klipper', 'marlin', 'marlin2', 'reprapfirmware']);

/** GCode.cpp sanitize_instance_name (bbs_3mf.cpp sanitize_object_label). */
export function sanitizeObjectLabel(name: string): string {
  return name.replace(/[ !@#$%^&*()=+[\]{};:",']+/g, '_').replace(/^_/, '').replace(/_$/, '');
}

/**
 * C's `%f` (std::to_string of a float): six decimals of the exact binary value, ties to even.
 * Only an odd multiple of 1/128 lies exactly halfway, so toFixed (nearest, ties up) is exact elsewhere.
 */
export function cFixed6(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const q = x * 128;
  if (!Number.isInteger(q) || Math.abs(q) > Number.MAX_SAFE_INTEGER) return x.toFixed(6);
  // x = q / 128 = q × 78125 / 10⁷: seven exact decimals.
  const neg = q < 0;
  const e7 = BigInt(Math.abs(q)) * 78125n;
  let e6 = e7 / 10n;
  const r = e7 % 10n;
  if (r > 5n || (r === 5n && e6 % 2n === 1n)) e6 += 1n;
  const digits = e6.toString().padStart(7, '0');
  const out = `${digits.slice(0, -6)}.${digits.slice(-6)}`;
  return neg && e6 !== 0n ? `-${out}` : out;
}

/**
 * A double as nlohmann::json dumps it (dtoa_impl::format_buffer): the shortest round-trip digits,
 * fixed notation with a ".0" on whole numbers for decimal exponents -4 < n ≤ 15, else d.ddde±XX.
 * A float is dumped as the double it converts to (pass Math.fround's value).
 */
export function nlohmannDouble(x: number): string {
  if (!Number.isFinite(x)) return 'null';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, expStr] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const k = digits.length, n = Number(expStr) + 1; // value = 0.digits × 10^n
  const sign = x < 0 ? '-' : '';
  if (k <= n && n <= 15) return `${sign}${digits}${'0'.repeat(n - k)}.0`;
  if (n > 0 && n <= 15) return `${sign}${digits.slice(0, n)}.${digits.slice(n)}`;
  if (n > -4 && n <= 0) return `${sign}0.${'0'.repeat(-n)}${digits}`;
  const e = n - 1;
  const m = k === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
  return `${sign}${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

/** A JSON value as nlohmann::json (std::map objects: keys sorted) dumps it compactly; `JsonFloat` marks a floating-point number. */
export class JsonFloat { constructor(readonly value: number) {} }
type Json = null | boolean | number | string | JsonFloat | Json[] | { [k: string]: Json };
export function nlohmannDump(v: Json): string {
  if (v === null) return 'null';
  if (v instanceof JsonFloat) return nlohmannDouble(v.value);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : nlohmannDouble(v);
  if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(nlohmannDump).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${nlohmannDump(v[k])}`).join(',')}}`;
}

/** DynamicPrintConfig::get_filament_type: support filaments are reported as PLA-S / PA-S. */
function filamentType(cfg: FlatConfig, id: number): string {
  const types = asList(cfg.filament_type);
  if (!types.length) return '';
  const type = types[id] ?? types[0];
  const sup = asList(cfg.filament_is_support);
  if (sup.length && (sup[id] ?? sup[0]) === '1') return type === 'PLA' ? 'PLA-S' : type === 'PA' ? 'PA-S' : type;
  return type;
}

/** The `<plate>` of slice_info.config (_add_slice_info_config_file_to_archive). */
function sliceInfoPlate(index: number, plate: Gcode3mfPlate, s: Gcode3mfSliced, scan: GcodeScan, input: Gcode3mfInput): string {
  const cfg = input.config;
  const stats = s.stats;
  const info = stats?.sliceInfo;
  const at = (key: string, i: number) => { const l = asList(cfg[key]); return l[i] ?? l[0]; };
  const one = (key: string) => joinValue(cfg[key]);
  let out = `  <plate>\n${meta('    ', 'index', String(index + 1))}`;
  out += meta('    ', 'extruder_type', asList(cfg.extruder_type).map((v) => EXTRUDER_TYPE_IDS[v] ?? 0).join(' '));
  out += meta('    ', 'nozzle_volume_type', asList(cfg.nozzle_volume_type).map((v) => NOZZLE_VOLUME_TYPE_IDS[v] ?? 0).join(' '));
  out += meta('    ', 'printer_model_id', input.printerModelId);
  out += meta('    ', 'nozzle_diameters', joinValue(cfg.nozzle_diameter));
  // -1 when the G-code processor warned that no timelapse is made.
  const noTimelapse = info?.warnings.some((w) => w.msg === NOT_GENERATE_TIMELAPSE) ?? false;
  out += meta('    ', 'timelapse_type', noTimelapse ? '-1' : String(Number(one('timelapse_type')) || 0));
  out += meta('    ', 'prediction', stats ? String(Math.trunc(stats.printTimeSec)) : '');
  const weight = (stats?.filamentG ?? []).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  out += meta('    ', 'weight', weight !== 0 ? weight.toFixed(2) : '');
  // std::to_string(GCodeProcessorResult::initial_layer_time); without the engine's report, empty as for no result.
  out += meta('    ', 'first_layer_time', info ? cFixed6(info.firstLayerTime) : '');
  out += meta('    ', 'outside', info?.toolpathOutside ? 'true' : 'false');
  const supportUsed = info ? info.supportUsed : joinValue(s.config.enable_support) === '1';
  out += meta('    ', 'support_used', supportUsed ? 'true' : 'false');
  // m_enable_exclude_object; without the report: Bambu G-code lists its label ids, other printers follow exclude_object.
  const labelled = info ? info.labelObjectEnabled : scan.labelIds !== null || (!input.bbl && one('exclude_object') === '1');
  out += meta('    ', 'label_object_enabled', labelled ? 'true' : 'false');
  const grouping = info?.nozzleGrouping;
  out += meta('    ', 'enable_filament_dynamic_map', grouping?.dynamic ? 'true' : 'false');
  out += meta('    ', 'has_filament_switcher', one('has_filament_switcher') === '1' ? 'true' : 'false');
  // The plate's own map, else the project's (full_config always has one: 1 per filament by default).
  const plateMap = plate.config?.filament_map;
  const projectMap = cfg.filament_map !== undefined ? asList(cfg.filament_map) : asList(cfg.filament_colour).map(() => '1');
  const filamentMaps = (plateMap !== undefined ? asList(plateMap) : projectMap).map((v) => Number(v) || 0);
  out += meta('    ', 'filament_maps', filamentMaps.join(' '));
  if (info?.limitFilamentMaps.length) out += meta('    ', 'limit_filament_maps', info.limitFilamentMaps.join(' '));

  // Objects: identify_id = the instance's label id in the G-code (sorted ids ↔ instances in slice order).
  const ids = scan.labelIds && scan.labelIds.length === s.objects.length ? scan.labelIds : null;
  const gcodeNames = !input.bbl && LABELLED_FLAVORS.has(one('gcode_flavor'));
  s.objects.forEach((o, k) => {
    const name = gcodeNames ? sanitizeObjectLabel(`${sanitizeObjectLabel(o.name)}_id_${k}_copy_0`) : o.name;
    out += `    <object identify_id="${ids ? ids[k] : o.fallbackId}" name="${escapeAttr(name)}" skipped="false" />\n`;
  });

  const nozzleGroup = (f: number) => (filamentMaps[f] > 0 ? filamentMaps[f] - 1 : 0);
  const diameters = asList(cfg.nozzle_diameter);
  const diameterOf = (g: number) => Number(diameters[g] ?? diameters[0] ?? 0);
  const volumeTypeOf = (g: number) => { const v = at('nozzle_volume_type', g); return v !== undefined && v in NOZZLE_VOLUME_TYPE_IDS ? v : 'Standard'; };
  // An extruder with a cluster of nozzles (H2C): the grouping's diameters; else the config's exact ones.
  const multiNozzle = asList(cfg.extruder_max_nozzle_count).some((v) => Number(v) > 1);
  const usedGroups: number[] = [];
  (stats?.filamentMm ?? []).forEach((mm, f) => {
    if (!(mm > 0)) return; // total_volumes_per_extruder lists the filaments that extruded
    const g = nozzleGroup(f);
    if (!usedGroups.includes(g)) usedGroups.push(g);
    const id = at('filament_ids', f) ?? '';
    // PlateData::parse_filament_info: the filament's nozzles in the grouping, when there is one.
    const nz = grouping?.filaments.find((x) => x.id === f);
    const groupId = nz?.groupIds.length ? nz.groupIds.join(',') : String(g);
    const diameter = multiNozzle && nz?.diameter !== undefined && nz.diameter > 0 ? nz.diameter : diameterOf(g);
    out += `    <filament id="${f + 1}" tray_info_idx="${escapeAttr(input.bbl ? BAMBU_FILAMENT_IDS[id] ?? id : id)}" type="${escapeAttr(filamentType(cfg, f))}"`
      + ` color="${escapeAttr(at('filament_colour', f) ?? '#FFFFFF')}" used_m="${(mm / 1000).toFixed(2)}" used_g="${(stats!.filamentG[f] ?? 0).toFixed(2)}"`
      + ` group_id="${groupId}" nozzle_diameter="${diameter.toFixed(2)}" volume_type="${nz?.volumeType || volumeTypeOf(g)}"`
      + ` used_for_object="${scan.modelFilaments.has(f)}" used_for_support="${scan.supportFilaments.has(f)}"/>\n`;
  });
  for (const m of info?.mixedFilaments ?? []) {
    out += `    <mixed_filament id="${m.id}" type="${escapeAttr(m.type)}" color="${escapeAttr(m.color)}" components="${escapeAttr(m.components)}"/>\n`;
  }
  for (const w of info?.warnings ?? []) {
    out += `    <warning msg="${escapeAttr(w.msg)}" level="${w.level}" error_code ="${escapeAttr(w.errorCode)}"  />\n`;
  }
  if (grouping) {
    for (const n of grouping.usedNozzles) {
      const d = !multiNozzle && n.extruderId >= 0 && n.extruderId < diameters.length ? String(diameterOf(n.extruderId)) : n.diameter;
      out += `    <nozzle id="${n.id}" extruder_id="${n.extruderId + 1}" nozzle_diameter="${d}" volume_type="${n.volumeType}"/>\n`;
    }
  } else {
    for (const g of usedGroups) {
      out += `    <nozzle id="${g}" extruder_id="${g + 1}" nozzle_diameter="${diameterOf(g)}" volume_type="${volumeTypeOf(g)}"/>\n`;
    }
  }
  if (info?.layerFilaments.length) {
    out += '    <layer_filament_lists>\n';
    for (const lf of info.layerFilaments) {
      out += `      <layer_filament_list filament_list="${lf.filaments.join(' ')}" layer_ranges="${lf.ranges.map(([a, b]) => `${a} ${b}`).join(',')}" />\n`;
    }
    out += '    </layer_filament_lists>\n';
  }
  return `${out}  </plate>\n`;
}

/**
 * plate_N.json (PlateBBoxData::to_json, Plater::priv::generate_first_layer_bbox): the engine's
 * first-layer boxes; the filaments the export writes are listed in the current plate's only, as
 * desktop's export loop pushes every plate's into that one. Null without the engine's report.
 */
export function plateBBoxJson(plateIndex: number, plate: Gcode3mfPlate, input: Gcode3mfInput, filaments: { ids: number[]; colors: string[] }): string | null {
  const fl = plate.sliced?.stats?.sliceInfo?.firstLayerBBox;
  if (!fl || !fl.objects.length) return null;
  const f = (x: number) => new JsonFloat(x);
  const seq = joinValue(plate.config?.print_sequence ?? input.config.print_sequence);
  return nlohmannDump({
    bbox_all: fl.bboxAll.map(f),
    bbox_objects: fl.objects.map((o) => ({
      area: f(o.area), bbox: o.bbox.map(f), id: o.wipeTower ? plateIndex + 1000 : o.id ?? 0, layer_height: f(o.layerHeight), name: o.name,
    })),
    bed_type: fl.bedType,
    filament_colors: filaments.colors,
    filament_ids: filaments.ids,
    first_extruder: fl.firstExtruder,
    first_layer_time: f(fl.firstLayerTime),
    is_seq_print: seq === 'by object',
    nozzle_diameter: f(fl.nozzleDiameter),
    version: 2,
  });
}

/** model_settings.config `<plate>` (no instances: SkipModel). */
function modelSettingsPlate(i: number, p: Gcode3mfPlate, gcodeFile: string, bboxFile: boolean): string {
  let out = `  <plate>\n${meta('    ', 'plater_id', String(i + 1))}${meta('    ', 'plater_name', p.name)}${meta('    ', 'locked', String(p.locked))}`;
  const cfg = p.config ?? {};
  for (const k of PLATE_KEYS) {
    const v = cfg[k.key];
    if (v === undefined || (PLATE_KEYS_NEED_MAP_MODE.has(k.key) && cfg.filament_map_mode === undefined)) continue;
    const w = k.write(String(joinValue(v)));
    if (w !== null) out += meta('    ', k.meta, w);
  }
  out += meta('    ', 'gcode_file', gcodeFile);
  if (p.images) {
    out += meta('    ', 'thumbnail_file', `Metadata/plate_${i + 1}.png`) + meta('    ', 'thumbnail_no_light_file', `Metadata/plate_no_light_${i + 1}.png`)
      + meta('    ', 'top_file', `Metadata/top_${i + 1}.png`) + meta('    ', 'pick_file', `Metadata/pick_${i + 1}.png`);
  }
  if (bboxFile) out += meta('    ', 'pattern_bbox_file', plateJsonOf(i));
  return `${out}  </plate>\n`;
}

/**
 * The minimal 3D/3dmodel.model: the model metadata only. With SkipModel,
 * _add_model_file_to_archive skips every object before its instances become
 * build items, so resources and build are empty.
 */
function modelXml(input: Gcode3mfInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n`
    + `${input.modelMetadataXml} <resources>\n </resources>\n <build/>\n</model>\n`;
}

export function buildGcode3mf(input: Gcode3mfInput): Uint8Array {
  const { plates } = input;
  const files: Zippable = {};
  files['[Content_Types].xml'] = strToU8(contentTypesXml([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['json', 'application/json'], ['gcode', 'text/x.gcode']]));

  // Plate images (stored, as desktop does): plate + small, then no-light, then top / pick.
  plates.forEach((p, i) => { if (p.images) { files[`Metadata/plate_${i + 1}.png`] = [p.images.plate, { level: 0 }]; files[`Metadata/plate_${i + 1}_small.png`] = [p.images.small, { level: 0 }]; } });
  plates.forEach((p, i) => { if (p.images) files[`Metadata/plate_no_light_${i + 1}.png`] = [p.images.noLight, { level: 0 }]; });
  plates.forEach((p, i) => { if (p.images) { files[`Metadata/top_${i + 1}.png`] = [p.images.top, { level: 0 }]; files[`Metadata/pick_${i + 1}.png`] = [p.images.pick, { level: 0 }]; } });

  // First-layer boxes, after the images (_add_bbox_file_to_archive). The filaments are those the
  // slice_info <filament> rows list, every exported plate's, in the current plate's file.
  const current = input.currentPlate ?? input.exportPlate ?? 0;
  const exported = { ids: [] as number[], colors: [] as string[] };
  plates.forEach((p) => {
    (p.sliced?.stats?.filamentMm ?? []).forEach((mm, f) => {
      if (!(mm > 0)) return;
      const c = asList(input.config.filament_colour);
      exported.ids.push(f);
      exported.colors.push(c[f] ?? c[0] ?? '#FFFFFF');
    });
  });
  const bboxFiles = new Set<number>();
  plates.forEach((p, i) => {
    const json = plateBBoxJson(i, p, input, i === current ? exported : { ids: [], colors: [] });
    if (json !== null) { files[plateJsonOf(i)] = strToU8(json); bboxFiles.add(i); }
  });

  files[MODEL_FILE] = strToU8(modelXml(input));
  if (input.customGcodeXml) files[CUSTOM_GCODE_FILE] = strToU8(input.customGcodeXml);
  if (input.projectSettings) files[PROJECT_SETTINGS_FILE] = strToU8(JSON.stringify(input.projectSettings, null, 4));

  // MD5 of each plate's G-code (uppercase hex, as desktop writes it), then the G-code.
  plates.forEach((p, i) => { if (p.sliced) files[`${gcodeFileOf(i)}.md5`] = strToU8(md5Hex(p.sliced.gcode).toUpperCase()); });
  plates.forEach((p, i) => { if (p.sliced) files[gcodeFileOf(i)] = p.sliced.gcode; });

  const gcodePaths = plates.flatMap((p, i) => (p.sliced ? [gcodeFileOf(i)] : []));
  if (gcodePaths.length) files[MODEL_SETTINGS_RELS_FILE] = strToU8(relsXml(gcodePaths.map((g, k) => [`/${g}`, `rel-${k + 1}`, GCODE_REL_TYPE])));
  files[MODEL_SETTINGS_FILE] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${plates.map((p, i) => modelSettingsPlate(i, p, p.sliced ? gcodeFileOf(i) : '', bboxFiles.has(i))).join('')}</config>\n`);

  const header = '  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n'
    + `    <header_item key="X-BBL-Client-Version" value="${BBS_COMPAT_VERSION}"/>\n    <header_item key="OrcaSlicer-Version" value="${ORCA_FORMAT_VERSION}"/>\n  </header>\n`;
  const sliceInfo = plates.map((p, i) => (p.sliced ? sliceInfoPlate(i, p, p.sliced, p.sliced.scan ?? scanGcode(p.sliced.gcode), input) : '')).join('');
  files[SLICE_INFO_FILE] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${header}${sliceInfo}</config>\n`);

  // Per plate: filament (1-based) / nozzle change sequences and the optimal assignment
  // (_add_filament_sequence_file_to_archive); a dynamic-map plate keys its sequence "filament_sequence".
  files[FILAMENT_SEQUENCE_FILE] = strToU8(nlohmannDump(Object.fromEntries(plates.map((p, i) => {
    const si = p.sliced?.stats?.sliceInfo;
    const seq = (si?.filamentChangeSequence ?? []).map((f) => f + 1);
    return [`plate_${i + 1}`, {
      [si?.nozzleGrouping?.dynamic ? 'filament_sequence' : 'sequence']: seq,
      nozzle_sequence: si?.nozzleChangeSequence ?? [], optimal_assignment: si?.optimalAssignment ?? [],
    }];
  }))));

  // The package thumbnail: the exported plate's, or plate 1's for "all".
  const t = input.exportPlate ?? 0;
  const rels: Array<[string, string, string]> = [[`/${MODEL_FILE}`, 'rel-1', MODEL_REL_TYPE]];
  if (plates[t]?.images) {
    rels.push([`/Metadata/plate_${t + 1}.png`, 'rel-2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail'],
      [`/Metadata/plate_${t + 1}.png`, 'rel-4', 'http://schemas.bambulab.com/package/2021/cover-thumbnail-middle'],
      [`/Metadata/plate_${t + 1}_small.png`, 'rel-5', 'http://schemas.bambulab.com/package/2021/cover-thumbnail-small']);
  }
  files['_rels/.rels'] = strToU8(relsXml(rels));
  return zipSync(files, { level: 6 });
}

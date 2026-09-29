/**
 * Orca-keyed preset values → preFlight (PrusaSlicer-style) keys.
 *
 * preFlight v1.3.0 ships its system filaments as an Orca-format bundle and
 * converts on import (src/libslic3r/OrcaConfigImporter.cpp + OrcaKeyMapping.cpp).
 * We do the same with the generated key table. Keys the preFlight schema
 * already knows are kept verbatim (native bundles pass through untouched).
 */
import type { ConfigSchema, ConfigScope, ConfigValue } from '../../engine/types';
import { parseDefault } from '../values';
import type { PresetKind, PresetValues } from '../types';
import { orcaKeyMapGenerated } from './orcaKeyMap.generated';

type MapKind = 'machine' | 'filament' | 'process';
const MAP_KIND: Record<PresetKind, MapKind> = { printer: 'machine', filament: 'filament', process: 'process' };

const truthy = (v: string) => v === '1' || v === 'true';

/** OrcaKeyMapper::transform_* ports. */
export const TRANSFORMS: Record<string, (v: string) => string> = {
  transform_infill_pattern: (v) => (v === 'zig-zag' ? 'rectilinear' : v),
  transform_seam_position: (v) => (v === 'back' ? 'rear' : v),
  transform_support_style: (v) => (v === 'default' ? 'grid' : v),
  transform_brim_type: (v) => (v === 'auto_brim' ? 'outer_only' : v),
  transform_wall_sequence_to_bool: (v) => (v === 'outer wall first' || v === 'outer_wall_first' ? '1' : '0'),
  transform_print_sequence_to_bool: (v) => (v === 'by object' || v === 'by_object' ? '1' : '0'),
  transform_only_one_wall_top: (v) => (truthy(v) ? 'top_surfaces' : 'none'),
  transform_emit_machine_limits: (v) => (truthy(v) ? 'emit_to_gcode' : 'time_estimate_only'),
  transform_wall_generator: (v) => (v === 'arachne' ? 'Arachne' : v === 'classic' ? 'Classic' : v),
  transform_gcode_label_objects: (v) => (truthy(v) ? 'octoprint' : 'disabled'),
  transform_fuzzy_skin: (v) => v,
  transform_ensure_vertical_shell: (v) => (truthy(v) ? 'enabled' : 'disabled'),
  transform_arc_fitting: (v) => (truthy(v) ? 'emit_center' : 'disabled'),
};

const PLATE_KEYS = ['hot_plate_temp', 'textured_plate_temp', 'supertack_plate_temp', 'eng_plate_temp', 'textured_cool_plate_temp', 'cool_plate_temp'];

const mapValue = (v: ConfigValue, fn: (s: string) => string): ConfigValue => (Array.isArray(v) ? v.map(fn) : fn(v));
const first = (v: ConfigValue | undefined) => (Array.isArray(v) ? v[0] : v);

/** Orca shrink (100% = none) → preFlight compensation (0% = none). */
function convertShrink(v: string): string {
  const n = Number(v.replace('%', '').trim());
  if (!Number.isFinite(n)) return '0%';
  return `${Math.round((100 - n) * 1e6) / 1e6}%`;
}

const GCODE_KEYS = new Set([
  'machine_start_gcode', 'machine_end_gcode', 'before_layer_change_gcode', 'layer_change_gcode', 'change_filament_gcode',
  'filament_start_gcode', 'filament_end_gcode', 'template_custom_gcode', 'machine_pause_gcode', 'time_lapse_gcode',
  'start_gcode', 'end_gcode', 'before_layer_gcode', 'layer_gcode', 'toolchange_gcode', 'start_filament_gcode',
  'end_filament_gcode', 'pause_print_gcode', 'color_change_gcode',
]);

/** Orca key → preFlight key across all preset kinds (for placeholder names). */
let allRenames: Map<string, string> | null = null;
function renameOf(key: string): string {
  if (!allRenames) {
    allRenames = new Map();
    for (const table of Object.values(orcaKeyMapGenerated)) for (const [k, e] of Object.entries(table)) if (e?.to && !allRenames.has(k)) allRenames.set(k, e.to);
  }
  return allRenames.get(key) ?? key;
}

const EXPR_WORDS = new Set([
  'if', 'elsif', 'else', 'endif', 'and', 'or', 'not', 'true', 'false', 'min', 'max', 'int', 'round', 'digits', 'zdigits',
  'interpolate_table', 'one_of', 'regex', 'is_nil', 'exists', 'empty', 'size', 'let', 'local', 'global', 'repeat', 'sqrt', 'abs',
]);

/**
 * OrcaConfigImporter::translate_gcode, extended: preFlight's placeholder
 * parser accepts [bracket] and {brace} syntax and resolves Orca names through
 * its alias map, but inside {…} a per-extruder vector needs an explicit index
 * — Orca reads it at the current extruder (index 0 for a single value),
 * preFlight rejects the macro. So every bare vector reference inside a {…}
 * expression (`{temperature}`, `{if nozzle_diameter == 0.2}`) gets `[0]`,
 * as preFlight's own importer does for the `{name}` form. String literals
 * and already-indexed / called names are left alone.
 */
export function translateGcode(gcode: string, isVector: (key: string) => boolean): string {
  const vectorName = (k: string) => !EXPR_WORDS.has(k) && (isVector(k) || isVector(renameOf(k)));
  return gcode.replace(/\{([^{}]*)\}/g, (_m, body: string) => {
    let out = '';
    let i = 0;
    while (i < body.length) {
      const c = body[i];
      if (c === '"') { // string literal
        const j = body.indexOf('"', i + 1);
        const end = j < 0 ? body.length : j + 1;
        out += body.slice(i, end); i = end; continue;
      }
      if (/[A-Za-z_]/.test(c) && !(i > 0 && /[A-Za-z0-9_.]/.test(body[i - 1]))) {
        let j = i + 1;
        while (j < body.length && /[A-Za-z0-9_]/.test(body[j])) j++;
        const name = body.slice(i, j);
        let k = j;
        while (k < body.length && (body[k] === ' ' || body[k] === '\t')) k++;
        const next = body[k];
        out += name;
        const assigned = next === '=' && body[k + 1] !== '='; // `local x = …`
        if (next !== '[' && next !== '(' && !assigned && vectorName(name)) out += '[0]';
        i = j; continue;
      }
      out += c; i++;
    }
    return `{${out}}`;
  });
}

/**
 * Convert values. `isNative(key)` says whether preFlight's schema defines the
 * key; when it returns true for everything (schema unknown) only explicit
 * renames are applied. `isVector(key)` (schema option is a vector type)
 * drives the G-code placeholder fix-up.
 */
export function orcaToPreflight(kind: PresetKind, values: PresetValues, isNative: (key: string) => boolean,
                                isVector?: (key: string) => boolean, orcaSchema?: ConfigSchema | null): PresetValues {
  const table = orcaKeyMapGenerated[MAP_KIND[kind]] ?? {};
  if (orcaSchema) values = { ...orcaDefaults(orcaSchema, kind), ...values };
  if (kind === 'process') values = resolveAccelPercents(values);
  const out: PresetValues = {};
  const mapped: PresetValues = {};
  for (const [k, v] of Object.entries(values)) {
    if (isNative(k)) { out[k] = v; continue; }
    const e = table[k];
    if (!e || !e.to) continue;
    const fn = e.transform ? TRANSFORMS[e.transform] : undefined;
    mapped[e.to] = fn ? mapValue(v, fn) : v;
  }
  if (kind === 'filament') {
    for (const [suffix, target] of [['', 'bed_temperature'], ['_initial_layer', 'first_layer_bed_temperature']] as const) {
      if (target in out) continue;
      for (const pk of PLATE_KEYS) {
        const v = first(values[pk + suffix]);
        if (v && v !== '0' && v !== 'nil') { mapped[target] = [v]; break; }
      }
    }
    const shrink = first(values.filament_shrink);
    if (shrink !== undefined && !isNative('filament_shrink')) {
      mapped.filament_shrinkage_compensation_x = [convertShrink(shrink)];
      mapped.filament_shrinkage_compensation_y = [convertShrink(shrink)];
    }
    const shrinkZ = first(values.filament_shrinkage_compensation_z);
    if (shrinkZ !== undefined && /%/.test(shrinkZ) && Number(shrinkZ.replace('%', '')) > 50) {
      out.filament_shrinkage_compensation_z = [convertShrink(shrinkZ)];
    }
  }
  // Orca line widths in % are of the nozzle diameter; preFlight's default
  // (legacy) reads them as % of layer height.
  if (kind === 'process' && !('extrusion_width_percent_of_nozzle' in values)) out.extrusion_width_percent_of_nozzle = '1';
  if (kind === 'printer') {
    // Orca emits SET_VELOCITY_LIMIT for Klipper; preFlight refuses to emit
    // machine limits for Klipper, so keep them for time estimates only.
    if (first(out.gcode_flavor ?? mapped.gcode_flavor) === 'klipper' && first(mapped.machine_limits_usage ?? out.machine_limits_usage) === 'emit_to_gcode') {
      if ('machine_limits_usage' in mapped) mapped.machine_limits_usage = 'time_estimate_only';
      else out.machine_limits_usage = 'time_estimate_only';
    }
    // Orca never auto-emits temperatures ahead of a Klipper start G-code (the
    // START_PRINT macro heats); preFlight would emit M190/M109 first.
    if (first(out.gcode_flavor ?? mapped.gcode_flavor) === 'klipper') out.autoemit_temperature_commands = '0';
    // preFlight refuses relative E without a per-layer "G92 E0" (float drift);
    // Orca doesn't require it and e.g. Bambu's layer G-code has none. Append
    // it — a no-op for the printer beyond what preFlight's own profiles do.
    const rel = first(out.use_relative_e_distances ?? mapped.use_relative_e_distances);
    if (rel === '1' || rel === 'true') {
      const bag = 'layer_gcode' in mapped ? mapped : out;
      const lg = String(first(bag.layer_gcode) ?? '');
      if (!/^\s*G92\s+E0\b/im.test(lg)) bag.layer_gcode = lg.trim() ? `${lg.replace(/\s+$/, '')}\nG92 E0` : 'G92 E0';
    }
  }
  // Native keys win over mapped ones.
  for (const [k, v] of Object.entries(mapped)) if (!(k in out) && isNative(k)) out[k] = v;
  if (isVector) {
    for (const [k, v] of Object.entries(out)) {
      if (!GCODE_KEYS.has(k)) continue;
      out[k] = mapValue(v, (g) => translateGcode(g, isVector));
    }
  }
  return out;
}

/**
 * Orca accelerations given as a percentage (OrcaConfigImporter does the same,
 * with Orca's documented bases); preFlight's targets are absolute mm/s².
 */
const ACCEL_PERCENT_BASE: Record<string, string> = {
  sparse_infill_acceleration: 'default_acceleration',
  internal_solid_infill_acceleration: 'default_acceleration',
  bridge_acceleration: 'outer_wall_acceleration',
};
function resolveAccelPercents(values: PresetValues): PresetValues {
  let out = values;
  for (const [k, baseKey] of Object.entries(ACCEL_PERCENT_BASE)) {
    const raw = String(first(values[k]) ?? '').trim();
    if (!raw.endsWith('%')) continue;
    const pct = Number(raw.slice(0, -1));
    const baseRaw = String(first(values[baseKey]) ?? '').trim();
    const base = baseRaw.endsWith('%') ? NaN : Number(baseRaw);
    if (!Number.isFinite(pct) || !Number.isFinite(base)) continue;
    if (out === values) out = { ...values };
    out[k] = String(Math.round((base * pct) / 100));
  }
  return out;
}

const KIND_SCOPE: Record<PresetKind, ConfigScope> = { printer: 'machine', filament: 'filament', process: 'print' };
const defaultsCache = new WeakMap<ConfigSchema, Partial<Record<PresetKind, PresetValues>>>();

/** Orca's schema defaults for one preset kind (what an Orca preset file leaves implicit). */
export function orcaDefaults(schema: ConfigSchema, kind: PresetKind): PresetValues {
  let c = defaultsCache.get(schema);
  if (!c) { c = {}; defaultsCache.set(schema, c); }
  let d = c[kind];
  if (!d) {
    d = {};
    for (const [k, def] of Object.entries(schema.options)) {
      if (def.scope !== KIND_SCOPE[kind] || def.readonly || def.type === 'none' || def.default === undefined) continue;
      const v = parseDefault(def);
      if (v !== undefined) d[k] = v;
    }
    c[kind] = d;
  }
  return d;
}

/** Prefix of Orca-only values carried through preFlight presets as G-code placeholder variables. */
export const ORCA_COMPAT_PREFIX = 'orca:';

/**
 * Orca options preFlight doesn't define, kept as `orca:<key>` so custom G-code
 * written for Orca (air filtration, flush temperatures, …) still resolves: at
 * slice time they're sent to the engine as placeholder variables.
 */
export function orcaCompatValues(kind: PresetKind, values: PresetValues, isNative: (key: string) => boolean,
                                 orcaSchema: ConfigSchema | null): PresetValues {
  const full = orcaSchema ? { ...orcaDefaults(orcaSchema, kind), ...values } : values;
  const out: PresetValues = {};
  for (const [k, v] of Object.entries(full)) if (!isNative(k)) out[ORCA_COMPAT_PREFIX + k] = v;
  return out;
}

export interface PlaceholderVar { type: string; value: ConfigValue }

const num = (v: ConfigValue | undefined, d = 0) => { const n = Number(String(first(v) ?? '').replace('%', '')); return Number.isFinite(n) ? n : d; };

/**
 * Split a resolved preFlight config into engine config + G-code placeholder
 * variables: the `orca:*` values (typed by Orca's schema) and Orca's computed
 * variables that preFlight doesn't provide. The engine registers only the ones
 * it neither defines nor aliases.
 */
export function splitOrcaCompat(config: Record<string, ConfigValue>, orcaSchema: ConfigSchema | null):
  { config: Record<string, ConfigValue>; vars: Record<string, PlaceholderVar> } {
  const clean: Record<string, ConfigValue> = {};
  const vars: Record<string, PlaceholderVar> = {};
  let any = false;
  for (const [k, v] of Object.entries(config)) {
    if (!k.startsWith(ORCA_COMPAT_PREFIX)) { clean[k] = v; continue; }
    any = true;
    const key = k.slice(ORCA_COMPAT_PREFIX.length);
    const def = orcaSchema?.options[key];
    if (!def || def.type === 'none') continue;
    vars[key] = { type: def.type, value: v };
  }
  if (!any) return { config: clean, vars };
  const orca = (k: string) => vars[k]?.value;
  const nozzle = num(clean.nozzle_diameter, 0.4);
  const lw = String(first(clean.external_perimeter_extrusion_width) ?? '');
  const width = lw && !lw.endsWith('%') && num(lw) > 0 ? num(lw) : nozzle * 1.125;
  const chamber = [orca('chamber_temperatures'), clean.chamber_temperature].flatMap((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])).map(Number).filter(Number.isFinite);
  let bed = String(first(orca('default_bed_type')) ?? '');
  const bedEnum = orcaSchema?.options.curr_bed_type?.enumValues ?? [];
  if (/^\d+$/.test(bed)) bed = bedEnum[Number(bed) - 1] ?? '';
  // Bed extents from bed_shape ("XxY" points).
  const pts = (Array.isArray(clean.bed_shape) ? clean.bed_shape : String(clean.bed_shape ?? '').split(','))
    .map((p) => String(p).split('x').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const bmin = pts.length ? [Math.min(...xs), Math.min(...ys)] : [0, 0];
  const bmax = pts.length ? [Math.max(...xs), Math.max(...ys)] : [200, 200];
  const fl = (a: number[]) => a.map((n) => String(Math.round(n * 1000) / 1000));
  const vec = (v: ConfigValue | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const slots = Math.max(1, vec(clean.nozzle_diameter).length, vec(clean.filament_type).length);
  const perSlot = (v: ConfigValue | undefined, i: number) => { const a = vec(v); return a[i] ?? a[0]; };
  const flushSpeeds = Array.from({ length: slots }, (_, i) => {
    const f = num(perSlot(orca('filament_flush_volumetric_speed'), i));
    return String(f || num(perSlot(clean.filament_max_volumetric_speed, i), 12));
  });
  const flushTemps = Array.from({ length: slots }, (_, i) => {
    const t = num(perSlot(orca('filament_flush_temp'), i));
    return String(Math.round(t || num(perSlot(orca('nozzle_temperature_range_high'), i), num(perSlot(clean.temperature, i), 220))));
  });
  const vitr = vec(orca('temperature_vitrification')).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const zeros = Array.from({ length: slots }, () => '0');
  // Orca's computed G-code variables (GCode.cpp _do_export) that preFlight may
  // lack. Print-dependent ones get whole-bed / first-extruder values; the
  // engine skips any preFlight already provides (print_bed_*, first_layer_print_*, …).
  const computed: Record<string, PlaceholderVar> = {
    bed_temperature_initial_layer_single: { type: 'int', value: String(Math.round(num(clean.first_layer_bed_temperature))) },
    bed_temperature_initial_layer_vector: { type: 'string', value: vec(clean.first_layer_bed_temperature).join(',') },
    overall_chamber_temperature: { type: 'int', value: String(Math.round(chamber.length ? Math.max(...chamber) : 0)) },
    chamber_minimal_temperature: { type: 'int', value: '0' },
    min_vitrification_temperature: { type: 'int', value: String(vitr.length ? Math.min(...vitr) : 0) },
    initial_no_support_extruder: { type: 'int', value: '0' },
    initial_no_support_tool: { type: 'int', value: '0' },
    initial_no_support_hotend: { type: 'int', value: '0' },
    current_hotend: { type: 'int', value: '0' },
    first_filaments: { type: 'ints', value: zeros }, first_tools: { type: 'ints', value: zeros },
    first_non_support_filaments: { type: 'ints', value: zeros }, first_non_support_tools: { type: 'ints', value: zeros },
    flush_volumetric_speeds: { type: 'floats', value: flushSpeeds },
    flush_temperatures: { type: 'ints', value: flushTemps },
    first_layer_center_no_wipe_tower: { type: 'floats', value: fl([(bmin[0] + bmax[0]) / 2, (bmin[1] + bmax[1]) / 2]) },
    print_bed_min: { type: 'floats', value: fl(bmin) }, print_bed_max: { type: 'floats', value: fl(bmax) },
    print_bed_size: { type: 'floats', value: fl([bmax[0] - bmin[0], bmax[1] - bmin[1]]) },
    adaptive_bed_mesh_min: { type: 'floats', value: fl(bmin) }, adaptive_bed_mesh_max: { type: 'floats', value: fl(bmax) },
    bed_mesh_probe_count: { type: 'ints', value: ['5', '5'] },
    bed_mesh_algo: { type: 'string', value: 'bicubic' },
    in_head_wrap_detect_zone: { type: 'bool', value: '0' },
    has_tpu_in_first_layer: { type: 'bool', value: vec(clean.filament_type).some((t) => /TPU/i.test(String(t))) ? '1' : '0' },
    is_all_bbl_filament: { type: 'bool', value: '0' },
    enable_high_low_temp_mix: { type: 'bool', value: '0' },
    hold_chamber_temp_for_flat_print: { type: 'bool', value: '0' },
    bbl_bed_temperature_gcode: { type: 'bool', value: '0' },
    max_additional_fan: { type: 'int', value: String(Math.round(num(orca('additional_cooling_fan_speed')))) },
    during_print_exhaust_fan_speed_num: { type: 'ints', value: zeros },
    retraction_distance_when_cut: { type: 'float', value: String(num(orca('retraction_distances_when_cut'), 18)) },
    long_retraction_when_cut: { type: 'bool', value: String(first(orca('long_retractions_when_cut')) ?? '0') },
    retraction_distance_when_ec: { type: 'float', value: String(num(orca('retraction_distances_when_ec'), 0)) },
    long_retraction_when_ec: { type: 'bool', value: String(first(orca('long_retractions_when_ec')) ?? '0') },
    plate_name: { type: 'string', value: 'plate' },
    plate_number: { type: 'int', value: '1' },
    model_name: { type: 'string', value: 'plate' },
    used_filament_length: { type: 'float', value: '0' },
    print_time_sec: { type: 'int', value: '0' },
    first_flush_volume: { type: 'float', value: '0' },
    second_flush_volume: { type: 'float', value: '0' },
    flush_length: { type: 'float', value: '0' },
    flush_length_1: { type: 'float', value: '0' }, flush_length_2: { type: 'float', value: '0' },
    flush_length_3: { type: 'float', value: '0' }, flush_length_4: { type: 'float', value: '0' },
    timelapse_pos_x: { type: 'int', value: '0' },
    timelapse_pos_y: { type: 'int', value: '0' },
    outer_wall_volumetric_speed: { type: 'float', value: String(Math.round(num(clean.external_perimeter_speed, 60) * width * num(clean.layer_height, 0.2) * 1000) / 1000) },
    ...(bed ? { curr_bed_type: { type: 'string', value: bed } } : {}),
  };
  for (const [k, v] of Object.entries(computed)) if (!(k in vars)) vars[k] = v;
  applyPlateTemperatures(clean, orca, String(first(vars.curr_bed_type?.value) ?? ''), slots);
  return { config: clean, vars };
}

/** Orca plate type → the filament's per-plate bed temperature key. */
export const PLATE_TEMP_KEY: Record<string, string> = {
  'Cool Plate': 'cool_plate_temp', 'Engineering Plate': 'eng_plate_temp', 'High Temp Plate': 'hot_plate_temp',
  'Textured PEI Plate': 'textured_plate_temp', 'Textured Cool Plate': 'textured_cool_plate_temp', 'Supertack Plate': 'supertack_plate_temp',
};

/**
 * Orca picks the bed temperature from the filament's per-plate values for the
 * selected plate type; conversion had to pick one (the first set plate, see
 * orcaToPreflight). Re-pick for the actual plate — unless the slot's value was
 * edited (it no longer equals the conversion's pick).
 */
function applyPlateTemperatures(cfg: Record<string, ConfigValue>, orca: (k: string) => ConfigValue | undefined, bed: string, slots: number): void {
  const key = PLATE_TEMP_KEY[bed];
  if (!key) return;
  const vec = (v: ConfigValue | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  for (const [suffix, target] of [['', 'bed_temperature'], ['_initial_layer', 'first_layer_bed_temperature']] as const) {
    const plate = vec(orca(key + suffix));
    if (!plate.length || cfg[target] === undefined) continue;
    const cur = vec(cfg[target]).slice();
    let changed = false;
    for (let i = 0; i < Math.max(slots, cur.length); i++) {
      const want = plate[i] ?? plate[0];
      if (!want || want === '0' || want === 'nil') continue;
      let pick: string | undefined;
      for (const pk of PLATE_KEYS) { const v = vec(orca(pk + suffix)); const x = v[i] ?? v[0]; if (x && x !== '0' && x !== 'nil') { pick = x; break; } }
      const have = cur[i] ?? cur[0];
      if (pick !== undefined && have !== pick) continue; // user-edited
      if (have !== want) { cur[i] = want; changed = true; }
    }
    if (changed) cfg[target] = Array.isArray(cfg[target]) ? cur : cur[0];
  }
}

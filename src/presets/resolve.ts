/**
 * Final config resolution:
 *
 *   schema defaults ← printer preset ← printer overrides
 *                   ← process preset ← process overrides
 *                   ← filament presets (+ per-filament overrides), merged element-wise
 *
 * Filament options are vectors indexed by filament slot. Each slot is
 * flattened on its own (defaults ← preset ← overrides) and slot i contributes
 * element i — except the per-variant filament keys (Orca 2.5), where each
 * slot contributes its whole vector (one value per variant column), with
 * `filament_extruder_variant` concatenated the same way and
 * `filament_self_index` naming each column's filament: the shape of
 * PresetBundle::full_config(false) that the engine resolves at slice time.
 * Print / printer variant vectors pass through full width.
 */
import type { ConfigOptionDef, ConfigSchema, ConfigValue, FlatConfig } from '../engine/types';
import { NON_ENGINE_KEYS, type PresetValues } from './types';
import { ORCA_COMPAT_PREFIX } from './preflight/convert';
import { cloneValue, escapeStrings, isVectorType, normalizeValue, parseDefault } from './values';
import { DEFAULT_FILAMENT_COLOUR } from '../lib/colour';
import { asList, SCALAR, valueAt } from '../lib/configValue';
import { columnCount, fitLength, variantKey } from './variants';

export interface ResolveInput {
  schema: ConfigSchema | null;
  printer: PresetValues;
  process: PresetValues;
  filaments: PresetValues[];
  overrides?: {
    printer?: PresetValues;
    process?: PresetValues;
    filaments?: PresetValues[];
  };
  /** Preset names, written to *_settings_id like Orca's full_config(). */
  names?: { printer?: string; process?: string; filaments?: string[] };
  /**
   * Project-level values that belong to no preset (Orca's plate type
   * `curr_bed_type`, per-slot `filament_colour` where '' = the preset's colour).
   */
  project?: PresetValues;
}

export type Scope = ConfigOptionDef['scope'];

/** Which preset tab owns a key. */
export function tabOfScope(scope: Scope | (string & {}) | undefined): 'printer' | 'process' | 'filament' | null {
  switch (scope) {
    case 'machine': return 'printer';
    case 'print': case 'object': return 'process';
    case 'filament': return 'filament';
    default: return null;
  }
}

const defaultsCache = new WeakMap<ConfigSchema, FlatConfig>();

/** Parsed defaults for every preset-scope option (cached per schema object). */
export function schemaDefaults(schema: ConfigSchema): FlatConfig {
  let d = defaultsCache.get(schema);
  if (!d) {
    d = {};
    for (const [k, def] of Object.entries(schema.options)) {
      if (def.type === 'none' || def.scope === 'other' || def.readonly) continue;
      if (NON_ENGINE_KEYS.has(k)) continue;
      d[k] = parseDefault(def);
    }
    defaultsCache.set(schema, d);
  }
  return d;
}

/**
 * Normalise preset values to the schema's shapes; drops keys the schema lacks
 * (when a schema is known) except `orca:*` compatibility values (see
 * preflight/convert.ts orcaCompatValues).
 */
export function shapeValues(schema: ConfigSchema | null, values: Record<string, unknown>): PresetValues {
  const out: PresetValues = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    const def = schema?.options[k];
    if (schema && !def && !k.startsWith(ORCA_COMPAT_PREFIX)) continue;
    const n = normalizeValue(def, v);
    const legacy = LEGACY_VALUES[k];
    out[k] = validEnum(def, k, legacy ? (Array.isArray(n) ? n.map(legacy) : legacy(n)) : n);
  }
  return out;
}

const truthyText = (x: string) => x === '1' || x.toLowerCase() === 'true';
const falsyText = (x: string) => x === '0' || x.toLowerCase() === 'false';
const PATTERN_LEGACY = (x: string) => (x === 'zig-zag' ? 'rectilinear' : x);
const VARIANT_LEGACY = (x: string) => x.replace(/Normal/g, 'Standard').replace(/Big Traffic/g, 'High Flow');
/**
 * Value spellings Orca still reads from older presets and projects
 * (PrintConfigDef::handle_legacy, value-level cases only), so a value the
 * engine would accept isn't flagged invalid or replaced by a fallback here
 * (e.g. a 2.4 `enable_arc_fitting = 1`, now `enabled`).
 */
const LEGACY_VALUES: Record<string, (x: string) => string> = {
  timelapse_type: (x) => (x === '2' ? '0' : x),
  support_type: (x) => ({ normal: 'normal(manual)', tree: 'tree(manual)', 'hybrid(auto)': 'tree(auto)' } as Record<string, string>)[x] ?? x,
  support_base_pattern: (x) => (x === 'none' ? 'hollow' : x),
  tree_support_wall_count: (x) => (x === '-1' ? '0' : x),
  overhang_fan_threshold: (x) => (x === '5%' ? '10%' : x),
  nozzle_volume_type: VARIANT_LEGACY, default_nozzle_volume_type: VARIANT_LEGACY, printer_extruder_variant: VARIANT_LEGACY,
  print_extruder_variant: VARIANT_LEGACY, filament_extruder_variant: VARIANT_LEGACY, extruder_variant_list: VARIANT_LEGACY,
  extruder_type: (x) => x.replace(/DirectDrive/g, 'Direct Drive'),
  enable_power_loss_recovery: (x) => (truthyText(x) ? 'enable' : falsyText(x) ? 'disable' : x),
  enable_arc_fitting: (x) => (truthyText(x) ? 'enabled' : falsyText(x) ? 'disabled' : x),
  ensure_vertical_shell_thickness: (x) => (x === '1' ? 'ensure_all' : x === '0' ? 'ensure_moderate' : x),
  ironing_angle: (x) => (x.startsWith('-') ? '0' : x),
  draft_shield: (x) => (x === 'limited' ? 'disabled' : x),
  sparse_infill_pattern: PATTERN_LEGACY, top_surface_pattern: PATTERN_LEGACY, bottom_surface_pattern: PATTERN_LEGACY,
  internal_solid_infill_pattern: PATTERN_LEGACY, ironing_pattern: PATTERN_LEGACY, support_ironing_pattern: PATTERN_LEGACY,
  filament_map_mode: (x) => (x === 'Auto' ? 'Auto For Flush' : x),
};

/**
 * Where an invalid enum value falls back to, when the schema default isn't the
 * right choice. (Some vendor profiles ship typos, e.g. Creality's
 * `"sparse_infill_pattern": "zig-zag"`, which Orca spells `zigzag`.)
 */
const ENUM_FALLBACK: Record<string, string> = { sparse_infill_pattern: 'cubic' };

/** Replace values an enum option doesn't know (per element for enum lists). */
function validEnum(def: ConfigOptionDef | undefined, key: string, v: ConfigValue): ConfigValue {
  const allowed = def?.enumValues;
  if (!def || !allowed?.length || def.type !== 'enum') return v;
  const fallback = () => {
    const f = ENUM_FALLBACK[key];
    if (f && allowed.includes(f)) return f;
    const d = String(def.default ?? '').split(',')[0];
    return allowed.includes(d) ? d : allowed[0];
  };
  const fix = (x: string) => (allowed.includes(x) ? x : fallback());
  return Array.isArray(v) ? v.map(fix) : fix(v);
}

function apply(target: FlatConfig, src: PresetValues | undefined): void {
  if (!src) return;
  for (const [k, v] of Object.entries(src)) {
    if (NON_ENGINE_KEYS.has(k)) continue;
    target[k] = cloneValue(v);
  }
}

/** The filament slot count: printer extruder count or the number of selected filaments, whichever is larger. */
export function extruderCount(printer: FlatConfig): number {
  return Math.max(1, asList(printer.nozzle_diameter).length);
}

export function resolveConfig(input: ResolveInput): FlatConfig {
  const { schema } = input;
  const defaults = schema ? schemaDefaults(schema) : {};
  const out: FlatConfig = {};
  for (const [k, v] of Object.entries(defaults)) out[k] = cloneValue(v);

  apply(out, input.printer);
  apply(out, input.overrides?.printer);
  apply(out, input.process);
  apply(out, input.overrides?.process);

  const filaments = input.filaments.length ? input.filaments : [{}];
  const fo = input.overrides?.filaments ?? [];
  const slots: FlatConfig[] = filaments.map((f, i) => {
    const s: FlatConfig = {};
    apply(s, f);
    apply(s, fo[i]);
    return s;
  });
  const isFilamentKey = (k: string) => !schema || schema.options[k]?.scope === 'filament' || !schema.options[k];
  const keys = new Set<string>();
  for (const s of slots) for (const k of Object.keys(s)) keys.add(k);
  if (schema) for (const [k, def] of Object.entries(schema.options)) if (def.scope === 'filament' && k in defaults) keys.add(k);

  // Variant columns per slot (filament_extruder_variant of each slot's own preset).
  const columns = slots.map((s) => columnCount(s, 'filament'));
  const variantTables = !!schema?.options.filament_self_index || (!schema && slots.some((s) => s.filament_extruder_variant !== undefined));

  for (const k of keys) {
    const def = schema?.options[k];
    if (def && !isFilamentKey(k)) {
      // A non-filament key inside a filament preset (rare): first slot wins, like a plain overlay.
      if (k in slots[0]) out[k] = cloneValue(slots[0][k]);
      continue;
    }
    const vector = def ? isVectorType(def.type) : slots.some((s) => Array.isArray(s[k]));
    const dflt = k in defaults ? defaults[k] : undefined;
    if (!vector) {
      const v = k in slots[0] ? slots[0][k] : dflt;
      if (v !== undefined) out[k] = cloneValue(v);
      continue;
    }
    const dArr = asList(dflt);
    if (variantTables && variantKey(schema, k)?.family === 'filament') {
      out[k] = slots.flatMap((s, i) => {
        const own = s[k] !== undefined ? asList(s[k]) : dArr.length ? [dArr[0]] : [];
        return own.length ? fitLength(own, columns[i]) : new Array<string>(columns[i]).fill('');
      });
      continue;
    }
    if (slots.length === 1) {
      const v = k in slots[0] ? slots[0][k] : dflt;
      if (v !== undefined) out[k] = cloneValue(v);
      continue;
    }
    out[k] = slots.map((s, i) => {
      const own = s[k];
      if (own !== undefined) return asList(own)[0] ?? '';
      return dArr[i] ?? dArr[0] ?? '';
    });
  }
  if (variantTables) out.filament_self_index = columns.flatMap((n, i) => new Array<string>(n).fill(String(i + 1)));

  // Filament colours: Orca takes them from the project's filament list,
  // initialised from each preset's default_filament_colour.
  if (!schema || schema.options.filament_colour) {
    const colours = slots.map((s, i) => presetFilamentColour(s) || valueAt(out.filament_colour, i) || DEFAULT_FILAMENT_COLOUR);
    const chosen = asList(input.project?.filament_colour);
    out.filament_colour = colours.map((c, i) => chosen[i] || c);
    // Every colour of a slot and their blending (Orca 2.5 project lists, '' = derived): an own
    // single colour is a solid filament of that colour, otherwise the preset's values hold.
    const multi = asList(input.project?.filament_multi_colour), type = asList(input.project?.filament_colour_type);
    if (!schema || schema.options.filament_multi_colour) {
      out.filament_multi_colour = slots.map((_, i) => multi[i] || (chosen[i] ? chosen[i] : valueAt(out.filament_multi_colour, i) || out.filament_colour![i] as string));
    }
    if (!schema || schema.options.filament_colour_type) {
      out.filament_colour_type = slots.map((_, i) => type[i] || (chosen[i] ? '1' : valueAt(out.filament_colour_type, i) || '1'));
    }
  }

  // Plate type: the project's choice, else the printer's default_bed_type.
  if (schema?.options.curr_bed_type) {
    const bed = bedTypeOf(schema, out.default_bed_type);
    if (bed) out.curr_bed_type = bed;
  }
  for (const [k, v] of Object.entries(input.project ?? {})) {
    if (k === 'filament_colour' || k === 'filament_multi_colour' || k === 'filament_colour_type' || NON_ENGINE_KEYS.has(k)) continue;
    if (!schema || schema.options[k] || k.startsWith(ORCA_COMPAT_PREFIX)) out[k] = cloneValue(v);
  }

  const names = input.names;
  if (names) {
    const set = (k: string, v: ConfigValue) => { if (!schema || schema.options[k]) out[k] = v; };
    if (names.printer !== undefined) set('printer_settings_id', names.printer);
    if (names.process !== undefined) set('print_settings_id', names.process);
    if (names.filaments) {
      const def = schema?.options.filament_settings_id;
      set('filament_settings_id', def && !isVectorType(def.type) ? escapeStrings(names.filaments) : names.filaments.slice());
    }
    // No printer preset (bare engine defaults): Orca defaults to relative E with an
    // empty layer G-code, which it refuses to slice. Reset E per layer like its presets do.
    const rel = String(asList(out.use_relative_e_distances)[0] ?? '');
    if (names.printer === '' && (rel === '1' || rel === 'true') && 'layer_gcode' in out && !/G92\s+E0/i.test(String(out.layer_gcode ?? ''))) {
      out.layer_gcode = `G92 E0${out.layer_gcode ? `\n${out.layer_gcode}` : ''}`;
    }
  }
  return out;
}

/**
 * A filament preset's own colour: its `filament_colour`, else its
 * `default_filament_colour` ('' when it has neither).
 */
export function presetFilamentColour(values: Record<string, ConfigValue | undefined>): string {
  return valueAt(values.filament_colour, 0) || valueAt(values.default_filament_colour, 0) || '';
}

/**
 * Map Orca's `default_bed_type` (enum value, or the numeric BedType where
 * 1 = first plate) to a `curr_bed_type` enum value; null when unset / unknown.
 */
export function bedTypeOf(schema: ConfigSchema | null, raw: ConfigValue | undefined): string | null {
  const v = valueAt(raw, SCALAR)?.trim();
  if (!v) return null;
  const vals = schema?.options.curr_bed_type?.enumValues ?? [];
  if (vals.includes(v)) return v;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= vals.length) return vals[n - 1];
  return null;
}

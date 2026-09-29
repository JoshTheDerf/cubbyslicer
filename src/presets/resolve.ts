/**
 * Final config resolution:
 *
 *   schema defaults ← printer preset ← printer overrides
 *                   ← process preset ← process overrides
 *                   ← filament presets (+ per-filament overrides), merged element-wise
 *
 * Filament options are vectors indexed by filament slot. Each slot is
 * flattened on its own (defaults ← preset ← overrides) and slot i contributes
 * element i. With a single filament the preset's vector passes through
 * unchanged (keeps multi-variant vectors intact).
 */
import type { ConfigOptionDef, ConfigSchema, ConfigValue, FlatConfig } from '../engine/types';
import { NON_ENGINE_KEYS, type PresetValues } from './types';
import { ORCA_COMPAT_PREFIX } from './preflight/convert';
import { asArray, cloneValue, escapeStrings, isVectorType, normalizeValue, parseDefault } from './values';

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
export function tabOfScope(scope: Scope | undefined): 'printer' | 'process' | 'filament' | null {
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
    out[k] = normalizeValue(def, v);
  }
  return out;
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
  return Math.max(1, asArray(printer.nozzle_diameter).length);
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
    if (slots.length === 1) {
      const v = k in slots[0] ? slots[0][k] : dflt;
      if (v !== undefined) out[k] = cloneValue(v);
      continue;
    }
    const dArr = asArray(dflt);
    out[k] = slots.map((s, i) => {
      const own = s[k];
      if (own !== undefined) return asArray(own)[0] ?? '';
      return dArr[i] ?? dArr[0] ?? '';
    });
  }

  // Filament colours: Orca takes them from the project's filament list,
  // initialised from each preset's default_filament_colour.
  if (!schema || schema.options.filament_colour) {
    const colours = slots.map((s, i) => {
      const own = s.filament_colour !== undefined ? asArray(s.filament_colour)[0] : undefined;
      const dfl = s.default_filament_colour !== undefined ? asArray(s.default_filament_colour)[0] : undefined;
      return own || dfl || asArray(out.filament_colour)[i] || asArray(out.filament_colour)[0] || '#F2754E';
    });
    const chosen = asArray(input.project?.filament_colour);
    out.filament_colour = colours.map((c, i) => chosen[i] || c);
  }

  // Plate type: the project's choice, else the printer's default_bed_type.
  if (schema?.options.curr_bed_type) {
    const bed = bedTypeOf(schema, out.default_bed_type);
    if (bed) out.curr_bed_type = bed;
  }
  for (const [k, v] of Object.entries(input.project ?? {})) {
    if (k === 'filament_colour' || NON_ENGINE_KEYS.has(k)) continue;
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
  }
  return out;
}

/**
 * Map Orca's `default_bed_type` (enum value, or the numeric BedType where
 * 1 = first plate) to a `curr_bed_type` enum value; null when unset / unknown.
 */
export function bedTypeOf(schema: ConfigSchema | null, raw: ConfigValue | undefined): string | null {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!v) return null;
  const vals = schema?.options.curr_bed_type?.enumValues ?? [];
  if (vals.includes(v)) return v;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= vals.length) return vals[n - 1];
  return null;
}

/** Values of a single preset tab as shown in the editor (defaults ← preset). */
export function tabBaseValue(schema: ConfigSchema | null, preset: PresetValues, key: string): ConfigValue | undefined {
  if (key in preset) return preset[key];
  const def = schema?.options[key];
  return def ? parseDefault(def) : undefined;
}

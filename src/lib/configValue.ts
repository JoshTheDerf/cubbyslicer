/**
 * Typed reads of engine config values for the UI and the app's own maths.
 *
 * Values are engine-native: a scalar string, or a string array for vector
 * options (one element per extruder, filament or nozzle variant). Every read
 * takes an explicit `index`:
 * - per-extruder / per-filament keys: the 0-based extruder or filament slot;
 * - per-variant keys (Orca 2.5: 43 process speed / acceleration / jerk keys,
 *   the printer and filament `*_options_with_variant`): the index from
 *   `variantIndex()`;
 * - true scalars: `SCALAR` (0), which says "this key is not a vector".
 * Out-of-range indexes fall back to element 0, like Orca's
 * `ConfigOptionVector::get_at`.
 */
import type { ConfigValue, FlatConfig } from '../engine/types';

/** Index for keys that are scalars (or vectors you deliberately read at 0, e.g. `nozzle_diameter` on a single-extruder printer). */
export const SCALAR = 0;

export interface ReadOptions {
  /** A scalar string may be a serialized vector ("0.4,0.6" / "a;b"): split it on `,` / `;`. */
  serialized?: boolean;
}

/** The element at `index` (Orca `get_at`: out of range → element 0), or undefined. */
export function valueAt(v: ConfigValue | undefined, index: number, opts?: ReadOptions): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[index] ?? v[0];
  if (opts?.serialized) {
    const parts = v.split(/[,;]/);
    return parts[index] ?? parts[0];
  }
  return v;
}

/** The value as an array (a scalar → one element; with `serialized`, split). */
export function asList(v: ConfigValue | undefined, opts?: ReadOptions): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  return opts?.serialized ? v.split(/[,;]/) : [v];
}

/** Number of elements (scalars count as 1, missing as 0). */
export function valueCount(v: ConfigValue | undefined, opts?: ReadOptions): number {
  if (v === undefined) return 0;
  if (Array.isArray(v)) return v.length;
  return opts?.serialized ? v.split(/[,;]/).filter(Boolean).length : 1;
}

/** Vectors joined with `sep` (Orca's ConfigOptionFloats::serialize uses ','), scalars as-is. */
export function joinValue(v: ConfigValue | undefined, sep = ','): string {
  if (v === undefined) return '';
  return Array.isArray(v) ? v.join(sep) : v;
}

// ---- element parsers ----------------------------------------------------------------

/** Float, or `fallback` for '', 'nil' (Orca's unset vector element) and junk. A trailing '%' is ignored. */
export function toNumber(s: string | undefined, fallback = NaN): number {
  if (s === undefined) return fallback;
  const t = s.trim();
  if (t === '' || t === 'nil') return fallback;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : fallback;
}

/** Orca bools: '1' / 'true' (any case) are true, '0' / 'false' false, anything else `fallback`. */
export function toBool(s: string | undefined, fallback = false): boolean {
  const t = (s ?? '').trim().toLowerCase();
  if (t === '1' || t === 'true') return true;
  if (t === '0' || t === 'false') return false;
  return fallback;
}

export interface FloatOrPercent { value: number; percent: boolean }

/** "110%" → { 110, percent }, "0.4" → { 0.4, absolute }; null when not a number. */
export function parseFloatOrPercent(s: string | undefined): FloatOrPercent | null {
  const t = (s ?? '').trim();
  if (t === '' || t === 'nil') return null;
  const percent = t.endsWith('%');
  const n = parseFloat(percent ? t.slice(0, -1) : t);
  return Number.isFinite(n) ? { value: n, percent } : null;
}

/** ConfigOptionFloatOrPercent::get_abs_value: a percent is taken of `ratioOver`. */
export function absValue(s: string | undefined, ratioOver: number, fallback = 0): number {
  const p = parseFloatOrPercent(s);
  if (!p) return fallback;
  return p.percent ? (ratioOver * p.value) / 100 : p.value;
}

// ---- config reads -------------------------------------------------------------------

/** `cfg[key]` at `index` as a string ('' when missing). */
export function cfgString(cfg: FlatConfig, key: string, index: number, fallback = '', opts?: ReadOptions): string {
  return valueAt(cfg[key], index, opts) ?? fallback;
}

/** `cfg[key]` at `index` as a number (`fallback` when missing / unset / junk). */
export function cfgNumber(cfg: FlatConfig, key: string, index: number, fallback = NaN, opts?: ReadOptions): number {
  return toNumber(valueAt(cfg[key], index, opts), fallback);
}

/** `cfg[key]` at `index` as a bool. */
export function cfgBool(cfg: FlatConfig, key: string, index: number, fallback = false, opts?: ReadOptions): boolean {
  return toBool(valueAt(cfg[key], index, opts), fallback);
}

/** `cfg[key]` at `index` as an absolute value, percentages taken of `ratioOver`. */
export function cfgAbs(cfg: FlatConfig, key: string, index: number, ratioOver: number, fallback = 0, opts?: ReadOptions): number {
  return absValue(valueAt(cfg[key], index, opts), ratioOver, fallback);
}

// ---- nozzle variants (Orca 2.5) -------------------------------------------------------

/** Which variant table a key belongs to. */
export type VariantFamily = 'print' | 'printer' | 'filament';

/**
 * The keys naming each variant column of a family's vectors (Preset::get_extruder_names_and_keysets).
 * Filament presets have no id column; in a full config (filaments concatenated, PresetBundle::full_config(false))
 * `filament_self_index` gives each column's 1-based filament, which is what slicing matches on
 * (Print::apply → update_values_to_printer_extruders_for_multiple_filaments).
 */
export const VARIANT_LAYOUT: Readonly<Record<VariantFamily, { id: string | null; variant: string }>> = {
  print: { id: 'print_extruder_id', variant: 'print_extruder_variant' },
  printer: { id: 'printer_extruder_id', variant: 'printer_extruder_variant' },
  filament: { id: 'filament_self_index', variant: 'filament_extruder_variant' },
};

/** NozzleVolumeType enum values (`filament_volume_map` stores these ints; 4 is reserved). */
export const NOZZLE_VOLUME_TYPE_IDS: Readonly<Record<string, number>> = {
  Standard: 0, 'High Flow': 1, Hybrid: 2, 'TPU High Flow': 3, 'E3D High Flow': 5, 'Extra High Flow': 6,
};
export function nozzleVolumeTypeName(id: number | string | undefined): string {
  const n = typeof id === 'string' ? parseInt(id, 10) : id;
  return Object.keys(NOZZLE_VOLUME_TYPE_IDS).find((k) => NOZZLE_VOLUME_TYPE_IDS[k] === n) ?? 'Standard';
}

/**
 * get_extruder_variant_string: "Direct Drive Standard", "Bowden High Flow", …
 * `Hybrid` matches `Standard` values (Orca: "nvtHybrid not supported in presets").
 */
export function variantName(extruderType: string, nozzleVolumeType: string): string {
  return `${extruderType} ${nozzleVolumeType === 'Hybrid' ? 'Standard' : nozzleVolumeType}`;
}

export interface VariantSelector {
  /** 1-based extruder id (the 1-based filament number for the filament family). */
  extruderId: number;
  /** extruder_type of that extruder, e.g. "Direct Drive". */
  extruderType: string;
  /** nozzle_volume_type of that extruder, e.g. "Standard". */
  nozzleVolumeType: string;
}

/**
 * The variant's selector for a 0-based extruder, read from the printer
 * config (`extruder_type` / `nozzle_volume_type` vectors).
 */
export function variantSelector(cfg: FlatConfig, extruder: number): VariantSelector {
  return {
    extruderId: extruder + 1,
    extruderType: cfgString(cfg, 'extruder_type', extruder, 'Direct Drive'),
    nozzleVolumeType: cfgString(cfg, 'nozzle_volume_type', extruder, 'Standard'),
  };
}

/** The 0-based extruder a filament prints with (`filament_map`, 1-based; default extruder 1). */
export function filamentExtruder(cfg: FlatConfig, filament: number): number {
  const n = Math.max(1, valueCount(cfg.nozzle_diameter));
  const e = Math.trunc(cfgNumber(cfg, 'filament_map', filament, 1)) - 1;
  return e >= 0 && e < n ? e : 0;
}

/**
 * Selector of a filament's variant: its extruder's type and volume type; a
 * Hybrid extruder uses the filament's own volume type (`filament_volume_map`,
 * PrintConfig update_values_to_printer_extruders).
 */
export function filamentVariantSelector(cfg: FlatConfig, filament: number): VariantSelector {
  const e = filamentExtruder(cfg, filament);
  const sel = variantSelector(cfg, e);
  const own = cfg.filament_volume_map !== undefined && valueCount(cfg.filament_volume_map) > filament
    ? nozzleVolumeTypeName(valueAt(cfg.filament_volume_map, filament)) : 'Standard';
  return { extruderId: filament + 1, extruderType: sel.extruderType, nozzleVolumeType: sel.nozzleVolumeType === 'Hybrid' ? own : sel.nozzleVolumeType };
}

/**
 * DynamicPrintConfig::get_index_for_extruder: the element index of a
 * per-variant value for `sel` in `family`'s table, or -1 when the config has
 * no matching column (also when it has no variant table at all: callers then
 * use their slot index / SCALAR). `stride` is 2 for machine limits
 * (normal / silent pairs).
 */
export function variantIndex(cfg: FlatConfig, family: VariantFamily, sel: VariantSelector, stride = 1): number {
  const keys = VARIANT_LAYOUT[family];
  const variants = cfg[keys.variant];
  if (variants === undefined) return -1;
  const vlist = asList(variants);
  let ids = keys.id && cfg[keys.id] !== undefined ? asList(cfg[keys.id]).map((s) => parseInt(s, 10)) : null;
  const complete = !!ids && ids.length >= vlist.length;
  // A filament preset (not a full config) has no self index: match the variant alone.
  if (family === 'filament' && !complete) ids = null;
  // Without a complete id column the ids come from extruder_variant_list order.
  const generatedId = (target: number): number => {
    const list = asList(cfg.extruder_variant_list);
    let k = 0;
    for (let e = 0; e < list.length; e++) {
      const count = list[e].split(',').filter((s) => s.trim()).length;
      if (target < k + count) return e + 1;
      k += count;
    }
    return 0;
  };
  const want = variantName(sel.extruderType, sel.nozzleVolumeType);
  for (let i = 0; i < vlist.length; i++) {
    if (vlist[i] !== want) continue;
    if (ids === null) return i * stride;
    const id = complete ? ids[i] : generatedId(i);
    if (id === sel.extruderId) return i * stride;
  }
  return -1;
}

/**
 * The column a value is read from at slice time: the matching column, else the
 * extruder's (filament's) first column — find_variant_index's fallback ("use the
 * id's own first variant, usually Standard") — else -1 (no table / no column of
 * that id).
 */
export function variantColumn(cfg: FlatConfig, family: VariantFamily, sel: VariantSelector, stride = 1): number {
  const hit = variantIndex(cfg, family, sel, stride);
  if (hit >= 0) return hit;
  const keys = VARIANT_LAYOUT[family];
  if (!keys.id || cfg[keys.id] === undefined || cfg[keys.variant] === undefined) return -1;
  const ids = asList(cfg[keys.id]).map((s) => parseInt(s, 10));
  if (ids.length < valueCount(cfg[keys.variant])) return -1;
  const first = ids.indexOf(sel.extruderId);
  return first >= 0 ? first * stride : -1;
}

/**
 * Read a per-variant key: `index` is the 0-based extruder (print / printer) or
 * filament (filament family). The matching variant column when the config has
 * one, else the extruder's / filament's own element (a pre-2.5 or
 * already-collapsed config).
 */
export function variantValue(cfg: FlatConfig, key: string, family: VariantFamily, index: number): string | undefined {
  if (family === 'filament') return filamentVariantValue(cfg, key, index);
  const idx = variantColumn(cfg, family, variantSelector(cfg, index));
  return valueAt(cfg[key], idx >= 0 ? idx : index);
}

/** A filament variant key of a full config (filaments concatenated, `filament_self_index`) for 0-based `filament`. */
export function filamentVariantValue(cfg: FlatConfig, key: string, filament: number): string | undefined {
  const idx = variantColumn(cfg, 'filament', filamentVariantSelector(cfg, filament));
  return valueAt(cfg[key], idx >= 0 ? idx : filament);
}

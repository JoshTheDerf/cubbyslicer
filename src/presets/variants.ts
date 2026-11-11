/**
 * Orca 2.5 extruder / nozzle variants on the preset side.
 *
 * A variant is an extruder type + nozzle volume type ("Direct Drive High
 * Flow"). Keys in Orca's `print_options_with_variant`,
 * `printer_options_with_variant_1/_2` and `filament_options_with_variant`
 * hold one value per variant column (`variantStride` values for the
 * normal / silent machine limits); the columns are named by
 * `print_extruder_id` / `print_extruder_variant`, `printer_extruder_id` /
 * `printer_extruder_variant` and `filament_extruder_variant`.
 *
 * Presets keep the full vectors (the engine picks each extruder's column at
 * slice time, docs/ENGINE-CONTRACT.md "Extruder variants"). This module:
 * - says which keys are per-variant (schema `variant`, else Orca's lists);
 * - sizes a flattened preset's variant vectors to its column count
 *   (Preset.cpp `extend_default_config_length`);
 * - lays a user preset over its parent column by column
 *   (PrintConfig.cpp `update_diff_values_to_child_config`), so a user preset
 *   saved before its parent gained a variant keeps its values on the variants
 *   it listed and the new ones take its first value of the same extruder.
 */
import type { ConfigSchema, ConfigValue } from '../engine/types';
import { asList, VARIANT_LAYOUT, type VariantFamily } from '../lib/configValue';
import type { PresetKind, PresetValues } from './types';
import { isVectorType } from './values';

export { VARIANT_LAYOUT, type VariantFamily };

// Orca 2.5 PrintConfig.cpp (the lists the engine's schema `variant` field is built from).
const PRINT = [
  'initial_layer_speed', 'initial_layer_infill_speed', 'outer_wall_speed', 'inner_wall_speed', 'small_perimeter_speed', 'small_perimeter_threshold',
  'sparse_infill_speed', 'internal_solid_infill_speed', 'top_surface_speed', 'enable_overhang_speed', 'overhang_1_4_speed', 'overhang_2_4_speed',
  'overhang_3_4_speed', 'overhang_4_4_speed', 'slowdown_for_curled_perimeters', 'bridge_speed', 'internal_bridge_speed', 'gap_infill_speed',
  'support_speed', 'support_interface_speed', 'travel_speed', 'travel_speed_z', 'initial_layer_travel_speed', 'default_acceleration',
  'bridge_acceleration', 'travel_acceleration', 'initial_layer_travel_acceleration', 'initial_layer_acceleration', 'outer_wall_acceleration',
  'inner_wall_acceleration', 'sparse_infill_acceleration', 'internal_solid_infill_acceleration', 'top_surface_acceleration', 'default_jerk',
  'outer_wall_jerk', 'inner_wall_jerk', 'infill_jerk', 'top_surface_jerk', 'initial_layer_jerk', 'travel_jerk', 'initial_layer_travel_jerk',
  'default_junction_deviation', 'print_extruder_id', 'print_extruder_variant', 'top_solid_infill_flow_ratio',
];
const FILAMENT = [
  'filament_flow_ratio', 'filament_max_volumetric_speed', 'filament_ramming_volumetric_speed', 'filament_pre_cooling_temperature',
  'filament_ramming_travel_time', 'filament_ramming_volumetric_speed_nc', 'filament_pre_cooling_temperature_nc', 'filament_ramming_travel_time_nc',
  'filament_retract_length_nc', 'filament_preheat_temperature_delta', 'filament_extruder_variant', 'filament_retraction_length', 'filament_z_hop',
  'filament_z_hop_types', 'filament_retract_lift_above', 'filament_retract_lift_below', 'filament_retract_lift_enforce', 'filament_retract_restart_extra',
  'filament_retract_length_toolchange', 'filament_retract_restart_extra_toolchange', 'filament_retraction_speed', 'filament_deretraction_speed',
  'filament_retraction_minimum_travel', 'filament_retract_when_changing_layer', 'filament_wipe', 'filament_wipe_distance', 'filament_retract_before_wipe',
  'filament_retract_after_wipe', 'filament_long_retractions_when_cut', 'filament_retraction_distances_when_cut', 'long_retractions_when_ec',
  'retraction_distances_when_ec', 'nozzle_temperature_initial_layer', 'nozzle_temperature', 'filament_flush_volumetric_speed', 'filament_flush_temp',
  'filament_cooling_before_tower', 'volumetric_speed_coefficients', 'filament_adaptive_volumetric_speed', 'filament_ironing_flow',
  'filament_ironing_spacing', 'filament_ironing_inset', 'filament_ironing_speed', 'enable_pressure_advance', 'pressure_advance',
  'adaptive_pressure_advance', 'adaptive_pressure_advance_model', 'adaptive_pressure_advance_overhangs', 'adaptive_pressure_advance_bridges',
  'fan_min_speed', 'fan_max_speed', 'additional_cooling_fan_speed', 'filament_minimal_purge_on_wipe_tower', 'filament_multitool_ramming',
  'filament_multitool_ramming_volume', 'filament_multitool_ramming_flow', 'nozzle_temperature_range_low', 'nozzle_temperature_range_high',
  'activate_air_filtration', 'activate_air_filtration_during_print', 'activate_air_filtration_on_completion', 'during_print_exhaust_fan_speed',
  'complete_print_exhaust_fan_speed',
];
const PRINTER_1 = [
  'nozzle_volume', 'retraction_length', 'z_hop', 'travel_slope', 'retract_lift_above', 'retract_lift_below', 'retract_lift_enforce', 'z_hop_types',
  'retraction_speed', 'deretraction_speed', 'retraction_minimum_travel', 'retract_when_changing_layer', 'wipe', 'wipe_distance', 'retract_before_wipe',
  'retract_after_wipe', 'retract_length_toolchange', 'retract_restart_extra', 'retract_restart_extra_toolchange', 'long_retractions_when_cut',
  'retraction_distances_when_cut', 'nozzle_type', 'printer_extruder_id', 'printer_extruder_variant', 'hotend_cooling_rate', 'hotend_heating_rate',
  'nozzle_flush_dataset',
];
const PRINTER_2 = [
  'machine_max_acceleration_x', 'machine_max_acceleration_y', 'machine_max_acceleration_z', 'machine_max_acceleration_e',
  'machine_max_acceleration_extruding', 'machine_max_acceleration_retracting', 'machine_max_acceleration_travel', 'machine_max_speed_x',
  'machine_max_speed_y', 'machine_max_speed_z', 'machine_max_speed_e', 'machine_max_jerk_x', 'machine_max_jerk_y', 'machine_max_jerk_z',
  'machine_max_jerk_e', 'machine_max_junction_deviation',
];

export interface VariantKeyInfo { family: VariantFamily; stride: number }

const FALLBACK = new Map<string, VariantKeyInfo>();
// First list wins, as in extend_default_config_length.
for (const k of PRINT) FALLBACK.set(k, { family: 'print', stride: 1 });
for (const k of FILAMENT) if (!FALLBACK.has(k)) FALLBACK.set(k, { family: 'filament', stride: 1 });
for (const k of PRINTER_1) if (!FALLBACK.has(k)) FALLBACK.set(k, { family: 'printer', stride: 1 });
for (const k of PRINTER_2) if (!FALLBACK.has(k)) FALLBACK.set(k, { family: 'printer', stride: 2 });

const schemaHasVariants = new WeakMap<ConfigSchema, boolean>();
function tagged(schema: ConfigSchema): boolean {
  let v = schemaHasVariants.get(schema);
  if (v === undefined) { v = Object.values(schema.options).some((d) => !!d.variant); schemaHasVariants.set(schema, v); }
  return v;
}

/**
 * Whether `key` holds one value per variant column, and of which table. The
 * engine schema's `variant` field decides when the schema has it (2.5 engine);
 * otherwise Orca's lists, for vector options only (a 2.4 schema has the
 * process speeds as scalars).
 */
export function variantKey(schema: ConfigSchema | null, key: string): VariantKeyInfo | null {
  const def = schema?.options[key];
  if (schema && tagged(schema)) return def?.variant ? { family: def.variant, stride: def.variantStride ?? 1 } : null;
  if (schema && (!def || !isVectorType(def.type))) return null;
  return FALLBACK.get(key) ?? null;
}

/** The variant table of a preset tab. */
export function familyOfKind(kind: PresetKind): VariantFamily {
  return kind === 'printer' ? 'printer' : kind === 'process' ? 'print' : 'filament';
}

/** The two keys naming a family's columns. */
export function layoutKeys(family: VariantFamily): string[] {
  const l = VARIANT_LAYOUT[family];
  // Presets name filament columns by variant only; filament_self_index belongs to the full config.
  return family === 'filament' ? [l.variant] : [l.id!, l.variant];
}

/** Variant columns a flattened preset has (extend_default_config_length: printers without a table use their nozzle count). */
export function columnCount(values: PresetValues, family: VariantFamily): number {
  const v = values[VARIANT_LAYOUT[family].variant];
  if (v !== undefined) return Math.max(1, asList(v).length);
  if (family === 'printer' && values.nozzle_diameter !== undefined) return Math.max(1, asList(values.nozzle_diameter).length);
  return 1;
}

/** ConfigOptionVector::resize: cut, or pad with the first element. */
export function fitLength(v: string[], n: number): string[] {
  if (v.length === n || !v.length) return v;
  if (v.length > n) return v.slice(0, n);
  return [...v, ...new Array<string>(n - v.length).fill(v[0])];
}

/**
 * extend_default_config_length for one flattened preset: every per-variant
 * vector sized to the preset's column count (× stride). Inheritance in system
 * profiles is a plain key overlay, so a child that adds variant columns
 * (`0.20mm Standard @BBL H2D`: 7) over a parent with fewer (4) leaves the
 * parent-only keys short; Orca pads them with their first value. Vectors
 * longer than the table are cut (`Bambu PLA Basic @BBL H2D` lists three
 * values per key but one filament_extruder_variant).
 */
export function normalizeVariantLengths(values: PresetValues, schema: ConfigSchema | null): PresetValues {
  const counts: Partial<Record<VariantFamily, number>> = {};
  let out: PresetValues | null = null;
  for (const [k, v] of Object.entries(values)) {
    if (!Array.isArray(v)) continue;
    const info = variantKey(schema, k);
    if (!info) continue;
    const n = (counts[info.family] ??= columnCount(values, info.family)) * info.stride;
    const fitted = fitLength(v, n);
    if (fitted !== v) (out ??= { ...values })[k] = fitted;
  }
  return out ?? values;
}

// ---- user presets over their parent ----------------------------------------------------------

/** find_variant_index (PrintConfig.cpp). */
export function findVariantIndex(variant: string, id: number, list: readonly string[], ids: readonly number[]): number {
  const count = list.length ? list.length : ids.length;
  if (count === 0) return 0;
  const sameId = (i: number) => id < 0 || !ids.length || (i < ids.length && ids[i] === id);
  for (let i = 0; i < list.length; i++) if (list[i] === variant && sameId(i)) return i;
  for (let i = 0; i < count; i++) if (sameId(i)) return i;
  return -1;
}

/** map_variant_indices: for each column of (variants, ids), the matching column of (from…), or -1. */
export function mapVariantIndices(variants: readonly string[], ids: readonly number[], fromVariants: readonly string[], fromIds: readonly number[]): number[] {
  const count = variants.length || ids.length;
  return Array.from({ length: count }, (_, i) => {
    if (ids.length && i >= ids.length) return -1;
    return findVariantIndex(variants[i] ?? '', ids.length ? ids[i] : -1, fromVariants, fromIds);
  });
}

const ints = (v: ConfigValue | undefined) => asList(v).map((s) => parseInt(s, 10));

/**
 * A user preset's own values over its (flattened) parent:
 * DynamicPrintConfig::update_diff_values_to_child_config. Non-variant keys:
 * the child's value. Variant keys: the parent's layout is kept and each parent
 * column takes the child's value of the same variant (or the child's first
 * column of the same extruder); a child `nil` inherits unless the key is a
 * nullable filament override.
 */
export function applyChildOverParent(parent: PresetValues, child: PresetValues, schema: ConfigSchema | null, kind: PresetKind): PresetValues {
  const family = familyOfKind(kind);
  const layout = VARIANT_LAYOUT[family];
  const idKey = family === 'filament' ? null : layout.id;
  const curVariants = asList(parent[layout.variant]);
  const curIds = idKey ? ints(parent[idKey]) : [];
  const childVariants = asList(child[layout.variant]);
  const childIds = idKey ? ints(child[idKey]) : [];
  const childCount = columnCount(child, family);

  let index: number[] = curVariants.length ? new Array<number>(curVariants.length).fill(-1) : [0];
  if (!childVariants.length) {
    if (curVariants.length) index = mapVariantIndices(curVariants, curIds, [], curIds.length ? [curIds[0]] : []);
  } else if ((curIds.length && curIds.length !== curVariants.length) || (childIds.length && childIds.length !== childVariants.length)) {
    // Inconsistent layout (Orca logs "should not happen"): parent columns stay.
  } else if (curVariants.length) {
    index = mapVariantIndices(curVariants, curIds, childVariants, childIds);
  }

  const out: PresetValues = { ...parent };
  for (const [k, v] of Object.entries(child)) {
    if (k === layout.variant || k === idKey) continue;
    const info = variantKey(schema, k);
    const base = parent[k];
    if (!info || info.family !== family || !Array.isArray(v) || !Array.isArray(base)) { out[k] = Array.isArray(v) ? v.slice() : v; continue; }
    const stride = info.stride;
    if (base.length !== index.length * stride) { out[k] = v.slice(); continue; }
    const own = fitLength(v, childCount * stride);
    const keepNil = family === 'filament' && !!schema?.options[k]?.nullable;
    const next = base.slice();
    index.forEach((ci, i) => {
      if (ci < 0) return;
      for (let j = 0; j < stride; j++) {
        const x = own[ci * stride + j];
        if (x === undefined || (x === 'nil' && !keepNil)) continue;
        next[i * stride + j] = x;
      }
    });
    out[k] = next;
  }
  return out;
}

/**
 * Saving a user preset: Orca always writes the variant layout with per-variant
 * values (Preset.cpp "send the variant layout even when it matches the
 * parent's"), so the loader can map them back to the right columns.
 */
export function withVariantLayout(diff: PresetValues, full: PresetValues, schema: ConfigSchema | null, kind: PresetKind): PresetValues {
  const family = familyOfKind(kind);
  const any = Object.keys(diff).some((k) => variantKey(schema, k)?.family === family);
  if (!any) return diff;
  const out = { ...diff };
  for (const k of layoutKeys(family)) if (full[k] !== undefined && out[k] === undefined) out[k] = full[k];
  return out;
}

// ---- the printer's extruders --------------------------------------------------------------

export interface ExtruderVariants {
  /** extruder_type of the extruder. */
  type: string;
  /** Nozzle volume types the profile has columns for (extruder_variant_list), in Orca's order. */
  volumeTypes: string[];
  /** The extruder holds several sub-nozzles (H2C rack: extruder_max_nozzle_count > 1): Hybrid is offered. */
  multiNozzle: boolean;
}

const VOLUME_ORDER = ['Standard', 'High Flow', 'TPU High Flow', 'E3D High Flow', 'Extra High Flow'];

/** get_extruder_supported_nozzle_volume_types for every extruder of a printer config. */
export function extruderVariants(printer: PresetValues): ExtruderVariants[] {
  const n = Math.max(1, asList(printer.nozzle_diameter).length);
  const types = asList(printer.extruder_type);
  const lists = asList(printer.extruder_variant_list);
  const maxNozzles = ints(printer.extruder_max_nozzle_count);
  return Array.from({ length: n }, (_, e) => {
    const type = types[e] ?? types[0] ?? 'Direct Drive';
    const list = (lists[e] ?? lists[0] ?? '').split(',').map((s) => s.trim());
    const volumeTypes = VOLUME_ORDER.filter((t) => list.includes(`${type} ${t}`));
    return { type, volumeTypes: volumeTypes.length ? volumeTypes : ['Standard'], multiNozzle: (maxNozzles[e] ?? 1) > 1 };
  });
}

/**
 * support_different_extruders: the printer's extruders list more than one
 * variant between them (then process values differ per extruder / flow type).
 */
export function hasVariants(printer: PresetValues): boolean {
  const n = Math.max(1, asList(printer.nozzle_diameter).length);
  const set = new Set<string>();
  asList(printer.extruder_variant_list).slice(0, n).forEach((l) => l.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => set.add(s)));
  return set.size > 1;
}

/** Short tag of a nozzle volume type on the variant switch (Tab.cpp short_nozzle_volume_name). */
export function shortVolumeName(t: string): string {
  return ({ Standard: 'SF', 'High Flow': 'HF', 'TPU High Flow': 'TPU HF', 'E3D High Flow': 'E3D HF', 'Extra High Flow': 'XHF' } as Record<string, string>)[t] ?? t;
}

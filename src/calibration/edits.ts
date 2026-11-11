/**
 * The calibration's settings writer. Orca edits the selected presets in place
 * (get_edited_preset().config.set_key_value) and sets per-object overrides;
 * here the edits are recorded against a `PresetSource` and committed as
 * unsaved preset edits in one go, so the planners stay pure and testable.
 *
 * Orca 2.5 turned 43 process speed / acceleration / jerk keys (and several
 * printer / filament keys) into per-nozzle-variant vectors:
 * - `set` writes every element, like Orca's `set_config_values`;
 * - `setAt` writes the element of one extruder's variant, like
 *   `get_index_for_extruder_parameter` + `values[index] = …`;
 * - reads go through the extruder's variant (`num`) where Orca uses get_index_for_extruder_parameter,
 *   and through the bare element (`el`) where Orca reads `get_at(i)` / `get_abs_value_at(key, i)`.
 * On an engine whose schema has the key as a scalar, all three degrade to a
 * plain scalar write / read.
 */
import type { ConfigValue, FlatConfig } from '../engine/types';
import {
  absValue, asList, SCALAR, toBool, toNumber, valueAt, variantIndex, variantSelector, type VariantFamily,
} from '../lib/configValue';
import type { PresetKind } from '../presets/types';

export type Scalar = string | number | boolean;

/** Orca's serialisation of a scalar: bools as 1/0, numbers rounded to 1e-6. */
export function serialize(v: Scalar): string {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  return v;
}

/** What the planners read: the schema, the tab (preset ← unsaved edit) values and the resolved config. */
export interface PresetSource {
  /** `{ vector }` for a known key, undefined for a key this engine doesn't have, null when no schema is loaded. */
  option(key: string): { vector: boolean } | undefined | null;
  /** Tab value of `key` (`slot` is the filament slot for filament keys). */
  value(kind: PresetKind, key: string, slot: number): ConfigValue | undefined;
  /** The full resolved config (printer + process + filaments). */
  resolved: FlatConfig;
}

export interface PresetWrite { kind: PresetKind; key: string; slot: number; value: ConfigValue }

const FAMILY: Record<PresetKind, VariantFamily> = { process: 'print', printer: 'printer', filament: 'filament' };
const VARIANT_KEYS: Record<PresetKind, string[]> = {
  process: ['print_extruder_variant', 'print_extruder_id'],
  printer: ['printer_extruder_variant', 'printer_extruder_id'],
  filament: ['filament_extruder_variant'],
};

export class Edits {
  /** Resolved config with the edits mirrored in, for maths that reads after writing (PA pattern geometry). */
  readonly cfg: FlatConfig;
  private readonly pending = new Map<string, PresetWrite>();

  /** `slot`: the filament slot / extruder the test is for (Calib_Params::extruder_id). */
  constructor(private readonly src: PresetSource, readonly slot = 0) {
    this.cfg = { ...src.resolved };
  }

  /** The recorded writes, in first-write order (later writes to a key replace earlier ones). */
  get writes(): PresetWrite[] { return [...this.pending.values()]; }

  private slotOf(kind: PresetKind): number { return kind === 'filament' ? this.slot : 0; }

  /** Current tab value including the pending edits. */
  tab(kind: PresetKind, key: string): ConfigValue | undefined {
    const w = this.pending.get(`${kind}:${key}`);
    return w ? w.value : this.src.value(kind, key, this.slotOf(kind));
  }

  private vector(key: string, cur: ConfigValue | undefined): boolean | null {
    const o = this.src.option(key);
    if (o === undefined) return null; // not an option of this engine build: skip
    return o === null ? Array.isArray(cur) : o.vector;
  }

  private record(kind: PresetKind, key: string, value: ConfigValue): void {
    this.pending.set(`${kind}:${key}`, { kind, key, slot: this.slotOf(kind), value });
    // Mirror: process / printer values are global; filament vectors in the resolved config are per slot.
    const full = this.cfg[key];
    if (kind === 'filament' && Array.isArray(full) && !Array.isArray(value)) {
      const next = full.slice(); next[this.slot] = value; this.cfg[key] = next;
    } else if (kind === 'filament' && Array.isArray(full) && Array.isArray(value) && full.length > value.length) {
      const next = full.slice(); next[this.slot] = value[0]; this.cfg[key] = next;
    } else this.cfg[key] = Array.isArray(value) ? value.slice() : value;
  }

  /** Set a key; vectors get the value in every element (Orca set_config_values). */
  set(kind: PresetKind, key: string, v: Scalar): void {
    const cur = this.tab(kind, key);
    const vec = this.vector(key, cur);
    if (vec === null) return;
    const s = serialize(v);
    const list = asList(cur);
    this.record(kind, key, vec ? (list.length ? list.map(() => s) : [s]) : s);
  }

  /** Set the element of 0-based extruder `ext`'s nozzle variant (scalar keys: the value). */
  setAt(kind: PresetKind, key: string, ext: number, v: Scalar): void {
    const cur = this.tab(kind, key);
    const vec = this.vector(key, cur);
    if (vec === null) return;
    const s = serialize(v);
    if (!vec) { this.record(kind, key, s); return; }
    const list = asList(cur).slice();
    const i = this.indexOf(kind, ext);
    const at = i >= 0 ? i : Math.min(ext, Math.max(0, list.length - 1));
    while (list.length <= at) list.push(list[list.length - 1] ?? s);
    list[at] = s;
    this.record(kind, key, list);
  }

  /** Replace a vector element-wise (`fn` gets each element and its index). */
  map(kind: PresetKind, key: string, fn: (s: string | undefined, i: number) => Scalar): void {
    const cur = this.tab(kind, key);
    const vec = this.vector(key, cur);
    if (vec === null) return;
    const list = asList(cur);
    if (!vec) { this.record(kind, key, serialize(fn(list[0], 0))); return; }
    this.record(kind, key, (list.length ? list : [undefined]).map((s, i) => serialize(fn(s, i))));
  }

  /** Write a whole vector (scalar keys: its first element). */
  setList(kind: PresetKind, key: string, list: Scalar[]): void {
    const vec = this.vector(key, this.tab(kind, key));
    if (vec === null || !list.length) return;
    const s = list.map(serialize);
    this.record(kind, key, vec ? s : s[0]);
  }

  print(key: string, v: Scalar): void { this.set('process', key, v); }
  printer(key: string, v: Scalar): void { this.set('printer', key, v); }
  filament(key: string, v: Scalar): void { this.set('filament', key, v); }

  // ---- reads -----------------------------------------------------------------------

  /** Element index of `kind`'s per-variant keys for 0-based extruder `ext` (-1: the config has no variant table). */
  indexOf(kind: PresetKind, ext = this.slot): number {
    const lookup: FlatConfig = { ...this.cfg };
    for (const k of VARIANT_KEYS[kind]) {
      const v = this.tab(kind, k);
      if (v !== undefined) lookup[k] = v;
    }
    return variantIndex(lookup, FAMILY[kind], variantSelector(this.cfg, ext));
  }

  /** Tab value of `key` at extruder `ext`'s variant (a pre-2.5 vector: the extruder's own element). */
  at(kind: PresetKind, key: string, ext = this.slot): string | undefined {
    const i = this.indexOf(kind, ext);
    return valueAt(this.tab(kind, key), i >= 0 ? i : kind === 'filament' ? SCALAR : ext);
  }

  /** Number at extruder `ext`'s variant (ConfigBase::get_abs_value_at; percentages of `over`). */
  num(kind: PresetKind, key: string, ext = this.slot, fallback = 0, over = 0): number {
    const s = this.at(kind, key, ext);
    return s !== undefined && s.trim().endsWith('%') ? absValue(s, over, fallback) : toNumber(s, fallback);
  }

  bool(kind: PresetKind, key: string, ext = this.slot): boolean { return toBool(this.at(kind, key, ext)); }

  /**
   * Number at bare element `i` of the tab value (ConfigOptionVector::get_at: past the end → the first),
   * where Orca reads an element index rather than the extruder's variant (get_abs_value_at(key, id), get_at(0)).
   */
  el(kind: PresetKind, key: string, i = 0, fallback = 0, over = 0): number {
    const s = valueAt(this.tab(kind, key), i);
    return s !== undefined && s.trim().endsWith('%') ? absValue(s, over, fallback) : toNumber(s, fallback);
  }

  /** First element of a tab value (Orca `values.front()` / `get_at(0)` on printer vectors). */
  first(kind: PresetKind, key: string, fallback = 0): number { return toNumber(valueAt(this.tab(kind, key), SCALAR), fallback); }

  /** String read of the resolved config (enums such as gcode_flavor). */
  str(key: string): string { return valueAt(this.cfg[key], SCALAR) ?? ''; }

  /** Nozzle diameter of 0-based extruder `ext` (clamped to the printer's extruders), 0.4 when unset. */
  nozzle(ext = 0): number {
    const list = asList(this.tab('printer', 'nozzle_diameter') ?? this.cfg.nozzle_diameter);
    const n = toNumber(list[Math.min(Math.max(ext, 0), Math.max(0, list.length - 1))], 0.4);
    return n > 0 ? n : 0.4;
  }

  /** Number of extruders (nozzle_diameter entries). */
  extruderCount(): number { return Math.max(1, asList(this.tab('printer', 'nozzle_diameter') ?? this.cfg.nozzle_diameter).length); }

  /** Plater.cpp has_junction_deviation: Marlin 2 with machine_max_junction_deviation[0] > 0. */
  hasJunctionDeviation(): boolean { return this.str('gcode_flavor') === 'marlin2' && this.first('printer', 'machine_max_junction_deviation') > 0; }
}

/**
 * Per-object overrides, serialised and filtered to the engine's options.
 * Vector options take arrays (a scalar becomes a one-element vector, like
 * Orca's `ConfigOptionFloatsNullable(1, v)`); scalar options take a scalar.
 */
export function objectOverrides(src: PresetSource, values: Record<string, Scalar | Scalar[]>): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const [k, v] of Object.entries(values)) {
    const o = src.option(k);
    if (o === undefined) continue;
    const list = (Array.isArray(v) ? v : [v]).map(serialize);
    out[k] = o?.vector ? list : list[0];
  }
  return out;
}

/**
 * Generic preset inheritance: `inherits` chains flattened root → leaf (the
 * child wins, key by key — Orca/Prusa `config = parent; config.apply(child)`).
 */
import type { ConfigValue } from '../engine/types';
import { STRUCTURAL_KEYS, type PresetInfo, type PresetValues } from './types';
import { aliasOf, str, strList } from './util';

export type RawPreset = Record<string, unknown>;

/** Lookup a parent by its `inherits` reference. */
export type ParentLookup = (ref: string, child: RawPreset) => RawPreset | null | undefined | Promise<RawPreset | null | undefined>;

export interface FlattenResult {
  /** Leaf → root names/refs actually resolved. */
  chain: string[];
  /** Missing parent reference, if the chain was cut short. */
  missing?: string;
  /** Merged raw values (structural keys removed). */
  values: Record<string, unknown>;
}

const MAX_DEPTH = 32;

export async function flattenInherits(leaf: RawPreset, lookup: ParentLookup, leafRef = str(leaf.name)): Promise<FlattenResult> {
  const stack: RawPreset[] = [leaf];
  const chain: string[] = [leafRef];
  const seen = new Set<string>([leafRef]);
  let cur = leaf;
  let missing: string | undefined;
  while (stack.length < MAX_DEPTH) {
    const ref = typeof cur.inherits === 'string' ? cur.inherits.trim() : '';
    if (!ref || seen.has(ref)) break;
    const parent = await lookup(ref, cur);
    if (!parent) { missing = ref; break; }
    seen.add(ref);
    chain.push(ref);
    stack.push(parent);
    cur = parent;
  }
  const values: Record<string, unknown> = {};
  for (let i = stack.length - 1; i >= 0; i--) {
    for (const [k, v] of Object.entries(stack[i])) {
      if (STRUCTURAL_KEYS.has(k)) continue;
      values[k] = v;
    }
  }
  return { chain, missing, values };
}

/** Synchronous variant for in-memory bundles. */
export function flattenInheritsSync(leaf: RawPreset, lookup: (ref: string) => RawPreset | null | undefined, leafRef = str(leaf.name)): FlattenResult {
  const stack: RawPreset[] = [leaf];
  const chain: string[] = [leafRef];
  const seen = new Set<string>([leafRef]);
  let cur = leaf;
  let missing: string | undefined;
  while (stack.length < MAX_DEPTH) {
    const ref = typeof cur.inherits === 'string' ? cur.inherits.trim() : '';
    if (!ref || seen.has(ref)) break;
    const parent = lookup(ref);
    if (!parent) { missing = ref; break; }
    seen.add(ref);
    chain.push(ref);
    stack.push(parent);
    cur = parent;
  }
  const values: Record<string, unknown> = {};
  for (let i = stack.length - 1; i >= 0; i--) {
    for (const [k, v] of Object.entries(stack[i])) if (!STRUCTURAL_KEYS.has(k)) values[k] = v;
  }
  return { chain, missing, values };
}

/**
 * The presets a system preset names in `include` (Orca 2.5, BBL_JSON_KEY_INCLUDES): an array of
 * names or one bare name. PresetBundle::load_vendor_configs_from_json layers each one's resolved
 * values over the resolved `inherits` parent, in this order, before the preset's own keys.
 */
export function includesOf(raw: RawPreset): string[] {
  const v = raw.include;
  const list = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v];
  return list.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

/**
 * A vendor file that only exists to be included or inherited (parse_subfile): `instantiation`
 * "false", or — when it states none — a nameless file or one named as G-code
 * ("Bambu Lab H2C 0.4 nozzle template machine_start_gcode").
 */
export function isTemplate(raw: RawPreset): boolean {
  const inst = str(raw.instantiation);
  if (inst) return inst === 'false';
  const name = str(raw.name);
  return !name || name.includes('gcode');
}

/** Raw JSON values → engine-native strings / string arrays (no schema needed). */
export function toPresetValues(raw: Record<string, unknown>): PresetValues {
  const out: PresetValues = {};
  for (const [k, v] of Object.entries(raw)) {
    if (STRUCTURAL_KEYS.has(k)) continue;
    const cv = rawToConfigValue(v);
    if (cv !== undefined) out[k] = cv;
  }
  return out;
}

function rawToConfigValue(v: unknown): ConfigValue | undefined {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'boolean' ? (x ? '1' : '0') : x === null ? '' : String(x)));
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'object') return undefined;
  return String(v);
}

/** Fill preset-picker metadata from flattened values. */
export function infoMetaFrom(values: Record<string, unknown>, name: string, rawLeaf?: RawPreset): Partial<PresetInfo> {
  const cond = (k: string) => { const s = str(values[k]).trim(); return s || undefined; };
  const list = (k: string) => { const l = strList(values[k]); return l.length ? l : undefined; };
  return {
    alias: aliasOf(name, typeof rawLeaf?.alias === 'string' ? rawLeaf.alias : undefined),
    printerModel: str(values.printer_model) || undefined,
    printerVariant: str(values.printer_variant) || undefined,
    filamentType: str(values.filament_type) || undefined,
    filamentVendor: str(values.filament_vendor) || undefined,
    compatiblePrinters: list('compatible_printers'),
    compatiblePrintersCondition: cond('compatible_printers_condition'),
    compatiblePrints: list('compatible_prints'),
    compatiblePrintsCondition: cond('compatible_prints_condition'),
    defaultProcess: str(values.default_print_profile) || undefined,
    defaultFilaments: list('default_filament_profile'),
  };
}

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

export function rawToConfigValue(v: unknown): ConfigValue | undefined {
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

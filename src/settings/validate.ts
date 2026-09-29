/**
 * Schema validation of engine-native values: type, min/max, enum membership.
 *
 * `getConfigProblems()` validates the active engine's resolved config (what
 * the slice button would send) and is what the slice orchestrator reads.
 */
import { computed } from 'vue';
import { resolvedConfig } from '../app/state';
import type { ConfigOptionDef, ConfigSchema, ConfigValue, FlatConfig } from '../engine/types';
import { currentPresets } from '../presets/store';
import { elementType, isVectorType, parseBool, parseFloatOrPercent, parseNumber, parsePoint } from '../presets/values';

export interface ConfigProblem {
  key: string;
  /** Element index for vector options. */
  index?: number;
  label: string;
  message: string;
  severity: 'error' | 'warning';
}

const OPEN_ENUM = new Set(['select_open', 'f_enum_open', 'i_enum_open']);

export function isOpenEnum(def: ConfigOptionDef): boolean {
  return !!def.guiType && OPEN_ENUM.has(def.guiType);
}

function range(def: ConfigOptionDef, n: number): string | null {
  // Nullable filament overrides reuse the base option's limits but accept sentinels (e.g. 0 = inherit).
  if (def.nullable) return null;
  if (def.min !== null && def.min !== undefined && n < def.min) return `must be ≥ ${def.min}`;
  if (def.max !== null && def.max !== undefined && n > def.max) return `must be ≤ ${def.max}`;
  return null;
}

/** Validate one scalar element. Returns an error message or null. */
export function validateScalar(def: ConfigOptionDef, raw: string): string | null {
  const v = raw.trim();
  if (def.nullable && v === 'nil') return null;
  switch (elementType(def.type)) {
    case 'bool':
      return parseBool(v) === null ? 'must be on/off (0 or 1)' : null;
    case 'int': {
      const n = parseNumber(v);
      if (n === null || !Number.isInteger(n)) return 'must be a whole number';
      return range(def, n);
    }
    case 'float': {
      const n = parseNumber(v);
      if (n === null) return 'must be a number';
      return range(def, n);
    }
    case 'percent': {
      const p = parseFloatOrPercent(v);
      if (p === null) return 'must be a percentage (e.g. 15%)';
      return range(def, p.value);
    }
    case 'floatOrPercent': {
      const p = parseFloatOrPercent(v);
      if (p === null) return 'must be a number or a percentage';
      // min/max apply to the absolute value in Orca/Prusa; percentages are only checked for sign.
      if (p.percent) return def.min !== null && def.min !== undefined && def.min >= 0 && p.value < 0 ? 'must not be negative' : null;
      return range(def, p.value);
    }
    case 'enum': {
      if (isOpenEnum(def)) return null;
      const vals = def.enumValues ?? [];
      return vals.length && !vals.includes(v) ? `"${v}" is not a valid choice` : null;
    }
    case 'point':
      // Orca's ConfigOptionPoint accepts "x,y" as well as "xXy".
      return parsePoint(v) || parsePoint(v.replace(/^([^,]+),([^,]+)$/, '$1x$2')) ? null : 'must be a point like 10x20';
    case 'point3':
      return v.split(',').length === 3 && v.split(',').every((x) => parseNumber(x) !== null) ? null : 'must be x,y,z';
    case 'string':
      if (def.enumValues?.length && !isOpenEnum(def) && def.type === 'strings' && !def.enumValues.includes(v)) return `"${v}" is not a valid choice`;
      return null;
    default:
      return null;
  }
}

/** Validate a value of any shape; one message per bad element. */
export function validateValue(def: ConfigOptionDef, value: ConfigValue | undefined): Array<{ index?: number; message: string }> {
  if (value === undefined) return [];
  if (def.readonly) return [];
  const out: Array<{ index?: number; message: string }> = [];
  if (isVectorType(def.type)) {
    const arr = Array.isArray(value) ? value : [value];
    if (def.type === 'points' && def.guiType !== 'one_string') {
      arr.forEach((el, i) => { if (el.trim() && !parsePoint(el)) out.push({ index: i, message: 'must be a point like 10x20' }); });
      return out;
    }
    arr.forEach((el, i) => { const m = validateScalar(def, el); if (m) out.push({ index: i, message: m }); });
    return out;
  }
  const m = validateScalar(def, Array.isArray(value) ? value[0] ?? '' : value);
  if (m) out.push({ message: m });
  return out;
}

export function validateConfig(schema: ConfigSchema, config: FlatConfig): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  for (const [key, value] of Object.entries(config)) {
    const def = schema.options[key];
    if (!def) continue;
    for (const p of validateValue(def, value)) {
      out.push({ key, index: p.index, label: def.fullLabel || def.label || key, message: p.message, severity: 'error' });
    }
  }
  return out;
}

/**
 * Problems of the active engine's resolved config (reactive). Values the user
 * edited (unsaved edits or user presets) are errors; odd values shipped by
 * system profiles (which the engine tolerates / substitutes) are warnings.
 */
export const configProblems = computed<ConfigProblem[]>(() => {
  const p = currentPresets.value;
  const schema = p.schema.value;
  if (!schema) return [];
  return validateConfig(schema, resolvedConfig.value).map((pr) => (p.userTouched(pr.key) ? pr : { ...pr, severity: 'warning' as const }));
});

/** For the slice button: all problems (check `severity === 'error'` to block slicing). */
export function getConfigProblems(): ConfigProblem[] {
  return configProblems.value;
}

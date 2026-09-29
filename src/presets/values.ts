/**
 * Engine-native config value helpers: parsing / serialization per option type,
 * normalisation of raw preset JSON values, equality.
 *
 * Values stay engine-native strings (scalars) or string arrays (vector
 * options, one element per extruder / filament / variant) end to end.
 */
import type { ConfigOptionDef, ConfigOptionType, ConfigValue, FlatConfig } from '../engine/types';

export const VECTOR_TYPES: ReadonlySet<ConfigOptionType> = new Set([
  'bools', 'ints', 'floats', 'percents', 'floatsOrPercents', 'strings', 'points',
]);

export function isVectorType(t: ConfigOptionType | undefined): boolean {
  return !!t && VECTOR_TYPES.has(t);
}

/** Scalar type of a vector type ('floats' → 'float'); scalars map to themselves. */
export function elementType(t: ConfigOptionType): ConfigOptionType {
  switch (t) {
    case 'bools': return 'bool';
    case 'ints': return 'int';
    case 'floats': return 'float';
    case 'percents': return 'percent';
    case 'floatsOrPercents': return 'floatOrPercent';
    case 'strings': return 'string';
    case 'points': return 'point';
    default: return t;
  }
}

// ---- C-style string vector (Orca/Prusa ConfigOptionStrings::serialize) ------

/** `escape_strings_cstyle`: join a string vector with ';', quoting where needed. */
export function escapeStrings(strs: readonly string[]): string {
  return strs.map((s) => {
    const quote = (strs.length === 1 && s === '') || /[ ;\t\\"\r\n]/.test(s);
    if (!quote) return s;
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  }).join(';');
}

/** `unescape_strings_cstyle`: inverse of escapeStrings. Lenient on malformed input. */
export function unescapeStrings(s: string): string[] {
  if (s === '') return [];
  const out: string[] = [];
  let i = 0;
  while (i <= s.length) {
    let cur = '';
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          cur += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n;
          i += 2;
        } else cur += s[i++];
      }
      i++; // closing quote
      while (i < s.length && s[i] !== ';') i++;
    } else {
      while (i < s.length && s[i] !== ';') cur += s[i++];
    }
    out.push(cur);
    if (i >= s.length) break;
    i++; // ';'
    if (i === s.length) { out.push(''); break; }
  }
  return out;
}

// ---- default / raw value parsing -------------------------------------------

/** Split a serialized vector into elements according to the option type. */
export function splitVector(type: ConfigOptionType, raw: string): string[] {
  if (type === 'strings') return unescapeStrings(raw);
  if (raw.trim() === '') return [];
  return raw.split(',').map((x) => x.trim());
}

/** Serialize a vector value to the engine's single-string form. */
export function joinVector(type: ConfigOptionType, values: readonly string[]): string {
  return type === 'strings' ? escapeStrings(values) : values.join(',');
}

/** Parse a schema `default` string into a ConfigValue of the right shape. */
export function parseDefault(def: ConfigOptionDef): ConfigValue {
  return isVectorType(def.type) ? splitVector(def.type, def.default ?? '') : (def.default ?? '');
}

function rawToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

/**
 * Normalise a raw preset JSON value (string, number, bool, array) to the
 * option's shape. Unknown options (no def) keep strings / string arrays.
 */
export function normalizeValue(def: ConfigOptionDef | undefined, v: unknown): ConfigValue {
  if (!def) return Array.isArray(v) ? v.map(rawToString) : rawToString(v);
  if (isVectorType(def.type)) {
    if (Array.isArray(v)) return v.map(rawToString);
    return splitVector(def.type, rawToString(v));
  }
  if (Array.isArray(v)) {
    // Scalars occasionally ship as 1-element arrays; points-as-string options
    // (e.g. bed_shape in some bundles) as XxY lists.
    // Join exactly like Orca's ConfigBase::load_from_json(): array elements of a
    // *scalar* option are comma-separated (only vector coStrings use ';').
    // e.g. thumbnails: ["16x16/QOI", "313x173/QOI"] -> "16x16/QOI,313x173/QOI".
    if (def.type === 'string' || def.type === 'point' || def.type === 'point3') return v.map(rawToString).join(',');
    return rawToString(v[0]);
  }
  return rawToString(v);
}

export function valuesEqual(a: ConfigValue | undefined, b: ConfigValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as string[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== bb[i]) return false;
    return true;
  }
  return false;
}

export function cloneValue(v: ConfigValue): ConfigValue {
  return Array.isArray(v) ? v.slice() : v;
}

/** Shallow key/value equality of two flat configs (values compared element-wise). */
export function configsEqual(a: FlatConfig, b: FlatConfig): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!(k in b) || !valuesEqual(a[k], b[k])) return false;
  return true;
}

// ---- scalar parsing for controls / validation ------------------------------

export function parseBool(s: string): boolean | null {
  const t = s.trim().toLowerCase();
  if (t === '1' || t === 'true') return true;
  if (t === '0' || t === 'false' || t === '') return false;
  return null;
}

export const serializeBool = (b: boolean): string => (b ? '1' : '0');

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

export function parseNumber(s: string): number | null {
  const t = s.trim();
  if (!NUM_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "50%" → {value:50, percent:true}; "0.4" → {value:0.4, percent:false}. */
export function parseFloatOrPercent(s: string): { value: number; percent: boolean } | null {
  const t = s.trim();
  const percent = t.endsWith('%');
  const n = parseNumber(percent ? t.slice(0, -1) : t);
  return n === null ? null : { value: n, percent };
}

/** Canonical number formatting (no exponent for normal magnitudes, trims float noise). */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1e9) / 1e9;
  return String(r);
}

/** Parse "XxY" (point) → [x, y]. */
export function parsePoint(s: string): [number, number] | null {
  const m = s.trim().match(/^(-?[\d.]+(?:e-?\d+)?)\s*x\s*(-?[\d.]+(?:e-?\d+)?)$/i);
  if (!m) return null;
  const x = Number(m[1]), y = Number(m[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

export const serializePoint = (p: readonly [number, number]): string => `${formatNumber(p[0])}x${formatNumber(p[1])}`;

/**
 * Normalise user text input for a scalar of the given type into the
 * engine-native form (e.g. "50 %" → "50%", "1.50" → "1.5", "true" → "1").
 * Returns the trimmed input unchanged when it can't be parsed — validation
 * reports it instead of silently dropping the edit.
 */
export function normalizeInput(type: ConfigOptionType, text: string): string {
  const t = text.trim();
  switch (elementType(type)) {
    case 'bool': { const b = parseBool(t); return b === null ? t : serializeBool(b); }
    case 'int': { const n = parseNumber(t); return n === null ? t : String(Math.trunc(n)) === String(n) ? String(n) : t; }
    case 'float': { const n = parseNumber(t); return n === null ? t : formatNumber(n); }
    case 'percent': { const p = parseFloatOrPercent(t); return p === null ? t : `${formatNumber(p.value)}%`; }
    case 'floatOrPercent': { const p = parseFloatOrPercent(t); return p === null ? t : `${formatNumber(p.value)}${p.percent ? '%' : ''}`; }
    case 'point': { const p = parsePoint(t); return p ? serializePoint(p) : t; }
    default: return text;
  }
}

/** First element of a vector, or the scalar itself. */
export function firstOf(v: ConfigValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export function asArray(v: ConfigValue | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

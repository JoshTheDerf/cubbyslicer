/**
 * Orca config values as plugins see them: `config_value(key)` returns
 * `ConfigOption::serialize()` text (libslic3r/Config.hpp / Config.cpp).
 * CubbySlicer stores `string | string[]` (vectors element-wise); this turns
 * them into Orca's serialized form and back.
 *
 *  - string:   escape_string_cstyle (\n \r \\ " escaped, no quotes)
 *  - strings:  escape_strings_cstyle (';'-joined, an item quoted when it has
 *              space, tab, ';', '\', '"', CR or LF — or is the only, empty item)
 *  - bools / ints / floats / percents / floatsOrPercents / points: ','-joined
 *  - scalars (bool, int, float, percent, floatOrPercent, enum, point): as stored
 */
import type { ConfigOptionType, ConfigValue } from '../../engine/types';

export function escapeStringCstyle(s: string): string {
  return s.replace(/[\\"\r\n]/g, (c) => (c === '\r' ? '\\r' : c === '\n' ? '\\n' : '\\' + c));
}

export function escapeStringsCstyle(items: readonly string[]): string {
  return items.map((s) => {
    const quote = (items.length === 1 && s === '') || /[ \t;\\"\r\n]/.test(s);
    return quote ? `"${s.replace(/[\\"\r\n]/g, (c) => (c === '\r' ? '\\r' : c === '\n' ? '\\n' : '\\' + c))}"` : s;
  }).join(';');
}

export function unescapeStringCstyle(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));
}

/** unescape_strings_cstyle: split Orca's ';'-joined, optionally quoted string list. */
export function unescapeStringsCstyle(s: string): string[] {
  const out: string[] = [];
  if (s === '') return out;
  let i = 0;
  for (;;) {
    let item = '';
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) { i++; item += s[i] === 'n' ? '\n' : s[i] === 'r' ? '\r' : s[i]; }
        else item += s[i];
        i++;
      }
      i++; // closing quote
      while (i < s.length && s[i] !== ';') i++;
    } else {
      const j = s.indexOf(';', i);
      item = j < 0 ? s.slice(i) : s.slice(i, j);
      i = j < 0 ? s.length : j;
    }
    out.push(item);
    if (i >= s.length) break;
    i++; // ';'
    if (i === s.length) { out.push(''); break; }
  }
  return out;
}

const VECTOR_TYPES = new Set<ConfigOptionType>(['bools', 'ints', 'floats', 'percents', 'floatsOrPercents', 'strings', 'points']);
export const isVector = (t: ConfigOptionType): boolean => VECTOR_TYPES.has(t);

const boolText = (v: string) => (v === 'true' ? '1' : v === 'false' ? '0' : v);

/** CubbySlicer value → Orca serialized text. `type` undefined (key not in the schema): strings as-is, arrays as strings. */
export function serializeOrcaValue(type: ConfigOptionType | undefined, v: ConfigValue | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const arr = Array.isArray(v) ? v : null;
  switch (type) {
    // Stored text is what Orca would deserialize; serialize(deserialize(x)) normalizes escapes.
    case 'string': return escapeStringCstyle(unescapeStringCstyle(arr ? arr.join(',') : v as string));
    case 'strings': return escapeStringsCstyle(arr ?? [v as string]);
    case 'bools': return (arr ?? [v as string]).map(boolText).join(',');
    case 'bool': return boolText(arr ? arr[0] ?? '' : v as string);
    case 'ints': case 'floats': case 'percents': case 'floatsOrPercents': case 'points':
      return (arr ?? [v as string]).join(',');
    case undefined:
      return arr ? escapeStringsCstyle(arr) : v as string;
    default:
      return arr ? arr.join(',') : v as string;
  }
}

/** Orca serialized text → CubbySlicer value (the inverse, for preset writes). */
export function parseOrcaValue(type: ConfigOptionType | undefined, s: string): ConfigValue {
  switch (type) {
    case 'string': return unescapeStringCstyle(s);
    case 'strings': return unescapeStringsCstyle(s);
    case 'bools': case 'ints': case 'floats': case 'percents': case 'floatsOrPercents': case 'points':
      return s === '' ? [] : s.split(',').map((x) => x.trim());
    default: return s;
  }
}

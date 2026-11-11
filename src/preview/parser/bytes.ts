/**
 * Byte-level helpers for the G-code parser: character codes, a decimal number
 * reader that works on UTF-8 bytes without making strings, and the few
 * string parsers header comments need.
 */

export const NL = 10, CR = 13, SP = 32, TAB = 9, SEMI = 59, DOT = 46, MINUS = 45, PLUS = 43;

/** Parameter slot (0..25) of an upper-case axis / parameter letter. */
export const LETTER = (c: string): number => c.charCodeAt(0) - 65;

/** Index just past the digits read by the last `parseNumber` call (a live binding). */
export let numEnd = 0;

const INV_POW10 = new Float64Array(16).map((_, i) => 1 / 10 ** i);

/** Parse a decimal number (no exponent: `E` is an axis letter). NaN if no digits. Sets `numEnd`. */
export function parseNumber(b: Uint8Array, p: number, end: number): number {
  let neg = false;
  const c = b[p];
  if (c === MINUS) { neg = true; p++; } else if (c === PLUS) { p++; }
  let intPart = 0, digits = 0;
  while (p < end) {
    const d = b[p] - 48;
    if (d < 0 || d > 9) break;
    intPart = intPart * 10 + d; p++; digits++;
  }
  let v = intPart;
  if (p < end && b[p] === DOT) {
    p++;
    let frac = 0, nd = 0;
    while (p < end) {
      const d = b[p] - 48;
      if (d < 0 || d > 9) break;
      if (nd < 15) { frac = frac * 10 + d; nd++; }
      p++; digits++;
    }
    v += frac * INV_POW10[nd];
  }
  numEnd = p;
  if (digits === 0) return NaN;
  return neg ? -v : v;
}

/** Bytes [start, end) as a Latin-1 string (comment lines are short). */
export function ascii(b: Uint8Array, start: number, end: number): string {
  // fromCharCode.apply on a typed array: fast for short strings.
  return String.fromCharCode.apply(null, b.subarray(start, end) as unknown as number[]);
}

/** "1d 2h 3m 4s" / "2h 5m" / "45s" / "1:02:03" → seconds; NaN if nothing parsed. */
export function parseDuration(s: string): number {
  let total = 0, any = false;
  const re = /(\d+(?:\.\d+)?)\s*([dhms])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    any = true;
    const v = Number(m[1]);
    switch (m[2].toLowerCase()) {
      case 'd': total += v * 86400; break;
      case 'h': total += v * 3600; break;
      case 'm': total += v * 60; break;
      default: total += v;
    }
  }
  if (!any) {
    const hms = s.match(/(\d+):(\d{2}):(\d{2})/);
    if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    return NaN;
  }
  return total;
}

/** "1.5, 2;3" → [1.5, 2, 3] (non-numbers dropped). */
export function numList(s: string): number[] {
  return s.split(/[,;]/).map((t) => Number(t.trim())).filter((v) => Number.isFinite(v));
}

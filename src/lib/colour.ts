/**
 * One colour parser / formatter for the app.
 *
 * Colour strings (Orca `decode_color`, `libslic3r/Color.cpp`): `#RRGGBB` or
 * `#RRGGBBAA` (2.5 filament opacity; AA = 255 is opaque). For leniency we
 * also take `#RGB` / `#RGBA` and a missing `#`, which other sources (OBJ
 * materials, G-code tags, user input) use.
 *
 * Filament colours in Orca 2.5 are three parallel per-slot string vectors
 * (`PrintConfig.cpp` `filament_colour`, `filament_multi_colour`,
 * `filament_colour_type`; read by `PresetComboBoxes.cpp`
 * `filament_color_picker_value`, drawn by `FilamentBitmapUtils.cpp`
 * `draw_rounded_filament_swatch`):
 * - `filament_colour[i]`: the slot's single colour (the first colour of a
 *   multi-colour filament), `#RRGGBB` or `#RRGGBBAA`.
 * - `filament_multi_colour[i]`: every colour of the filament, separated by
 *   single spaces: `"#FF0000 #00FF00"`. Empty means "just filament_colour".
 * - `filament_colour_type[i]`: `"0"` = gradient (the colours blend left to
 *   right), `"1"` (default) = solid or segmented (equal hard-edged bands).
 *   Gradient only applies with two or more colours.
 * A swatch with any translucent colour is drawn over a checkerboard of white
 * and rgb(217, 217, 217) squares, `height / 5` big.
 */
import { Color, SRGBColorSpace } from 'three';

/** 8-bit channels; `a` 255 = opaque. */
export interface RGBA { r: number; g: number; b: number; a: number }

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const hex2 = (v: number) => clamp8(v).toString(16).padStart(2, '0');

/** `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` (the `#` optional, any case) → RGBA, or null. */
export function parseColour(s: string | null | undefined): RGBA | null {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec((s ?? '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
  const at = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: at(0), g: at(2), b: at(4), a: h.length === 8 ? at(6) : 255 };
}

/** parseColour with a fallback for unparseable input. */
export function parseColourOr(s: string | null | undefined, fallback: RGBA | string): RGBA {
  return parseColour(s) ?? (typeof fallback === 'string' ? parseColour(fallback) ?? { r: 0, g: 0, b: 0, a: 255 } : fallback);
}

/** True when the string parses and has an alpha below 255. */
export function isTranslucent(c: RGBA | string): boolean {
  const v = typeof c === 'string' ? parseColour(c) : c;
  return !!v && v.a < 255;
}

/**
 * RGBA → `#RRGGBB` (uppercase). `alpha: 'auto'` (default) appends `AA` only when
 * translucent, `'always'` always, `'never'` drops it.
 */
export function toHex(c: Pick<RGBA, 'r' | 'g' | 'b'> & { a?: number }, alpha: 'auto' | 'always' | 'never' = 'auto'): string {
  const a = c.a ?? 255;
  const tail = alpha === 'always' || (alpha === 'auto' && clamp8(a) < 255) ? hex2(a) : '';
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${tail}`.toUpperCase();
}

/** Normalise a colour string to `#RRGGBB[AA]` uppercase, or null. */
export function normaliseHex(s: string | null | undefined): string | null {
  const c = parseColour(s);
  return c ? toHex(c) : null;
}

/** Replace the RGB part of `value` with `rgb`'s, keeping `value`'s alpha (colour pickers that only edit RGB). */
export function withRgb(value: string, rgb: string): string | null {
  const next = parseColour(rgb);
  if (!next) return null;
  const old = parseColour(value);
  return toHex({ ...next, a: old?.a ?? 255 });
}

/** RGB as a 24-bit integer 0xRRGGBB (alpha dropped). */
export function toInt(c: Pick<RGBA, 'r' | 'g' | 'b'>): number {
  return (clamp8(c.r) << 16) | (clamp8(c.g) << 8) | clamp8(c.b);
}

/** Parse straight to 0xRRGGBB (alpha dropped), or null. */
export function hexToInt(s: string | null | undefined): number | null {
  const c = parseColour(s);
  return c ? toInt(c) : null;
}

export function fromInt(n: number): RGBA {
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
}

/** 0xRRGGBB → CSS `#rrggbb` (lowercase, as the canvas / three.js code writes it). */
export function intToCss(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** CSS colour for an RGBA: `#RRGGBB`, or `#RRGGBBAA` when translucent. */
export function toCss(c: RGBA): string {
  return toHex(c);
}

/** Channels as 0..1 floats, no colour management (what Orca feeds its shaders). */
export function toRgb01(c: Pick<RGBA, 'r' | 'g' | 'b'>): [number, number, number] {
  return [c.r / 255, c.g / 255, c.b / 255];
}

/**
 * A three.js Color from an RGBA or colour string, treated as sRGB (same as
 * `new Color('#rrggbb')`, so three's colour management applies). Alpha is
 * ignored: use `c.a / 255` as material opacity.
 */
export function toThreeColor(c: RGBA | string, fallback: RGBA | string = '#888888', target = new Color()): Color {
  const v = typeof c === 'string' ? parseColourOr(c, fallback) : c;
  return target.setRGB(v.r / 255, v.g / 255, v.b / 255, SRGBColorSpace);
}

/** Perceived brightness 0..255 (Rec. 601 weights, as the dialogs used). */
export function brightness(c: Pick<RGBA, 'r' | 'g' | 'b'>): number {
  return c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
}

/**
 * Text colour readable on a swatch: `'#111'` on light, `'#fff'` on dark
 * (brightness > 150). Alpha is ignored, so text on a translucent swatch reads
 * as it would on the opaque colour.
 */
export function contrastText(bg: RGBA | string): '#111' | '#fff' {
  const c = typeof bg === 'string' ? parseColour(bg) : bg;
  return c && brightness(c) > 150 ? '#111' : '#fff';
}

/** Linear blend in sRGB (alpha too); t = 0 → a, 1 → b. */
export function mixColour(a: RGBA, b: RGBA, t: number): RGBA {
  const l = (x: number, y: number) => x + (y - x) * t;
  return { r: l(a.r, b.r), g: l(a.g, b.g), b: l(a.b, b.b), a: l(a.a, b.a) };
}

// ---- filament colours (Orca 2.5) ---------------------------------------------------

export interface FilamentColour {
  /** At least one colour; the first is `filament_colour`. */
  colours: RGBA[];
  /** Blend the colours (`filament_colour_type` "0"); otherwise hard segments. */
  gradient: boolean;
}

/** Orca's default `filament_colour`. */
export const DEFAULT_FILAMENT_COLOUR = '#F2754E';

/**
 * One slot from its three values (`filament_colour`, `filament_multi_colour`,
 * `filament_colour_type`), as `filament_color_picker_value` reads them.
 * Unparseable entries are skipped; with nothing usable you get `fallback`.
 */
export function parseFilamentColour(primary: string | undefined, multi?: string, type?: string,
  fallback: string = DEFAULT_FILAMENT_COLOUR): FilamentColour {
  const colours = (multi ?? '').split(/\s+/).map(parseColour).filter((c): c is RGBA => !!c);
  const head = parseColour(primary);
  if (!colours.length) colours.push(head ?? parseColourOr(fallback, DEFAULT_FILAMENT_COLOUR));
  return { colours, gradient: colours.length > 1 && (type ?? '').trim() === '0' };
}

type ConfigLike = Record<string, string | readonly string[] | undefined>;

function slotOf(v: string | readonly string[] | undefined, slot: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return v[slot];
  // A serialized vector: Orca joins strings with ';' (and the app sometimes with ',').
  return v.split(/[;,]/)[slot];
}

/** The 0-based filament `slot`'s colour from a (resolved / project) config. */
export function configFilamentColour(cfg: ConfigLike, slot: number, fallback: string = DEFAULT_FILAMENT_COLOUR): FilamentColour {
  return parseFilamentColour(slotOf(cfg.filament_colour, slot), slotOf(cfg.filament_multi_colour, slot),
    slotOf(cfg.filament_colour_type, slot), fallback);
}

/** The three config values for one slot (inverse of parseFilamentColour). */
export function formatFilamentColour(fc: FilamentColour): { filament_colour: string; filament_multi_colour: string; filament_colour_type: string } {
  const hex = fc.colours.map((c) => toHex(c));
  return {
    filament_colour: hex[0] ?? DEFAULT_FILAMENT_COLOUR,
    filament_multi_colour: hex.join(' '),
    filament_colour_type: fc.gradient && hex.length > 1 ? '0' : '1',
  };
}

/** The colour to use where only one fits (3D preview, single-colour icons): the first. */
export function primaryColour(fc: FilamentColour): RGBA {
  return fc.colours[0];
}

/** Orca's checkerboard under translucent swatches: white with rgb(217,217,217) squares. */
export function checkerboardCss(square = 4): string {
  return `repeating-conic-gradient(#D9D9D9 0 25%, #FFFFFF 0 50%) 0 0 / ${2 * square}px ${2 * square}px`;
}

/**
 * CSS `background` for a filament swatch: a flat colour, hard segments or a
 * left-to-right gradient, over the checkerboard when any colour is
 * translucent. Use as `:style="{ background: swatchBackground(fc) }"`.
 */
export function swatchBackground(fc: FilamentColour | RGBA | string, square = 4): string {
  const f: FilamentColour = typeof fc === 'string'
    ? parseFilamentColour(fc)
    : 'colours' in fc ? fc : { colours: [fc], gradient: false };
  const cs = f.colours.map(toCss);
  const translucent = f.colours.some((c) => c.a < 255);
  if (cs.length === 1 && !translucent) return cs[0];
  let top: string;
  if (cs.length === 1) top = `linear-gradient(${cs[0]}, ${cs[0]})`;
  else if (f.gradient) top = `linear-gradient(to right, ${cs.join(', ')})`;
  else {
    const n = cs.length;
    const pct = (i: number) => `${Math.round((i / n) * 10000) / 100}%`;
    top = `linear-gradient(to right, ${cs.map((c, i) => `${c} ${pct(i)} ${pct(i + 1)}`).join(', ')})`;
  }
  return translucent ? `${top}, ${checkerboardCss(square)}` : top;
}

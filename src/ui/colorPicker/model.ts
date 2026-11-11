/**
 * Orca 2.5's colour picker state (resources/web/dialog/ColorPickerDialog/colorpicker-model.js, v2.5.0):
 * a solid colour or a gradient of 2–7 colours, each RGBA bytes; HSL conversions; the contrast colour a
 * new gradient stop starts with; favourites. Selections are `{ type, colors: ['#RRGGBBAA', …] }`.
 */

export type RGBA8 = [number, number, number, number];
export interface Selection { type: 'solid' | 'gradient'; colors: string[] }
export interface PickerOptions { allowGradient?: boolean; allowAlpha?: boolean; maxGradientColors?: number }
export interface PickerState {
  options: { allowGradient: boolean; allowAlpha: boolean };
  maxGradientColors: number;
  mode: 'solid' | 'gradient';
  /** Selected gradient stop. */
  active: number;
  solid: RGBA8;
  gradient: RGBA8[] | null;
}

/** Most colours a gradient may have (COLOR_PICKER_MAX_GRADIENT_COLORS). */
export const MAX_GRADIENT_COLORS = 7;
/** Hue step of every newly created gradient colour. */
export const NEW_GRADIENT_HUE_SHIFT = 75;
/** Favourite slots shown; up to 24 are kept. */
export const FAVORITE_SLOTS = 16;
export const FAVORITES_KEPT = 24;

const gradientLimit = (v: number | undefined) => Math.max(2, Math.min(MAX_GRADIENT_COLORS, Math.floor(Number(v)) || 2));

export function parseHex(hex: string): RGBA8 | null {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null;
  return [1, 3, 5, 7].map((o) => (o === 7 && hex.length === 7 ? 255 : parseInt(hex.slice(o, o + 2), 16))) as RGBA8;
}

export function toHex(c: readonly number[]): string {
  return `#${c.map((b) => Math.round(b).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function normalizeSelection(value: Selection | null | undefined, options: { allowGradient?: boolean; allowAlpha?: boolean }, maxGradientColors = 2): Selection | null {
  if (!value || !['solid', 'gradient'].includes(value.type) || !Array.isArray(value.colors)) return null;
  if (value.type === 'gradient' && !options.allowGradient) return null;
  const n = value.colors.length;
  if (value.type === 'solid' ? n !== 1 : n < 2 || n > gradientLimit(maxGradientColors)) return null;
  const colors = value.colors.map(parseHex);
  if (colors.some((c) => c === null)) return null;
  if (!options.allowAlpha) colors.forEach((c) => { c![3] = 255; });
  return { type: value.type, colors: colors.map((c) => toHex(c!)) };
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 60; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1)), m = l - c / 2;
  const sectors = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
  return sectors[Math.floor(h)].map((ch) => Math.round((ch + m) * 255)) as [number, number, number];
}

/** The colour a new gradient stop starts with: hue shifted, lightness pushed away (greys go to black / white). */
export function contrastColor(color: RGBA8, hueShift = 90): RGBA8 {
  if (!Number.isFinite(hueShift)) hueShift = 90;
  const deg = Math.max(-180, Math.min(180, hueShift));
  const amount = Math.abs(deg) / 180;
  const [h, s, l] = rgbToHsl(color[0], color[1], color[2]);
  const grey = s < 10;
  const target = grey ? (l < 50 ? 100 : 0) : 100 - l;
  const rgb = hslToRgb(h + deg, grey ? 0 : s, l + (target - l) * amount);
  return [...rgb, color[3]] as RGBA8;
}

export function createState(options: PickerOptions = {}, selection: Selection = { type: 'solid', colors: ['#808080'] }): PickerState | null {
  const state: PickerState = {
    options: { allowGradient: options.allowGradient === true, allowAlpha: options.allowAlpha === true },
    maxGradientColors: gradientLimit(options.maxGradientColors), mode: 'solid', active: 0, solid: [128, 128, 128, 255], gradient: null,
  };
  return applySelection(state, selection) ? state : null;
}

export function applySelection(state: PickerState, value: Selection): boolean {
  const sel = normalizeSelection(value, state.options, state.maxGradientColors);
  if (!sel) return false;
  state.mode = sel.type;
  const colors = sel.colors.map((c) => parseHex(c)!);
  if (state.mode === 'solid') state.solid = colors[0];
  else {
    state.gradient = colors;
    state.active = Math.min(state.active, colors.length - 1);
  }
  return true;
}

export const activeColor = (s: PickerState): RGBA8 => (s.mode === 'solid' ? s.solid : s.gradient![s.active]);

export function setMode(state: PickerState, mode: 'solid' | 'gradient'): boolean {
  if (mode !== 'solid' && (mode !== 'gradient' || !state.options.allowGradient)) return false;
  // A new gradient starts at the current solid colour and ends at its contrast colour.
  if (mode === 'gradient' && !state.gradient) state.gradient = [[...state.solid] as RGBA8, contrastColor(state.solid, NEW_GRADIENT_HUE_SHIFT)];
  state.mode = mode;
  return true;
}

export function addGradientColor(state: PickerState): boolean {
  if (state.mode !== 'gradient' || state.gradient!.length >= state.maxGradientColors) return false;
  state.gradient!.splice(state.active + 1, 0, contrastColor(state.gradient![state.active], NEW_GRADIENT_HUE_SHIFT));
  state.active += 1;
  return true;
}

export function removeGradientColor(state: PickerState): boolean {
  if (state.mode !== 'gradient' || state.gradient!.length <= 2) return false;
  state.gradient!.splice(state.active, 1);
  state.active = Math.min(state.active, state.gradient!.length - 1);
  return true;
}

export function setRgb(state: PickerState, rgb: readonly number[]): boolean {
  if (rgb.length !== 3 || rgb.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) return false;
  const c = activeColor(state);
  rgb.forEach((v, i) => { c[i] = Math.round(v); });
  return true;
}

export function setAlphaPercent(state: PickerState, value: number): boolean {
  if (!state.options.allowAlpha || !Number.isFinite(value) || value < 0 || value > 100) return false;
  activeColor(state)[3] = Math.round(value * 255 / 100);
  return true;
}

export function setHex(state: PickerState, hex: string): boolean {
  const c = parseHex(hex);
  if (!c) return false;
  if (hex.length === 7) c[3] = activeColor(state)[3];
  if (!state.options.allowAlpha) c[3] = 255;
  if (state.mode === 'solid') state.solid = c;
  else state.gradient![state.active] = c;
  return true;
}

export function exportSelection(state: PickerState): Selection | null {
  const colors = state.mode === 'solid' ? [state.solid] : state.gradient!;
  return normalizeSelection({ type: state.mode, colors: colors.map(toHex) }, state.options, state.maxGradientColors);
}

/** Favourites keep full capabilities whatever this caller can select. */
export function normalizeFavorites(values: unknown): Selection[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, FAVORITES_KEPT).map((v) => normalizeSelection(v as Selection, { allowGradient: true, allowAlpha: true }, MAX_GRADIENT_COLORS)).filter((v): v is Selection => !!v);
}

/** Save `sel` as the first favourite (the save-colour button). */
export function addFavorite(favorites: readonly Selection[], sel: Selection): Selection[] {
  const key = JSON.stringify(sel);
  return [sel, ...favorites.filter((f) => JSON.stringify(f) !== key)].slice(0, FAVORITES_KEPT);
}

/** CSS background of a selection (gradient left to right). */
export function selectionBackground(v: Selection): string {
  const css = v.colors.map(cssOf);
  return v.type === 'gradient' ? `linear-gradient(to right, ${css.join(', ')})` : `linear-gradient(${css[0]}, ${css[0]})`;
}
function cssOf(hex: string): string {
  const c = parseHex(hex);
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] / 255).toFixed(3)})` : hex;
}

/** Palette filter: every word of the query in the name or the hex digits (`paletteMatches`). */
export function paletteMatches(entry: { name: string; hex?: string; grad?: string }, query: string): boolean {
  if (!query) return true;
  const hay = [entry.name, entry.hex ?? '', entry.grad ?? ''].join(' ').toLowerCase();
  return query.toLowerCase().split(/\s+/).every((w) => hay.includes(w.replace(/^#/, '')));
}

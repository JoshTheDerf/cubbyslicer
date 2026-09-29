/**
 * Flushing volumes (OrcaSlicer FlushVolCalc.cpp + FlushVolPredictor.cpp,
 * WipingDialog::CalcFlushingVolumes, Plater get_min_flush_volumes and the
 * per-nozzle flush_volumes_matrix layout from PrintConfig.hpp). Pure.
 */
import type { ConfigValue, FlatConfig } from '../../engine/types';
import { FLUSH_DATASETS } from './flushData';

export const MIN_FLUSH_FROM_SUPPORT = 700;
export const FLUSH_TO_SUPPORT = 230;
export const MAX_FLUSH_VOLUME = 20000;

interface RGBA { r: number; g: number; b: number; a: number }

/** "#RRGGBB" / "#RRGGBBAA" / "#RGB" → 0-255 channels (alpha 255 when absent). */
export function parseColour(s: string): RGBA {
  let h = (s || '').trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  const v = (i: number) => { const x = parseInt(h.slice(i, i + 2), 16); return Number.isFinite(x) ? x : 0; };
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return { r: 255, g: 255, b: 255, a: 255 };
  return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) : 255 };
}

// ---- colour spaces ------------------------------------------------------------------

function rgb2hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h: number;
  if (Math.abs(d) < 0.001) h = 0;
  else if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  const s = Math.abs(max) < 0.001 ? 0 : d / max;
  return [h, s, max];
}

function rgb2lab(c: { r: number; g: number; b: number }): [number, number, number] {
  const gamma = (x: number) => (x > 0.04045 ? Math.pow((x + 0.055) / 1.055, 2.4) : x / 12.92);
  const R = gamma(c.r / 255) * 100, G = gamma(c.g / 255) * 100, B = gamma(c.b / 255) * 100;
  const x = 0.412453 * R + 0.35758 * G + 0.180423 * B;
  const y = 0.212671 * R + 0.71516 * G + 0.072169 * B;
  const z = 0.019334 * R + 0.119193 * G + 0.950227 * B;
  const f = (t: number) => (t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 0.137931);
  const xn = f(x / 95.0489), yn = f(y / 100), zn = f(z / 108.884);
  return [116 * yn - 16, 500 * (xn - yn), 200 * (yn - zn)];
}

/** CIEDE2000 (FlushPredict::calc_color_distance). */
export function deltaE2000(l1: [number, number, number], l2: [number, number, number]): number {
  const deg = (d: number) => (d * Math.PI) / 180;
  const p25 = Math.pow(25, 7);
  const C1 = Math.hypot(l1[1], l1[2]), C2 = Math.hypot(l2[1], l2[2]);
  const pc7 = Math.pow((C1 + C2) / 2, 7);
  const G = 0.5 * (1 - Math.sqrt(pc7 / (pc7 + p25)));
  const a1 = (1 + G) * l1[1], a2 = (1 + G) * l2[1];
  const c1 = Math.hypot(a1, l1[2]), c2 = Math.hypot(a2, l2[2]);
  const hue = (a: number, b: number) => { if (a === 0 && b === 0) return 0; let h = Math.atan2(b, a); if (h < 0) h += Math.PI * 2; return h; };
  const h1 = hue(a1, l1[2]), h2 = hue(a2, l2[2]);
  const dL = l2[0] - l1[0], dC = c2 - c1;
  let dH = 0;
  if (c1 * c2 !== 0) {
    let d = h2 - h1;
    if (d < -Math.PI) d += 2 * Math.PI; else if (d > Math.PI) d -= 2 * Math.PI;
    dH = 2 * Math.sqrt(c1 * c2) * Math.sin(d / 2);
  }
  const Lm = (l1[0] + l2[0]) / 2, Cm = (c1 + c2) / 2;
  let Hm = h1 + h2;
  if (c1 * c2 !== 0) {
    if (Math.abs(h1 - h2) <= Math.PI) Hm = (h1 + h2) / 2;
    else Hm = h1 + h2 < 2 * Math.PI ? (h1 + h2 + 2 * Math.PI) / 2 : (h1 + h2 - 2 * Math.PI) / 2;
  }
  const T = 1 - 0.17 * Math.cos(Hm - deg(30)) + 0.24 * Math.cos(2 * Hm) + 0.32 * Math.cos(3 * Hm + deg(6)) - 0.2 * Math.cos(4 * Hm - deg(63));
  const dTheta = deg(30) * Math.exp(-Math.pow((Hm - deg(275)) / deg(25), 2));
  const cm7 = Math.pow(Cm, 7);
  const RC = 2 * Math.sqrt(cm7 / (cm7 + p25));
  const l50 = Math.pow(Lm - 50, 2);
  const SL = 1 + (0.015 * l50) / Math.sqrt(20 + l50), SC = 1 + 0.045 * Cm, SH = 1 + 0.015 * Cm * T;
  const RT = -Math.sin(2 * dTheta) * RC;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

// ---- measured data (GenericFlushPredictor) ----------------------------------------------------

interface Predictor { colors: Array<{ hex: string; lab: [number, number, number] }>; map: Map<string, number> }
const predictors = new Map<number, Predictor | null>();

function predictor(dataset: number): Predictor | null {
  if (predictors.has(dataset)) return predictors.get(dataset)!;
  const d = FLUSH_DATASETS[dataset];
  let p: Predictor | null = null;
  if (d) {
    const map = new Map<string, number>();
    for (const row of d.rows.split(';')) {
      const [a, b, v] = row.trim().split(/\s+/);
      if (a && b && v) map.set(`${a.toUpperCase()}${b.toUpperCase()}`, Number(v));
    }
    p = { colors: d.colors.map((hex) => ({ hex: hex.toUpperCase(), lab: rgb2lab(parseColour(hex)) })), map };
  }
  predictors.set(dataset, p);
  return p;
}

function predict(dataset: number, from: RGBA, to: RGBA): number | null {
  const p = predictor(dataset);
  if (!p) return null;
  const lf = rgb2lab(from), lt = rgb2lab(to);
  const sf = p.colors.find((c) => deltaE2000(c.lab, lf) <= 5);
  const st = p.colors.find((c) => deltaE2000(c.lab, lt) <= 5);
  if (!sf || !st) return null;
  return p.map.get(`${sf.hex}${st.hex}`) ?? null;
}

// ---- FlushVolCalculator -------------------------------------------------------------------------

const lum = (r: number, g: number, b: number) => r * 0.3 + g * 0.59 + b * 0.11;

function calcRgb(from: RGBA, to: RGBA, dataset: number): number {
  if (dataset === 0) { const v = predict(0, from, to); if (v !== null) return Math.trunc(v); }
  const [fr, fg, fb] = [from.r / 255, from.g / 255, from.b / 255];
  const [tr, tg, tb] = [to.r / 255, to.g / 255, to.b / 255];
  const [fh, fs, fv] = rgb2hsv(fr, fg, fb);
  const [th, ts, tv] = rgb2hsv(tr, tg, tb);
  const rad = (d: number) => (d / 180) * Math.PI;
  const dx = Math.cos(rad(fh)) * fs * fv - Math.cos(rad(th)) * ts * tv;
  const dy = Math.sin(rad(fh)) * fs * fv - Math.sin(rad(th)) * ts * tv;
  let hsDist = Math.min(1.2, Math.hypot(dx, dy));
  const fromLumi = lum(fr, fg, fb), toLumi = lum(tr, tg, tb);
  let lumiFlush: number;
  if (toLumi >= fromLumi) lumiFlush = Math.pow(toLumi - fromLumi, 0.7) * 560;
  else {
    lumiFlush = (fromLumi - toLumi) * 80;
    hsDist = Math.min(0.67 * tv + 0.33 * fv, hsDist);
  }
  const hsFlush = 230 * hsDist;
  const v = Math.sqrt(hsFlush * hsFlush + lumiFlush * lumiFlush - 2 * hsFlush * lumiFlush * Math.cos(rad(120)));
  return Math.trunc(Math.max(v, 60));
}

/** FlushVolCalculator::calc_flush_vol(min_flush, max, dataset). */
export function calcFlushVolume(fromHex: string, toHex: string, minFlush: number, dataset = 0, maxFlush = MAX_FLUSH_VOLUME): number {
  const from = parseColour(fromHex), to = parseColour(toHex);
  // Transparent materials are treated as white.
  if (from.a === 0) { from.r = from.g = from.b = 255; }
  if (to.a === 0) { to.r = to.g = to.b = 255; }
  if (dataset !== 0) {
    const v = predict(dataset, from, to);
    if (v !== null) return Math.min(Math.trunc(v), maxFlush);
  }
  let v = calcRgb(from, to, dataset);
  // Orca compares 0–255 luminance with 0–1 thresholds here; kept as is.
  const fromDark = lum(from.r, from.g, from.b) > 180 / 255;
  const toLight = lum(to.r, to.g, to.b) < 75 / 255;
  if (dataset !== 0 && fromDark && toLight) v *= 1.3;
  v += minFlush;
  return Math.min(Math.trunc(v), maxFlush);
}

// ---- config helpers -------------------------------------------------------------------------------

const arr = (v: ConfigValue | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : v === '' ? [] : v.split(','));
const numAt = (v: ConfigValue | undefined, i: number, d = 0): number => {
  const a = arr(v);
  const s = a[i] ?? a[0];
  const n = s === undefined || s === 'nil' ? NaN : parseFloat(s);
  return Number.isFinite(n) ? n : d;
};

/** Plater get_min_flush_volumes: nozzle volume minus long-retraction savings, per filament. */
export function minFlushVolumes(cfg: FlatConfig, nozzleId: number, filamentCount: number, variantIndex = extruderVariantIndex(cfg, nozzleId)): number[] {
  const nozzleVolume = Math.trunc(numAt(cfg.nozzle_volume, variantIndex, 0));
  const machineLevel = Math.trunc(numAt(cfg.enable_long_retraction_when_cut, 0, 0));
  const machineActivated = arr(cfg.long_retractions_when_cut)[nozzleId] === '1';
  const out: number[] = [];
  for (let i = 0; i < filamentCount; i++) {
    let retract = machineLevel && machineActivated ? numAt(cfg.retraction_distances_when_cut, nozzleId, 18) : 0;
    const act = arr(cfg.filament_long_retractions_when_cut)[i];
    const filLen = numAt(cfg.filament_retraction_distances_when_cut, i, NaN);
    if (act === undefined || act === '0' || act === 'nil') retract = 0;
    else if (act === '1' && machineLevel === 2) retract = Number.isFinite(filLen) ? Math.trunc(filLen) : numAt(cfg.retraction_distances_when_cut, nozzleId, 18);
    out.push(Math.trunc(nozzleVolume - (Math.PI * 1.75 * 1.75) / 4 * retract));
  }
  return out;
}

/**
 * Index into per-variant printer vectors (Bambu H2D: nozzle_volume,
 * nozzle_flush_dataset have one entry per extruder × nozzle variant, mapped by
 * printer_extruder_id / printer_extruder_variant) for extruder `ext`, using the
 * project's nozzle_volume_type (Standard / High Flow).
 */
export function extruderVariantIndex(cfg: FlatConfig, ext: number): number {
  const ids = arr(cfg.printer_extruder_id);
  if (!ids.length) return ext;
  const variants = arr(cfg.printer_extruder_variant);
  const type = arr(cfg.nozzle_volume_type)[ext] ?? 'Standard';
  const matches = ids.map((id, j) => (Number(id) === ext + 1 ? j : -1)).filter((j) => j >= 0);
  if (!matches.length) return ext;
  return matches.find((j) => (variants[j] ?? '').toLowerCase().endsWith(type.toLowerCase())) ?? matches[0];
}

/** Flush dataset of extruder `ext` (nozzle_flush_dataset, nullable per variant). */
export function flushDataset(cfg: FlatConfig, ext: number): number {
  const v = Math.trunc(numAt(cfg.nozzle_flush_dataset, extruderVariantIndex(cfg, ext), 0));
  return v >= 0 && v <= 2 ? v : 0;
}

/** Filament n → whether it's a support material (filament_is_support). */
export function supportFlags(cfg: FlatConfig, n: number): boolean[] {
  const a = arr(cfg.filament_is_support);
  return Array.from({ length: n }, (_, i) => (a[i] ?? '0') === '1');
}

/** WipingDialog::CalcFlushingVolumes for one nozzle: n × n (row = from, column = to). */
export function autoFlushMatrix(colours: string[], opts: { minFlush: number[]; support?: boolean[]; dataset?: number }): number[][] {
  const n = colours.length;
  const sup = opts.support ?? [];
  return Array.from({ length: n }, (_, from) => Array.from({ length: n }, (_, to) => {
    if (from === to) return 0;
    if (sup[to]) return FLUSH_TO_SUPPORT;
    let v = calcFlushVolume(colours[from], colours[to], opts.minFlush[from] ?? 0, opts.dataset ?? 0);
    if (sup[from]) v = Math.max(MIN_FLUSH_FROM_SUPPORT, v);
    return v;
  }));
}

/** Re-calculate only row + column `changed` (Sidebar::auto_calc_flushing_volumes_internal). */
export function autoFlushUpdate(matrix: number[][], colours: string[], changed: number, opts: { minFlush: number[]; support?: boolean[]; dataset?: number }): number[][] {
  const full = autoFlushMatrix(colours, opts);
  return matrix.map((row, from) => row.map((v, to) => (from === changed || to === changed ? full[from][to] : v)));
}

/** get_flush_volumes_matrix: the n × n block of nozzle `nozzle` from the flat multi-nozzle vector. */
export function nozzleMatrix(flat: number[], n: number, nozzle: number, nozzles: number): number[][] {
  const block = n * n;
  const base = flat.length >= block * nozzles ? block * nozzle : 0;
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => {
    const v = flat[base + r * n + c];
    return r === c ? 0 : Number.isFinite(v) ? v : 280;
  }));
}

/** set_flush_volumes_matrix for every nozzle at once. */
export function flattenMatrices(ms: number[][][]): number[] {
  return ms.flatMap((m) => m.flat());
}

/**
 * Resize a flat matrix after the filament count changed, keeping the values of
 * surviving pairs (by index) and seeding new pairs with `seed`.
 */
export function resizeFlat(flat: number[], oldN: number, newN: number, nozzles: number, seed = 280): number[] {
  const out: number[] = [];
  for (let z = 0; z < nozzles; z++) {
    const m = oldN > 0 && flat.length >= oldN * oldN * (z + 1) ? nozzleMatrix(flat, oldN, z, nozzles) : [];
    for (let r = 0; r < newN; r++) for (let c = 0; c < newN; c++) out.push(r === c ? 0 : m[r]?.[c] ?? seed);
  }
  return out;
}

/** Filament count implied by a flat matrix for `nozzles` nozzles (0 when inconsistent). */
export function matrixSize(flatLength: number, nozzles: number): number {
  const per = flatLength / Math.max(1, nozzles);
  const n = Math.round(Math.sqrt(per));
  return n * n === per ? n : 0;
}

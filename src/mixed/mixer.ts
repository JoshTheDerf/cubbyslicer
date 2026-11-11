/**
 * Orca's mixed-filament colour model, ported from libslic3r (OrcaSlicer
 * v2.5.0): the pigment mixer (`FilamentMixerModel.hpp` `filament_mixer::lerp`,
 * `FilamentMixer.cpp` `blend_color_multi`) and the gradient curve
 * (`parse_gradient_curve`, `serialize_gradient_curve`,
 * `sample_gradient_curve`, Fritsch–Carlson PCHIP tangents).
 *
 * Not ported: `lookup_measured_blend_color` (ColorDecomposeRecipe.cpp), which
 * replaces the polynomial with lab-measured blends when every component is one
 * of Orca's standard CMYW / RYBW reference colours at 20–80 %. Desktop shows
 * the measured colour for those; the engine's `mixed_filament` tool op
 * ("preview") has it.
 */
import { parseColour, toHex } from '../lib/colour';
import { COEF, INTERCEPT } from './mixerModel.generated';

type RGB = [number, number, number];

// Monomials of (r1, g1, b1, r2, g2, b2, t) up to degree 4 in scikit-learn
// PolynomialFeatures order (degree, then combinations with replacement), as
// variable-index lists: [] = 1, [0] = r1, [0, 0] = r1², …
const MONOMIALS: number[][] = (() => {
  const out: number[][] = [];
  const rec = (deg: number, start: number, acc: number[]) => {
    if (acc.length === deg) { out.push(acc); return; }
    for (let i = start; i < 7; i++) rec(deg, i, [...acc, i]);
  };
  for (let d = 0; d <= 4; d++) rec(d, 0, []);
  return out;
})();

/** `filament_mixer::lerp`: mix two 8-bit colours, t = share of the second (0..1). */
export function pigmentLerp(a: RGB, b: RGB, t: number): RGB {
  const tf = Math.fround(t); // the C++ takes a float
  if (tf <= 0) return [a[0], a[1], a[2]];
  if (tf >= 1) return [b[0], b[1], b[2]];
  const x = [a[0], a[1], a[2], b[0], b[1], b[2], tf];
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let sum = INTERCEPT[c];
    for (let i = 0; i < MONOMIALS.length; i++) {
      let v = 1;
      for (const j of MONOMIALS[i]) v *= x[j];
      sum += v * COEF[i * 3 + c];
    }
    out[c] = Math.max(0, Math.min(255, Math.trunc(sum))); // static_cast<int>, then clamp
  }
  return out;
}

function rgbOf(hex: string): RGB {
  const c = parseColour(hex);
  // parse_hex wants "#RRGGBB…"; anything else stays mid grey.
  return c && /^#[0-9a-f]{6}/i.test(hex) ? [c.r, c.g, c.b] : [128, 128, 128];
}

/**
 * `blend_color_multi`: blend colours by integer weights, accumulating pairwise
 * with the pigment mixer. Returns "#RRGGBB" (uppercase).
 */
export function blendColours(hexes: readonly string[], weights: readonly number[]): string {
  if (!hexes.length) return '#000000';
  if (hexes.length === 1) { const [r, g, b] = rgbOf(hexes[0]); return toHex({ r, g, b }); }
  let cur: RGB = [128, 128, 128];
  let acc = 0;
  for (let i = 0; i < hexes.length && i < weights.length; i++) {
    const w = Math.trunc(weights[i]);
    if (w <= 0) continue;
    const c = rgbOf(hexes[i]);
    if (acc === 0) { cur = c; acc = w; continue; }
    const total = acc + w;
    cur = pigmentLerp(cur, c, Math.fround(w) / Math.fround(total));
    acc = total;
  }
  if (acc === 0) return '#000000';
  return toHex({ r: cur[0], g: cur[1], b: cur[2] });
}

// ---- gradient curves ----------------------------------------------------------------

/** Anchor y (= first component's share) is kept inside this band (kGradientMin/MaxRatio). */
export const GRADIENT_MIN_RATIO = 0.1;
export const GRADIENT_MAX_RATIO = 0.9;

/** Control point; `mIn` / `mOut` are tangent overrides (NaN = PCHIP default). */
export interface GradientAnchor { x: number; y: number; mIn: number; mOut: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function tangentToken(tok: string): number {
  if (!tok || tok.toLowerCase() === 'nan') return NaN;
  const v = Number(tok);
  return Number.isFinite(v) ? v : NaN;
}

/** `parse_gradient_curve`: "x,y|x,y" or "x,y,mIn,mOut|…"; fewer than 2 valid points → []. */
export function parseGradientCurve(s: string): GradientAnchor[] {
  const pts: GradientAnchor[] = [];
  for (const seg of (s ?? '').split('|')) {
    if (!seg) continue;
    const f = seg.split(',');
    if (f.length !== 2 && f.length !== 4) continue;
    const x = parseFloat(f[0]), y = parseFloat(f[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push({
      x: clamp(x, 0, 1), y: clamp(y, GRADIENT_MIN_RATIO, GRADIENT_MAX_RATIO),
      mIn: f.length === 4 ? tangentToken(f[2]) : NaN, mOut: f.length === 4 ? tangentToken(f[3]) : NaN,
    });
  }
  if (pts.length < 2) return [];
  return pts.sort((a, b) => a.x - b.x);
}

const f4 = (v: number) => v.toFixed(4);

/** `serialize_gradient_curve`: 2 fields per anchor unless a tangent is set. */
export function serializeGradientCurve(pts: readonly GradientAnchor[]): string {
  return pts.map((a) => {
    const hasIn = Number.isFinite(a.mIn), hasOut = Number.isFinite(a.mOut);
    return hasIn || hasOut
      ? `${f4(a.x)},${f4(a.y)},${hasIn ? f4(a.mIn) : ''},${hasOut ? f4(a.mOut) : ''}`
      : `${f4(a.x)},${f4(a.y)}`;
  }).join('|');
}

/** `compute_pchip_default_tangents` (Fritsch–Carlson, no overshoot). */
export function pchipTangents(pts: readonly GradientAnchor[]): number[] {
  const n = pts.length;
  const m = new Array<number>(n).fill(0);
  if (n < 2) return m;
  const d: number[] = [];
  for (let i = 0; i + 1 < n; i++) d.push((pts[i + 1].y - pts[i].y) / Math.max(1e-12, pts[i + 1].x - pts[i].x));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i + 1 < n; i++) m[i] = 0.5 * (d[i - 1] + d[i]);
  for (let i = 0; i + 1 < n; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
  }
  return m;
}

/** `sample_gradient_curve`: first component's share at height t (0 bottom … 1 top). */
export function sampleGradientCurve(pts: readonly GradientAnchor[], t: number): number {
  if (pts.length < 2) return 0.5;
  if (t <= pts[0].x) return pts[0].y;
  if (t >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  const md = pchipTangents(pts);
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    if (t > p1.x) continue;
    const h = Math.max(1e-12, p1.x - p0.x);
    const ml = Number.isFinite(p0.mOut) ? p0.mOut : md[i - 1];
    const mr = Number.isFinite(p1.mIn) ? p1.mIn : md[i];
    const u = (t - p0.x) / h, u2 = u * u, u3 = u2 * u;
    const y = (2 * u3 - 3 * u2 + 1) * p0.y + (u3 - 2 * u2 + u) * h * ml + (-2 * u3 + 3 * u2) * p1.y + (u3 - u2) * h * mr;
    return clamp(y, GRADIENT_MIN_RATIO, GRADIENT_MAX_RATIO);
  }
  return pts[pts.length - 1].y;
}

/** The straight-line curve a gradient direction implies: A→B starts at 90 % of the first component. */
export function linearCurve(direction: 'ab' | 'ba'): GradientAnchor[] {
  const [y0, y1] = direction === 'ab' ? [GRADIENT_MAX_RATIO, GRADIENT_MIN_RATIO] : [GRADIENT_MIN_RATIO, GRADIENT_MAX_RATIO];
  return [{ x: 0, y: y0, mIn: NaN, mOut: NaN }, { x: 1, y: y1, mIn: NaN, mOut: NaN }];
}

/**
 * Colours along the height (bottom → top) of a two-component gradient
 * (FilamentBitmapUtils `sample_gradient_ramp`: cell centres, blended like a
 * fixed mix of that ratio).
 */
export function gradientRamp(first: string, second: string, curve: readonly GradientAnchor[], steps: number): string[] {
  if (steps <= 0 || curve.length < 2) return [];
  return Array.from({ length: steps }, (_, i) => {
    const r1 = sampleGradientCurve(curve, steps > 1 ? (i + 0.5) / steps : 0.5);
    return blendColours([first, second], [Math.round(r1 * 10000), Math.round((1 - r1) * 10000)]);
  });
}

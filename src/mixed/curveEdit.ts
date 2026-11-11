/**
 * Orca's gradient curve editor (GUI/GradientCurveEditor.cpp, plot layout from
 * FilamentBitmapUtils `mixed_gradient_plot_rect`) as plain functions: the
 * component's share (y) over the model height (x), Photoshop-curves style.
 *
 * - Two curves are drawn: component 1's share (the stored y) and component 2's
 *   (1 − y). Only the selected one shows anchors and takes edits.
 * - Pressing on an anchor of the selected curve drags it and clears its tangent
 *   overrides; endpoints keep x = 0 / 1, interior anchors stay between their
 *   neighbours. y stays in the blend band (10–90 %).
 * - Pressing on the selected curve's line inserts an anchor on the curve at
 *   that x and drags it; pressing on the other curve selects it.
 * - Right-click on an interior anchor deletes it; endpoints stay.
 *
 * Coordinates: data x, y in [0, 1]; pixels in the editor's own box (y down).
 */
import { GRADIENT_MAX_RATIO, GRADIENT_MIN_RATIO, sampleGradientCurve, type GradientAnchor } from './mixer';

export interface Rect { x: number; y: number; width: number; height: number }

/** Plot area ratios (FilamentBitmapUtils kPlot*Ratio): a square plot, axes and labels in the margins. */
const PLOT_LEFT = 0.0316, PLOT_RIGHT = 0.6766, PLOT_TOP = 0.1529, PLOT_BOTTOM = 0.8474;
/** Grid divisions (10 lines including the borders). */
export const GRID_DIVISIONS = 9;
/** Hit radii (DIP). */
export const HIT_RADIUS = 6;
export const CURVE_HIT_RADIUS = 5;
/** Minimum canvas (GradientCurveEditor SetMinSize). */
export const MIN_WIDTH = 260;
export const MIN_HEIGHT = 200;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clampY = (v: number) => clamp(v, GRADIENT_MIN_RATIO, GRADIENT_MAX_RATIO);

/** `mixed_gradient_plot_rect`. */
export function plotRect(w: number, h: number): Rect {
  const x = Math.round(w * PLOT_LEFT), y = Math.round(h * PLOT_TOP);
  const x2 = Math.round(w * PLOT_RIGHT), y2 = Math.round(h * PLOT_BOTTOM);
  const side = Math.max(1, Math.min(x2 - x, y2 - y));
  return { x, y, width: side, height: side };
}

export function dataToPx(r: Rect, x: number, y: number): { x: number; y: number } {
  return { x: r.x + x * r.width, y: r.y + (1 - y) * r.height };
}

export function pxToData(r: Rect, px: number, py: number): { x: number; y: number } {
  const w = Math.max(1, r.width), h = Math.max(1, r.height);
  return { x: clamp((px - r.x) / w, 0, 1), y: clamp(1 - (py - r.y) / h, 0, 1) };
}

/** Visual y of a curve: curve 0 is the stored share, curve 1 its complement. */
export const toVisualY = (curve: 0 | 1, stored: number) => (curve === 0 ? stored : 1 - stored);
export const toStoredY = toVisualY;

/** The editor's two-point line from y0 (bottom) to y1 (top), no tangents (`reset_to_linear`). */
export function linearPoints(y0: number, y1: number): GradientAnchor[] {
  return [{ x: 0, y: clampY(y0), mIn: NaN, mOut: NaN }, { x: 1, y: clampY(y1), mIn: NaN, mOut: NaN }];
}

/** `normalize_points` (set_points): clamp, sort, at least two anchors, endpoints at x = 0 / 1. */
export function normalizePoints(pts: readonly GradientAnchor[]): GradientAnchor[] {
  if (!pts.length) return linearPoints(GRADIENT_MIN_RATIO, GRADIENT_MAX_RATIO);
  const out = pts.map((p) => ({ ...p, x: clamp(p.x, 0, 1), y: clampY(p.y) })).sort((a, b) => a.x - b.x);
  if (out.length < 2) out.push({ x: 1, y: out[0].y, mIn: NaN, mOut: NaN });
  out[0].x = 0;
  out[out.length - 1].x = 1;
  return out;
}

/** `reverse`: mirror y around 0.5; tangents flip sign, NaN stays NaN. */
export function reversePoints(pts: readonly GradientAnchor[]): GradientAnchor[] {
  return pts.map((p) => ({ x: p.x, y: 1 - p.y, mIn: Number.isFinite(p.mIn) ? -p.mIn : NaN, mOut: Number.isFinite(p.mOut) ? -p.mOut : NaN }));
}

/** Sample count of the drawn / hit-tested polyline (`max(128, plot width × 2)`). */
export const sampleCount = (r: Rect) => Math.max(128, Math.round(r.width * 2));

/** The polyline of one curve in pixels. */
export function curvePolyline(pts: readonly GradientAnchor[], r: Rect, curve: 0 | 1): Array<{ x: number; y: number }> {
  if (pts.length < 2) return [];
  const n = sampleCount(r);
  const out: Array<{ x: number; y: number }> = [];
  for (let s = 0; s <= n; s++) {
    const x = s / n;
    out.push(dataToPx(r, x, toVisualY(curve, sampleGradientCurve(pts, x))));
  }
  return out;
}

/** `hit_test`: the selected curve's anchor nearest the point within `tol` px, or -1 (later anchors win ties). */
export function hitAnchor(pts: readonly GradientAnchor[], r: Rect, curve: 0 | 1, px: number, py: number, tol = HIT_RADIUS): number {
  let best = -1, bestD2 = tol * tol;
  pts.forEach((p, i) => {
    const q = dataToPx(r, p.x, toVisualY(curve, p.y));
    const d2 = (px - Math.round(q.x)) ** 2 + (py - Math.round(q.y)) ** 2;
    if (d2 <= bestD2) { best = i; bestD2 = d2; }
  });
  return best;
}

function dist2ToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  if (l2 === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
}

/**
 * `hit_test_curve`: which curve's line is under the point (the selected one
 * first), and the left anchor of the data segment covering that x.
 */
export function hitCurve(pts: readonly GradientAnchor[], r: Rect, selected: 0 | 1, px: number, py: number, tol = CURVE_HIT_RADIUS): { curve: 0 | 1; seg: number } | null {
  if (pts.length < 2) return null;
  const hits = (c: 0 | 1) => {
    const poly = curvePolyline(pts, r, c);
    for (let i = 1; i < poly.length; i++) if (dist2ToSeg(px, py, poly[i - 1].x, poly[i - 1].y, poly[i].x, poly[i].y) <= tol * tol) return true;
    return false;
  };
  const segFor = () => {
    const x = pxToData(r, px, py).x;
    for (let i = 1; i < pts.length; i++) if (x <= pts[i].x) return i - 1;
    return pts.length - 2;
  };
  for (const c of [selected, (1 - selected) as 0 | 1]) if (hits(c)) return { curve: c, seg: segFor() };
  return null;
}

/** What a left press does (`on_left_down`). */
export type PressResult =
  | { kind: 'anchor'; index: number; points: GradientAnchor[]; changed: boolean }
  | { kind: 'select'; curve: 0 | 1 }
  | { kind: 'none' };

export function press(pts: readonly GradientAnchor[], r: Rect, selected: 0 | 1, px: number, py: number, scale = 1): PressResult {
  const idx = hitAnchor(pts, r, selected, px, py, HIT_RADIUS * scale);
  if (idx >= 0) {
    const had = Number.isFinite(pts[idx].mIn) || Number.isFinite(pts[idx].mOut);
    const points = pts.map((p, i) => (i === idx ? { ...p, mIn: NaN, mOut: NaN } : { ...p }));
    return { kind: 'anchor', index: idx, points, changed: had };
  }
  const hit = hitCurve(pts, r, selected, px, py, CURVE_HIT_RADIUS * scale);
  if (!hit) return { kind: 'none' };
  if (hit.curve !== selected) return { kind: 'select', curve: hit.curve };
  const x = pxToData(r, px, py).x;
  if (x <= 0 || x >= 1 || hit.seg < 0) return { kind: 'none' };
  const points = pts.map((p) => ({ ...p }));
  points.splice(hit.seg + 1, 0, { x, y: sampleGradientCurve(pts, x), mIn: NaN, mOut: NaN });
  return { kind: 'anchor', index: hit.seg + 1, points, changed: true };
}

/** `on_motion` while dragging anchor `idx` to data point (x, visual y). */
export function dragAnchor(pts: readonly GradientAnchor[], idx: number, curve: 0 | 1, x: number, visualY: number): GradientAnchor[] {
  if (idx < 0 || idx >= pts.length) return pts.slice();
  const out = pts.map((p) => ({ ...p }));
  const p = out[idx];
  if (idx > 0 && idx < out.length - 1) {
    const eps = 1e-4;
    p.x = clamp(x, out[idx - 1].x + eps, out[idx + 1].x - eps);
  }
  p.y = clampY(toStoredY(curve, visualY));
  return out;
}

/** `on_right_down`: delete an interior anchor; endpoints stay. Null when nothing was deleted. */
export function deleteAnchor(pts: readonly GradientAnchor[], idx: number): GradientAnchor[] | null {
  if (idx <= 0 || idx >= pts.length - 1) return null;
  return pts.filter((_, i) => i !== idx);
}

/** Same curve (values and tangents), for "was it edited" checks. */
export function sameCurve(a: readonly GradientAnchor[], b: readonly GradientAnchor[]): boolean {
  const eq = (u: number, v: number) => (Number.isNaN(u) && Number.isNaN(v)) || u === v;
  return a.length === b.length && a.every((p, i) => eq(p.x, b[i].x) && eq(p.y, b[i].y) && eq(p.mIn, b[i].mIn) && eq(p.mOut, b[i].mOut));
}

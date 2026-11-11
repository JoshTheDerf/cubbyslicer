/**
 * Ratio editing in Orca's MixedFilamentDialog: the two-colour blend bar, the
 * three-colour triangle (ternary) picker and the click-to-type ratio labels
 * (`apply_manual_ratio`, `apply_dragged_triangle_ratio`, `create_ratio_slider`,
 * `create_triangle_picker`; barycentric helpers from FilamentBitmapUtils).
 * Ratios are whole percentages summing to 100, each at least 10.
 */
import { MIN_COMPONENT_RATIO } from './model';

export interface Pt { x: number; y: number }

/** The ratio bar: x on a bar `width` wide → the first component's share (left = 100 %). */
export function barRatio(x: number, width: number): number {
  const r = 100 - Math.trunc(x * 100 / Math.max(1, width) + 0.5);
  return Math.max(MIN_COMPONENT_RATIO, Math.min(100 - MIN_COMPONENT_RATIO, r));
}

/**
 * `apply_manual_ratio`: component `idx` typed as `value`. Two components: the
 * other takes the rest. Three: the others share the rest in proportion to
 * their current values (each ≥ 10), rounding fixed one step at a time.
 */
export function applyManualRatio(ratios: readonly number[], idx: number, value: number): number[] {
  const n = ratios.length;
  if (idx < 0 || idx >= n || !Number.isFinite(value)) return ratios.slice();
  const out = ratios.slice();
  const max = 100 - (n - 1) * MIN_COMPONENT_RATIO;
  const v = Math.max(MIN_COMPONENT_RATIO, Math.min(Math.max(MIN_COMPONENT_RATIO, max), Math.trunc(value)));
  if (n === 2) {
    out[idx] = v;
    out[1 - idx] = 100 - v;
    out[0] = Math.max(MIN_COMPONENT_RATIO, Math.min(100 - MIN_COMPONENT_RATIO, out[0]));
    out[1] = 100 - out[0];
    return out;
  }
  if (n < 3) return out;
  out[idx] = v;
  const remaining = 100 - v;
  const others = out.map((_, i) => i).filter((i) => i !== idx);
  const othersSum = others.reduce((a, i) => a + out[i], 0);
  if (othersSum > 0) {
    let assigned = 0;
    const cur = others.map((i) => out[i]);
    others.forEach((i, k) => {
      const nv = Math.max(Math.trunc(remaining * cur[k] / othersSum + 0.5), MIN_COMPONENT_RATIO);
      out[i] = nv;
      assigned += nv;
    });
    while (assigned !== remaining) {
      if (assigned > remaining) {
        let pick = -1;
        others.forEach((i, k) => { if (out[i] > MIN_COMPONENT_RATIO && (pick < 0 || out[i] > out[others[pick]])) pick = k; });
        if (pick < 0) break;
        out[others[pick]]--; assigned--;
      } else {
        let pick = 0;
        for (let k = 1; k < others.length; k++) if (out[others[k]] > out[others[pick]]) pick = k;
        out[others[pick]]++; assigned++;
      }
    }
  } else {
    const base = Math.trunc(remaining / others.length);
    others.forEach((i) => { out[i] = base; });
    out[others[others.length - 1]] += remaining - base * others.length;
  }
  return out;
}

/** `apply_dragged_triangle_ratio`: each ≥ 10, then trimmed from the largest / topped up on the smallest to 100. */
export function applyDraggedTriangleRatio(r0: number, r1: number, r2: number): [number, number, number] {
  const r: [number, number, number] = [r0, r1, r2].map((v) => Math.max(MIN_COMPONENT_RATIO, Math.min(100, v))) as [number, number, number];
  let sum = r[0] + r[1] + r[2];
  while (sum > 100) {
    let i = 0;
    for (let k = 1; k < 3; k++) if (r[k] > r[i]) i = k;
    if (r[i] <= MIN_COMPONENT_RATIO) break;
    r[i]--; sum--;
  }
  while (sum < 100) {
    let i = 0;
    for (let k = 1; k < 3; k++) if (r[k] < r[i]) i = k;
    r[i]++; sum++;
  }
  return r;
}

// ---- the triangle ----------------------------------------------------------------------------

/** Margin around the triangle (DIP, kTriangleMarginDip). */
export const TRIANGLE_MARGIN = 20;
/** Picker panel size (DIP). */
export const TRIANGLE_PANEL = 160;

/** Vertices: top = component 1, bottom-left = 2, bottom-right = 3 (an equilateral triangle centred in the panel). */
export function triangleVertices(w: number, h: number, margin = TRIANGLE_MARGIN): [Pt, Pt, Pt] {
  const side = Math.min(w, h) - 2 * margin;
  const triH = side * Math.sqrt(3) / 2;
  const cx = w / 2, top = (h - triH) / 2, bot = top + triH;
  return [{ x: cx, y: top }, { x: cx - side / 2, y: bot }, { x: cx + side / 2, y: bot }];
}

const area2 = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);

export function triContains(p: Pt, v0: Pt, v1: Pt, v2: Pt): boolean {
  const total = area2(v0, v1, v2);
  if (Math.abs(total) < 1e-9) return false;
  const s0 = area2(p, v1, v2) / total, s1 = area2(v0, p, v2) / total, s2 = 1 - s0 - s1;
  return s0 >= -0.001 && s1 >= -0.001 && s2 >= -0.001;
}

/** `tri_barycentric`: weights clamped to [0, 1] and renormalised (so outside points snap towards the edge). */
export function triBarycentric(p: Pt, v0: Pt, v1: Pt, v2: Pt): [number, number, number] {
  const total = Math.abs(area2(v0, v1, v2));
  if (total < 1e-9) return [1 / 3, 1 / 3, 1 / 3];
  let w0 = Math.abs(area2(p, v1, v2)) / total;
  let w1 = Math.abs(area2(v0, p, v2)) / total;
  let w2 = 1 - w0 - w1;
  w0 = Math.max(0, Math.min(1, w0)); w1 = Math.max(0, Math.min(1, w1)); w2 = Math.max(0, Math.min(1, w2));
  const s = w0 + w1 + w2;
  if (s > 0) { w0 /= s; w1 /= s; w2 /= s; }
  return [w0, w1, w2];
}

export function triClamp(p: Pt, v0: Pt, v1: Pt, v2: Pt): Pt {
  const [w0, w1, w2] = triBarycentric(p, v0, v1, v2);
  return { x: w0 * v0.x + w1 * v1.x + w2 * v2.x, y: w0 * v0.y + w1 * v1.y + w2 * v2.y };
}

/** A drag to point p (clamped into the triangle) → weights and ratios (`handle_mouse`). */
export function triangleDrag(p: Pt, v: [Pt, Pt, Pt]): { weights: [number, number, number]; ratios: [number, number, number] } {
  const c = triClamp(p, ...v);
  const weights = triBarycentric(c, ...v);
  const r0 = Math.max(0, Math.min(100, Math.trunc(weights[0] * 100 + 0.5)));
  const r1 = Math.max(0, Math.min(100, Math.trunc(weights[1] * 100 + 0.5)));
  const r2 = Math.max(0, Math.min(100, 100 - r0 - r1));
  return { weights, ratios: applyDraggedTriangleRatio(r0, r1, r2) };
}

/** Handle position for weights (the drag marker). */
export function trianglePoint(w: readonly number[], v: [Pt, Pt, Pt]): Pt {
  return { x: w[0] * v[0].x + w[1] * v[1].x + w[2] * v[2].x, y: w[0] * v[0].y + w[1] * v[1].y + w[2] * v[2].y };
}

/** `sync_triangle_weights_from_ratios`. */
export function weightsFromRatios(r: readonly number[]): [number, number, number] {
  const s = r[0] + r[1] + r[2];
  return s > 0 ? [r[0] / s, r[1] / s, r[2] / s] : [1 / 3, 1 / 3, 1 / 3];
}

/** Parse the inline ratio editor's text ("45", "45 %"); null when it isn't a number (`commit_ratio_editor`). */
export function parseRatioText(s: string): number | null {
  let t = s.trim();
  if (t.endsWith('%')) t = t.slice(0, -1);
  if (!/^[+-]?\d+$/.test(t.trim())) return null;
  return parseInt(t, 10);
}

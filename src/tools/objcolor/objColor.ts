/**
 * OBJ colours → filaments (Orca ObjColorDialog + ObjColorUtils QuantKMeans):
 * cluster the model's face colours (k-means in CIE Lab, k-means++ seeding),
 * map each cluster to a filament slot ("Color match" = nearest by ΔE76, or
 * "Append" = new slots), and turn the mapping into per-triangle extruder
 * states for colour painting.
 */

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** sRGB (0–255) → CIE Lab (D65). */
export function rgbToLab([r, g, b]: RGB): RGB {
  const lin = (v: number) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb([L, A, Bv]: RGB): RGB {
  const fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - Bv / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
  const R = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const G = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const B = x * 0.0557 + y * -0.204 + z * 1.057;
  const g = (v: number) => 255 * (v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v);
  return [g(R), g(G), g(B)];
}

/** Orca calc_color_distance: ΔE76 in Lab. */
export function colorDistance(a: string, b: string): number {
  const ra = hexToRgb(a), rb = hexToRgb(b);
  if (!ra || !rb) return Infinity;
  const la = rgbToLab(ra), lb = rgbToLab(rb);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

export interface WeightedColor { color: string; weight: number }
export interface Clustering { centers: string[]; labels: number[] }

/** Deterministic PRNG so the dialog is stable between renders / tests. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; };
}

/** Weighted k-means in Lab with k-means++ seeding; labels are per input colour. */
export function kmeans(colors: WeightedColor[], k: number, iterations = 60): Clustering {
  const pts = colors.map((c) => rgbToLab(hexToRgb(c.color) ?? [0, 0, 0]));
  const w = colors.map((c) => Math.max(c.weight, 1e-6));
  const n = pts.length;
  k = Math.max(1, Math.min(k, n));
  if (!n) return { centers: [], labels: [] };
  const rand = rng(12345 + n * 31 + k);
  const d2 = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  // Seed: heaviest colour, then D²-weighted picks.
  let first = 0;
  for (let i = 1; i < n; i++) if (w[i] > w[first]) first = i;
  const centers: RGB[] = [pts[first]];
  while (centers.length < k) {
    const dist = pts.map((p, i) => Math.min(...centers.map((c) => d2(p, c))) * w[i]);
    const total = dist.reduce((a, b) => a + b, 0);
    if (total <= 0) break;
    let r = rand() * total, pick = 0;
    for (; pick < n - 1; pick++) { r -= dist[pick]; if (r <= 0) break; }
    centers.push(pts[pick]);
  }
  const labels = new Array<number>(n).fill(0);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      centers.forEach((c, j) => { const d = d2(pts[i], c); if (d < bd) { bd = d; best = j; } });
      if (labels[i] !== best) { labels[i] = best; moved = true; }
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) { const s = sums[labels[i]]; s[0] += pts[i][0] * w[i]; s[1] += pts[i][1] * w[i]; s[2] += pts[i][2] * w[i]; s[3] += w[i]; }
    sums.forEach((s, j) => { if (s[3] > 0) centers[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
    if (!moved && it > 0) break;
  }
  // Drop empty clusters, renumber.
  const used = [...new Set(labels)].sort((a, b) => a - b);
  const remap = new Map(used.map((c, i) => [c, i]));
  return { centers: used.map((c) => rgbToHex(labToRgb(centers[c]))), labels: labels.map((l) => remap.get(l)!) };
}

/**
 * Orca's recommended colour count: distinct colours, capped at `max`; when
 * there are more, the largest k whose cluster centres stay distinct (ΔE ≥ 10)
 * — QuantKMeans stops once centres start to repeat.
 */
export function recommendedClusters(colors: WeightedColor[], max = 16): number {
  const distinct = new Set(colors.map((c) => c.color.toUpperCase())).size;
  if (distinct <= max) return Math.max(1, distinct);
  let best = 1;
  for (let k = 2; k <= max; k++) {
    const { centers } = kmeans(colors, k);
    let repeated = centers.length < k;
    for (let i = 0; i < centers.length && !repeated; i++) for (let j = i + 1; j < centers.length; j++) if (colorDistance(centers[i], centers[j]) < 10) { repeated = true; break; }
    if (repeated) break;
    best = k;
  }
  return best;
}

/** "Color match": each cluster → the nearest existing filament (1-based slot). */
export function nearestFilaments(centers: string[], filaments: string[]): number[] {
  return centers.map((c) => {
    let best = 0, bd = Infinity;
    filaments.forEach((f, i) => { const d = colorDistance(c, f); if (d < bd) { bd = d; best = i; } });
    return best + 1;
  });
}

/**
 * Per-triangle extruder states for colour painting. `tri[i]` = group of
 * triangle i; `groupCluster[g]` = cluster of group g; `clusterSlot[c]` =
 * 1-based filament. Returns the object's base extruder (the most-covered
 * slot, which stays unpainted) and sparse [triangle, extruder] pairs for the
 * rest (Orca: first cluster → volume extruder, the others painted).
 */
export function paintStates(tri: Uint32Array, groupCluster: number[], clusterSlot: number[]): { base: number; states: Array<[number, number]> } {
  const slotOf = (t: number): number => {
    const g = tri[t];
    if (g === 0xffffffff || g >= groupCluster.length) return 0;
    return clusterSlot[groupCluster[g]] ?? 0;
  };
  const count = new Map<number, number>();
  for (let t = 0; t < tri.length; t++) { const s = slotOf(t); if (s > 0) count.set(s, (count.get(s) ?? 0) + 1); }
  let base = 1, bn = -1;
  for (const [s, n] of count) if (n > bn || (n === bn && s < base)) { base = s; bn = n; }
  const states: Array<[number, number]> = [];
  for (let t = 0; t < tri.length; t++) { const s = slotOf(t); if (s > 0 && s !== base) states.push([t, s]); }
  return { base, states };
}

/** Parse the Kd (diffuse) colours of an MTL file: material name → '#RRGGBB'. */
export function parseMtl(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('newmtl ')) cur = l.slice(7).trim();
    else if (cur && /^Kd\s/.test(l)) {
      const [r, g, b] = l.split(/\s+/).slice(1, 4).map(Number);
      if ([r, g, b].every(Number.isFinite)) out.set(cur, rgbToHex([r * 255, g * 255, b * 255]));
    }
  }
  return out;
}

/** Distinct, readable colours for groups without a known colour (golden-angle hues). */
export function fallbackColor(i: number): string {
  const h = (i * 137.508) % 360, s = 0.55, l = 0.55;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

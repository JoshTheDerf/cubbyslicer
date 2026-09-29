/**
 * Approximate colour previews of a mixed filament along Z (bottom → top), for
 * the editor's strip. The engine's display colour is the authority for the
 * swatch; this only shows how a gradient / pattern is laid out.
 */
import type { MixedDefinition } from './store';

type RGB = [number, number, number];

function rgb(hex: string): RGB {
  const h = (hex || '#888888').replace('#', '').slice(0, 6).padEnd(6, '8');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const css = ([r, g, b]: RGB) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Anchor positions (0..1) of each gradient component: stops[0], stops[2], … or spread by weight. */
export function gradientAnchors(def: Pick<MixedDefinition, 'components' | 'gradient'>): number[] {
  const n = def.components.length;
  const st = def.gradient.stops;
  if (st.length === 2 * n - 1) return def.components.map((_, i) => st[2 * i]);
  if (n <= 1) return [0];
  // Weighted spread (FullSpectrum derives default boundaries from the weights).
  const w = def.components.map((c) => Math.max(1, c.percent));
  const total = w.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) { out.push(i === 0 ? 0 : i === n - 1 ? 1 : (acc + w[i] / 2) / total); acc += w[i]; }
  return out;
}

/** Colour at height t (0 bottom … 1 top). */
export function colourAt(def: MixedDefinition, colourOf: (id: number) => string, t: number): string {
  const cols = def.components.map((c) => rgb(colourOf(c.id)));
  if (def.kind === 'pattern') return css(rgb(colourOf(def.pattern[0]?.[0] ?? 1)));
  if (!def.gradient.enabled) {
    // Static blend: weighted average of the components.
    const w = def.components.map((c) => Math.max(0, c.percent));
    const total = w.reduce((a, b) => a + b, 0) || 1;
    return css(cols.reduce<RGB>((acc, c, i) => [acc[0] + (c[0] * w[i]) / total, acc[1] + (c[1] * w[i]) / total, acc[2] + (c[2] * w[i]) / total], [0, 0, 0]));
  }
  if (cols.length === 2) {
    // A's share runs from `start` (bottom) to `end` (top).
    const shareA = def.gradient.start + (def.gradient.end - def.gradient.start) * t;
    return css(mix(cols[1], cols[0], Math.max(0, Math.min(1, shareA))));
  }
  const a = gradientAnchors(def);
  if (t <= a[0]) return css(cols[0]);
  for (let i = 0; i < a.length - 1; i++) {
    if (t > a[i + 1]) continue;
    const span = a[i + 1] - a[i] || 1;
    return css(mix(cols[i], cols[i + 1], (t - a[i]) / span));
  }
  return css(cols[cols.length - 1]);
}

/** CSS background for a vertical strip (bottom → top). */
export function previewBackground(def: MixedDefinition, colourOf: (id: number) => string): string {
  if (def.kind === 'pattern') {
    const seq = def.pattern[0] ?? [];
    if (!seq.length) return '#888';
    const step = 100 / (seq.length * 3); // three repeats of the cadence
    const parts: string[] = [];
    for (let r = 0; r < 3; r++) seq.forEach((id, k) => {
      const i = r * seq.length + k;
      const c = css(rgb(colourOf(id)));
      parts.push(`${c} ${(i * step).toFixed(2)}%`, `${c} ${((i + 1) * step).toFixed(2)}%`);
    });
    return `linear-gradient(to top, ${parts.join(', ')})`;
  }
  const n = 24;
  const parts = Array.from({ length: n + 1 }, (_, i) => `${colourAt(def, colourOf, i / n)} ${((i / n) * 100).toFixed(1)}%`);
  return `linear-gradient(to top, ${parts.join(', ')})`;
}

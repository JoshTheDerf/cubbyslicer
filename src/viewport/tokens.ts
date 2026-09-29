/** Read theme.css colour tokens for three.js materials. */
import { Color } from 'three';

export function tokenColor(name: string, fallback = '#888888'): Color {
  let v = '';
  try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch { /* SSR/tests */ }
  const c = new Color();
  try { c.setStyle(v || fallback); } catch { c.setStyle(fallback); }
  return c;
}

export function readViewportTheme() {
  return {
    bg: tokenColor('--vp-bg', '#0d0f12'),
    bed: tokenColor('--vp-bed', '#20252d'),
    bedEdge: tokenColor('--vp-bed-edge', '#4a5261'),
    grid: tokenColor('--vp-grid', '#2a3039'),
    gridStrong: tokenColor('--vp-grid-strong', '#3a4250'),
    volume: tokenColor('--vp-volume', '#3a4250'),
    exclude: tokenColor('--vp-exclude', '#ef5b5b'),
    object: tokenColor('--vp-object', '#8fa3b8'),
    selected: tokenColor('--vp-selected', '#19c37d'),
    hover: tokenColor('--vp-hover', '#4ea1ff'),
    warn: tokenColor('--vp-warn', '#f5b041'),
    axisX: tokenColor('--vp-axis-x', '#ef5b5b'),
    axisY: tokenColor('--vp-axis-y', '#19c37d'),
    axisZ: tokenColor('--vp-axis-z', '#4ea1ff'),
  };
}
export type ViewportTheme = ReturnType<typeof readViewportTheme>;

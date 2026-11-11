/** Graphics prefs shared with the CubbyCAD editor (same origin → same localStorage key `cad-graphics`). */
import { readJson } from '../lib/storage';

export interface GraphicsSettings {
  /** Device-pixel-ratio cap; 0 = up to 3. */
  pixelRatioCap: number;
  antialias: boolean;
}

export function readGraphicsSettings(): GraphicsSettings {
  const out: GraphicsSettings = { pixelRatioCap: 2, antialias: true };
  const p = readJson<{ pixelRatioCap?: unknown; antialias?: unknown }>('cad-graphics');
  if (!p || typeof p !== 'object') return out;
  if (p.pixelRatioCap === 0 || p.pixelRatioCap === 1 || p.pixelRatioCap === 1.5 || p.pixelRatioCap === 2) out.pixelRatioCap = p.pixelRatioCap;
  if (typeof p.antialias === 'boolean') out.antialias = p.antialias;
  return out;
}

/** Renderer pixel ratio under the cap. */
export function cappedPixelRatio(cap: number): number {
  const dr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return cap === 0 ? Math.min(dr, 3) : Math.min(dr, cap);
}

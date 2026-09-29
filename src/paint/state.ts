/**
 * Painting tools (OrcaSlicer's paint gizmos): support painting (L), seam
 * painting (P), color painting / MMU segmentation (N) and fuzzy-skin painting
 * (H). UI state shared by the actions, the panel and the 3D tool handler.
 */
import { reactive } from 'vue';
import type { PaintLayer } from '../engine/types';
import { activeEngine } from '../app/state';

export type PaintTool = 'circle' | 'sphere' | 'fill' | 'bucket' | 'height' | 'pointer';

export const PAINT_TITLES: Record<PaintLayer, string> = {
  support: 'Support painting',
  seam: 'Seam painting',
  color: 'Color painting',
  fuzzy: 'Fuzzy skin painting',
};

/** Tools offered per layer (Orca: seam painting has no fill tools; color painting adds bucket + height range). */
export const PAINT_TOOLS: Record<PaintLayer, PaintTool[]> = {
  support: ['circle', 'sphere', 'fill', 'pointer'],
  seam: ['circle', 'sphere'],
  color: ['circle', 'sphere', 'fill', 'bucket', 'height', 'pointer'],
  fuzzy: ['circle', 'sphere', 'fill', 'pointer'],
};

export const TOOL_LABELS: Record<PaintTool, string> = {
  circle: 'Circle', sphere: 'Sphere', fill: 'Smart fill', bucket: 'Bucket fill', height: 'Height range', pointer: 'Triangle',
};

export const paintUi = reactive({
  /** Active painting layer (null = not painting). */
  layer: null as PaintLayer | null,
  /** Object being painted. */
  objectId: null as string | null,
  tool: 'circle' as PaintTool,
  /** Brush radius (mm, world). */
  radius: 2,
  /** Smart fill / bucket angle threshold (degrees). */
  angle: 30,
  /** Support painting: highlight overhangs / paint on overhangs only (degrees, 0 = off). */
  overhang: 0,
  onOverhangsOnly: false,
  /** Height range tool: band height (mm). */
  height: 1,
  /** Color painting: the filament (1-based) the left button paints. */
  filament: 1,
  /** Engine session is busy (first open can take a moment on big meshes). */
  busy: false,
  error: null as string | null,
});

/** Engine state painted by left / right button for a layer (0 erases). */
export function stateFor(layer: PaintLayer, button: number, shift: boolean): number {
  if (shift) return 0;
  if (layer === 'color') return button === 2 ? 0 : paintUi.filament;
  if (layer === 'fuzzy') return button === 2 ? 0 : 1;
  return button === 2 ? 2 : 1; // support / seam: enforcer / blocker
}

/** Highest engine state a layer uses (TriangleSelector serialisation range). */
export function maxStateFor(layer: PaintLayer): number {
  // Colour states are filament numbers: Orca's TriangleSelector stops at 16, Full Spectrum's (mixed filaments) at 255.
  return layer === 'color' ? (activeEngine.value === 'fullspectrum' ? 64 : 16) : layer === 'fuzzy' ? 1 : 2;
}

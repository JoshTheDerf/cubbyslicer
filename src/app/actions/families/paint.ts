import type { Action } from '../types';
import type { AppContext } from '../context';

// Orca paint gizmos: L support painting, P seam painting, N color painting, H fuzzy skin painting;
// C cut (see cut.ts). Esc closes the open tool.
export interface PaintDispatch {
  togglePaint(layer: 'support' | 'seam' | 'color' | 'fuzzy'): void | Promise<void>;
  closePaint(): void | Promise<void>;
  paintLayer(): 'support' | 'seam' | 'color' | 'fuzzy' | null;
}

let paint: PaintDispatch | null = null;
/** The shell binds the painting controller (keeps this family free of app imports for tests). */
export function bindPaintDispatch(d: PaintDispatch | null): void { paint = d; }

const LAYERS = [
  ['support', 'Support painting', 'l', 'i-lucide-shield-plus', ['paint supports', 'support enforcer', 'support blocker']],
  ['seam', 'Seam painting', 'p', 'i-lucide-scan-line', ['paint seam', 'seam position']],
  ['color', 'Color painting', 'n', 'i-lucide-palette', ['paint color', 'multi material', 'mmu segmentation', 'multicolor']],
  ['fuzzy', 'Fuzzy skin painting', 'h', 'i-lucide-waves', ['paint fuzzy skin', 'texture']],
] as const;

export function paintActions(): Action[] {
  const can = (c: AppContext) => c.objectCount > 0 && c.view === 'prepare';
  return [
    ...LAYERS.map(([layer, title, key, icon, aliases]): Action => ({
      id: `paint.${layer}`, title, icon, category: 'Object', aliases: [...aliases],
      binding: { key, scope: 'prepare' },
      state: () => (paint?.paintLayer() === layer ? 'active' : undefined),
      when: can, run: () => paint?.togglePaint(layer),
    })),
    { id: 'paint.close', title: 'Close painting', icon: 'i-lucide-x', category: 'Object', hidden: true, paletteHidden: true,
      binding: { key: 'escape', scope: 'prepare', passThroughWhenUnavailable: true },
      when: (c) => !!paint?.paintLayer() && !c.modalOpen, run: () => paint?.closePaint() },
  ];
}

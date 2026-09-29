/**
 * Custom G-codes on the preview's layer slider (Orca IMSlider ticks) and the
 * colour-print view they drive. Pure helpers — PreviewView / LayerSlider /
 * CustomGcodeMenu wire them to the plate store.
 */
import type { CustomGcodeItem } from '../engine/types';
import type { ParsedGcode } from './parser/types';

/** Default colours Orca's GCodeProcessor cycles through for untagged colour changes. */
const DEFAULT_CHANGE_COLORS = [0x0b2c7a, 0x1c8891, 0xaaf200, 0xf5ce0a, 0xd16830, 0x942616];

export interface SliderTick {
  /** 0-based layer index the code runs before. */
  layer: number;
  item: CustomGcodeItem;
  /** CSS colour of the marker. */
  color: string;
  /** Tooltip text (Orca IMSlider tooltips). */
  title: string;
}

/** Layer index whose print Z matches `z` (Orca applies a code to the layer with print_z ≥ the mid-point below). */
export function layerOfZ(layerZ: ArrayLike<number>, z: number): number {
  const n = layerZ.length;
  if (!n) return -1;
  if (z > layerZ[n - 1] + 1e-3) return -1;
  for (let i = n - 1; i > 0; i--) if (z > 0.5 * (layerZ[i - 1] + layerZ[i]) + 1e-6) return i;
  return 0;
}

/** Print Z to store for a tick on layer `i` (float32 layer Z rounded to 0.1 µm). */
export function zOfLayer(layerZ: ArrayLike<number>, i: number): number {
  return Math.round(layerZ[i] * 1e4) / 1e4;
}

const TYPE_TITLES: Record<CustomGcodeItem['type'], string> = {
  color_change: 'Color change', pause: 'Pause', custom: 'Custom G-code', tool_change: 'Filament change', template: 'Custom template',
};

export function tickTitle(g: CustomGcodeItem): string {
  const z = `${g.z.toFixed(2)} mm`;
  switch (g.type) {
    case 'color_change': return `${TYPE_TITLES.color_change} (${g.color ?? ''}) at ${z}`;
    case 'tool_change': return `Change to filament ${g.extruder ?? 1} at ${z}`;
    case 'pause': return `Pause at ${z}${g.extra ? `: "${g.extra}"` : ''}`;
    case 'custom': return `Custom G-code at ${z}: "${(g.extra ?? '').slice(0, 80)}"`;
    default: return `${TYPE_TITLES[g.type]} at ${z}`;
  }
}

/** Slider markers for a plate's items against the parsed layers (items off the layer range are dropped). */
export function sliderTicks(items: readonly CustomGcodeItem[], layerZ: ArrayLike<number>, toolColors: readonly number[]): SliderTick[] {
  const out: SliderTick[] = [];
  for (const item of items) {
    const layer = layerOfZ(layerZ, item.z);
    if (layer < 0) continue;
    let color = '#9aa0a6';
    if (item.type === 'color_change' && item.color) color = item.color;
    else if (item.type === 'tool_change') color = `#${(toolColors[(item.extruder ?? 1) - 1] ?? 0x999999).toString(16).padStart(6, '0')}`;
    else if (item.type === 'pause') color = '#f5b041';
    else if (item.type === 'custom' || item.type === 'template') color = '#4ea1ff';
    out.push({ layer, item, color, title: tickTitle(item) });
  }
  return out.sort((a, b) => a.layer - b.layer);
}

/**
 * Orca's colour print: after a colour change, an extruder prints in the new
 * colour. Returns a per-segment colour slot array (for the renderer's `tool`
 * attribute) and the slot colours: slots 0..tools-1 = filament colours, then
 * one slot per colour change (max 16 slots, the renderer's palette size).
 * Null when the G-code has no colour changes.
 */
export function colorPrintSlots(p: ParsedGcode, toolColors: readonly number[]): { tool: Uint8Array; colors: number[]; base: number } | null {
  const ev = p.colorChanges;
  if (!ev?.length) return null;
  const MAX = 16;
  const base = Math.min(MAX - 1, Math.max(1, maxOf(p.tool) + 1));
  const colors = toolColors.slice(0, base);
  while (colors.length < base) colors.push(0x999999);
  const slotOf = Array.from({ length: 256 }, (_, t) => Math.min(t, base - 1));
  const out = new Uint8Array(p.segmentCount);
  let seg = 0, di = 0;
  const events = ev.slice().sort((a, b) => a.seg - b.seg);
  for (let k = 0; k <= events.length; k++) {
    const end = k < events.length ? Math.min(p.segmentCount, events[k].seg) : p.segmentCount;
    for (; seg < end; seg++) out[seg] = slotOf[p.tool[seg]];
    if (k < events.length && colors.length < MAX) {
      const e = events[k];
      colors.push(e.color ?? DEFAULT_CHANGE_COLORS[di++ % DEFAULT_CHANGE_COLORS.length]);
      slotOf[e.extruder] = colors.length - 1;
    }
  }
  return { tool: out, colors, base };
}

function maxOf(a: Uint8Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}

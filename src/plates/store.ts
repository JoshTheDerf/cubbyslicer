/**
 * Per-plate settings (Orca PlateSettingsDialog → PartPlate config) and the
 * plate's slider custom G-codes (Orca CustomGCode::Info per plate). Both live
 * on the plate record (PlateMeta.config / .customGcodes) and change through
 * the project store's `mutate()` — undoable, persisted, and part of the
 * plate's slice signature (changing them marks the plate's slice stale).
 */
import type { ConfigValue, CustomGcodeItem, FlatConfig } from '../engine/types';
import { mutate, plates } from '../project/store';

/** Plate config keys Orca's PlateSettingsDialog writes (Tab.cpp plate_keys). */
export const PLATE_KEYS = [
  'curr_bed_type', 'print_sequence', 'spiral_mode',
  'first_layer_print_sequence', 'first_layer_sequence_choice',
  'other_layers_print_sequence', 'other_layers_print_sequence_nums', 'other_layers_sequence_choice',
] as const;

export function plateConfig(i: number): Readonly<Record<string, ConfigValue>> {
  return plates.value[i]?.config ?? {};
}

/** Replace a plate's settings (keys absent = "Same as global"). Undoable. */
export function setPlateConfig(i: number, config: Record<string, ConfigValue>): void {
  mutate('Plate settings', () => {
    const p = plates.value[i];
    if (!p) return;
    const clean = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== ''));
    if (Object.keys(clean).length) p.config = clean; else delete p.config;
  });
}

/**
 * The resolved config with a plate's settings applied (Orca
 * BackgroundSlicingProcess::apply: `new_config.apply(plate->config())`).
 * `known` filters keys the active engine doesn't have (null = keep all).
 */
export function applyPlateConfig(base: FlatConfig, plateCfg: Readonly<Record<string, ConfigValue>> | undefined, known: ((k: string) => boolean) | null = null): FlatConfig {
  if (!plateCfg) return base;
  const entries = Object.entries(plateCfg).filter(([k]) => !known || known(k));
  if (!entries.length) return base;
  const out: FlatConfig = { ...base };
  for (const [k, v] of entries) out[k] = Array.isArray(v) ? [...v] : v;
  return out;
}

// ---- custom G-codes ----------------------------------------------------------------------

const Z_EPS = 1e-4;

export function plateCustomGcodes(i: number): readonly CustomGcodeItem[] {
  return plates.value[i]?.customGcodes ?? [];
}

const LABELS: Record<CustomGcodeItem['type'], string> = {
  color_change: 'Add color change', pause: 'Add pause', custom: 'Add custom G-code', tool_change: 'Change filament', template: 'Add custom template',
};

function write(i: number, label: string, fn: (list: CustomGcodeItem[]) => CustomGcodeItem[]): void {
  mutate(label, () => {
    const p = plates.value[i];
    if (!p) return;
    const next = fn((p.customGcodes ?? []).map((g) => ({ ...g }))).sort((a, b) => a.z - b.z);
    if (next.length) p.customGcodes = next; else delete p.customGcodes;
  });
}

/**
 * Add (or replace — Orca keeps one tick per layer) a custom G-code at print Z
 * `item.z` on plate `i`. Colour / tool changes switch an existing tick's code
 * like Orca's add_code_as_tick; other types don't overwrite a different tick.
 */
export function addCustomGcode(i: number, item: CustomGcodeItem): boolean {
  const existing = plateCustomGcodes(i).find((g) => Math.abs(g.z - item.z) < Z_EPS);
  const switchable = (t: CustomGcodeItem['type']) => t === 'color_change' || t === 'tool_change';
  if (existing && existing.type !== item.type && !(switchable(existing.type) && switchable(item.type)) && item.type !== 'custom') return false;
  write(i, LABELS[item.type], (list) => [...list.filter((g) => Math.abs(g.z - item.z) >= Z_EPS), { ...item }]);
  return true;
}

export function updateCustomGcode(i: number, z: number, patch: Partial<CustomGcodeItem>): void {
  write(i, 'Edit custom G-code', (list) => list.map((g) => (Math.abs(g.z - z) < Z_EPS ? { ...g, ...patch } : g)));
}

export function removeCustomGcode(i: number, z: number): void {
  const g = plateCustomGcodes(i).find((x) => Math.abs(x.z - z) < Z_EPS);
  const what = g?.type === 'color_change' ? 'color change' : g?.type === 'pause' ? 'pause' : g?.type === 'tool_change' ? 'filament change' : 'custom G-code';
  write(i, `Delete ${what}`, (list) => list.filter((x) => Math.abs(x.z - z) >= Z_EPS));
}

export function clearCustomGcodes(i: number): void {
  write(i, 'Delete all custom G-codes', () => []);
}

/** Orca's default colour-change palette (GCodeProcessor Default_Colors). */
export const COLOR_CHANGE_PALETTE = ['#0B2C7A', '#1C8891', '#AAF200', '#F5CE0A', '#D16830', '#942616'];

/** Next colour for a new colour change: the palette entry after the last used one. */
export function nextChangeColor(list: readonly CustomGcodeItem[]): string {
  const used = list.filter((g) => g.type === 'color_change').length;
  return COLOR_CHANGE_PALETTE[used % COLOR_CHANGE_PALETTE.length];
}

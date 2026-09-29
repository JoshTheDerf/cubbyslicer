/**
 * Shared, reactive settings layout of the active engine (sidebar, printer /
 * filament dialogs and the search all read the same tables), plus the
 * mode filter and page icons.
 */
import { computed } from 'vue';
import { activeEngine } from '../app/state';
import type { ConfigMode } from '../engine/types';
import { currentPresets } from '../presets/store';
import type { PresetKind } from '../presets/types';
import { asArray } from '../presets/values';
import { buildLayout, locateKeys, type KeyLocation } from './layout/build';
import type { BuiltPage, SettingsTabId } from './layout/types';
import { revealSetting, settingsUi } from './uiState';

export const MODES: readonly ConfigMode[] = ['simple', 'advanced', 'expert'];
export const MODE_LABELS: Record<ConfigMode, string> = { simple: 'Simple', advanced: 'Advanced', expert: 'Expert' };
export const MODE_RANK: Record<ConfigMode, number> = { simple: 0, advanced: 1, expert: 2 };

export const extruderCount = computed(() => Math.max(1, asArray(currentPresets.value.value('printer', 'nozzle_diameter')).length));
export const settingsLayout = computed(() => {
  const schema = currentPresets.value.schema.value;
  return schema ? buildLayout(schema, activeEngine.value, extruderCount.value) : null;
});
export const keyLocations = computed(() => (settingsLayout.value ? locateKeys(settingsLayout.value) : new Map<string, KeyLocation>()));
/** Printer keys edited per extruder (resized with the extruder count). */
export const perExtruderKeys = computed(() => {
  const s = new Set<string>();
  for (const pg of settingsLayout.value?.printer.pages ?? []) if (pg.extruder !== undefined) for (const g of pg.groups) for (const k of g.keys) s.add(k);
  return s;
});

/** Whether a key shows in the current mode (always when modified or just jumped to). */
export function isVisible(key: string, kind: PresetKind, slot: number): boolean {
  const p = currentPresets.value;
  const def = p.schema.value?.options[key];
  if (!def) return false;
  return MODE_RANK[def.mode] <= MODE_RANK[settingsUi.mode] || key === settingsUi.highlightKey || p.isModified(kind, key, slot);
}

export function pageDirty(pg: BuiltPage, kind: PresetKind, slot: number): number {
  const p = currentPresets.value;
  let n = 0;
  for (const g of pg.groups) for (const k of g.keys) if (p.isModified(kind, k, slot)) n++;
  return n;
}

/** The selected page of a tab (first page by default). */
export function currentPageOf(tab: SettingsTabId): BuiltPage | null {
  const t = settingsLayout.value?.[tab];
  if (!t?.pages.length) return null;
  return t.pages.find((pg) => pg.id === settingsUi.pageByTab[tab]) ?? t.pages[0];
}

export function selectPage(tab: SettingsTabId, pageId: string): void {
  settingsUi.pageByTab = { ...settingsUi.pageByTab, [tab]: pageId };
}

/** Jump to a setting anywhere (process tab in the sidebar, printer / filament in their dialog). */
export async function jumpToSetting(key: string): Promise<boolean> {
  const loc = keyLocations.value.get(key);
  if (!loc) return false;
  await revealSetting(key, loc);
  return true;
}

// Icons for Orca / preFlight page titles (Orca's Tab.cpp page icons, lucide equivalents).
const PAGE_ICONS: Record<string, string> = {
  quality: 'i-lucide-layers', strength: 'i-lucide-shield-half', speed: 'i-lucide-gauge', support: 'i-lucide-tree-pine',
  'support material': 'i-lucide-tree-pine', multimaterial: 'i-lucide-palette', 'multiple extruders': 'i-lucide-palette',
  others: 'i-lucide-sliders-horizontal', other: 'i-lucide-ellipsis', 'layers and perimeters': 'i-lucide-layers', infill: 'i-lucide-grid-3x3',
  'skirt and brim': 'i-lucide-square-dashed', advanced: 'i-lucide-settings-2', preprocessing: 'i-lucide-wand-sparkles',
  'output options': 'i-lucide-file-output', notes: 'i-lucide-notebook-pen', dependencies: 'i-lucide-link',
  filament: 'i-lucide-disc', cooling: 'i-lucide-fan', 'setting overrides': 'i-lucide-file-pen', 'basic information': 'i-lucide-printer',
  general: 'i-lucide-printer', 'machine g-code': 'i-lucide-file-code', 'custom g-code': 'i-lucide-file-code', 'motion ability': 'i-lucide-move',
  'machine limits': 'i-lucide-move', 'single extruder mm': 'i-lucide-palette',
};
export function pageIcon(title: string): string {
  const t = title.toLowerCase();
  if (/^extruder( \d+)?$/.test(t)) return 'i-lucide-pen-tool';
  return PAGE_ICONS[t] ?? 'i-lucide-file';
}

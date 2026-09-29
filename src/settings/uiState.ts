/**
 * Settings sidebar UI state shared with the action registry (src/settings/actions.ts):
 * mode filter, which preset kind is being edited, the Global/Objects switch,
 * the printer / filament settings dialog, and one-shot requests the mounted
 * panel reacts to.
 */
import { nextTick, reactive, ref, watch } from 'vue';
import type { ConfigMode } from '../engine/types';
import { lsGet, lsSet } from '../presets/kv';
import type { PresetKind } from '../presets/types';
import type { SettingsTabId } from './layout/types';

export type SettingsRegion = 'global' | 'objects';
/** Collapsible sidebar sections (Orca's Printer / Filament / Process title bars). */
export type SidebarSection = 'printer' | 'filament' | 'process';

export const settingsUi = reactive({
  mode: (lsGet<ConfigMode>('cubby.settings.mode') ?? 'advanced') as ConfigMode,
  /** Preset kind last focused / edited (drives the save / revert actions). */
  tab: (lsGet<SettingsTabId>('cubby.settings.tab') ?? 'process') as SettingsTabId,
  filamentSlot: 0,
  /** Orca's process "Global | Objects" switch. */
  region: (lsGet<SettingsRegion>('cubby.settings.region') ?? 'global') as SettingsRegion,
  /** Open "Printer settings" / "Filament settings" dialog (Orca's edit buttons next to the combos). */
  editor: null as 'printer' | 'filament' | null,
  /** Selected page per tab (page id from the built layout). */
  pageByTab: {} as Partial<Record<SettingsTabId, string>>,
  /** Collapsed option groups (group id). */
  collapsedGroups: [] as string[],
  collapsedSections: (lsGet<SidebarSection[]>('cubby.settings.collapsed') ?? []) as SidebarSection[],
  /** Key flashed after a search jump. */
  highlightKey: null as string | null,
  /** Number of mounted SettingsPanel instances (actions are gated on it). */
  mounted: 0,
});
watch(() => settingsUi.mode, (m) => lsSet('cubby.settings.mode', m));
watch(() => settingsUi.tab, (t) => lsSet('cubby.settings.tab', t));
watch(() => settingsUi.region, (r) => lsSet('cubby.settings.region', r));
watch(() => settingsUi.collapsedSections.slice(), (c) => lsSet('cubby.settings.collapsed', c));
// Closing the printer / filament dialog hands the save / revert actions back to the process preset.
watch(() => settingsUi.editor, (e) => { settingsUi.tab = e ?? 'process'; });

export type PresetRequestType = 'pick' | 'save' | 'saveAs';
export interface PresetRequest { type: PresetRequestType; kind: PresetKind; index: number; seq: number }

let seq = 0;
/** Latest preset-row request (open picker / save / save as). */
export const presetRequest = ref<PresetRequest | null>(null);
export function requestPreset(type: PresetRequestType, kind: PresetKind, index = 0): void {
  presetRequest.value = { type, kind, index, seq: ++seq };
}

/** Panel-level one-shot requests (counter bumps). `focusSearch` opens the settings search. */
export const panelRequest = reactive({ focusSearch: 0, addPrinter: 0, importFiles: 0, setupWizard: 0, closeSetupWizard: 0 });
/** Whether the first-run setup wizard is showing (mirrored by SettingsPanel). */
export const setupWizardState = reactive({ open: false });

/** Set once the user has finished (or skipped) the first-run printer setup. */
export const SETUP_DONE_KEY = 'cubby.setup.done';

/** Preset kind edited by the active tab. */
export function activeKind(): PresetKind {
  return settingsUi.tab === 'printer' ? 'printer' : settingsUi.tab === 'process' ? 'process' : 'filament';
}

/** Open a settings tab: process → sidebar Global mode; printer / filament → their settings dialog. */
export function openSettingsTab(tab: SettingsTabId, filamentSlot?: number): void {
  if (filamentSlot !== undefined) settingsUi.filamentSlot = filamentSlot;
  if (tab === 'process') {
    settingsUi.editor = null;
    settingsUi.region = 'global';
    settingsUi.collapsedSections = settingsUi.collapsedSections.filter((s) => s !== 'process');
  } else settingsUi.editor = tab;
  settingsUi.tab = tab;
}

export function toggleGroup(id: string, open?: boolean): void {
  const has = settingsUi.collapsedGroups.includes(id);
  const want = open ?? has;
  if (want && has) settingsUi.collapsedGroups = settingsUi.collapsedGroups.filter((g) => g !== id);
  else if (!want && !has) settingsUi.collapsedGroups = [...settingsUi.collapsedGroups, id];
}

/** Where a key lives (subset of layout/build KeyLocation, kept here to avoid a cycle). */
export interface JumpTarget { tab: SettingsTabId; pageId: string; groupId: string }

let flashTimer: ReturnType<typeof setTimeout> | null = null;
/** Reveal a setting: open its tab / page / group, scroll it into view, focus its control and flash it. */
export async function revealSetting(key: string, where: JumpTarget): Promise<void> {
  openSettingsTab(where.tab);
  settingsUi.pageByTab = { ...settingsUi.pageByTab, [where.tab]: where.pageId };
  toggleGroup(where.groupId, true);
  settingsUi.highlightKey = key;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (settingsUi.highlightKey === key) settingsUi.highlightKey = null; }, 4000);
  // The dialog may still be opening: retry for a moment.
  for (let i = 0; i < 20; i++) {
    await nextTick();
    const el = document.querySelector<HTMLElement>(`[data-settings-scope="${where.tab}"] [data-key="${CSS.escape(key)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.querySelector<HTMLElement>('input, textarea, button[role="combobox"], button[role="checkbox"]')?.focus({ preventScroll: true });
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

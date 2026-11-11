/**
 * Settings / presets commands for the app action registry (menus, command
 * palette, keyboard dispatcher). No global key listeners here — the
 * registry's dispatcher owns the keyboard.
 */
import { activeEngine } from '../app/state';
import { ENGINE_LABELS } from '../engine/client';
import type { ConfigMode, EngineId } from '../engine/types';
import { currentPresets, ENGINES, setActiveEngine } from '../presets/store';
import type { PresetKind } from '../presets/types';
import type { Action } from '../app/actions/types';
import type { SettingsTabId } from './layout/types';
import { activeKind, openSettingsTab, panelRequest, requestPreset, settingsUi, type SettingsRegion } from './uiState';

const CATEGORY = 'Settings';
const panelMounted = () => settingsUi.mounted > 0;
/** The settings dialogs (SettingsHost) work whether or not the sidebar is showing. */
const dialogsReady = () => settingsUi.hosts > 0;
const slotIndex = () => (activeKind() === 'filament' ? settingsUi.filamentSlot : 0);
const TAB_TITLES: Record<SettingsTabId, string> = { process: 'Process settings', filament: 'Filament settings…', printer: 'Printer settings…' };
const MODE_TITLES: Record<ConfigMode, string> = { simple: 'Simple', advanced: 'Advanced', expert: 'Expert' };
const KIND_TITLES: Record<PresetKind, string> = { printer: 'printer', process: 'process', filament: 'filament' };

export const settingsActions: Action[] = [
  {
    id: 'settings.search.focus', title: 'Search settings', category: CATEGORY, aliases: ['find setting', 'option', 'parameter'],
    binding: { key: 'f', ctrlOrMeta: true, shift: true }, when: dialogsReady,
    run: () => { panelRequest.focusSearch++; },
  },
  ...ENGINES.map((e: EngineId): Action => ({
    id: `settings.engine.${e}`, title: `Use ${ENGINE_LABELS[e]} engine`, category: CATEGORY, aliases: ['engine', 'slicer', e],
    state: () => (activeEngine.value === e ? 'on' : 'off'),
    run: () => setActiveEngine(e),
  })),
  ...(['printer', 'filament', 'process'] as PresetKind[]).map((k): Action => ({
    id: `settings.preset.pick.${k}`, title: `Choose ${KIND_TITLES[k]} preset…`, category: CATEGORY, aliases: ['preset', 'profile', k],
    when: panelMounted,
    run: () => {
      settingsUi.collapsedSections = settingsUi.collapsedSections.filter((s) => s !== k);
      if (k === 'process') openSettingsTab('process');
      if (k !== 'filament') settingsUi.tab = k;
      requestPreset('pick', k, k === 'filament' ? settingsUi.filamentSlot : 0);
    },
  })),
  {
    id: 'settings.setup', title: 'Printer & filament setup…', category: CATEGORY,
    aliases: ['setup wizard', 'first run', 'choose printer', 'choose filament', 'onboarding'],
    when: dialogsReady, run: () => { panelRequest.setupWizard++; },
  },
  {
    id: 'settings.printer.add', title: 'Add / remove printers…', category: CATEGORY, aliases: ['printer', 'vendor', 'machine', 'wizard'],
    when: dialogsReady, run: () => { panelRequest.addPrinter++; },
  },
  {
    id: 'settings.preset.save', title: 'Save preset', category: CATEGORY, aliases: ['save profile'],
    dynamicTitle: () => `Save ${KIND_TITLES[activeKind()]} preset`,
    when: () => panelMounted() && currentPresets.value.dirtyCount(activeKind(), slotIndex()) > 0,
    run: () => requestPreset('save', activeKind(), slotIndex()),
  },
  {
    id: 'settings.preset.saveAs', title: 'Save preset as…', category: CATEGORY, aliases: ['duplicate preset', 'new preset'],
    dynamicTitle: () => `Save ${KIND_TITLES[activeKind()]} preset as…`,
    when: panelMounted, run: () => requestPreset('saveAs', activeKind(), slotIndex()),
  },
  {
    id: 'settings.preset.revert', title: 'Discard preset changes', category: CATEGORY, aliases: ['revert', 'reset settings'],
    dynamicTitle: () => `Discard ${KIND_TITLES[activeKind()]} changes`,
    when: () => currentPresets.value.dirtyCount(activeKind(), slotIndex()) > 0,
    run: () => currentPresets.value.revertAll(activeKind(), slotIndex()),
  },
  {
    id: 'settings.presets.import', title: 'Import presets…', category: CATEGORY, aliases: ['import profile', 'orca', 'bambu', 'bundle'],
    when: dialogsReady, run: () => { panelRequest.importFiles++; },
  },
  ...(['simple', 'advanced', 'expert'] as ConfigMode[]).map((m): Action => ({
    id: `settings.mode.${m}`, title: `${MODE_TITLES[m]} settings mode`, category: CATEGORY, aliases: ['mode', 'show all settings', m],
    state: () => (settingsUi.mode === m ? 'on' : 'off'),
    run: () => { settingsUi.mode = m; },
  })),
  ...(['process', 'filament', 'printer'] as SettingsTabId[]).map((t): Action => ({
    id: `settings.tab.${t}`, title: TAB_TITLES[t], category: CATEGORY, aliases: ['tab', 'edit', t, ...(t === 'printer' ? ['machine', 'bed', 'g-code'] : [])],
    state: () => (t === 'process' ? (settingsUi.editor === null && settingsUi.region === 'global' ? 'active' : undefined) : settingsUi.editor === t ? 'active' : undefined),
    when: t === 'process' ? panelMounted : dialogsReady, run: () => openSettingsTab(t),
  })),
  ...(['global', 'objects'] as SettingsRegion[]).map((r): Action => ({
    id: `settings.region.${r}`, title: r === 'global' ? 'Edit global process settings' : 'Edit per-object settings',
    category: CATEGORY, aliases: ['global', 'objects', 'per-object', 'modifier', r],
    state: () => (settingsUi.region === r ? 'on' : 'off'),
    when: panelMounted, run: () => { settingsUi.region = r; settingsUi.editor = null; },
  })),
];

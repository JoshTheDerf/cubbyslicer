/**
 * OrcaSlicer 2.5 Python plugins in CubbySlicer: the wiring.
 *
 * `startPlugins()` reads the installed packages (OPFS) and, when any is
 * enabled, boots the plugin runtime worker in idle time and loads them, as
 * Orca auto-loads enabled packages at startup. Nothing Python-related loads
 * otherwise; the Plugins dialog boots it on demand.
 *
 * Layout: manager/ (catalog, install, sidecars, configs), runtime/ (worker,
 * Pyodide, the `orca` shim in python/, HostChannel), host/ (the host API the
 * shim calls, post-process, palette actions, lifecycle), ui/ (dialog, plugin
 * windows, prompts). Slicing-pipeline hooks (phase 2) slot in through
 * runtime/hookChannel.ts once the engine ABI lands (docs/ENGINE-CONTRACT.md).
 */
import { watch } from 'vue';
import { currentPresets } from '../presets/store';
import type { PluginPermissions } from './types';
import {
  handlePermissionRequest, handleRuntimeDenial, loadEnabledPlugins, log, onPluginsChange, pluginName, pluginState, pushConfigs,
  scanCatalog, setPermissionAsker, setPresetOverrideAccess,
} from './manager/store';
import { connectEngineWorker, setRuntimeHooks } from './runtime/client';
import { onEngineWorker } from '../engine/client';
import { addConfigProblemSource } from '../settings/validate';
import { pipelineProblems } from './host/pipelineSelection';
import { setSwitchPrompt } from './host/presets';
import { chooseAction } from '../app/shell/uiState';
import { hostCall, hostPost } from './host/api';
import { appInfo } from './host/app';
import { askPermission } from './host/ui';
import { installPluginActions } from './host/actions';
import { installLifecycleEvents } from './host/lifecycle';
import { installPluginPages } from './host/pages';
import { pluginsActive } from './state';

export { openPluginsDialog, pluginsDialogOpen, pluginsActive } from './state';

let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  setRuntimeHooks({
    hostCall, hostPost, appInfo,
    log: (level, text, key) => log(level, text, key),
    permissionRequest: (key, req) => handlePermissionRequest(key, req),
    permissionDenied: (m) => { void handleRuntimeDenial(m.pluginKey, m.category, m.target, m.persistable, m.message); },
  });
  setPermissionAsker((key, request: PluginPermissions, kind, detail) =>
    askPermission({ pluginKey: key, pluginName: pluginName(key), request, kind, detail }));
  setPresetOverrideAccess({
    read: (kind, key) => {
      const s = currentPresets.value;
      if (!s.schema.value?.options[key]) return null;
      const v = s.value(kind, key);
      return Array.isArray(v) ? v.join('') : (v ?? '');
    },
    write: (kind, key, value) => currentPresets.value.setValue(kind, key, value),
  });
  onPluginsChange(() => { pluginsActive.value = pluginState.rows.some((r) => r.status === 'loaded'); });
  // Preset overrides follow the edited process preset.
  watch(() => {
    const s = currentPresets.value;
    return s.schema.value?.options.print_plugin_config_overrides ? s.value('process', 'print_plugin_config_overrides') : null;
  }, () => { pluginState.configRevision++; pushConfigs(); });
  installPluginActions();
  installPluginPages();
  installLifecycleEvents();
  // A plugin's begin_update(preset_name=…) over unsaved edits: the same question the preset selector asks.
  setSwitchPrompt(async (kind, from, to, edits) => {
    const c = await chooseAction({
      title: `Switch the ${kind} preset?`,
      message: `A plugin wants to edit “${to}”. “${from}” has ${edits} unsaved change${edits === 1 ? '' : 's'}.`,
      confirmLabel: 'Discard changes', altLabel: 'Transfer changes', danger: true, testId: 'plugin-preset-switch',
    });
    return c === 'confirm' ? 'discard' : c === 'alt' ? 'transfer' : null;
  });
  // The missing-plugin gate: unresolved slicing-pipeline references block slicing (Orca PluginResolver).
  addConfigProblemSource(pipelineProblems);
  // Slicing-pipeline hooks: every orca engine worker gets a HookChannel to the plugin runtime.
  onEngineWorker((w, engine) => (engine === 'orca' ? connectEngineWorker(w) : undefined));
}

let started: Promise<void> | null = null;

/** Read the catalog; load enabled packages in idle time. Safe to call more than once. */
export function startPlugins(): Promise<void> {
  wire();
  return (started ??= (async () => {
    try { await scanCatalog(); } catch (e) { log('error', `Couldn't read installed plugins: ${(e as Error).message}`); return; }
    if (!pluginState.rows.some((r) => r.desc.state?.enabled && r.desc.metadataValid)) return;
    await new Promise<void>((res) => {
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
      if (ric) ric(() => res(), { timeout: 4000 }); else setTimeout(res, 1500);
    });
    await loadEnabledPlugins();
  })());
}

/** Make sure the catalog is wired and read (the Plugins dialog). */
export async function ensurePluginsReady(): Promise<void> {
  wire();
  if (!pluginState.scanned) await scanCatalog();
}

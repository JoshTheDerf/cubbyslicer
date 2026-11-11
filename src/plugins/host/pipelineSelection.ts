/**
 * The process preset's slicing-pipeline selection and what hangs off it
 * (Orca 2.5 PrintConfig.cpp / PluginConfig / PluginResolver):
 *
 *  - `slicing_pipeline_plugin` (strings): capability names in run order;
 *  - `plugins` (strings): the manifest `<name or plugin_key>;<cloud uuid>;<capability>`
 *    of the references (local plugins use their plugin_key), rewritten whenever the
 *    selection changes (Orca: save_plugin_collection);
 *  - `print_plugin_config_overrides`: per-preset capability configs, pruned of
 *    capabilities the selection no longer names (prune_stale_plugin_overrides);
 *  - the missing-plugin gate: a selected capability that is not installed, not
 *    active, or no longer provided blocks slicing, with what to do about it
 *    (Orca keeps the Slice button disabled until resolved).
 *
 * Engines whose schema lacks `slicing_pipeline_plugin` (before 2.5) keep the
 * selection in CubbySlicer's own storage, for post-processing only.
 */
import { ref } from 'vue';
import { currentPresets } from '../../presets/store';
import { readJson, writeJson } from '../../lib/storage';
import { CapabilityConfigDocument } from '../manager/config';
import { loadedCapabilities, log, pluginState } from '../manager/store';

export const PIPELINE_KEY = 'slicing_pipeline_plugin';
export const MANIFEST_KEY = 'plugins';
export const OVERRIDES_KEY = 'print_plugin_config_overrides';
const FALLBACK_STORE = 'cubby-plugins:slicing-pipeline-plugin';

/** The selection kept by CubbySlicer when the engine schema has no `slicing_pipeline_plugin`. */
export const fallbackSelection = ref<string[]>(readJson<string[]>(FALLBACK_STORE) ?? []);

const hasKey = (k: string) => !!currentPresets.value.schema.value?.options[k];
export function schemaHasPipelineKey(): boolean { return hasKey(PIPELINE_KEY); }

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []).filter(Boolean);

/** Capability names the process preset selects, in run order. */
export function selectedPipelineNames(): string[] {
  if (schemaHasPipelineKey()) return asList(currentPresets.value.value('process', PIPELINE_KEY));
  return fallbackSelection.value;
}

/** The manifest entries of the edited process preset. */
export function manifestEntries(): string[] {
  return hasKey(MANIFEST_KEY) ? asList(currentPresets.value.value('process', MANIFEST_KEY)) : [];
}

/** Set the selection (run order) and keep the manifest and the per-preset overrides in step. */
export function setPipelineSelection(names: string[]): void {
  const next = [...new Set(names.filter(Boolean))];
  if (!schemaHasPipelineKey()) {
    fallbackSelection.value = next;
    writeJson(FALLBACK_STORE, next);
    return;
  }
  const p = currentPresets.value;
  p.setValue('process', PIPELINE_KEY, next.length ? next : []);
  if (hasKey(MANIFEST_KEY)) {
    const old = manifestEntries();
    const loaded = loadedCapabilities('slicing-pipeline');
    const entries = next.map((name) => {
      const c = loaded.find((x) => x.name === name);
      if (c) return `${c.pluginKey};;${name}`;
      // Not loaded here: keep the reference the preset came with (so the gate can say what is missing).
      return old.find((e) => e.split(';')[2] === name) ?? `;;${name}`;
    });
    // In 2.5 this option is the process preset's only plugin-backed one, so the manifest is exactly its references.
    p.setValue('process', MANIFEST_KEY, entries);
  }
  if (hasKey(OVERRIDES_KEY)) {
    const raw = String(p.value('process', OVERRIDES_KEY) ?? '');
    try {
      const doc = CapabilityConfigDocument.parseOverrides(raw);
      if (doc.pruneUnreferenced(next.map((n) => ['slicing-pipeline', n]))) p.setValue('process', OVERRIDES_KEY, doc.toOverrides());
    } catch (e) { log('warn', `Kept unreadable plugin overrides: ${(e as Error).message}`); }
  }
}

export function setPipelineSelected(name: string, on: boolean): void {
  const cur = selectedPipelineNames().filter((n) => n !== name);
  setPipelineSelection(on ? [...cur, name] : cur);
}

// ---- the missing-plugin gate (PluginResolver) -----------------------------------------------------

export type RefState = 'ok' | 'loading' | 'inactive' | 'missing' | 'broken';
export interface PipelineRef { name: string; state: RefState; pluginKey?: string; pluginName?: string; message: string }

/** What each selected capability resolves to now. */
export function pipelineRefs(): PipelineRef[] {
  const manifest = manifestEntries();
  return selectedPipelineNames().map((name): PipelineRef => {
    const ref = manifest.find((e) => e.split(';')[2] === name)?.split(';')[0] || '';
    const provides = (r: (typeof pluginState.rows)[number]) =>
      r.caps.some((x) => x.type === 'slicing-pipeline' && x.name === name) || !!r.desc.state?.capabilities.some(([n]) => n === name);
    // The manifest names the plugin; without it, any installed plugin known to provide the capability.
    const candidates = pluginState.rows.filter((r) => (ref ? r.desc.pluginKey === ref || r.desc.name === ref : provides(r)));
    for (const r of candidates) {
      const c = r.caps.find((x) => x.type === 'slicing-pipeline' && x.name === name);
      if (c && r.status === 'loaded') {
        return c.enabled
          ? { name, state: 'ok', pluginKey: r.desc.pluginKey, pluginName: r.desc.name, message: '' }
          : { name, state: 'inactive', pluginKey: r.desc.pluginKey, pluginName: r.desc.name, message: `“${name}” is turned off in ${r.desc.name}. Turn it on in Plugins.` };
      }
    }
    const installed = candidates[0];
    if (installed) {
      if (installed.status === 'loading') return { name, state: 'loading', pluginKey: installed.desc.pluginKey, pluginName: installed.desc.name, message: `${installed.desc.name} is still loading.` };
      if (installed.status !== 'loaded') return { name, state: 'inactive', pluginKey: installed.desc.pluginKey, pluginName: installed.desc.name, message: `${installed.desc.name} is not active. Activate it in Plugins.` };
      return { name, state: 'broken', pluginKey: installed.desc.pluginKey, pluginName: installed.desc.name, message: `${installed.desc.name} no longer provides “${name}”.` };
    }
    if (!pluginState.scanned) return { name, state: 'loading', message: 'Plugins are loading.' };
    return { name, state: 'missing', message: `“${name}” is not installed${ref ? ` (plugin ${ref})` : ''}. Install it from File ▸ Plugins.` };
  });
}

/** Slice-blocking problems for the settings validator (SliceBar shows them with "Go to setting"). */
export function pipelineProblems(): Array<{ key: string; label: string; message: string; severity: 'error' }> {
  if (!schemaHasPipelineKey()) return [];
  return pipelineRefs().filter((r) => r.state !== 'ok')
    .map((r) => ({ key: PIPELINE_KEY, label: 'Slicing pipeline plugin', message: r.message, severity: 'error' as const }));
}

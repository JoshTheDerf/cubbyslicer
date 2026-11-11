<script setup lang="ts">
/**
 * A capability's configuration (OrcaSlicer's Config tab and the preset
 * "Plugin Configuration" dialog): the JSON editor, or the capability's own
 * HTML (get_config_ui()) in a sandboxed frame with Orca's config bridge.
 *
 * Scope: "Global" writes orca_plugins/config.json; "Process preset" writes the
 * edited process preset's print_plugin_config_overrides (Orca 2.5 schema key;
 * only slicing-pipeline capabilities, and only when the engine schema has it).
 * Restore defaults: global → get_default_config(); preset → drop the override.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { LoadedCapability } from '../types';
import {
  capabilityConfig, configUiOf, defaultConfigOf, globalConfig, pluginState, presetOverrideAvailable, saveGlobalConfig, setPresetOverride,
} from '../manager/store';
import { buildConfigDocument, themeSnapshot, type ConfigContext } from './pluginDocument';
import { confirmAction } from '../../app/shell/uiState';
import { toast } from '../../ui/toast';

const props = defineProps<{ cap: LoadedCapability; pluginVersion: string; initialScope?: 'global' | 'preset' }>();

const scope = ref<'global' | 'preset'>(props.initialScope ?? 'global');
const canPreset = computed(() => { void pluginState.configRevision; return presetOverrideAvailable(props.cap); });
const effective = computed(() => { void pluginState.configRevision; return capabilityConfig(props.cap); });
const shown = computed(() => {
  const e = effective.value;
  if (scope.value === 'preset') return e.config;
  // The global layer itself (an override may be what's effective).
  return e.hasPresetOverride ? globalOnly.value : e.config;
});
const globalOnly = computed(() => { void pluginState.configRevision; return globalConfig.value.find(props.cap)?.config ?? {}; });

const text = ref('');
const error = ref('');
watch(shown, (v) => { text.value = JSON.stringify(v ?? {}, null, 2); error.value = ''; }, { immediate: true, deep: true });
watch(text, (t) => { try { JSON.parse(t); error.value = ''; } catch (e) { error.value = (e as Error).message; } });

const stale = computed(() => {
  const v = effective.value.storedPluginVersion;
  return v && props.pluginVersion && v !== props.pluginVersion ? v : '';
});

async function save(cfg: unknown): Promise<void> {
  if (scope.value === 'preset') { setPresetOverride(props.cap, cfg); toast.success('Configuration saved to the process preset.', { timeout: 2000 }); }
  else { await saveGlobalConfig(props.cap, cfg); toast.success('Configuration saved.', { timeout: 2000 }); }
}

async function saveText(): Promise<void> {
  let v: unknown;
  try { v = JSON.parse(text.value); } catch { return; }
  await save(v);
}

async function restore(): Promise<void> {
  const ok = await confirmAction({
    title: 'Restore defaults',
    message: scope.value === 'preset'
      ? `Remove the process preset's configuration for "${props.cap.name}"? The global configuration applies again.`
      : `Restore the default configuration for "${props.cap.name}"?\n\nThis discards the settings currently saved for this capability.`,
    confirmLabel: 'Restore', danger: true,
  });
  if (!ok) return;
  if (scope.value === 'preset') { setPresetOverride(props.cap, undefined); return; }
  try { await save(await defaultConfigOf(props.cap)); toast.success('Default configuration restored.', { timeout: 2000 }); }
  catch (e) { toast.error("Couldn't read the plugin's default configuration.", { detail: (e as Error).message }); }
}

// ---- custom UI ----
const customHtml = ref<string | null>(null);
const customError = ref('');
const frame = ref<HTMLIFrameElement | null>(null);
const context = computed<ConfigContext>(() => ({ scope: scope.value, readOnly: false, hasPresetOverride: effective.value.hasPresetOverride }));
const srcdoc = ref('');

async function loadCustom(): Promise<void> {
  customHtml.value = null;
  customError.value = '';
  if (!props.cap.hasConfigUi) return;
  try {
    const html = await configUiOf(props.cap);
    customHtml.value = html || null;
    if (html) srcdoc.value = buildConfigDocument(html, shown.value, context.value);
  } catch (e) { customError.value = (e as Error).message; }
}
watch(() => [props.cap.pluginKey, props.cap.name], () => { scope.value = props.initialScope ?? 'global'; void loadCustom(); }, { immediate: true });
watch([shown, context], () => {
  frame.value?.contentWindow?.postMessage(JSON.parse(JSON.stringify({ __orca: 'config', config: shown.value ?? {}, context: context.value })), '*');
}, { deep: true });

function onMessage(e: MessageEvent): void {
  if (!frame.value || e.source !== frame.value.contentWindow) return;
  const m = e.data as { __orca?: string; config?: unknown };
  if (m?.__orca === 'save') void save(m.config ?? {});
  else if (m?.__orca === 'restore') void restore();
}
let obs: MutationObserver | null = null;
onMounted(() => {
  window.addEventListener('message', onMessage);
  obs = new MutationObserver(() => frame.value?.contentWindow?.postMessage({ __orca: 'theme', theme: themeSnapshot() }, '*'));
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
});
onBeforeUnmount(() => { window.removeEventListener('message', onMessage); obs?.disconnect(); });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <UButtonGroup v-if="canPreset" size="xs">
        <UButton label="Global" :variant="scope === 'global' ? 'solid' : 'outline'" @click="scope = 'global'" />
        <UButton label="Process preset" :variant="scope === 'preset' ? 'solid' : 'outline'" @click="scope = 'preset'" />
      </UButtonGroup>
      <span v-if="effective.hasPresetOverride" class="text-xs text-warning">The process preset overrides this configuration.</span>
      <span v-if="stale" class="text-xs text-dimmed">Saved by version {{ stale }}.</span>
      <span class="flex-1" />
      <UButton v-if="!customHtml" size="xs" variant="outline" icon="i-lucide-rotate-ccw" label="Restore defaults" @click="restore" />
    </div>
    <p v-if="customError" class="text-xs text-error">The custom configuration page failed: {{ customError }}</p>
    <iframe v-if="customHtml" ref="frame" class="cfg-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" :srcdoc="srcdoc"
            :title="`${cap.name} configuration`" data-testid="plugin-config-frame" />
    <template v-else>
      <UTextarea v-model="text" :rows="10" autoresize :maxrows="18" class="w-full font-mono" :ui="{ base: 'font-mono text-xs' }"
                 aria-label="Configuration (JSON)" data-testid="plugin-config-json" />
      <div class="flex items-center gap-2">
        <p class="flex-1 text-xs" :class="error ? 'text-error' : 'text-dimmed'">{{ error ? `Not valid JSON: ${error}` : 'JSON. The plugin reads it with get_config().' }}</p>
        <UButton size="sm" color="primary" label="Save" :disabled="!!error" data-testid="plugin-config-save" @click="saveText" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.cfg-frame { width: 100%; flex: 1 1 320px; min-height: 260px; border: 1px solid var(--ui-border); border-radius: 6px; background: var(--ui-bg); }
</style>

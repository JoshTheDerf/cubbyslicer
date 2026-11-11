<script setup lang="ts">
/**
 * The `slicing_pipeline_plugin` setting (Orca 2.5 gui type `plugin_picker`): the
 * slicing-pipeline capabilities this process preset runs, in order. Choices are
 * the loaded capabilities; selected ones that don't resolve stay listed with
 * what's wrong and what to do (the missing-plugin gate blocks slicing until then).
 * Changing it also rewrites the `plugins` manifest and prunes stale overrides.
 */
import { computed } from 'vue';
import { ensurePluginsReady } from '../index';
import { openPluginsDialog } from '../state';
import { loadedCapabilities, pluginState, setCapabilityEnabled, setPluginEnabled } from '../manager/store';
import { pipelineRefs, setPipelineSelection, type PipelineRef } from '../host/pipelineSelection';

defineProps<{ disabled?: boolean }>();

void ensurePluginsReady();

const refs = computed(() => { void pluginState.rows; void pluginState.configRevision; return pipelineRefs(); });
const selected = computed(() => refs.value.map((r) => r.name));
const choices = computed(() => {
  const loaded = loadedCapabilities('slicing-pipeline').map((c) => c.name);
  return [...new Set([...loaded, ...selected.value])];
});

function setSelected(v: string[] | undefined): void {
  // Keep the existing order and append new picks at the end (= run order).
  const want = new Set(v ?? []);
  setPipelineSelection([...selected.value.filter((n) => want.has(n)), ...[...want].filter((n) => !selected.value.includes(n))]);
}
function move(i: number, d: -1 | 1): void {
  const next = selected.value.slice();
  const j = i + d;
  if (j < 0 || j >= next.length) return;
  [next[i], next[j]] = [next[j], next[i]];
  setPipelineSelection(next);
}
function remove(name: string): void { setPipelineSelection(selected.value.filter((n) => n !== name)); }

async function fix(r: PipelineRef): Promise<void> {
  if (r.state === 'inactive' && r.pluginKey) {
    const row = pluginState.rows.find((x) => x.desc.pluginKey === r.pluginKey);
    if (row && row.status !== 'loaded') await setPluginEnabled(r.pluginKey, true);
    else await setCapabilityEnabled({ pluginKey: r.pluginKey, type: 'slicing-pipeline', name: r.name }, true);
    return;
  }
  openPluginsDialog();
}
const FIX_LABEL: Record<string, string> = { inactive: 'Activate', missing: 'Install…', broken: 'Plugins…' };
</script>

<template>
  <div class="pp" data-testid="plugin-picker">
    <USelectMenu :model-value="selected" :items="choices" multiple size="xs" class="w-full" :disabled="disabled"
                 :placeholder="choices.length ? 'None' : 'No slicing-pipeline plugins installed'" aria-label="Slicing pipeline plugins"
                 @update:model-value="(v: string[]) => setSelected(v)" />
    <div v-for="(r, i) in refs" :key="r.name" class="pp__row" :class="`pp__row--${r.state}`" :data-testid="`plugin-picker-${r.name}`">
      <span class="pp__n">{{ i + 1 }}</span>
      <span class="pp__name" :title="r.pluginName ? `${r.name} — ${r.pluginName}` : r.name">{{ r.name }}</span>
      <UButton v-if="refs.length > 1" size="xs" variant="ghost" icon="i-lucide-arrow-up" :disabled="disabled || i === 0" aria-label="Run earlier" @click="move(i, -1)" />
      <UButton v-if="refs.length > 1" size="xs" variant="ghost" icon="i-lucide-arrow-down" :disabled="disabled || i === refs.length - 1" aria-label="Run later" @click="move(i, 1)" />
      <UButton size="xs" variant="ghost" icon="i-lucide-x" :disabled="disabled" :aria-label="`Remove ${r.name}`" @click="remove(r.name)" />
      <p v-if="r.state !== 'ok'" class="pp__msg">
        {{ r.message }}
        <UButton v-if="FIX_LABEL[r.state]" size="xs" variant="link" :label="FIX_LABEL[r.state]" class="p-0" @click="fix(r)" />
      </p>
    </div>
  </div>
</template>

<style scoped>
.pp { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pp__row { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; font-size: 12px; }
.pp__n { width: 14px; color: var(--ui-text-dimmed); font-size: 10px; }
.pp__name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.pp__msg { flex-basis: 100%; margin: 0 0 2px 16px; font-size: 11px; color: var(--ui-error); }
.pp__row--loading .pp__msg { color: var(--ui-text-dimmed); }
.pp__row--missing .pp__name, .pp__row--broken .pp__name, .pp__row--inactive .pp__name { color: var(--ui-error); }
</style>

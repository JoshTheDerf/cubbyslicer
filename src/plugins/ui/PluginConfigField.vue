<script setup lang="ts">
/**
 * The "Plugin Configuration" group of the process settings (Orca 2.5 gui type
 * `plugin_config`, key `print_plugin_config_overrides`): one Configure button per
 * selected slicing-pipeline capability, opening its config in preset scope
 * (an override stored in this preset; "Restore defaults" drops it).
 */
import { computed, ref } from 'vue';
import AppDialog from '../../ui/AppDialog.vue';
import { capabilityConfig, pluginState, rowOf } from '../manager/store';
import { pipelineRefs } from '../host/pipelineSelection';
import PluginConfigEditor from './PluginConfigEditor.vue';
import type { LoadedCapability } from '../types';

defineProps<{ disabled?: boolean }>();

const caps = computed(() => {
  void pluginState.configRevision;
  return pipelineRefs().flatMap((r) => {
    if (r.state !== 'ok' || !r.pluginKey) return [];
    const c = rowOf(r.pluginKey)?.caps.find((x) => x.type === 'slicing-pipeline' && x.name === r.name);
    return c ? [{ cap: c, overridden: capabilityConfig(c).hasPresetOverride }] : [];
  });
});

const open = ref<LoadedCapability | null>(null);
const dialogOpen = computed({ get: () => !!open.value, set: (v: boolean) => { if (!v) open.value = null; } });
</script>

<template>
  <div class="pc" data-testid="plugin-config-field">
    <p v-if="!caps.length" class="pc__none">No slicing-pipeline plugin selected.</p>
    <div v-for="c in caps" :key="`${c.cap.pluginKey}/${c.cap.name}`" class="pc__row">
      <span class="pc__name">{{ c.cap.name }}</span>
      <UBadge v-if="c.overridden" size="sm" color="warning" variant="subtle" label="This preset" />
      <UButton size="xs" variant="outline" label="Configure…" :disabled="disabled" :data-testid="`plugin-configure-${c.cap.name}`" @click="open = c.cap" />
    </div>
    <AppDialog v-if="open" v-model:open="dialogOpen" :title="`${open.name} configuration`" description="Saved in this process preset (an override of the plugin's global configuration)."
               size="2xl" fullscreen body-class="flex min-h-[340px] flex-col">
      <PluginConfigEditor :cap="open" :plugin-version="rowOf(open.pluginKey)?.desc.version ?? ''" initial-scope="preset" />
    </AppDialog>
  </div>
</template>

<style scoped>
.pc { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pc__row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.pc__name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.pc__none { margin: 0; font-size: 12px; color: var(--ui-text-dimmed); }
</style>

<script setup lang="ts">
/**
 * Full Spectrum "Mixed filaments" (sidebar ▸ Filament): the engine's auto
 * pairs and the user's blends / gradients / patterns, each a virtual filament
 * numbered after the physical ones. Click one to edit it (MixedFilamentEditor);
 * the colour mixing settings (Local-Z, gradient cadence, surface) sit below.
 */
import { computed, ref } from 'vue';
import { currentPresets } from '../presets/store';
import MixedFilamentEditor from './MixedFilamentEditor.vue';
import MixedSettings from './MixedSettings.vue';
import { previewBackground } from './preview';
import { editMixedFilaments, filamentColourOf, mixedFilaments, mixedLabel, type MixedFilament } from './store';

const p = computed(() => currentPresets.value);
const physical = computed(() => p.value.selection.filaments.length);
const open = ref(true);
const settingsOpen = ref(false);
const editing = ref<MixedFilament | 'new' | null>(null);

const icon = (m: MixedFilament) => (m.kind === 'pattern' ? 'i-lucide-align-justify' : m.gradient.enabled ? 'i-lucide-blend' : 'i-lucide-pipette');
function remove(m: MixedFilament): void { void editMixedFilaments([{ op: 'remove', stableId: m.stableId }]); }
</script>

<template>
  <div class="mf">
    <div class="mf__head">
      <button type="button" class="mf__toggle" :aria-expanded="open" @click="open = !open">
        <UIcon :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5" />
        Mixed filaments <span class="text-dimmed">({{ mixedFilaments.length }})</span>
      </button>
      <span class="flex-1" />
      <UButton v-if="physical >= 2" size="xs" variant="ghost" icon="i-lucide-plus" label="Mix" aria-label="Add mixed filament" @click="editing = 'new'" />
    </div>
    <template v-if="open">
      <p v-if="physical < 2" class="mf__hint">Add a second filament to blend colours: Full Spectrum alternates thin layers of the physical filaments.</p>
      <div v-for="m in mixedFilaments" :key="m.stableId" class="mf__row">
        <span class="mf__no">{{ m.id }}</span>
        <button type="button" class="mf__main" :title="`Edit mixed filament ${m.id}`" @click="editing = m">
          <span class="mf__sw" :style="{ background: m.gradient.enabled || m.kind === 'pattern' ? previewBackground(m, filamentColourOf) : m.color }" />
          <span class="mf__lbl">
            <UIcon :name="icon(m)" class="size-3.5 shrink-0 text-dimmed" />
            <span class="truncate">{{ mixedLabel(m) }}</span><span v-if="!m.custom" class="text-dimmed shrink-0">· auto</span>
          </span>
        </button>
        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-x" square :aria-label="`Remove mixed filament ${m.id}`" @click="remove(m)" />
      </div>
      <button type="button" class="mf__toggle mf__toggle--sub" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen">
        <UIcon :name="settingsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5" />
        Colour mixing settings
      </button>
      <MixedSettings v-if="settingsOpen" />
    </template>
    <MixedFilamentEditor :target="editing" @close="editing = null" />
  </div>
</template>

<style scoped>
.mf { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; padding-top: 6px; border-top: 1px dashed var(--line); }
.mf__head { display: flex; align-items: center; gap: 4px; }
.mf__toggle { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); font-weight: 600; color: var(--fg-1); align-self: flex-start; }
.mf__toggle--sub { font-weight: 500; color: var(--fg-2); margin-top: 4px; }
.mf__hint { font-size: var(--fs-xs); color: var(--fg-2); }
.mf__row { display: flex; align-items: center; gap: 6px; }
.mf__no { width: 18px; text-align: right; font-size: var(--fs-xs); color: var(--fg-2); font-variant-numeric: tabular-nums; }
.mf__main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: var(--radius-sm); text-align: left; }
.mf__main:hover { background: var(--bg-3); }
.mf__sw { width: 18px; height: 18px; border-radius: 4px; border: 1px solid var(--line-strong); flex: none; }
.mf__lbl { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: var(--fs-xs); color: var(--fg-1); white-space: nowrap; }
</style>

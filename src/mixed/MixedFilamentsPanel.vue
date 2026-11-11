<script setup lang="ts">
/**
 * Orca's "Mixed Filament" sidebar section (Plater.cpp
 * update_mixed_filament_list): with 2+ physical filaments an "Add mixed
 * filament" button, then one row per mix (number + swatch, components with
 * their ratios or the gradient's direction) with edit / delete, and a warning
 * when a mix lost a component or mixes filament types.
 */
import { computed, ref, watch } from 'vue';
import { currentPresets } from '../presets/store';
import { mixedValidate } from '../engine/client';
import type { FlatConfig } from '../engine/types';
import MixedFilamentEditor from './MixedFilamentEditor.vue';
import { MIXED_SLOT_KEYS, swatchCss } from './model';
import {
  canAddMixed, filamentColourOf, mixedFilaments, mixedIssues, mixedLabel, removeAllMixedFilaments, removeMixedFilament, type MixedFilament,
} from './store';

const p = computed(() => currentPresets.value);
const physical = computed(() => p.value.selection.filaments.length);
const physicalColours = computed(() => p.value.physicalColours());
const issues = computed(() => new Map(mixedIssues.value.map((i) => [i.id, i.reason])));
const editing = ref<MixedFilament | 'new' | null>(null);

// The engine's own check of the mix keys (validate_mixed_filament_params): what would fail the slice.
const engineErrors = ref<string[]>([]);
watch(() => (mixedFilaments.value.length ? JSON.stringify(MIXED_SLOT_KEYS.map((k) => p.value.project[k] ?? null)) : ''), async (key) => {
  if (!key) { engineErrors.value = []; return; }
  const config = Object.fromEntries(MIXED_SLOT_KEYS.filter((k) => p.value.project[k] !== undefined).map((k) => [k, p.value.project[k]])) as FlatConfig;
  try { engineErrors.value = Object.values(await mixedValidate(config)); } catch { engineErrors.value = []; }
}, { immediate: true });

const tip = (m: MixedFilament) => {
  const comps = m.gradient && m.direction === 'ba' ? [...m.components].reverse() : m.components;
  return comps.map((c) => `Filament ${c || '(missing)'}`).join(m.gradient ? ' → ' : ' + ');
};
</script>

<template>
  <div v-if="physical >= 2 || mixedFilaments.length" class="mf">
    <UButton v-if="!mixedFilaments.length" block size="xs" variant="soft" color="neutral" icon="i-lucide-blend" label="Add mixed filament"
             :disabled="!canAddMixed" @click="editing = 'new'" />
    <template v-else>
      <div class="mf__head">
        <span class="mf__title">Mixed filament</span>
        <span class="flex-1" />
        <UButton size="xs" variant="ghost" icon="i-lucide-plus" square aria-label="Add mixed filament" title="Add mixed filament" :disabled="!canAddMixed" @click="editing = 'new'" />
        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-trash-2" square aria-label="Remove all mixed filaments" title="Remove all mixed filaments" @click="removeAllMixedFilaments()" />
      </div>
      <div v-for="m in mixedFilaments" :key="m.id" class="mf__row">
        <button type="button" class="mf__main" :title="`Edit mixed filament ${m.id}: ${tip(m)}`" @click="editing = m">
          <span class="mf__sw" :style="{ background: swatchCss(m, physicalColours) }">{{ m.id }}</span>
          <span class="mf__comps">
            <template v-for="(c, i) in (m.gradient && m.direction === 'ba' ? [...m.components].reverse() : m.components)" :key="i">
              <span v-if="i" class="text-dimmed">{{ m.gradient ? '→' : '+' }}</span>
              <span class="mf__chip" :style="{ background: c ? filamentColourOf(c) : 'transparent' }">{{ c || '—' }}</span>
              <span v-if="!m.gradient" class="mf__pct">{{ m.ratios[i] }}%</span>
            </template>
          </span>
          <UIcon v-if="issues.has(m.id)" name="i-lucide-triangle-alert" class="size-3.5 shrink-0 text-warning"
                 :title="issues.get(m.id) === 'missing' ? 'A component filament is missing: edit this mix.' : 'Components have different filament types.'" />
        </button>
        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-x" square :aria-label="`Remove mixed filament ${m.id} (${mixedLabel(m)})`" @click="removeMixedFilament(m.id)" />
      </div>
      <p v-if="issues.size" class="mf__warn">Mixed filament has invalid or mismatched components. Please re-edit affected entries.</p>
      <p v-for="(e, i) in engineErrors" :key="`e${i}`" class="mf__warn" data-testid="mixed-engine-error">{{ e }}</p>
    </template>
    <MixedFilamentEditor :target="editing" @close="editing = null" />
  </div>
</template>

<style scoped>
.mf { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; padding-top: 6px; border-top: 1px dashed var(--line); }
.mf__head { display: flex; align-items: center; gap: 4px; }
.mf__title { font-size: var(--fs-sm); font-weight: 600; color: var(--fg-1); }
.mf__row { display: flex; align-items: center; gap: 6px; }
.mf__main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: var(--radius-sm); text-align: left; }
.mf__main:hover { background: var(--bg-3); }
.mf__sw { width: 22px; height: 22px; border-radius: 4px; border: 1px solid var(--line-strong); flex: none; display: grid; place-items: center;
  font-size: var(--fs-xs); font-weight: 600; color: #fff; text-shadow: 0 0 2px #000; font-variant-numeric: tabular-nums; }
.mf__comps { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; font-size: var(--fs-xs); color: var(--fg-1); white-space: nowrap; }
.mf__chip { min-width: 18px; height: 18px; padding: 0 3px; border-radius: 3px; border: 1px solid var(--line-strong); display: grid; place-items: center;
  color: #fff; text-shadow: 0 0 2px #000; font-variant-numeric: tabular-nums; }
.mf__pct { color: var(--fg-2); font-variant-numeric: tabular-nums; }
.mf__warn { font-size: var(--fs-xs); color: var(--ui-warning); }
</style>

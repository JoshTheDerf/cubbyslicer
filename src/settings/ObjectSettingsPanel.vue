<script setup lang="ts">
/**
 * Per-object overrides of print-scope (process) options (Orca's "Objects"
 * mode): searchable "Add setting" picker + the overridden keys with the same
 * rows as the global settings. Values live in the project store (undoable)
 * via projectAdapter.
 */
import { computed, nextTick, ref } from 'vue';
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui';
import type { ConfigValue } from '../engine/types';
import { currentPresets } from '../presets/store';
import { normalizeValue, valuesEqual } from '../presets/values';
import SettingRow from './controls/SettingRow.vue';
import LayerRangeHeader from '../layers/LayerRangeHeader.vue';
import { HIDDEN_KEYS } from './layout/build';
import { getObjectOverrides, objectName, setObjectOverride } from './projectAdapter';
import { keyLocations, settingsLayout } from './useLayout';

const props = defineProps<{ objectId: string; partId?: string; rangeId?: string }>();

const p = computed(() => currentPresets.value);
const schema = computed(() => p.value.schema.value);
const overrides = computed(() => getObjectOverrides(props.objectId, props.partId, props.rangeId));
const set = (k: string, v: ConfigValue | undefined) => setObjectOverride(props.objectId, k, v, props.partId, props.rangeId);

/** Candidate keys: print / object scope (object first — those are per-object in the engine). */
const candidates = computed(() => {
  const s = schema.value;
  if (!s) return [] as string[];
  return Object.keys(s.options).filter((k) => {
    const d = s.options[k];
    return (d.scope === 'object' || d.scope === 'print') && !HIDDEN_KEYS.has(k) && !d.readonly && d.type !== 'none';
  });
});

const label = (k: string) => schema.value?.options[k]?.fullLabel || schema.value?.options[k]?.label || k;
function where(k: string): { page: string; group: string; order: string } {
  const l = keyLocations.value.get(k);
  const page = l && settingsLayout.value?.process.pages.find((pg) => pg.id === l.pageId);
  const g = page?.groups.find((gr) => gr.id === l?.groupId);
  const pi = page ? settingsLayout.value!.process.pages.indexOf(page) : 99;
  return { page: page?.title ?? (schema.value?.options[k]?.category || 'Other'), group: g?.title ?? '', order: `${String(pi).padStart(2, '0')}|${l?.groupId ?? ''}` };
}
const keys = computed(() => Object.keys(overrides.value).sort((a, b) => where(a).order.localeCompare(where(b).order)));

// ---- picker ---------------------------------------------------------------------------
const picking = ref(false);
interface Pick extends CommandPaletteItem { key: string }
const pickGroups = computed<CommandPaletteGroup<Pick>[]>(() => {
  if (!picking.value) return [];
  const by = new Map<string, { order: string; items: Pick[] }>();
  for (const k of candidates.value) {
    if (k in overrides.value) continue;
    const w = where(k);
    let g = by.get(w.page);
    if (!g) by.set(w.page, (g = { order: w.order, items: [] }));
    const d = schema.value!.options[k];
    g.items.push({ key: k, label: label(k), suffix: w.group, keywords: `${k} ${d.tooltip ?? ''}`.slice(0, 200) } as Pick);
  }
  return [...by.entries()].sort((a, b) => a[1].order.localeCompare(b[1].order))
    .map(([page, g]) => ({ id: page, label: page, items: g.items }));
});
const fuse = { fuseOptions: { keys: ['label', 'suffix', 'keywords'], threshold: 0.3 }, resultLimit: 60 };

function add(item: unknown): void {
  const k = (item as Pick | null)?.key;
  if (!k) return;
  const v = p.value.value('process', k);
  if (v !== undefined) set(k, Array.isArray(v) ? v.slice() : v);
  picking.value = false;
  nextTick(() => document.querySelector<HTMLElement>(`.osp [data-key="${CSS.escape(k)}"] input, .osp [data-key="${CSS.escape(k)}"] button[role="combobox"]`)?.focus());
}

function change(k: string, v: ConfigValue): void {
  set(k, normalizeValue(schema.value?.options[k], v));
}
const processValue = (k: string) => p.value.value('process', k);
const differs = (k: string) => !valuesEqual(overrides.value[k], processValue(k));
</script>

<template>
  <div class="osp" data-settings-scope="object">
    <header class="osp__head">
      <UIcon :name="rangeId ? 'i-lucide-between-horizontal-start' : 'i-lucide-box'" class="size-4 flex-none text-primary" />
      <span class="osp__title">{{ objectName(objectId, partId, rangeId) || 'Object' }}</span>
      <UBadge v-if="keys.length" size="sm" variant="subtle" color="warning" :label="`${keys.length} override${keys.length > 1 ? 's' : ''}`" />
      <UPopover v-model:open="picking" :content="{ side: 'bottom', align: 'end' }">
        <UButton size="xs" variant="soft" color="primary" icon="i-lucide-plus" label="Add setting" :disabled="!schema" />
        <template #content>
          <UCommandPalette :groups="pickGroups" :fuse="fuse" placeholder="Search process settings…" autofocus class="h-80 w-[min(22rem,90vw)]"
                           @update:model-value="add" />
        </template>
      </UPopover>
    </header>

    <LayerRangeHeader v-if="rangeId" :object-id="objectId" :range-id="rangeId" />
    <p v-if="!keys.length" class="osp__empty">No per-object overrides — this object uses the process preset. Add a setting to change it for this object only.</p>
    <div v-if="schema" class="osp__rows">
      <template v-for="k in keys" :key="k">
        <SettingRow v-if="schema.options[k]" :opt-key="k" :def="schema.options[k]" :value="overrides[k]" :preset-value="processValue(k)"
                    :modified="differs(k)" revert-to="Process" removable
                    @change="(v) => change(k, v)" @revert="change(k, processValue(k) ?? '')" @remove="set(k, undefined)" />
        <div v-else class="osp__unknown">
          <code>{{ k }}</code> = {{ overrides[k] }} <small>(not an option of this engine)</small>
          <UButton size="xs" variant="ghost" label="Remove" @click="set(k, undefined)" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.osp { display: flex; flex-direction: column; gap: 4px; }
.osp__head { display: flex; align-items: center; gap: 6px; padding: 6px 6px 4px; border-bottom: 1px solid var(--ui-border); }
.osp__title { flex: 1; min-width: 0; font-weight: 600; font-size: 12px; color: var(--ui-text-highlighted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.osp__empty { color: var(--ui-text-dimmed); font-size: 12px; padding: 6px; margin: 0; }
.osp__rows { display: flex; flex-direction: column; }
.osp__unknown { font-size: 11px; color: var(--ui-text-toned); padding: 4px; display: flex; align-items: center; gap: 6px; }
</style>

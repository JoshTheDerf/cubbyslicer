<script setup lang="ts">
/**
 * The option groups of one settings page (Orca's option groups): collapsible
 * headings with Orca-style rows. Only the current page is rendered, and a
 * group's rows mount when they scroll near the viewport (LazyMount), so ~700
 * options stay snappy. (A plain v-if collapsible rather than UCollapsible:
 * its content measures itself with getBoundingClientRect on mount — one
 * forced layout per group.)
 */
import { computed } from 'vue';
import type { ConfigValue } from '../engine/types';
import { currentPresets } from '../presets/store';
import type { PresetKind } from '../presets/types';
import { asArray } from '../presets/values';
import SettingRow from './controls/SettingRow.vue';
import LazyMount from './LazyMount.vue';
import type { BuiltPage } from './layout/types';
import { isVisible, MODE_LABELS } from './useLayout';
import { settingsUi, toggleGroup } from './uiState';

const props = defineProps<{ kind: PresetKind; page: BuiltPage | null; slotIndex?: number }>();

const p = computed(() => currentPresets.value);
const schema = computed(() => p.value.schema.value);
const idx = computed(() => (props.kind === 'filament' ? Math.min(props.slotIndex ?? 0, p.value.selection.filaments.length - 1) : 0));

const groups = computed(() => (props.page?.groups ?? [])
  .map((g) => ({ ...g, visibleKeys: g.keys.filter((k) => isVisible(k, props.kind, idx.value)) }))
  .filter((g) => g.visibleKeys.length));
const hidden = computed(() => (props.page?.groups ?? []).reduce((n, g) => n + g.keys.filter((k) => !isVisible(k, props.kind, idx.value)).length, 0));
const nextMode = computed(() => (settingsUi.mode === 'simple' ? 'advanced' : 'expert'));

const isOpen = (id: string) => !settingsUi.collapsedGroups.includes(id);
const rowValue = (key: string) => p.value.value(props.kind, key, idx.value);
const rowPreset = (key: string) => p.value.presetValue(props.kind, key, idx.value);
const rowModified = (key: string) => p.value.isModified(props.kind, key, idx.value);
function onChange(key: string, v: ConfigValue): void { p.value.setValue(props.kind, key, v, idx.value); }
function onRevert(key: string): void { p.value.revert(props.kind, key, idx.value); }
/** Filament `filament_<key>` overrides fall back to the printer's `<key>` for the extruder. */
function nullFallback(key: string): string | undefined {
  const def = schema.value?.options[key];
  if (!def?.nullable || !key.startsWith('filament_')) return undefined;
  const raw = key.slice('filament_'.length);
  if (!schema.value?.options[raw]) return undefined;
  const v = asArray(p.value.value('printer', raw));
  return v[idx.value] ?? v[0];
}
const modifiedIn = (keys: string[]) => keys.reduce((n, k) => n + (rowModified(k) ? 1 : 0), 0);
</script>

<template>
  <div class="sg">
    <div v-if="!schema" class="sg__empty">{{ p.loading.value ? 'Loading settings…' : 'Settings unavailable.' }}</div>
    <section v-for="(g, gi) in groups" :key="g.id" class="sg__group" :class="{ 'sg__group--auto': g.auto }">
      <button type="button" class="sg__head" :aria-expanded="isOpen(g.id)" @click="toggleGroup(g.id)">
        <UIcon name="i-lucide-chevron-down" class="sg__chev" :class="{ 'sg__chev--closed': !isOpen(g.id) }" />
        <span class="sg__title">{{ g.title || page?.title }}</span>
        <span v-if="modifiedIn(g.visibleKeys)" class="sg__mod" :title="`${modifiedIn(g.visibleKeys)} modified`" />
        <span class="sg__count">{{ g.visibleKeys.length }}</span>
      </button>
      <LazyMount v-if="isOpen(g.id)" :key="`${page?.id}:${g.id}`" class="sg__rows" :estimate="g.visibleKeys.length * 30 + 8"
                 :eager="gi < 2 || (!!settingsUi.highlightKey && g.visibleKeys.includes(settingsUi.highlightKey))">
        <SettingRow v-for="k in g.visibleKeys" :key="`${g.id}:${k}`" :opt-key="k" :def="schema!.options[k]"
                    :value="rowValue(k)" :preset-value="rowPreset(k)" :modified="rowModified(k)"
                    :element-index="page?.extruder" :highlighted="settingsUi.highlightKey === k" :null-fallback="nullFallback(k)"
                    @change="(v) => onChange(k, v)" @revert="onRevert(k)" />
      </LazyMount>
    </section>
    <p v-if="hidden && schema" class="sg__more">
      {{ hidden }} more setting{{ hidden > 1 ? 's' : '' }} on this page in
      <UButton variant="link" size="xs" class="p-0" :label="`${MODE_LABELS[nextMode]} mode`" @click="settingsUi.mode = nextMode" />
    </p>
  </div>
</template>

<style scoped>
.sg { display: flex; flex-direction: column; gap: 2px; }
.sg__head {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 6px 4px 4px; border: 0; background: none; cursor: pointer; text-align: left;
  color: var(--ui-text-highlighted); font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--ui-border);
}
.sg__group--auto .sg__head { color: var(--ui-text-toned); }
.sg__head:hover { color: var(--ui-primary); }
.sg__chev { width: 14px; height: 14px; color: var(--ui-text-dimmed); transition: transform .12s; flex: none; }
.sg__chev--closed { transform: rotate(-90deg); }
.sg__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg__mod { width: 6px; height: 6px; border-radius: 50%; background: var(--modified); flex: none; }
.sg__count { color: var(--ui-text-dimmed); font-weight: 400; font-size: 11px; }
.sg__rows { display: flex; flex-direction: column; padding: 2px 0 6px; }
.sg__rows > :deep(*) { flex: none; }
.sg__empty { color: var(--ui-text-dimmed); padding: 24px; text-align: center; }
.sg__more { color: var(--ui-text-dimmed); font-size: 11px; padding: 8px 6px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
</style>

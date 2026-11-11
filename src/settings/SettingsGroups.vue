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
import { asList, SCALAR, toNumber, valueAt } from '../lib/configValue';
import { variantEdit } from '../presets/variantEdit';
import { variantKey } from '../presets/variants';
import SettingRow from './controls/SettingRow.vue';
import ImexModesEditor from '../plates/ImexModesEditor.vue';
import { IMEX_LAYOUTS } from '../plates/imexModes';
import { resetPlatesImexMode } from '../plates/store';
import VariantSwitch from '../presets/ui/VariantSwitch.vue';
import LazyMount from './LazyMount.vue';
import type { BuiltPage } from './layout/types';
import { isVisible, MODE_LABELS } from './useLayout';
import { narrowedDef, ruleContext, rowStates, setWithCoupled } from './useRules';
import { settingsUi, toggleGroup } from './uiState';

const props = defineProps<{ kind: PresetKind; page: BuiltPage | null; slotIndex?: number }>();

const p = computed(() => currentPresets.value);
const schema = computed(() => p.value.schema.value);
const idx = computed(() => (props.kind === 'filament' ? Math.min(props.slotIndex ?? 0, p.value.selection.filaments.length - 1) : 0));
/** The per-extruder page edits the extruder chosen on its switch (Orca 2.5's single Extruder page). */
const pageExtruder = computed(() => (props.page?.perExtruder ? Math.min(variantEdit.extruder, Math.max(0, asList(p.value.value('printer', 'nozzle_diameter')).length - 1)) : undefined));

/** Enable / show rules (Orca ConfigManipulation): per page extruder on the printer's extruder pages. */
const states = computed(() => rowStates(props.kind, idx.value, pageExtruder.value));
/** Hidden by a rule (a search jump still shows it, with the reason). */
const ruleHidden = (k: string) => !!states.value.get(k)?.hidden && settingsUi.highlightKey !== k;
const groups = computed(() => (props.page?.groups ?? [])
  .map((g) => ({ ...g, visibleKeys: g.keys.filter((k) => !ruleHidden(k) && isVisible(k, props.kind, idx.value)) }))
  .filter((g) => g.visibleKeys.length));
/** Rows the mode filter hides (rule-hidden rows don't count: switching mode wouldn't show them). */
const hidden = computed(() => (props.page?.groups ?? []).reduce((n, g) => n + g.keys.filter((k) => !ruleHidden(k) && !isVisible(k, props.kind, idx.value)).length, 0));
function rowDef(k: string) {
  const def = schema.value!.options[k];
  if (!def.enumValues?.length) return def;
  const cur = rowValue(k);
  return narrowedDef(props.kind, k, def, ruleContext(props.kind, idx.value, pageExtruder.value), valueAt(cur, rowElement(k) ?? SCALAR) ?? '');
}
const nextMode = computed(() => (settingsUi.mode === 'simple' ? 'advanced' : 'expert'));

const isOpen = (id: string) => !settingsUi.collapsedGroups.includes(id);
const rowValue = (key: string) => p.value.value(props.kind, key, idx.value);
const rowPreset = (key: string) => p.value.presetValue(props.kind, key, idx.value);
/** Per-variant keys (Orca 2.5): the element of the variant being edited (presets/variantEdit.ts); others: the page's extruder. */
const variantEl = (key: string) => p.value.variantElement(props.kind, key, idx.value, pageExtruder.value);
const rowElement = (key: string) => variantEl(key) ?? pageExtruder.value;
/** Machine limits keep a normal / silent pair per variant column. */
const rowStride = (key: string) => (variantEl(key) === undefined ? 1 : variantKey(schema.value, key)?.stride ?? 1);
const rowModified = (key: string) => p.value.isModified(props.kind, key, idx.value, variantEl(key));
function onChange(key: string, v: ConfigValue): void {
  const el = variantEl(key);
  let next = v;
  if (el !== undefined && Array.isArray(v)) {
    const vec = p.value.variantVector(props.kind, key, idx.value, el, v[el] ?? v[0] ?? '');
    for (let s = 1; s < rowStride(key); s++) if (v[el + s] !== undefined) vec[el + s] = v[el + s];
    next = vec;
  }
  setWithCoupled(props.kind, key, next, idx.value, el ?? pageExtruder.value ?? 0);
}
function onRevert(key: string): void {
  const el = variantEl(key);
  if (el === undefined) p.value.revert(props.kind, key, idx.value); else p.value.revertVariantElement(props.kind, key, idx.value, el);
}
const showVariantSwitch = computed(() => (props.kind === 'printer' && !!props.page?.perExtruder)
  || groups.value.some((g) => g.visibleKeys.some((k) => variantEl(k) !== undefined)));
/** Filament `filament_<key>` overrides fall back to the printer's `<key>` for the extruder. */
function nullFallback(key: string): string | undefined {
  const def = schema.value?.options[key];
  if (!def?.nullable || !key.startsWith('filament_')) return undefined;
  const raw = key.slice('filament_'.length);
  if (!schema.value?.options[raw]) return undefined;
  const v = asList(p.value.value('printer', raw));
  return v[idx.value] ?? v[0];
}
// Orca 2.5 IDEX/IQEX Modes grid: the three mode lists edited together; the grid follows the gantry setup.
const imexGrid = computed(() => ({
  cols: Math.max(1, Math.round(toNumber(valueAt(rowValue('imex_tools_per_gantry'), SCALAR), 2)) || 1),
  rows: Math.max(1, Math.round(toNumber(valueAt(rowValue('imex_gantry_count'), SCALAR), 1)) || 1),
  layout: Math.max(0, IMEX_LAYOUTS.indexOf(valueAt(rowValue('imex_tool_layout'), SCALAR) ?? 'front-left')),
}));
const imexSaved = computed(() => ({ names: asList(rowPreset('imex_mode_names')), tools: asList(rowPreset('imex_mode_active_tools')), gcodes: asList(rowPreset('imex_mode_gcodes')) }));
function onImexModes(v: { names: string[]; tools: string[]; gcodes: string[] }): void {
  onChange('imex_mode_names', v.names);
  onChange('imex_mode_active_tools', v.tools);
  onChange('imex_mode_gcodes', v.gcodes);
}
function onImexRemoved(names: string[]): void { resetPlatesImexMode(names); }
const modifiedIn = (keys: string[]) => keys.reduce((n, k) => n + (rowModified(k) ? 1 : 0), 0);
</script>

<template>
  <div class="sg">
    <VariantSwitch v-if="showVariantSwitch" :kind="kind" :index="idx" />
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
        <template v-for="k in g.visibleKeys" :key="`${g.id}:${k}`">
        <div v-if="k === 'imex_mode_names' && kind === 'printer'" class="sg__wide">
          <div class="sg__wide-label">Modes</div>
          <ImexModesEditor :names="asList(rowValue('imex_mode_names'))" :tools="asList(rowValue('imex_mode_active_tools'))" :gcodes="asList(rowValue('imex_mode_gcodes'))"
                           :saved="imexSaved" :grid="imexGrid" :disabled="states.get(k)?.disabled" @change="onImexModes" @removed="onImexRemoved" />
        </div>
        <SettingRow v-else :opt-key="k" :def="rowDef(k)"
                    :value="rowValue(k)" :preset-value="rowPreset(k)" :modified="rowModified(k)"
                    :disabled="states.get(k)?.disabled" :hidden-by-rule="states.get(k)?.hidden" :reason="states.get(k)?.reason" :label-override="states.get(k)?.label"
                    :element-index="rowElement(k)" :element-stride="rowStride(k)" :per-variant="variantEl(k) !== undefined" :highlighted="settingsUi.highlightKey === k" :null-fallback="nullFallback(k)"
                    @change="(v) => onChange(k, v)" @revert="onRevert(k)" />
        </template>
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
.sg__wide { padding: 4px 6px 2px 10px; }
.sg__wide-label { font-size: 12px; color: var(--ui-text-muted); padding-bottom: 2px; }
.sg__more { color: var(--ui-text-dimmed); font-size: 11px; padding: 8px 6px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
</style>

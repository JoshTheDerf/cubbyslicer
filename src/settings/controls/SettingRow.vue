<script setup lang="ts">
/**
 * One setting, Orca style: label left (tooltip with description, key,
 * default, range), control(s) right with the unit side text, orange label +
 * revert icon when modified, validation message. Vector options render one
 * control per element — or only element `elementIndex` on per-extruder pages.
 */
import { offerBedExcludeVolumes } from '../applyAutoChanges';
import { computed, defineAsyncComponent, ref } from 'vue';
import type { ConfigOptionDef, ConfigValue } from '../../engine/types';
import { isVectorType, joinVector, splitVector } from '../../presets/values';
import { validateValue } from '../validate';
import ScalarControl from './ScalarControl.vue';
import { openDialog } from '../../dialogs/state';
import { shapeRequest, volumesRequest } from '../../dialogs/bed/request';
import { currentPresets } from '../../presets/store';
import { asList, SCALAR, toNumber, valueAt } from '../../lib/configValue';
// Orca 2.5 plugin-backed options (gui types plugin_picker / plugin_config): editors from src/plugins, loaded on demand.
const PluginPicker = defineAsyncComponent(() => import('../../plugins/ui/PluginPicker.vue'));
const PluginConfigField = defineAsyncComponent(() => import('../../plugins/ui/PluginConfigField.vue'));

const props = defineProps<{
  optKey: string;
  def: ConfigOptionDef;
  value: ConfigValue | undefined;
  presetValue?: ConfigValue;
  modified?: boolean;
  elementIndex?: number;
  /** Elements per variant column at `elementIndex` (2: machine limits' normal / silent pair). */
  elementStride?: number;
  /** One value per nozzle variant (Orca 2.5): the row edits the column chosen on the page's switch. */
  perVariant?: boolean;
  highlighted?: boolean;
  disabled?: boolean;
  /** Hidden by a rule but shown anyway (a search jump): drawn dimmed with the reason. */
  hiddenByRule?: boolean;
  /** Why the row is disabled / hidden (Orca's "Disabled: …" / "Hidden: …"). */
  reason?: string;
  /** Label set by a rule (Orca set_option_label). */
  labelOverride?: string;
  /** Label for the revert action ("preset" / "process"). */
  revertTo?: string;
  removable?: boolean;
  /** Nullable options: value shown / used when enabling an override that is currently `nil`. */
  nullFallback?: string;
}>();
const emit = defineEmits<{ (e: 'change', v: ConfigValue): void; (e: 'revert'): void; (e: 'remove'): void }>();

/** Point-list options edited in the bed shape dialog (the printable area itself opens the full bed dialog). */
const SHAPE_KEYS = new Set(['printable_area', 'bed_shape', 'bed_exclude_area', 'wrapping_exclude_area', 'parallel_printheads_bed_exclude_areas']);
/** Toolhead collision volume strings (Orca 2.5). */
const VOLUME_KEYS = new Set(['bed_exclude_volumes', 'extruder_bed_exclude_volumes']);
const vector = computed(() => isVectorType(props.def.type));
const arr = computed(() => asList(props.value));
const label = computed(() => props.labelOverride || props.def.label || props.def.fullLabel || props.optKey);
const stateText = computed(() => (props.hiddenByRule ? `Hidden: ${props.reason || 'not used with the current settings.'}` : props.disabled && props.reason ? `Disabled: ${props.reason}` : ''));
const multiline = computed(() => (props.def.multiline || /gcode$/.test(props.optKey)) && (props.def.type === 'string' || props.def.type === 'strings'));

const mode = computed<'scalar' | 'element' | 'points' | 'lines' | 'list'>(() => {
  if (!vector.value) return 'scalar';
  if (props.def.type === 'points') return 'points';
  if (props.elementIndex !== undefined) return 'element';
  if (props.def.type === 'strings' && !multiline.value && !props.def.guiType && (props.optKey.startsWith('compatible_') || arr.value.length > 2)) return 'lines';
  if (arr.value.length <= 1) return 'element';
  return 'list';
});
const full = computed(() => multiline.value || mode.value === 'lines');
const elIdx = computed(() => props.elementIndex ?? 0);

function elementLabels(n: number): string[] {
  if (/^machine_(max|min)_/.test(props.optKey) && n === 2) return ['Normal', 'Silent'];
  return Array.from({ length: n }, (_, i) => `#${i + 1}`);
}

function setElement(i: number, v: string): void {
  const next = arr.value.slice();
  while (next.length <= i) next.push(next[next.length - 1] ?? '');
  next[i] = v;
  emit('change', next);
}

const scalarValue = computed(() => valueAt(props.value, SCALAR) ?? '');
const current = computed(() => (mode.value === 'element' ? arr.value[elIdx.value] ?? arr.value[0] ?? '' : scalarValue.value));
const nullable = computed(() => !!props.def.nullable && (mode.value === 'scalar' || mode.value === 'element'));
const isNil = computed(() => nullable.value && current.value === 'nil');
function setNullable(on: boolean): void {
  const v = on ? (props.nullFallback && props.nullFallback !== 'nil' ? props.nullFallback : (props.def.default.split(',')[0] || '0').replace(/^nil$/, '0')) : 'nil';
  if (mode.value === 'element') setElement(elIdx.value, v); else emit('change', v);
}

const linesDraft = ref<string | null>(null);
const linesText = computed(() => linesDraft.value ?? arr.value.join('\n'));
function commitLines(): void {
  if (linesDraft.value === null) return;
  emit('change', linesDraft.value.split('\n').map((s) => s.trim()).filter(Boolean));
  linesDraft.value = null;
}
const pointsDraft = ref<string | null>(null);
const pointsText = computed(() => pointsDraft.value ?? joinVector('points', arr.value));
function commitPoints(): void {
  if (pointsDraft.value === null) return;
  // Collision-volume syntax in the excluded area is offered to the collision volumes instead (Orca 2.5).
  if (props.optKey === 'bed_exclude_area' && offerBedExcludeVolumes(pointsDraft.value)) {
    pointsDraft.value = null;
    return;
  }
  emit('change', splitVector('points', pointsDraft.value));
  pointsDraft.value = null;
}
const tip = ref(false);

async function editShape(): Promise<void> {
  if (props.optKey === 'printable_area' || props.optKey === 'bed_shape') { openDialog('bedShape'); return; }
  const pts = await shapeRequest.ask({ title: label.value, points: arr.value, allowEmpty: true });
  if (pts) emit('change', pts);
}
const isVolumes = computed(() => VOLUME_KEYS.has(props.optKey) && (mode.value === 'scalar' || mode.value === 'element'));
async function editVolumes(): Promise<void> {
  const p = currentPresets.value;
  const value = mode.value === 'element' ? arr.value[elIdx.value] ?? '' : scalarValue.value;
  const next = await volumesRequest.ask({
    title: label.value, value,
    printableHeight: toNumber(valueAt(p.value('printer', 'printable_height'), SCALAR), 0),
    bed: asList(p.value('printer', 'printable_area')),
  });
  if (next === null) return;
  if (mode.value === 'element') setElement(elIdx.value, next); else emit('change', next);
}

const problems = computed(() => {
  const all = validateValue(props.def, props.value);
  if (props.elementIndex !== undefined) return all.filter((p) => p.index === undefined || p.index === props.elementIndex);
  return all;
});

const fmt = (v: ConfigValue | undefined) => (v === undefined ? '—' : Array.isArray(v) ? (v.length ? v.join(', ') : '(empty)') : v === '' ? '(empty)' : v);
const shortFmt = (v: ConfigValue | undefined) => { const s = fmt(v); return s.length > 120 ? `${s.slice(0, 117)}…` : s; };
const hasRange = computed(() => (props.def.min !== null && props.def.min !== undefined) || (props.def.max !== null && props.def.max !== undefined));
</script>

<template>
  <div class="row" :class="{ 'row--mod': modified, 'row--hl': highlighted, 'row--bad': problems.length > 0, 'row--full': full, 'row--off': disabled || hiddenByRule }" :data-key="optKey">
    <UButton v-if="modified" class="row__rev" size="xs" variant="ghost" color="warning" icon="i-lucide-undo-2" square
             :aria-label="`Revert ${label}`" :title="`Revert to the ${revertTo || 'preset'} value (${shortFmt(presetValue)})`" @click="emit('revert')" />
    <span v-else class="row__rev" />

    <!-- The tooltip is mounted on first hover: ~700 eager UTooltips double a page's render time. -->
    <span v-if="!tip" class="row__lbl" @pointerenter="tip = true" @focusin="tip = true">
      <span class="row__text">{{ label }}</span>
      <span v-if="def.mode === 'expert'" class="row__mode" title="Expert setting">E</span>
      <UIcon v-if="perVariant" name="i-lucide-split" class="row__var" />
    </span>
    <UTooltip v-else :delay-duration="450" :content="{ side: 'top', align: 'start' }" :ui="{ content: 'h-auto max-w-80 flex-col items-start gap-1 py-2 px-2.5' }">
      <span class="row__lbl">
        <span class="row__text">{{ label }}</span>
        <span v-if="def.mode === 'expert'" class="row__mode" title="Expert setting">E</span>
        <UIcon v-if="perVariant" name="i-lucide-split" class="row__var" />
      </span>
      <template #content>
        <strong class="text-xs text-highlighted">{{ def.fullLabel || label }}</strong>
        <span v-if="def.tooltip" class="whitespace-pre-wrap text-xs leading-snug text-muted">{{ def.tooltip }}</span>
        <span v-if="perVariant" class="text-xs leading-snug text-muted">One value per nozzle: this edits the one chosen at the top of the page.</span>
        <span v-if="stateText" class="text-xs leading-snug text-warning">{{ stateText }}</span>
        <dl class="row__dl">
          <dt>Key</dt><dd class="font-mono">{{ optKey }}</dd>
          <dt>Default</dt><dd class="font-mono">{{ shortFmt(def.default === '' ? '(empty)' : def.default) }}{{ def.sidetext ? ` ${def.sidetext}` : '' }}</dd>
          <template v-if="modified"><dt>{{ revertTo || 'Preset' }}</dt><dd class="font-mono">{{ shortFmt(presetValue) }}</dd></template>
          <template v-if="hasRange"><dt>Range</dt><dd class="font-mono">{{ def.min ?? '−∞' }} … {{ def.max ?? '∞' }}</dd></template>
        </dl>
      </template>
    </UTooltip>

    <div class="row__ctl" :class="{ 'row__ctl--null': nullable }">
      <UCheckbox v-if="nullable" :model-value="!isNil" :disabled="disabled" size="sm" aria-label="Override"
                 :title="isNil ? 'Not overridden — the printer value is used. Tick to override.' : 'Overrides the printer value. Untick to use the printer value.'"
                 @update:model-value="(v: boolean | 'indeterminate') => setNullable(v === true)" />
      <div v-if="isNil" class="row__nil">{{ nullFallback && nullFallback !== 'nil' ? nullFallback : '—' }} <small>{{ def.sidetext }} (printer)</small></div>
      <div v-else-if="isVolumes" class="row__pts">
        <UInput :model-value="mode === 'element' ? arr[elIdx] ?? '' : scalarValue" size="xs" class="min-w-0 flex-1" :ui="{ base: 'font-mono text-[11px]' }" spellcheck="false"
                :disabled="disabled" :aria-label="label" placeholder="None" @change="(e: Event) => (mode === 'element' ? setElement(elIdx, (e.target as HTMLInputElement).value) : emit('change', (e.target as HTMLInputElement).value))" />
        <UButton size="xs" variant="outline" label="Edit…" :disabled="disabled" @click="editVolumes" />
      </div>
      <PluginPicker v-else-if="def.guiType === 'plugin_picker'" :disabled="disabled" />
      <PluginConfigField v-else-if="def.guiType === 'plugin_config'" :disabled="disabled" />
      <ScalarControl v-else-if="mode === 'scalar'" :def="def" :opt-key="optKey" :model-value="scalarValue" :disabled="disabled" :aria-label="label"
                     @update:model-value="(v: string) => emit('change', v)" />
      <div v-else-if="mode === 'element' && (elementStride ?? 1) > 1" class="row__list">
        <label v-for="s in (elementStride ?? 1)" :key="s" class="row__el">
          <span class="row__elabel">{{ s === 1 ? 'Normal' : s === 2 ? 'Silent' : `#${s}` }}</span>
          <ScalarControl :def="def" :opt-key="`${optKey}-${s}`" :model-value="arr[elIdx + s - 1] ?? arr[0] ?? ''" compact :disabled="disabled" :aria-label="`${label} ${s === 1 ? 'normal' : 'silent'}`"
                         @update:model-value="(v: string) => setElement(elIdx + s - 1, v)" />
        </label>
      </div>
      <ScalarControl v-else-if="mode === 'element'" :def="def" :opt-key="optKey" :model-value="arr[elIdx] ?? arr[0] ?? ''" :disabled="disabled" :aria-label="label"
                     @update:model-value="(v: string) => setElement(elIdx, v)" />
      <div v-else-if="mode === 'list'" class="row__list">
        <label v-for="(el, i) in arr" :key="i" class="row__el">
          <span class="row__elabel">{{ elementLabels(arr.length)[i] }}</span>
          <ScalarControl :def="def" :opt-key="`${optKey}-${i}`" :model-value="el" compact :disabled="disabled" :aria-label="`${label} ${elementLabels(arr.length)[i]}`"
                         @update:model-value="(v: string) => setElement(i, v)" />
        </label>
      </div>
      <UTextarea v-else-if="mode === 'lines'" :model-value="linesText" :rows="3" autoresize :maxrows="10" size="xs" spellcheck="false" :disabled="disabled"
                 placeholder="One entry per line" class="w-full" :ui="{ base: 'font-mono text-[11px]' }"
                 @update:model-value="(v: string) => (linesDraft = String(v))" @blur="commitLines" />
      <div v-else class="row__pts">
        <UInput :model-value="pointsText" size="xs" class="min-w-0 flex-1" :ui="{ base: 'font-mono text-[11px]' }" spellcheck="false" :disabled="disabled" :aria-label="label"
                @update:model-value="(v: string | number) => (pointsDraft = String(v))" @blur="commitPoints" @keydown.enter.prevent="commitPoints" />
        <UButton v-if="SHAPE_KEYS.has(optKey)" size="xs" variant="outline" label="Edit…" :disabled="disabled" @click="editShape" />
      </div>
      <p v-if="stateText && (hiddenByRule || highlighted)" class="row__why">{{ stateText }}</p>
      <p v-for="(pr, i) in problems" :key="i" class="row__err">{{ pr.index !== undefined && mode === 'list' ? `${elementLabels(arr.length)[pr.index]}: ` : '' }}{{ pr.message }}</p>
    </div>

    <UButton v-if="removable" class="row__x" size="xs" variant="ghost" icon="i-lucide-x" square aria-label="Remove override" title="Remove override" @click="emit('remove')" />
  </div>
</template>

<style scoped>
.row {
  display: grid; grid-template-columns: 20px minmax(0, 1fr) minmax(0, 50%); align-items: start; column-gap: 4px;
  padding: 2px 6px 2px 2px; border-radius: var(--ui-radius); position: relative; min-height: 28px;
}
.row:has(.row__x) { grid-template-columns: 20px minmax(0, 1fr) minmax(0, 50%) 22px; }
.row:hover { background: color-mix(in srgb, var(--ui-bg-elevated) 70%, transparent); }
.row--full { grid-template-columns: 20px minmax(0, 1fr); }
.row--full .row__ctl { grid-column: 2 / -1; }
.row--hl { animation: flash 1.6s ease-out; }
@keyframes flash { 0%, 30% { background: color-mix(in srgb, var(--ui-info) 30%, transparent); } 100% { background: transparent; } }
.row__rev { width: 20px; height: 24px; display: inline-flex; align-items: center; justify-content: center; }
.row__lbl { display: flex; align-items: center; gap: 4px; min-height: 24px; min-width: 0; color: var(--ui-text-toned); font-size: 12px; cursor: default; }
/* Long labels wrap (a second line beats "Wipe tower rotation a…"). */
.row__text { overflow-wrap: anywhere; line-height: 1.25; padding-block: 4px; }
.row--mod .row__text { color: var(--modified); }
.row__var { width: 12px; height: 12px; flex: none; color: var(--ui-text-dimmed); }
.row__mode { font-size: 9px; line-height: 12px; padding: 0 3px; border-radius: 3px; flex: none; color: var(--ui-warning); border: 1px solid color-mix(in srgb, var(--ui-warning) 40%, transparent); }
.row__dl { display: grid; grid-template-columns: auto 1fr; gap: 1px 8px; margin: 2px 0 0; font-size: 11px; }
.row__dl dt { color: var(--ui-text-dimmed); }
.row__dl dd { margin: 0; word-break: break-all; color: var(--ui-text-toned); }
.row__ctl { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.row__ctl--null { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px; }
.row__ctl--null > .sc, .row__ctl--null > .row__nil { flex: 1; }
.row__nil { color: var(--ui-text-dimmed); font-size: 12px; height: 24px; display: flex; align-items: center; gap: 4px; }
.row__list { display: flex; flex-wrap: wrap; gap: 3px 8px; }
.row__el { display: flex; align-items: center; gap: 3px; }
.row__elabel { font-size: 10px; color: var(--ui-text-dimmed); min-width: 14px; }
.row__pts { display: flex; gap: 4px; }
.row__err { margin: 0; color: var(--ui-error); font-size: 11px; flex-basis: 100%; }
.row__why { margin: 0; color: var(--ui-text-dimmed); font-size: 11px; line-height: 1.3; flex-basis: 100%; }
.row--off .row__text { color: var(--ui-text-dimmed); }
.row__x { align-self: start; }
/* Wide settings dialogs: cap the label column so a label isn't a long way from its control. */
@container settings (min-width: 640px) {
  .row:not(.row--full) { grid-template-columns: 20px minmax(0, 240px) minmax(0, 520px); }
  .row:not(.row--full):has(.row__x) { grid-template-columns: 20px minmax(0, 240px) minmax(0, 520px) 22px; }
}
/* Phone dialogs (settings drawer / printer & filament settings): labels wrap next to the 40 px controls. */
@media (max-width: 640px), (max-height: 500px) {
  .row__lbl { min-height: 40px; }
  .row__text { padding-block: 2px; }
  .row__rev { height: 40px; }
}
</style>

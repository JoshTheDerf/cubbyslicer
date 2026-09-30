<script setup lang="ts">
/**
 * One setting, Orca style: label left (tooltip with description, key,
 * default, range), control(s) right with the unit side text, orange label +
 * revert icon when modified, validation message. Vector options render one
 * control per element — or only element `elementIndex` on per-extruder pages.
 */
import { computed, ref } from 'vue';
import type { ConfigOptionDef, ConfigValue } from '../../engine/types';
import { asArray, isVectorType, joinVector, splitVector } from '../../presets/values';
import { validateValue } from '../validate';
import BedShapeDialog from './BedShapeDialog.vue';
import ScalarControl from './ScalarControl.vue';
import { openDialog } from '../../dialogs/state';

const props = defineProps<{
  optKey: string;
  def: ConfigOptionDef;
  value: ConfigValue | undefined;
  presetValue?: ConfigValue;
  modified?: boolean;
  elementIndex?: number;
  highlighted?: boolean;
  disabled?: boolean;
  /** Label for the revert action ("preset" / "process"). */
  revertTo?: string;
  removable?: boolean;
  /** Nullable options: value shown / used when enabling an override that is currently `nil`. */
  nullFallback?: string;
}>();
const emit = defineEmits<{ (e: 'change', v: ConfigValue): void; (e: 'revert'): void; (e: 'remove'): void }>();

const BED_KEYS = new Set(['printable_area', 'bed_shape', 'bed_exclude_area', 'wrapping_exclude_area', 'thumbnails_list']);
const vector = computed(() => isVectorType(props.def.type));
const arr = computed(() => asArray(props.value));
const label = computed(() => props.def.label || props.def.fullLabel || props.optKey);
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

const scalarValue = computed(() => (Array.isArray(props.value) ? props.value[0] ?? '' : props.value ?? ''));
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
  emit('change', splitVector('points', pointsDraft.value));
  pointsDraft.value = null;
}
const bedDialog = ref(false);
const tip = ref(false);

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
  <div class="row" :class="{ 'row--mod': modified, 'row--hl': highlighted, 'row--bad': problems.length > 0, 'row--full': full }" :data-key="optKey">
    <UButton v-if="modified" class="row__rev" size="xs" variant="ghost" color="warning" icon="i-lucide-undo-2" square
             :aria-label="`Revert ${label}`" :title="`Revert to the ${revertTo || 'preset'} value (${shortFmt(presetValue)})`" @click="emit('revert')" />
    <span v-else class="row__rev" />

    <!-- The tooltip is mounted on first hover: ~700 eager UTooltips double a page's render time. -->
    <span v-if="!tip" class="row__lbl" @pointerenter="tip = true" @focusin="tip = true">
      <span class="row__text">{{ label }}</span>
      <span v-if="def.mode === 'expert'" class="row__mode" title="Expert setting">E</span>
    </span>
    <UTooltip v-else :delay-duration="450" :content="{ side: 'top', align: 'start' }" :ui="{ content: 'h-auto max-w-80 flex-col items-start gap-1 py-2 px-2.5' }">
      <span class="row__lbl">
        <span class="row__text">{{ label }}</span>
        <span v-if="def.mode === 'expert'" class="row__mode" title="Expert setting">E</span>
      </span>
      <template #content>
        <strong class="text-xs text-highlighted">{{ def.fullLabel || label }}</strong>
        <span v-if="def.tooltip" class="whitespace-pre-wrap text-xs leading-snug text-muted">{{ def.tooltip }}</span>
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
      <ScalarControl v-else-if="mode === 'scalar'" :def="def" :opt-key="optKey" :model-value="scalarValue" :disabled="disabled" :aria-label="label"
                     @update:model-value="(v: string) => emit('change', v)" />
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
                @update:model-value="(v: string | number) => (pointsDraft = String(v))" @blur="commitPoints" @keydown.enter="commitPoints" />
        <UButton v-if="BED_KEYS.has(optKey)" size="xs" variant="outline" label="Edit…" :disabled="disabled" @click="optKey === 'printable_area' || optKey === 'bed_shape' ? openDialog('bedShape') : (bedDialog = true)" />
      </div>
      <p v-for="(pr, i) in problems" :key="i" class="row__err">{{ pr.index !== undefined && mode === 'list' ? `${elementLabels(arr.length)[pr.index]}: ` : '' }}{{ pr.message }}</p>
    </div>

    <UButton v-if="removable" class="row__x" size="xs" variant="ghost" icon="i-lucide-x" square aria-label="Remove override" title="Remove override" @click="emit('remove')" />

    <BedShapeDialog v-if="bedDialog" :title="label" :points="arr" :allow-empty="optKey !== 'printable_area' && optKey !== 'bed_shape'"
                    @close="bedDialog = false" @apply="(v: string[]) => emit('change', v)" />
  </div>
</template>

<style scoped>
.row {
  display: grid; grid-template-columns: 20px minmax(0, 1fr) minmax(0, 54%); align-items: start; column-gap: 4px;
  padding: 2px 6px 2px 2px; border-radius: var(--ui-radius); position: relative; min-height: 28px;
}
.row:has(.row__x) { grid-template-columns: 20px minmax(0, 1fr) minmax(0, 54%) 22px; }
.row:hover { background: color-mix(in srgb, var(--ui-bg-elevated) 70%, transparent); }
.row--full { grid-template-columns: 20px minmax(0, 1fr); }
.row--full .row__ctl { grid-column: 2 / -1; }
.row--hl { animation: flash 1.6s ease-out; }
@keyframes flash { 0%, 30% { background: color-mix(in srgb, var(--ui-info) 30%, transparent); } 100% { background: transparent; } }
.row__rev { width: 20px; height: 24px; display: inline-flex; align-items: center; justify-content: center; }
.row__lbl { display: flex; align-items: center; gap: 4px; min-height: 24px; min-width: 0; color: var(--ui-text-toned); font-size: 12px; cursor: default; }
.row__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row--mod .row__text { color: var(--modified); }
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
.row__x { align-self: start; }
/* Phone dialogs (settings drawer / printer & filament settings): labels wrap next to the 40 px controls. */
@media (max-width: 640px), (max-height: 500px) {
  .row__lbl { min-height: 40px; }
  .row__text { white-space: normal; overflow-wrap: anywhere; line-height: 1.25; padding-block: 2px; }
  .row__rev { height: 40px; }
}
</style>

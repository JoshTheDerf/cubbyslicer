<script setup lang="ts">
/**
 * One engine-native scalar value editor, chosen by option type (Nuxt UI):
 * UCheckbox (bool), UInputNumber (int / float), UInput (percent /
 * floatOrPercent — accepts "50%" —, strings, points), USelect (enum),
 * UInputMenu autocomplete (open enum), ColorField (colour), GcodeEditor
 * (multiline). Text-ish inputs commit on blur / Enter; Esc reverts.
 */
import { mobileDialog } from '../../ui/mobileDialog';
import { computed, ref, watch } from 'vue';
import type { ConfigOptionDef } from '../../engine/types';
import { elementType, normalizeInput, parseBool, parseNumber, serializeBool } from '../../presets/values';
import { isOpenEnum, validateScalar } from '../validate';
import ColorField from './ColorField.vue';
import GcodeEditor from './GcodeEditor.vue';

const props = defineProps<{
  def: ConfigOptionDef;
  modelValue: string;
  optKey: string;
  disabled?: boolean;
  /** Compact (vector element) rendering. */
  compact?: boolean;
  ariaLabel?: string;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

/** Reka's Select can't hold '' as an item value. */
const EMPTY = '\u0000empty';

const kind = computed(() => elementType(props.def.type));
const isColor = computed(() => props.def.guiType === 'color');
const isOpen = computed(() => isOpenEnum(props.def));
const isEnum = computed(() => (kind.value === 'enum' || !!props.def.enumValues?.length) && !isOpen.value && !isColor.value);
const isMultiline = computed(() => kind.value === 'string' && (props.def.multiline || /gcode$/.test(props.optKey)));
const isGcode = computed(() => isMultiline.value && /gcode/.test(props.optKey));
/** Plain numbers get a UInputNumber; unparsable current values fall back to a text input so nothing is hidden. */
const isNumber = computed(() => (kind.value === 'int' || kind.value === 'float') && !isEnum.value && (props.modelValue.trim() === '' || parseNumber(props.modelValue) !== null));
const isTextNumeric = computed(() => ['int', 'float', 'percent', 'floatOrPercent'].includes(kind.value) && !isEnum.value && !isNumber.value);
const readonly = computed(() => !!props.def.readonly);

// ---- text inputs --------------------------------------------------------------------
const draft = ref(props.modelValue);
const focused = ref(false);
watch(() => props.modelValue, (v) => { if (!focused.value) draft.value = v; });
const error = computed(() => validateScalar(props.def, draft.value));

function commit(): void {
  const v = kind.value === 'string' ? draft.value : normalizeInput(props.def.type, draft.value);
  draft.value = v;
  if (v !== props.modelValue) emit('update:modelValue', v);
}
function onBlur(): void { focused.value = false; commit(); }
function onKey(ev: KeyboardEvent): void {
  const el = ev.target as HTMLInputElement;
  if (ev.key === 'Enter') el.blur();
  else if (ev.key === 'Escape') { draft.value = props.modelValue; ev.stopPropagation(); el.blur(); }
  else if (isTextNumeric.value && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
    ev.preventDefault();
    const m = draft.value.trim().match(/^(-?[\d.]+)(%?)$/);
    if (!m) return;
    const step = (kind.value === 'int' || Math.abs(Number(m[1])) >= 10 ? 1 : 0.1) * (ev.shiftKey ? 10 : 1);
    let n = Number(m[1]) + (ev.key === 'ArrowUp' ? step : -step);
    if (props.def.min !== null && props.def.min !== undefined) n = Math.max(props.def.min, n);
    if (props.def.max !== null && props.def.max !== undefined) n = Math.min(props.def.max, n);
    draft.value = `${Math.round(n * 1e6) / 1e6}${m[2]}`;
    commit();
  }
}

// ---- numbers --------------------------------------------------------------------------
const numberValue = computed(() => (props.modelValue.trim() === '' ? null : parseNumber(props.modelValue)));
const numberFormat = { useGrouping: false, maximumFractionDigits: 8 } as const;
const bound = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? undefined : v);
const step = computed(() => (kind.value === 'int' ? 1 : Math.abs(numberValue.value ?? 0) >= 10 ? 1 : 0.1));
function onNumber(v: number | null | undefined): void {
  if (v === null || v === undefined || !Number.isFinite(v)) return;
  const s = kind.value === 'int' ? String(Math.round(v)) : String(Math.round(v * 1e8) / 1e8);
  if (s !== props.modelValue) emit('update:modelValue', s);
}

// ---- bool / enum ----------------------------------------------------------------------
const boolVal = computed(() => parseBool(props.modelValue) === true);
const enumItems = computed(() => {
  const vals = props.def.enumValues ?? [];
  const labels = props.def.enumLabels ?? [];
  const items = vals.map((v, i) => ({ value: v === '' ? EMPTY : v, label: labels[i] || v || '(none)' }));
  if (props.modelValue !== '' && !vals.includes(props.modelValue)) items.unshift({ value: props.modelValue, label: `${props.modelValue} (invalid)` });
  return items;
});
const enumModel = computed(() => (props.modelValue !== '' ? props.modelValue : (props.def.enumValues ?? []).includes('') ? EMPTY : undefined));
function onEnum(v: unknown): void {
  const s = v === EMPTY ? '' : String(v ?? '');
  if (s !== props.modelValue) emit('update:modelValue', s);
}
const openItems = computed(() => (props.def.enumValues ?? []).map((v, i) => ({ label: props.def.enumLabels?.[i] || v, value: v })));

const side = computed(() => props.def.sidetext);
</script>

<template>
  <div class="sc" :class="{ 'sc--compact': compact }">
    <UCheckbox v-if="kind === 'bool'" :model-value="boolVal" :disabled="disabled || readonly" :aria-label="ariaLabel" size="sm"
               @update:model-value="(v: boolean | 'indeterminate') => emit('update:modelValue', serializeBool(v === true))" />

    <USelect v-else-if="isEnum" :model-value="enumModel" :items="enumItems" value-key="value" size="xs" class="sc__select" placeholder="—"
             :disabled="disabled || readonly" :aria-label="ariaLabel" @update:model-value="onEnum" />

    <ColorField v-else-if="isColor" :model-value="modelValue" :disabled="disabled || readonly" :aria-label="ariaLabel" :swatch-only="compact"
                @update:model-value="(v: string) => emit('update:modelValue', v)" />

    <GcodeEditor v-else-if="isMultiline" :model-value="modelValue" :gcode="isGcode" :disabled="disabled || readonly" :title="def.fullLabel || def.label" :opt-key="optKey"
                 @update:model-value="(v: string) => emit('update:modelValue', v)" />

    <UInputNumber v-else-if="isNumber" :model-value="numberValue" size="xs" class="sc__num" :class="{ 'sc__num--int': kind === 'int' }"
                  :min="bound(def.nullable ? null : def.min)" :max="bound(def.nullable ? null : def.max)" :step="step" :step-snapping="false"
                  :format-options="numberFormat" :increment="kind === 'int' && !compact && !mobileDialog" :decrement="kind === 'int' && !compact && !mobileDialog"
                  orientation="vertical" disable-wheel-change :disabled="disabled || readonly" :aria-label="ariaLabel"
                  @update:model-value="onNumber" />

    <UInputMenu v-else-if="isOpen" :model-value="draft" mode="autocomplete" :items="openItems" value-key="value" size="xs" class="sc__open"
                :disabled="disabled || readonly" :aria-label="ariaLabel" :color="error ? 'error' : 'primary'" :highlight="!!error"
                @focus="focused = true" @blur="onBlur" @update:model-value="(v: unknown) => (draft = String(v ?? ''))"
                @update:open="(o: boolean) => { if (!o && !focused) commit(); }" @keydown.enter="commit" />

    <UInput v-else v-model="draft" size="xs" class="sc__text" :class="{ 'sc__text--num': isTextNumeric, 'sc__text--mono': !isTextNumeric }"
            :disabled="disabled || readonly" :inputmode="isTextNumeric ? 'decimal' : undefined" spellcheck="false"
            :aria-label="ariaLabel" :aria-invalid="!!error" :title="error ?? undefined" :color="error ? 'error' : 'primary'" :highlight="!!error"
            @focus="focused = true" @blur="onBlur" @keydown="onKey" />

    <span v-if="side && kind !== 'bool' && !isMultiline && !isColor" class="sc__side">{{ side }}</span>
  </div>
</template>

<style scoped>
.sc { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.sc__select { width: 100%; min-width: 0; }
.sc__open { flex: 1; min-width: 0; }
.sc__num { width: 96px; flex: none; }
.sc__num :deep(input) { text-align: right; font-variant-numeric: tabular-nums; }
.sc--compact .sc__num { width: 68px; }
.sc__text { flex: 1; min-width: 0; }
.sc__text--num { flex: none; width: 96px; }
.sc__text--num :deep(input) { text-align: right; font-variant-numeric: tabular-nums; }
.sc--compact .sc__text--num { width: 68px; }
.sc__text--mono :deep(input) { font-family: var(--mono); font-size: 11px; }
.sc__side { color: var(--ui-text-dimmed); font-size: 11px; white-space: nowrap; min-width: 16px; }
</style>

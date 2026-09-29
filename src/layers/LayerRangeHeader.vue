<script setup lang="ts">
/**
 * Z range editor of a height range modifier (Orca GUI_ObjectLayers: the
 * "Start / End height" fields and the add-range / delete buttons). Its
 * settings are edited by ObjectSettingsPanel below this header.
 */
import { computed, ref, watch } from 'vue';
import { getObject } from '../project/store';
import { addLayerRange, getRange, objectHeight, rangeBoundsError, removeLayerRange, selectedRange, setLayerRangeBounds } from './store';

const props = defineProps<{ objectId: string; rangeId: string }>();
const range = computed(() => getRange(props.objectId, props.rangeId));
const lo = ref(0), hi = ref(2);
watch(range, (r) => { if (r) { lo.value = r.min; hi.value = r.max; } }, { immediate: true });
const error = computed(() => {
  const o = getObject(props.objectId);
  return o ? rangeBoundsError(o, props.rangeId, Number(lo.value), Number(hi.value)) : null;
});
const height = computed(() => objectHeight(props.objectId));

function commit(): void {
  const r = range.value;
  if (!r || error.value) return;
  if (r.min !== lo.value || r.max !== hi.value) setLayerRangeBounds(props.objectId, props.rangeId, Number(lo.value), Number(hi.value));
}
function addAfter(): void {
  const id = addLayerRange(props.objectId);
  if (id) selectedRange.value = { objectId: props.objectId, rangeId: id };
}
</script>

<template>
  <div v-if="range" class="lrh" data-testid="layer-range-header">
    <div class="lrh__fields">
      <label><span>Start height</span>
        <UInputNumber v-model="lo" :min="0" :step="0.1" :step-snapping="false" size="xs" :format-options="{ maximumFractionDigits: 3 }"
                      :color="error ? 'error' : undefined" aria-label="Start height (mm)" @blur="commit" @keydown.enter="commit" /></label>
      <label><span>End height</span>
        <UInputNumber v-model="hi" :min="0" :step="0.1" :step-snapping="false" size="xs" :format-options="{ maximumFractionDigits: 3 }"
                      :color="error ? 'error' : undefined" aria-label="End height (mm)" @blur="commit" @keydown.enter="commit" /></label>
      <span class="lrh__unit">mm</span>
    </div>
    <p v-if="error" class="lrh__err">{{ error }}</p>
    <p v-else-if="height && range.min >= height" class="lrh__err">This range is above the object ({{ height.toFixed(2) }} mm).</p>
    <div class="lrh__actions">
      <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-plus" label="Add range after" @click="addAfter" />
      <UButton size="xs" variant="ghost" color="error" icon="i-lucide-trash-2" label="Delete" @click="removeLayerRange(objectId, rangeId)" />
    </div>
  </div>
</template>

<style scoped>
.lrh { display: flex; flex-direction: column; gap: 6px; padding: 6px; border-bottom: 1px solid var(--ui-border); }
.lrh__fields { display: flex; align-items: flex-end; gap: 8px; }
.lrh__fields label { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; font-size: 11px; color: var(--ui-text-muted); }
.lrh__unit { font-size: 11px; color: var(--ui-text-dimmed); padding-bottom: 6px; }
.lrh__err { margin: 0; font-size: 11px; color: var(--ui-error); }
.lrh__actions { display: flex; gap: 6px; }
</style>

<script setup lang="ts">
/**
 * Monospace multi-line editor (UTextarea, resizable) for G-code and other
 * multiline options; commits on blur. "Edit G-code" opens the large editor with
 * Orca's placeholder picker (dialogs/gcode/GcodeEditDialog.vue).
 */
import { computed, ref, watch } from 'vue';
import GcodeEditDialog from '../../dialogs/gcode/GcodeEditDialog.vue';

const props = defineProps<{ modelValue: string; gcode?: boolean; disabled?: boolean; title?: string; optKey?: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const draft = ref(props.modelValue);
const focused = ref(false);
watch(() => props.modelValue, (v) => { if (!focused.value && !big.value) draft.value = v; });
const lines = computed(() => draft.value.split('\n').length);
const big = ref(false);

function commit(): void { if (draft.value !== props.modelValue) emit('update:modelValue', draft.value); }
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Tab' && !ev.shiftKey) {
    ev.preventDefault();
    const ta = ev.target as HTMLTextAreaElement;
    const s = ta.selectionStart, e = ta.selectionEnd;
    draft.value = `${draft.value.slice(0, s)}  ${draft.value.slice(e)}`;
    requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
  }
}
function cancelBig(): void { draft.value = props.modelValue; big.value = false; }
function applyBig(v: string): void { draft.value = v; commit(); big.value = false; }
</script>

<template>
  <div class="ge">
    <UTextarea v-model="draft" :rows="Math.min(12, Math.max(3, lines))" :maxrows="24" autoresize :disabled="disabled" spellcheck="false"
               wrap="off" size="xs" class="ge__ta" :ui="{ base: 'font-mono text-[11px] leading-4 resize-y whitespace-pre' }"
               :aria-label="title" @focus="focused = true" @blur="focused = false; commit()" @keydown="onKey" />
    <div class="ge__bar">
      <span>{{ lines }} line{{ lines === 1 ? '' : 's' }}</span>
      <UButton size="xs" variant="ghost" icon="i-lucide-maximize-2" :label="gcode ? 'Edit G-code' : 'Expand'" :disabled="disabled" @click="big = true" />
    </div>

    <GcodeEditDialog v-model:open="big" :title="title || 'Edit'" :opt-key="optKey || ''" :value="draft" :disabled="disabled"
                     @update:open="(o: boolean) => { if (!o) cancelBig(); }" @apply="applyBig" />
  </div>
</template>

<style scoped>
.ge { width: 100%; display: flex; flex-direction: column; gap: 2px; }
.ge__ta { width: 100%; }
.ge__bar { display: flex; align-items: center; justify-content: space-between; color: var(--ui-text-dimmed); font-size: 11px; }
</style>

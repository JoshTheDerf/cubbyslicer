<script setup lang="ts">
/**
 * Orca's RatioLabelPanel + inline ratio editor (MixedFilamentDialog
 * `start_ratio_editor` / `commit_ratio_editor`): a percentage that turns into
 * a three-digit field on click. Enter or leaving the field applies, Esc cancels;
 * text that isn't a number leaves the ratio as it was.
 */
import { nextTick, ref } from 'vue';
import { parseRatioText } from './ratioEdit';

const props = defineProps<{ value: number; label: string }>();
const emit = defineEmits<{ commit: [number] }>();

const editing = ref(false);
const text = ref('');
const input = ref<HTMLInputElement | null>(null);

async function start(): Promise<void> {
  text.value = String(props.value);
  editing.value = true;
  await nextTick();
  input.value?.focus();
  input.value?.select();
}
function finish(apply: boolean): void {
  if (!editing.value) return;
  editing.value = false;
  if (!apply) return;
  const v = parseRatioText(text.value);
  if (v !== null) emit('commit', v);
}
</script>

<template>
  <span class="rl">
    <span v-if="editing" class="rl__edit">
      <input ref="input" v-model="text" class="rl__input" maxlength="3" inputmode="numeric" :aria-label="label"
             @keydown.enter.prevent="finish(true)" @keydown.esc.stop.prevent="finish(false)" @blur="finish(true)"
             @pointerdown.stop>
      <span>%</span>
    </span>
    <button v-else type="button" class="rl__btn" title="Click to edit ratio" :aria-label="`${label}: ${value} %. Click to edit`"
            @pointerdown.stop @click="start">{{ value }}%</button>
  </span>
</template>

<style scoped>
.rl { display: inline-flex; }
.rl__btn { padding: 1px 4px; border: 1px solid transparent; border-radius: 3px; font-size: 11px; line-height: 16px; color: var(--ui-text-highlighted); font-variant-numeric: tabular-nums; cursor: pointer; background: transparent; }
.rl__btn:hover, .rl__btn:focus-visible { background: var(--ui-bg-elevated); border-color: var(--ui-border-accented); color: var(--ui-primary); outline: none; }
.rl__edit { display: inline-flex; align-items: center; gap: 1px; padding: 0 3px; border: 1px solid var(--ui-border-accented); border-radius: 3px; background: var(--ui-bg-elevated); font-size: 11px; color: var(--ui-text-highlighted); }
/* Three digits wide (the inline editor's SetMaxLength(3)); 16 px font on phones comes from the dialog rules. */
.rl__input { width: 3.2ch; min-width: 0; padding: 0; border: 0; background: transparent; text-align: right; font: inherit; color: inherit; outline: none; }
</style>

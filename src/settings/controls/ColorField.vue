<script setup lang="ts">
/**
 * Colour swatch that opens a UColorPicker in a UPopover (+ hex input and an
 * optional palette). Keeps an existing alpha suffix (#RRGGBBAA) intact.
 */
import { computed, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  modelValue: string;
  disabled?: boolean;
  /** Swatch only (no hex text next to it). */
  swatchOnly?: boolean;
  ariaLabel?: string;
  palette?: readonly string[];
  /** Offer "reset" (emits ''). */
  resettable?: boolean;
  size?: 'xs' | 'sm';
}>(), { size: 'xs', palette: () => [] });
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const hex = computed(() => {
  const m = /^#([0-9a-f]{6})/i.exec(props.modelValue.trim());
  return m ? `#${m[1].toUpperCase()}` : '#000000';
});
const alpha = computed(() => (/^#[0-9a-f]{8}$/i.test(props.modelValue.trim()) ? props.modelValue.trim().slice(7) : ''));
const draft = ref(hex.value);
watch(hex, (h) => { draft.value = h; });

function set(v: string): void {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) { draft.value = hex.value; return; }
  const next = `#${m[1].toUpperCase()}${alpha.value}`;
  if (next !== props.modelValue) emit('update:modelValue', next);
}
</script>

<template>
  <UPopover :content="{ side: 'bottom', align: 'start' }">
    <button type="button" class="cf" :class="[`cf--${size}`, { 'cf--swatch': swatchOnly }]" :disabled="disabled"
            :aria-label="ariaLabel ?? 'Colour'" :title="modelValue || hex">
      <span class="cf__sw" :style="{ background: hex }" />
      <span v-if="!swatchOnly" class="cf__hex">{{ hex }}</span>
    </button>
    <template #content>
      <div class="flex w-56 flex-col gap-2 p-2" data-color-popover>
        <UColorPicker :model-value="hex" size="sm" @update:model-value="(v: string | undefined) => v && set(v)" />
        <div class="flex items-center gap-1">
          <UInput v-model="draft" size="xs" class="flex-1 font-mono" aria-label="Hex colour" spellcheck="false"
                  @keydown.enter="set(draft)" @blur="set(draft)" />
          <UButton v-if="resettable" size="xs" variant="ghost" icon="i-lucide-rotate-ccw" title="Use the preset colour" @click="emit('update:modelValue', '')" />
        </div>
        <div v-if="palette.length" class="flex flex-wrap gap-1">
          <button v-for="c in palette" :key="c" type="button" class="cf__chip" :class="{ on: c.toUpperCase() === hex }" :style="{ background: c }"
                  :title="c" :aria-label="`Use ${c}`" @click="set(c)" />
        </div>
      </div>
    </template>
  </UPopover>
</template>

<style scoped>
.cf {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px 0 3px; flex: none;
  border: 1px solid var(--ui-border-accented); border-radius: var(--ui-radius); background: var(--ui-bg); cursor: pointer;
}
.cf:hover:not(:disabled) { border-color: var(--ui-border-inverted); }
.cf:disabled { opacity: .5; cursor: default; }
.cf--sm { height: 28px; }
.cf--swatch { padding: 2px; width: 24px; justify-content: center; }
.cf--sm.cf--swatch { width: 28px; }
.cf__sw { width: 18px; height: 16px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgb(255 255 255 / .18); flex: none; }
.cf--swatch .cf__sw { width: 100%; height: 100%; }
.cf__hex { font: 11px var(--mono); color: var(--ui-text-muted); }
.cf__chip { width: 18px; height: 18px; border-radius: 4px; border: 1px solid rgb(255 255 255 / .15); cursor: pointer; }
.cf__chip.on { outline: 2px solid var(--ui-primary); outline-offset: 1px; }
</style>

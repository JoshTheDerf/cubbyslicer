<script setup lang="ts">
/**
 * Colour swatch that opens Orca 2.5's colour picker (src/ui/colorPicker, solid colours as Orca's
 * setting fields use it) in a popover. Keeps an existing alpha suffix (#RRGGBBAA) intact.
 * `palette` / `resettable` add quick chips and "use the preset colour" under the picker.
 */
import { computed, ref } from 'vue';
import { normaliseHex, swatchBackground, withRgb } from '../../lib/colour';
import ColorPicker from '../../ui/colorPicker/ColorPicker.vue';
import ColorPickerHost from '../../ui/colorPicker/ColorPickerHost.vue';
import type { Selection } from '../../ui/colorPicker/model';

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

const open = ref(false);
/** RGB part (#RRGGBB) for the picker; the alpha of the value is kept on edit. */
const hex = computed(() => normaliseHex(props.modelValue)?.slice(0, 7) ?? '#000000');
const swatch = computed(() => (normaliseHex(props.modelValue) ? swatchBackground(props.modelValue) : hex.value));
const selection = computed<Selection>(() => ({ type: 'solid', colors: [hex.value] }));

function set(v: string): void {
  const rgb = normaliseHex(v)?.slice(0, 7);
  const next = rgb ? withRgb(props.modelValue, rgb) ?? rgb : null;
  if (next && next !== props.modelValue) emit('update:modelValue', next);
}
function confirm(sel: Selection): void { set(sel.colors[0]); open.value = false; }
</script>

<template>
  <ColorPickerHost v-model:open="open">
    <template #trigger>
    <button type="button" class="cf" :class="[`cf--${size}`, { 'cf--swatch': swatchOnly }]" :disabled="disabled"
            :aria-label="ariaLabel ?? 'Colour'" :title="modelValue || hex">
      <span class="cf__sw" :style="{ background: swatch }" />
      <span v-if="!swatchOnly" class="cf__hex">{{ hex }}</span>
    </button>
    </template>
      <div data-color-popover>
        <ColorPicker v-if="open" :selection="selection" @confirm="confirm" @cancel="open = false" />
        <div v-if="palette.length || resettable" class="flex flex-wrap items-center gap-1 px-2.5 pb-2.5">
          <button v-for="c in palette" :key="c" type="button" class="cf__chip" :class="{ on: c.toUpperCase() === hex }" :style="{ background: c }"
                  :title="c" :aria-label="`Use ${c}`" @click="set(c); open = false" />
          <UButton v-if="resettable" size="xs" variant="ghost" icon="i-lucide-rotate-ccw" label="Preset colour" title="Use the preset colour" class="ms-auto"
                   @click="emit('update:modelValue', ''); open = false" />
        </div>
      </div>
  </ColorPickerHost>
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

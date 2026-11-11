<script setup lang="ts">
/**
 * A physical filament slot's colour: Orca 2.5's colour picker with opacity and gradients of up to
 * seven colours (PlaterPresetComboBox::show_default_color_picker). A segmented multi-colour filament
 * the picker can't edit opens as its first colour with Orca's notice, and is kept unless the colour
 * changes (filament_color_picker_changed). Writes filament_colour / filament_multi_colour /
 * filament_colour_type for the slot.
 */
import { computed, ref } from 'vue';
import { currentPresets } from '../../presets/store';
import { parseColour, swatchBackground, toHex, type FilamentColour, type RGBA } from '../../lib/colour';
import ColorPicker from '../../ui/colorPicker/ColorPicker.vue';
import ColorPickerHost from '../../ui/colorPicker/ColorPickerHost.vue';
import { MAX_GRADIENT_COLORS, normalizeSelection, type Selection } from '../../ui/colorPicker/model';

const props = withDefaults(defineProps<{ slotIndex: number; swatchOnly?: boolean; ariaLabel?: string; palette?: readonly string[]; size?: 'xs' | 'sm' }>(),
  { size: 'sm', palette: () => [] });

const OPTIONS = { allowGradient: true, allowAlpha: true, maxGradientColors: MAX_GRADIENT_COLORS };
const p = computed(() => currentPresets.value);
const open = ref(false);
const spec = computed<FilamentColour>(() => p.value.filamentColourSpec(props.slotIndex));
const swatch = computed(() => swatchBackground(spec.value));
const hex8 = (c: RGBA) => toHex(c, 'always');
/** filament_color_picker_selection: exact when solid or a 2–7 colour gradient; else null (kept as is). */
const exact = computed<Selection | null>(() => normalizeSelection(
  { type: spec.value.gradient ? 'gradient' : 'solid', colors: spec.value.colours.map(hex8) }, OPTIONS, MAX_GRADIENT_COLORS));
const initial = computed<Selection>(() => exact.value ?? { type: 'solid', colors: [hex8(spec.value.colours[0])] });
const label = computed(() => spec.value.colours.map((c) => toHex(c)).join(' → '));

function confirm(sel: Selection): void {
  open.value = false;
  if (JSON.stringify(sel) === JSON.stringify(initial.value)) return;
  const colours = sel.colors.map((c) => parseColour(c)!).filter(Boolean);
  p.value.setFilamentColourSpec(props.slotIndex, { colours, gradient: sel.type === 'gradient' });
}
function chip(c: string): void {
  open.value = false;
  const rgb = parseColour(c);
  if (rgb) p.value.setFilamentColourSpec(props.slotIndex, { colours: [rgb], gradient: false });
}
</script>

<template>
  <ColorPickerHost v-model:open="open">
    <template #trigger>
    <button type="button" class="fcf" :class="[`fcf--${size}`, { 'fcf--swatch': swatchOnly }]" :aria-label="ariaLabel ?? 'Filament colour'" :title="label"
            data-testid="filament-colour">
      <span class="fcf__sw" :style="{ background: swatch }" />
      <span v-if="!swatchOnly" class="fcf__hex">{{ label }}</span>
    </button>
    </template>
      <div data-color-popover>
        <ColorPicker v-if="open" :selection="initial" :options="OPTIONS" :preserve-notice="!exact" @confirm="confirm" @cancel="open = false" />
        <div class="flex flex-wrap items-center gap-1 px-2.5 pb-2.5">
          <button v-for="c in palette" :key="c" type="button" class="fcf__chip" :style="{ background: c }" :title="c" :aria-label="`Use ${c}`" @click="chip(c)" />
          <UButton size="xs" variant="ghost" icon="i-lucide-rotate-ccw" label="Preset colour" title="Use the preset colour" class="ms-auto"
                   @click="p.setFilamentColourSpec(slotIndex, null); open = false" />
        </div>
      </div>
  </ColorPickerHost>
</template>

<style scoped>
.fcf {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px 0 3px; flex: none; min-width: 0; max-width: 220px;
  border: 1px solid var(--ui-border-accented); border-radius: var(--ui-radius); background: var(--ui-bg); cursor: pointer;
}
.fcf:hover { border-color: var(--ui-border-inverted); }
.fcf--sm { height: 28px; }
.fcf--swatch { padding: 2px; width: 24px; justify-content: center; }
.fcf--sm.fcf--swatch { width: 28px; }
.fcf__sw { width: 18px; height: 16px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgb(255 255 255 / .18); flex: none; }
.fcf--swatch .fcf__sw { width: 100%; height: 100%; }
.fcf__hex { font: 11px var(--mono); color: var(--ui-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fcf__chip { width: 18px; height: 18px; border-radius: 4px; border: 1px solid rgb(255 255 255 / .15); cursor: pointer; }
</style>

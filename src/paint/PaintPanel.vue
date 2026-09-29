<script setup lang="ts">
import { mixedEnabled, mixedFilaments, mixedLabel } from '../mixed/store';
/**
 * Orca's paint gizmo panel (support / seam / color / fuzzy skin painting):
 * brush type, size, smart-fill angle, overhang limit, filament swatches,
 * erase all and the mouse legend. Floats over the plater's left edge.
 */
import { computed } from 'vue';
import { currentPresets } from '../presets/store';
import { phone, touch } from '../app/shell/uiState';
import { closePaint, eraseAllPaint } from './controller';
import { PAINT_TITLES, PAINT_TOOLS, TOOL_LABELS, paintUi, type PaintTool } from './state';

const TOOL_ICONS: Record<PaintTool, string> = {
  circle: 'i-lucide-circle', sphere: 'i-lucide-globe', fill: 'i-lucide-paint-bucket', bucket: 'i-lucide-paint-roller',
  height: 'i-lucide-align-vertical-space-around', pointer: 'i-lucide-triangle',
};

const layer = computed(() => paintUi.layer);
const tools = computed(() => (layer.value ? PAINT_TOOLS[layer.value] : []));
const filaments = computed(() => [
  ...currentPresets.value.selection.filaments.map((_, i) => ({
    n: i + 1, colour: currentPresets.value.filamentColour(i), name: currentPresets.value.infos.value.filaments[i]?.name ?? `Filament ${i + 1}`,
  })),
  // Full Spectrum mixed filaments paint like physical ones (virtual filament numbers).
  ...(mixedEnabled.value ? mixedFilaments.value.map((m) => ({ n: m.id, colour: m.color, name: `Mixed ${mixedLabel(m)}` })) : []),
]);
const brush = computed(() => paintUi.tool === 'circle' || paintUi.tool === 'sphere');
const legend = computed(() => {
  const l = layer.value;
  if (!l) return [];
  const tap = touch.value ? 'Drag on the model' : 'Left mouse';
  if (l === 'color') return [[tap, `Paint filament ${paintUi.filament}`], ['Right mouse / Shift + left', 'Erase'], ['Alt + wheel', 'Brush size']];
  if (l === 'fuzzy') return [[tap, 'Paint fuzzy skin'], ['Right mouse / Shift + left', 'Erase'], ['Alt + wheel', 'Brush size']];
  return [[tap, l === 'seam' ? 'Enforce seam' : 'Enforce supports'], ['Right mouse', l === 'seam' ? 'Block seam' : 'Block supports'], ['Shift + left', 'Erase'], ['Alt + wheel', 'Brush size']];
});
</script>

<template>
  <div v-if="layer" class="pp" :class="{ 'pp--phone': phone }" role="region" :aria-label="PAINT_TITLES[layer]">
    <div class="pp__head">
      <UIcon name="i-lucide-brush" class="size-4 text-primary" />
      <span class="pp__title">{{ PAINT_TITLES[layer] }}</span>
      <UIcon v-if="paintUi.busy" name="i-lucide-loader-circle" class="size-3.5 animate-spin text-dimmed" />
      <span class="flex-1" />
      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Close painting" @click="closePaint()" />
    </div>

    <div class="pp__row pp__tools" role="radiogroup" aria-label="Brush">
      <UTooltip v-for="t in tools" :key="t" :text="TOOL_LABELS[t]">
        <UButton size="sm" :icon="TOOL_ICONS[t]" :aria-label="TOOL_LABELS[t]" :aria-checked="paintUi.tool === t" role="radio"
                 :color="paintUi.tool === t ? 'primary' : 'neutral'" :variant="paintUi.tool === t ? 'soft' : 'ghost'" @click="paintUi.tool = t" />
      </UTooltip>
    </div>

    <div v-if="brush || paintUi.tool === 'pointer'" v-show="brush" class="pp__field">
      <span>Size</span>
      <USlider v-model="paintUi.radius" :min="0.2" :max="20" :step="0.1" size="sm" class="flex-1" aria-label="Brush size" />
      <span class="pp__val">{{ paintUi.radius.toFixed(1) }} mm</span>
    </div>
    <div v-if="paintUi.tool === 'height'" class="pp__field">
      <span>Height</span>
      <USlider v-model="paintUi.height" :min="0.1" :max="20" :step="0.1" size="sm" class="flex-1" aria-label="Height range" />
      <span class="pp__val">{{ paintUi.height.toFixed(1) }} mm</span>
    </div>
    <div v-if="paintUi.tool === 'fill' || paintUi.tool === 'bucket'" class="pp__field">
      <span>Angle</span>
      <USlider v-model="paintUi.angle" :min="0" :max="90" :step="1" size="sm" class="flex-1" aria-label="Smart fill angle" />
      <span class="pp__val">{{ paintUi.angle }}°</span>
    </div>
    <template v-if="layer === 'support'">
      <UCheckbox v-model="paintUi.onOverhangsOnly" label="On overhangs only" class="pp__check" />
      <div v-if="paintUi.onOverhangsOnly" class="pp__field">
        <span>Overhang</span>
        <USlider v-model="paintUi.overhang" :min="0" :max="90" :step="1" size="sm" class="flex-1" aria-label="Overhang angle" />
        <span class="pp__val">{{ paintUi.overhang }}°</span>
      </div>
    </template>

    <div v-if="layer === 'color'" class="pp__swatches" role="radiogroup" aria-label="Filament">
      <UTooltip v-for="f in filaments" :key="f.n" :text="`${f.n}: ${f.name}`">
        <button type="button" class="pp__swatch" :class="{ on: paintUi.filament === f.n }" :style="{ background: f.colour }"
                role="radio" :aria-checked="paintUi.filament === f.n" :aria-label="`Filament ${f.n}`" @click="paintUi.filament = f.n">
          <span>{{ f.n }}</span>
        </button>
      </UTooltip>
      <p v-if="filaments.length < 2" class="pp__hint">Add filaments in the sidebar to paint with more colours.</p>
    </div>

    <dl class="pp__legend">
      <template v-for="[k, v] in legend" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
    </dl>
    <p v-if="paintUi.error" class="pp__err">{{ paintUi.error }}</p>

    <div class="pp__foot">
      <UButton size="xs" color="error" variant="ghost" icon="i-lucide-eraser" label="Erase all" @click="eraseAllPaint()" />
      <span class="flex-1" />
      <UButton size="xs" color="primary" label="Done" @click="closePaint()" />
    </div>
  </div>
</template>

<style scoped>
.pp {
  width: 280px; max-width: calc(100vw - 16px); padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px;
  background: color-mix(in oklab, var(--ui-bg-elevated) 94%, transparent); border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2); box-shadow: var(--shadow); backdrop-filter: blur(6px); font-size: 12px;
}
.pp--phone { width: auto; }
.pp__head { display: flex; align-items: center; gap: 6px; }
.pp__title { font-weight: 600; color: var(--ui-text-highlighted); font-size: 13px; }
.pp__tools { display: flex; flex-wrap: wrap; gap: 2px; }
.pp__field { display: flex; align-items: center; gap: 8px; }
.pp__field > span:first-child { width: 58px; color: var(--ui-text-muted); }
.pp__val { width: 52px; text-align: right; font-variant-numeric: tabular-nums; color: var(--ui-text-toned); }
.pp__swatches { display: flex; flex-wrap: wrap; gap: 6px; }
.pp__swatch {
  width: 28px; height: 28px; border-radius: 6px; border: 2px solid transparent; cursor: pointer; display: grid; place-items: center;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.25);
}
.pp__swatch span { font-size: 11px; font-weight: 700; color: #fff; text-shadow: 0 0 3px #000; }
.pp__swatch.on { border-color: var(--ui-primary); }
.pp__hint { flex-basis: 100%; margin: 0; color: var(--ui-text-dimmed); }
.pp__legend { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; color: var(--ui-text-dimmed); }
.pp__legend dt { color: var(--ui-text-muted); }
.pp__legend dd { margin: 0; }
.pp__err { margin: 0; color: var(--ui-error); }
.pp__foot { display: flex; align-items: center; gap: 6px; }
</style>

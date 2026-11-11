<script setup lang="ts">
/**
 * Orca 2.5's section view button and panel (GLCanvas3D canvas toolbar +
 * _render_section_view_panel), shared by Prepare and Preview: click opens the
 * panel, right click toggles the cut, middle click sets the viewing angle,
 * the wheel over the button moves the plane. The panel has the slider, its
 * value, "Set viewing angle" and Reset; Alt + mouse wheel in the view moves the
 * plane too.
 */
import { computed } from 'vue';
import { alignSectionToCamera, setSectionRatio, toggleSection, viewportState } from './controller';

const s = viewportState.section;
const active = computed(() => s.ratio > 0);
const alt = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌥' : 'Alt+';

function onButton(e: MouseEvent): void {
  if (e.button === 0) s.panelOpen = !s.panelOpen;
  else if (e.button === 1) { e.preventDefault(); alignSectionToCamera(); }
}
function onWheel(e: WheelEvent): void { setSectionRatio(s.ratio + (e.deltaY > 0 ? -0.01 : 0.01)); }
function onSlider(v: number | number[] | undefined): void { onInput(Array.isArray(v) ? v[0] ?? 0 : v ?? 0); }
function onInput(v: string | number): void { const n = Number(v); if (Number.isFinite(n)) setSectionRatio(n); }
</script>

<template>
  <div class="secv" data-testid="section-view">
    <div v-if="s.panelOpen" class="secv__panel" role="group" aria-label="Section view">
      <UPopover mode="hover" :content="{ side: 'top', align: 'start' }">
        <UButton icon="i-lucide-circle-help" size="xs" color="neutral" variant="ghost" aria-label="Section view controls" />
        <template #content>
          <dl class="secv__tips">
            <dt>{{ alt }}Mouse wheel</dt><dd>Move section plane</dd>
            <dt>Mouse wheel on icon</dt><dd>Move section plane</dd>
            <dt>Right click on icon</dt><dd>Toggle section view</dd>
            <dt>Middle click on icon</dt><dd>Set viewing angle</dd>
          </dl>
        </template>
      </UPopover>
      <span class="secv__label">Section view</span>
      <USlider :model-value="s.ratio" :min="0" :max="1" :step="0.01" size="sm" class="secv__slider" aria-label="Section plane position"
               @update:model-value="onSlider" />
      <UInput :model-value="s.ratio.toFixed(2)" type="number" :step="0.05" :min="0" :max="1" size="xs" class="secv__num" aria-label="Section plane position value"
              @change="(e: Event) => onInput((e.target as HTMLInputElement).value)" />
      <UButton size="xs" color="neutral" variant="soft" label="Set viewing angle" @click="alignSectionToCamera()" />
      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-rotate-ccw" aria-label="Reset" title="Reset" :disabled="!active" @click="setSectionRatio(0)" />
    </div>
    <UTooltip text="Section view">
      <UButton :icon="active ? 'i-lucide-square-split-horizontal' : 'i-lucide-square-dashed'" size="sm" :color="active ? 'primary' : 'neutral'"
               :variant="active || s.panelOpen ? 'soft' : 'ghost'" class="secv__btn" aria-label="Section view" :aria-pressed="active"
               @mousedown="onButton" @contextmenu.prevent="toggleSection()" @wheel.prevent="onWheel" @auxclick.prevent />
    </UTooltip>
  </div>
</template>

<style scoped>
.secv { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; pointer-events: auto; }
.secv__btn { background: color-mix(in srgb, var(--bg-1) 88%, transparent); }
.secv__panel {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; max-width: min(560px, calc(100vw - 24px));
  padding: 6px 10px; border-radius: 8px; background: color-mix(in srgb, var(--bg-1) 94%, transparent); box-shadow: 0 2px 10px rgb(0 0 0 / 0.25);
}
.secv__label { font-size: var(--fs-sm); color: var(--fg-1); white-space: nowrap; }
.secv__slider { width: 112px; }
.secv__num { width: 64px; }
.secv__tips { display: grid; grid-template-columns: auto auto; gap: 4px 12px; padding: 8px 10px; font-size: var(--fs-sm); }
.secv__tips dt { color: var(--fg-1); }
.secv__tips dd { margin: 0; color: var(--fg-0); }
</style>

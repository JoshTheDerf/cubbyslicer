<script setup lang="ts">
/**
 * CubbyCAD's shape palette (toolbar "Add shape…"): built-in primitives,
 * added as new objects on the active plate. Esc or a click outside closes it.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { shortScreen as short } from '../ui/mobileDialog';
import { addShapeCmd, cadUi } from './commands';
import { paletteShapes } from './shapes';
import { ShapePalette } from './ui';

const shapes = paletteShapes().map((s) => s.id);
// Landscape phones: a wide, short palette so every shape fits without scrolling.
const columns = computed(() => (short.value ? Math.min(shapes.length, 8) : 4));
const el = ref<HTMLElement | null>(null);

function add(id: string) { cadUi.paletteOpen = false; void addShapeCmd(id); }
function onDown(e: PointerEvent) {
  const t = e.target as Element | null;
  if (el.value && t && !el.value.contains(t) && !t.closest?.('[data-action="cad.palette"]')) cadUi.paletteOpen = false;
}
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.stopPropagation(); cadUi.paletteOpen = false; } }
watch(() => cadUi.paletteOpen, (open) => {
  if (open) { window.addEventListener('pointerdown', onDown, true); window.addEventListener('keydown', onKey, true); }
  else { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); }
}, { immediate: true });
onBeforeUnmount(() => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); });
</script>

<template>
  <section v-if="cadUi.paletteOpen" ref="el" class="spp" :class="{ 'spp--wide': short }" role="dialog" aria-label="Add shape">
    <header class="spp__head">
      <span class="spp__title">Add shape</span>
      <span class="text-xs text-dimmed">CubbyCAD primitives</span>
      <UButton icon="i-lucide-x" size="xs" variant="ghost" color="neutral" aria-label="Close" class="ml-auto" @click="cadUi.paletteOpen = false" />
    </header>
    <div class="spp__body"><ShapePalette :shapes="shapes" :columns="columns" @add="add" /></div>
  </section>
</template>

<style scoped>
.spp {
  display: flex; flex-direction: column;
  width: min(360px, calc(100vw - 24px)); max-height: min(60vh, 420px); overflow: hidden; padding: 6px 8px 8px;
  background: color-mix(in srgb, var(--bg-1) 96%, transparent);
  border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: var(--shadow); backdrop-filter: blur(6px);
}
.spp--wide { width: min(680px, calc(100vw - 24px)); max-height: calc(var(--vvh, 100dvh) - 24px); }
.spp__head { flex: none; display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.spp__body { flex: 1; min-height: 0; overflow-y: auto; }
.spp__title { font: 600 var(--fs-sm) var(--font); color: var(--fg-0); }
</style>

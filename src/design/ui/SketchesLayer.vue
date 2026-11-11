<script setup lang="ts">
/**
 * Finished sketches over the Design view (committed.ts): strokes of the sketches nothing consumes
 * yet, of the selected ones, and of every sketch while a feature card with a Sketch row is open
 * (click a region or a stroke to pick it). The card's chosen sketch is drawn in the reference
 * colour with its regions shaded.
 */
import { computed, ref, watch } from 'vue';
import type { DesignScene } from '../scene/DesignScene';
import { cardSketchRows, committedSketches, sketchPolylines, type CommittedSketch } from '../sketch/committed';
import { designUi } from '../state';
import { sk } from '../sketch/session';

const props = defineProps<{ scene: DesignScene | null }>();
const tick = ref(0);
watch(() => props.scene, (s, _o, onCleanup) => { if (s) onCleanup(s.onView(() => { tick.value++; })); }, { immediate: true });

const shown = computed<CommittedSketch[]>(() => {
  if (sk.open) return [];
  const rows = cardSketchRows();
  return committedSketches.value.filter((s) => rows.length || !s.consumed || designUi.selected.includes(s.index));
});
defineExpose({ shown });

const paths = computed(() => {
  void tick.value;
  const s = props.scene;
  if (!s) return [];
  const chosen = new Set(cardSketchRows().map((r) => r.value));
  const P = (p: [number, number, number]) => { const [x, y, z] = s.project(p); return z > 1 ? null : `${x.toFixed(1)} ${y.toFixed(1)}`; };
  return shown.value.map((sk) => {
    let d = '', dc = '';
    for (const pl of sketchPolylines(sk, true)) {
      const pts = pl.pts.map(P).filter(Boolean);
      if (pts.length < 2) continue;
      const seg = `M${pts.join('L')}`;
      if (pl.construction) dc += seg; else d += seg;
    }
    return { index: sk.index, d, dc, cls: chosen.has(sk.index) ? 'ref' : designUi.selected.includes(sk.index) ? 'sel' : '' };
  });
});
</script>

<template>
  <svg v-if="paths.length" class="skl" aria-hidden="true" data-testid="design-sketches">
    <g v-for="p in paths" :key="p.index" :class="p.cls ? `is-${p.cls}` : ''" :data-sketch="p.index">
      <path v-if="p.cls === 'ref'" :d="p.d" class="skl__fill" fill-rule="evenodd" />
      <path :d="p.d" class="skl__line" />
      <path v-if="p.dc" :d="p.dc" class="skl__line skl__line--cons" />
    </g>
  </svg>
</template>

<style scoped>
.skl { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; overflow: visible; }
.skl__line { fill: none; stroke: var(--vp-sketch-committed); stroke-width: 1.6; stroke-linejoin: round; }
.skl__line--cons { stroke-dasharray: 6 4; stroke-width: 1; opacity: 0.7; }
.skl__fill { fill: color-mix(in srgb, var(--vp-cad-ref, #f2a33a) 16%, transparent); stroke: none; }
.is-sel .skl__line { stroke: var(--vp-sketch-sel); stroke-width: 2.2; }
.is-ref .skl__line { stroke: var(--vp-cad-ref, #f2a33a); stroke-width: 2.4; }
</style>

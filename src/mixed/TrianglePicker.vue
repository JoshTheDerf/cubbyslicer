<script setup lang="ts">
/**
 * Orca's triangle (ternary) ratio picker for three-component mixes
 * (MixedFilamentDialog `create_triangle_picker`, FilamentBitmapUtils
 * `draw_mixed_triangle_picker`): the triangle filled with the pigment blend of
 * the three colours (top = component 1, bottom-left = 2, bottom-right = 3), a
 * drag handle, and each corner's percentage, which can be clicked and typed.
 * A press only starts a drag inside the triangle; the drag is clamped to it.
 * Browser addition: arrow keys move the handle (Shift: larger steps).
 */
import { computed, onMounted, ref, watch } from 'vue';
import { pigmentLerp } from './mixer';
import { parseColour } from '../lib/colour';
import RatioLabel from './RatioLabel.vue';
import { TRIANGLE_PANEL, triangleDrag, trianglePoint, triangleVertices, triContains, weightsFromRatios, type Pt } from './ratioEdit';

const props = defineProps<{ colours: [string, string, string]; ratios: number[]; names: [string, string, string] }>();
const emit = defineEmits<{ drag: [ratios: [number, number, number]]; edit: [index: number, value: number] }>();

const S = TRIANGLE_PANEL;
const canvas = ref<HTMLCanvasElement | null>(null);
const box = ref<HTMLElement | null>(null);
const v = triangleVertices(S, S);
/** Barycentric weights of the handle: the exact drag point while dragging, else from the ratios. */
const weights = ref<[number, number, number]>(weightsFromRatios(props.ratios));
watch(() => props.ratios.join(','), () => { if (!dragging) weights.value = weightsFromRatios(props.ratios); });
const handle = computed(() => trianglePoint(weights.value, v));

const rgb = (s: string): [number, number, number] => { const c = parseColour(s); return c ? [c.r, c.g, c.b] : [217, 217, 217]; };
function paint(): void {
  const cv = canvas.value;
  if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const n = Math.round(S * dpr);
  cv.width = n; cv.height = n;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(n, n);
  const [c0, c1, c2] = props.colours.map(rgb);
  const vv = v.map((p) => ({ x: p.x * dpr, y: p.y * dpr })) as [Pt, Pt, Pt];
  const total = (vv[1].x - vv[0].x) * (vv[2].y - vv[0].y) - (vv[2].x - vv[0].x) * (vv[1].y - vv[0].y);
  for (let y = Math.floor(vv[0].y); y <= Math.ceil(vv[1].y); y++) {
    for (let x = Math.floor(vv[1].x); x <= Math.ceil(vv[2].x); x++) {
      const p = { x, y };
      if (!triContains(p, ...vv)) continue;
      const w0 = Math.abs((vv[1].x - x) * (vv[2].y - y) - (vv[2].x - x) * (vv[1].y - y)) / Math.abs(total);
      const w1 = Math.abs((x - vv[0].x) * (vv[2].y - vv[0].y) - (vv[2].x - vv[0].x) * (y - vv[0].y)) / Math.abs(total);
      const w2 = Math.max(0, 1 - w0 - w1);
      let m: [number, number, number];
      if (w0 + w1 > 1e-6) m = pigmentLerp(pigmentLerp(c0, c1, w1 / (w0 + w1)), c2, w2);
      else m = c2;
      const o = (y * n + x) * 4;
      if (o < 0 || o + 3 >= img.data.length) continue;
      img.data[o] = m[0]; img.data[o + 1] = m[1]; img.data[o + 2] = m[2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
onMounted(paint);
watch(() => props.colours.join(','), paint);

let dragging = false;
function local(e: PointerEvent): Pt {
  const b = box.value!.getBoundingClientRect();
  return { x: (e.clientX - b.left) * (S / b.width), y: (e.clientY - b.top) * (S / b.height) };
}
function apply(p: Pt): void {
  const r = triangleDrag(p, v);
  weights.value = r.weights;
  emit('drag', r.ratios);
}
function onDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const p = local(e);
  if (!triContains(p, ...v)) return;
  e.preventDefault();
  dragging = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  (e.currentTarget as HTMLElement).focus({ preventScroll: true, focusVisible: false } as FocusOptions);
  apply(p);
}
function onMove(e: PointerEvent): void { if (dragging) apply(local(e)); }
function onUp(e: PointerEvent): void {
  dragging = false;
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
}
function onKey(e: KeyboardEvent): void {
  const d = e.shiftKey ? 10 : 2;
  const p = { ...handle.value };
  if (e.key === 'ArrowUp') p.y -= d; else if (e.key === 'ArrowDown') p.y += d;
  else if (e.key === 'ArrowLeft') p.x -= d; else if (e.key === 'ArrowRight') p.x += d;
  else return;
  e.preventDefault();
  apply(p);
}
const labelPos = computed(() => [
  { left: v[0].x, top: v[0].y - 20 }, { left: v[1].x, top: v[1].y + 3 }, { left: v[2].x, top: v[2].y + 3 },
]);
</script>

<template>
  <div class="tp" data-testid="triangle-picker">
    <span class="tp__title">Ratio</span>
    <div ref="box" class="tp__box" tabindex="0" role="slider" aria-valuemin="10" aria-valuemax="80" :aria-valuenow="ratios[0]"
         :aria-valuetext="names.map((n, i) => `${n} ${ratios[i]} %`).join(', ')" aria-label="Mixing ratio of the three filaments"
         @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @keydown="onKey">
      <canvas ref="canvas" class="tp__canvas" />
      <svg class="tp__svg" :viewBox="`0 0 ${S} ${S}`">
        <polygon :points="v.map((p) => `${p.x},${p.y}`).join(' ')" class="tp__outline" />
        <circle :cx="handle.x" :cy="handle.y" r="5" class="tp__handle" />
      </svg>
      <span v-for="(pos, i) in labelPos" :key="i" class="tp__lbl" :style="{ left: `${pos.left / S * 100}%`, top: `${pos.top / S * 100}%` }">
        <RatioLabel :value="ratios[i]" :label="`${names[i]} share`" @commit="(val) => emit('edit', i, val)" />
      </span>
    </div>
  </div>
</template>

<style scoped>
.tp { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.tp__title { align-self: flex-start; font-size: var(--fs-xs); color: var(--ui-text-muted); }
.tp__box { position: relative; width: 160px; height: 160px; background: var(--ui-bg); touch-action: none; user-select: none; border-radius: 4px; }
.tp__box:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.tp__canvas, .tp__svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.tp__outline { fill: none; stroke: var(--ui-border-accented); stroke-width: 1; }
.tp__handle { fill: #fff; stroke: var(--ui-text-highlighted); stroke-width: 2; }
.tp__lbl { position: absolute; transform: translateX(-50%); }
</style>

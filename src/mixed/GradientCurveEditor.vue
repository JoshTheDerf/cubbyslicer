<script setup lang="ts">
/**
 * Orca's gradient curve editor (GradientCurveEditor.cpp): the first and second
 * component's share over the model height, Photoshop-curves style. Press on
 * the selected curve to add an anchor and drag it, drag an anchor to move it
 * (its tangent overrides are cleared), right-click an interior anchor to delete
 * it, press the other curve to select it. Logic in curveEdit.ts.
 *
 * Browser additions: arrow keys move the focused anchor (Shift: 10 %), Delete
 * removes it, Tab / Shift+Tab step through anchors, C switches curve; a long
 * press deletes on touch screens.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { GradientAnchor } from './mixer';
import {
  curvePolyline, dataToPx, deleteAnchor, dragAnchor, GRID_DIVISIONS, hitAnchor, hitCurve, MIN_HEIGHT, MIN_WIDTH, plotRect, press, pxToData, toVisualY,
} from './curveEdit';
import { parseColour, toHex } from '../lib/colour';

const props = defineProps<{ points: GradientAnchor[]; colorLow: string; colorHigh: string; labelLow?: string; labelHigh?: string }>();
const emit = defineEmits<{ 'update:points': [GradientAnchor[]] }>();

const root = ref<HTMLElement | null>(null);
const svg = ref<SVGSVGElement | null>(null);
const w = ref(300);
const h = computed(() => Math.max(MIN_HEIGHT, Math.min(260, Math.round(w.value * 0.78))));
const rect = computed(() => plotRect(w.value, h.value));
const selected = ref<0 | 1>(0);
const active = ref(-1);
const bg = ref<[number, number, number] | null>(null);

let ro: ResizeObserver | null = null;
onMounted(() => {
  const el = root.value!;
  const measure = () => {
    w.value = Math.max(MIN_WIDTH, Math.round(el.clientWidth));
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(getComputedStyle(el).backgroundColor);
    bg.value = m ? [+m[1], +m[2], +m[3]] : null;
  };
  measure();
  ro = new ResizeObserver(measure);
  ro.observe(el);
});
onBeforeUnmount(() => { ro?.disconnect(); clearTimeout(longPress); });

const pts = computed(() => props.points);
watch(() => props.points.length, (n) => { if (active.value >= n) active.value = -1; });

// ---- drawing ----
const grid = computed(() => {
  const r = rect.value;
  return Array.from({ length: GRID_DIVISIONS + 1 }, (_, i) => ({ x: r.x + r.width * i / GRID_DIVISIONS, y: r.y + r.height * i / GRID_DIVISIONS }));
});
const pathOf = (c: 0 | 1) => {
  const poly = curvePolyline(pts.value, rect.value, c);
  return poly.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('');
};
/** Transparent filaments would vanish: draw them at alpha 150 (#RRGGBB96). */
function strokeColour(hex: string): string {
  const c = parseColour(hex);
  if (!c) return '#D9D9D9';
  return c.a === 0 ? toHex({ ...c, a: 150 }) : toHex(c, 'never');
}
/** Outline a curve only when its colour is close to the background (kBgSimilarThreshold). */
function needsOutline(hex: string): boolean {
  const c = parseColour(hex);
  if (!c || !bg.value) return false;
  const [r, g, b] = bg.value;
  return Math.hypot(c.r - r, c.g - g, c.b - b) < 40;
}
const curves = computed(() => {
  const other = (1 - selected.value) as 0 | 1;
  return [other, selected.value].map((c) => {
    const colour = c === 0 ? props.colorLow : props.colorHigh;
    return { c, d: pathOf(c), stroke: strokeColour(colour), width: c === selected.value ? 4 : 2, outline: needsOutline(colour) };
  });
});
const anchors = computed(() => pts.value.map((p) => dataToPx(rect.value, p.x, toVisualY(selected.value, p.y))));
const axis = computed(() => {
  const r = rect.value;
  const xAxisY = r.y + r.height;
  const titleY = Math.max(0, r.y - 30);
  // The X arrow sits 10 px past the plot unless "Model Height" would run off the right edge.
  const arrowTx = Math.max(r.x + r.width + 10, Math.min(r.x + r.width + 10, w.value - 76 - 10 - 10));
  return { xAxisY, titleY, arrowTx, tipX: arrowTx + 10 };
});

// ---- input ----
function local(e: MouseEvent | PointerEvent): { x: number; y: number } {
  const b = svg.value!.getBoundingClientRect();
  return { x: (e.clientX - b.left) * (w.value / b.width), y: (e.clientY - b.top) * (h.value / b.height) };
}
let drag = -1;
let moved = false;
let longPress: ReturnType<typeof setTimeout> | undefined;
function onDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const p = local(e);
  const scale = e.pointerType === 'touch' ? 2.5 : 1;
  const r = press(pts.value, rect.value, selected.value, p.x, p.y, scale);
  if (r.kind === 'none') return;
  e.preventDefault();
  svg.value?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
  if (r.kind === 'select') { selected.value = r.curve; active.value = -1; return; }
  drag = r.index;
  active.value = r.index;
  moved = false;
  svg.value?.setPointerCapture(e.pointerId);
  if (r.changed) emit('update:points', r.points);
  if (e.pointerType === 'touch') {
    clearTimeout(longPress);
    const idx = r.index;
    longPress = setTimeout(() => { if (!moved) { drag = -1; remove(idx); } }, 650);
  }
}
function onMove(e: PointerEvent): void {
  if (drag < 0) return;
  const q = local(e);
  const p = pxToData(rect.value, q.x, q.y);
  moved = true;
  clearTimeout(longPress);
  emit('update:points', dragAnchor(pts.value, drag, selected.value, p.x, p.y));
}
function onUp(e: PointerEvent): void {
  clearTimeout(longPress);
  if (svg.value?.hasPointerCapture(e.pointerId)) svg.value.releasePointerCapture(e.pointerId);
  drag = -1;
}
function remove(idx: number): boolean {
  const next = deleteAnchor(pts.value, idx);
  if (!next) return false;
  emit('update:points', next);
  active.value = Math.min(idx, next.length - 1);
  return true;
}
function onContext(e: MouseEvent): void {
  const p = local(e);
  const idx = hitAnchor(pts.value, rect.value, selected.value, p.x, p.y);
  if (idx >= 0) { e.preventDefault(); remove(idx); return; }
  const hit = hitCurve(pts.value, rect.value, selected.value, p.x, p.y);
  if (hit) { e.preventDefault(); if (hit.curve !== selected.value) { selected.value = hit.curve; active.value = -1; } }
}
function onKey(e: KeyboardEvent): void {
  const n = pts.value.length;
  if (e.key === 'c' || e.key === 'C') { selected.value = (1 - selected.value) as 0 | 1; e.preventDefault(); return; }
  if (e.key === 'Tab') {
    const next = active.value + (e.shiftKey ? -1 : 1);
    if (next < 0 || next >= n) { active.value = -1; return; } // leave the editor
    active.value = next;
    e.preventDefault();
    return;
  }
  if (active.value < 0) { if (e.key.startsWith('Arrow')) { active.value = 0; e.preventDefault(); } return; }
  const a = pts.value[active.value];
  const step = e.shiftKey ? 0.1 : 0.01;
  let x = a.x, vy = toVisualY(selected.value, a.y);
  if (e.key === 'ArrowUp') vy += step;
  else if (e.key === 'ArrowDown') vy -= step;
  else if (e.key === 'ArrowLeft') x -= step;
  else if (e.key === 'ArrowRight') x += step;
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (remove(active.value)) e.preventDefault(); return; }
  else return;
  e.preventDefault();
  emit('update:points', dragAnchor(pts.value.map((p, i) => (i === active.value ? { ...p, mIn: NaN, mOut: NaN } : p)), active.value, selected.value, x, vy));
}
const status = computed(() => {
  const i = active.value;
  if (i < 0 || !pts.value[i]) return '';
  const p = pts.value[i];
  const share = Math.round(toVisualY(selected.value, p.y) * 100);
  return `Point ${i + 1} of ${pts.value.length}: height ${Math.round(p.x * 100)} %, ${selected.value === 0 ? props.labelLow ?? 'first' : props.labelHigh ?? 'second'} ${share} %`;
});
</script>

<template>
  <div ref="root" class="gce" data-testid="gradient-curve">
    <svg ref="svg" :viewBox="`0 0 ${w} ${h}`" :width="w" :height="h" class="gce__svg" tabindex="0" role="application"
         :aria-label="`Gradient curve: ${selected === 0 ? labelLow ?? 'first filament' : labelHigh ?? 'second filament'}'s share over the model height. Click the line to add a point, drag points, right-click a point to delete it. Arrow keys move the selected point, Delete removes it, C switches curve.`"
         @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @contextmenu="onContext" @keydown="onKey" @blur="active = -1">
      <g class="gce__grid">
        <template v-for="(g, i) in grid" :key="i">
          <line :x1="g.x" :y1="rect.y" :x2="g.x" :y2="rect.y + rect.height" />
          <line :x1="rect.x" :y1="g.y" :x2="rect.x + rect.width" :y2="g.y" />
        </template>
      </g>
      <g class="gce__axis">
        <line :x1="rect.x" :y1="axis.titleY + 10" :x2="rect.x" :y2="axis.xAxisY" />
        <polygon :points="`${rect.x},${axis.titleY} ${rect.x - 5},${axis.titleY + 10} ${rect.x + 5},${axis.titleY + 10}`" />
        <line :x1="rect.x" :y1="axis.xAxisY" :x2="axis.arrowTx" :y2="axis.xAxisY" />
        <polygon :points="`${axis.tipX},${axis.xAxisY} ${axis.arrowTx},${axis.xAxisY - 5} ${axis.arrowTx},${axis.xAxisY + 5}`" />
      </g>
      <text class="gce__lbl" :x="rect.x + 10" :y="axis.titleY + 10">Material Ratio</text>
      <text class="gce__pct" :x="rect.x + 10" :y="axis.titleY + 24">100%</text>
      <text class="gce__pct" :x="rect.x + rect.width" :y="axis.xAxisY + 14" text-anchor="end">100%</text>
      <text class="gce__lbl" :x="axis.tipX + 4" :y="axis.xAxisY + 4">Model Height</text>
      <g v-for="cv in curves" :key="cv.c" :data-curve="cv.c">
        <path v-if="cv.outline" :d="cv.d" class="gce__outline" :stroke-width="cv.width + 2" />
        <path :d="cv.d" fill="none" :stroke="cv.stroke" :stroke-width="cv.width" stroke-linejoin="round" stroke-linecap="round" />
      </g>
      <circle v-for="(a, i) in anchors" :key="i" :cx="a.x" :cy="a.y" r="4" class="gce__pt" :class="{ 'gce__pt--on': i === active }" :data-index="i" />
    </svg>
    <p class="gce__status" aria-live="polite">{{ status }}</p>
  </div>
</template>

<style scoped>
.gce { position: relative; width: 100%; background: var(--ui-bg); }
.gce__svg { display: block; width: 100%; height: auto; touch-action: none; user-select: none; cursor: crosshair; border-radius: 4px; }
.gce__svg:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.gce__grid line { stroke: var(--ui-border); stroke-width: 1; shape-rendering: crispEdges; }
.gce__axis line { stroke: var(--ui-text-muted); stroke-width: 2; }
.gce__axis polygon { fill: var(--ui-text-muted); }
.gce__lbl { font-size: 11px; fill: var(--ui-text-muted); }
.gce__pct { font-size: 11px; font-weight: 600; fill: var(--ui-text-highlighted); }
.gce__outline { fill: none; stroke: var(--ui-border-accented); stroke-linejoin: round; }
.gce__pt { fill: var(--ui-bg); stroke: var(--ui-text-muted); stroke-width: 1; }
.gce__pt--on { stroke: var(--ui-primary); stroke-width: 2; }
.gce__status { position: absolute; left: 0; bottom: 0; font-size: var(--fs-xs); color: var(--ui-text-dimmed); pointer-events: none; }
</style>

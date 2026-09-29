<script setup lang="ts">
/**
 * Orca's layer editing mode ("Variable layer height", GLCanvas3D::LayersEditing):
 * Adaptive (quality / speed) · Smooth (radius, keep min) · Reset, plus the
 * vertical layer-height bar Orca draws next to the object — here a 2D profile
 * editor: Z runs bottom → top, layer height left → right.
 *
 * Mouse (as Orca): left = add detail (thinner layers), right = remove detail,
 * Shift+left = reset to base, Shift+right = smooth, wheel = edit band width.
 * Touch / pen: the brush picker chooses what a drag does. Holding still keeps
 * applying the brush (Orca's 100 ms timer); the edit is one undo step.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { resolvedConfig } from '../app/state';
import { phone } from '../app/shell/uiState';
import { rampColor } from '../preview/render/colors';
import {
  brush, editObject, hasCustomProfile, heightRanges, layersUi, liveProfile, paramsFor, profileOf, resetLayerProfile, runAdaptive,
  runSmooth, setBandWidth, setLayerProfile,
} from './store';
import { DEFAULT_STRENGTH, generateLayers, heightAt, isUniform, type LayerEditAction } from './profile';

const obj = editObject;
const params = computed(() => { void resolvedConfig.value; return obj.value ? paramsFor(obj.value) : null; });
const stored = computed(() => (obj.value && params.value ? profileOf(obj.value, params.value) : []));
const working = ref<number[] | null>(null);
const shown = computed(() => working.value ?? stored.value);
const ranges = computed(() => (obj.value ? heightRanges(obj.value) : []));
const layers = computed(() => (params.value && shown.value.length ? generateLayers(params.value, shown.value) : []));
const uniformLayers = computed(() => (params.value ? generateLayers(params.value, []).length / 2 : 0));
const canReset = computed(() => hasCustomProfile(obj.value) || (!!params.value && !isUniform(params.value, stored.value) && !ranges.value.length));

watch(obj, () => { working.value = null; liveProfile.value = null; });

const BRUSHES: Array<{ value: LayerEditAction; label: string; icon: string; hint: string }> = [
  { value: 'decrease', label: 'Add detail', icon: 'i-lucide-chevrons-left', hint: 'Thinner layers' },
  { value: 'increase', label: 'Remove detail', icon: 'i-lucide-chevrons-right', hint: 'Thicker layers' },
  { value: 'reduce', label: 'Reset', icon: 'i-lucide-eraser', hint: 'Back to the base layer height' },
  { value: 'smooth', label: 'Smooth', icon: 'i-lucide-waves', hint: 'Smooth the curve' },
];
const HELP = [
  ['Left mouse button', 'Add detail'], ['Right mouse button', 'Remove detail'], ['Shift + Left mouse button', 'Reset to base'],
  ['Shift + Right mouse button', 'Smoothing'], ['Mouse wheel', 'Increase/decrease edit area'],
];

// ---- canvas ----------------------------------------------------------------------------
const wrap = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const size = ref({ w: 200, h: 300 });
const PAD = { l: 18, r: 10, t: 14, b: 20 };
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(([e]) => { size.value = { w: Math.max(80, e.contentRect.width), h: Math.max(80, e.contentRect.height) }; });
  if (wrap.value) ro.observe(wrap.value);
});
onBeforeUnmount(() => { ro?.disconnect(); stopTimer(); liveProfile.value = null; layersUi.cursorZ = null; });

const xMax = computed(() => (params.value ? params.value.maxLayerHeight * 1.12 : 0.4));
const plotW = () => size.value.w - PAD.l - PAD.r;
const plotH = () => size.value.h - PAD.t - PAD.b;
const xOf = (h: number) => PAD.l + (h / xMax.value) * plotW();
const yOf = (z: number) => PAD.t + plotH() * (1 - z / Math.max(1e-6, params.value?.objectHeight ?? 1));
const zAt = (clientY: number) => {
  const r = canvas.value!.getBoundingClientRect();
  const f = 1 - (clientY - r.top - PAD.t) / Math.max(1, plotH());
  return Math.max(0, Math.min(1, f)) * (params.value?.objectHeight ?? 0);
};

function css(name: string, fallback: string): string {
  const v = wrap.value ? getComputedStyle(wrap.value).getPropertyValue(name).trim() : '';
  return v || fallback;
}
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function draw(): void {
  const c = canvas.value, p = params.value;
  if (!c) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { w, h } = size.value;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!p || p.objectHeight <= 0) return;
  const fg = css('--ui-text-muted', '#999'), line = css('--ui-border', '#444'), accent = css('--ui-primary', '#19c37d');
  const span = Math.max(1e-6, p.maxLayerHeight - p.minLayerHeight);
  // layer bands (Orca's layer texture): colour = layer height, alternating shade per layer
  const L = layers.value;
  for (let i = 0; i + 1 < L.length; i += 2) {
    const lh = L[i + 1] - L[i];
    const y0 = yOf(L[i]), y1 = yOf(L[i + 1]);
    g.fillStyle = hex(rampColor((lh - p.minLayerHeight) / span));
    g.globalAlpha = (i / 2) % 2 ? 0.55 : 0.8;
    g.fillRect(PAD.l - 12, y1, 8, Math.max(0.5, y0 - y1));
  }
  g.globalAlpha = 1;
  // height ranges: locked (Orca refuses edits inside them)
  for (const r of ranges.value) {
    const y0 = yOf(Math.min(r.max, p.objectHeight)), y1 = yOf(r.min);
    g.fillStyle = 'rgba(128,128,128,0.18)';
    g.fillRect(PAD.l, y0, plotW(), y1 - y0);
  }
  // grid: min / base / max layer height
  g.lineWidth = 1;
  for (const [v, dash] of [[p.minLayerHeight, [2, 3]], [p.layerHeight, [5, 4]], [p.maxLayerHeight, [2, 3]]] as Array<[number, number[]]>) {
    g.strokeStyle = line; g.setLineDash(dash);
    g.beginPath(); g.moveTo(xOf(v) + 0.5, PAD.t); g.lineTo(xOf(v) + 0.5, PAD.t + plotH()); g.stroke();
  }
  g.setLineDash([]);
  g.fillStyle = fg; g.font = '10px ui-monospace, monospace';
  g.textAlign = 'left';
  g.fillText(`${p.objectHeight.toFixed(1)} mm`, PAD.l + 2, PAD.t - 3);
  g.textAlign = 'center';
  g.fillText(p.layerHeight.toFixed(2), xOf(p.layerHeight), h - 6);
  g.textAlign = 'left'; g.fillText(p.minLayerHeight.toFixed(2), Math.max(0, xOf(p.minLayerHeight) - 10), h - 6);
  g.textAlign = 'right'; g.fillText(p.maxLayerHeight.toFixed(2), Math.min(w, xOf(p.maxLayerHeight) + 12), h - 6);
  // edit band at the cursor
  const cz = layersUi.cursorZ;
  if (cz !== null) {
    const bw = layersUi.bandWidth;
    const y0 = yOf(Math.min(p.objectHeight, cz + bw / 2)), y1 = yOf(Math.max(0, cz - bw / 2));
    g.fillStyle = accent; g.globalAlpha = 0.16;
    g.fillRect(PAD.l, y0, plotW(), y1 - y0);
    g.globalAlpha = 1;
  }
  // the profile curve (filled like Orca's bar)
  const prof = shown.value;
  if (prof.length >= 4) {
    g.beginPath();
    g.moveTo(PAD.l, yOf(prof[0]));
    for (let i = 0; i < prof.length; i += 2) g.lineTo(xOf(prof[i + 1]), yOf(prof[i]));
    g.lineTo(PAD.l, yOf(prof[prof.length - 2]));
    g.closePath();
    g.fillStyle = accent; g.globalAlpha = 0.22;
    g.fill();
    g.globalAlpha = 1;
    g.beginPath();
    for (let i = 0; i < prof.length; i += 2) { const x = xOf(prof[i + 1]), y = yOf(prof[i]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.strokeStyle = accent; g.lineWidth = 1.5; g.stroke();
  }
  if (cz !== null) {
    const y = yOf(cz);
    g.strokeStyle = fg; g.lineWidth = 1; g.setLineDash([3, 2]);
    g.beginPath(); g.moveTo(PAD.l, y + 0.5); g.lineTo(PAD.l + plotW(), y + 0.5); g.stroke(); g.setLineDash([]);
  }
}
watch([shown, layers, size, () => layersUi.cursorZ, () => layersUi.bandWidth, ranges], () => requestAnimationFrame(draw), { flush: 'post' });
onMounted(() => requestAnimationFrame(draw));

const cursorLabel = computed(() => {
  const z = layersUi.cursorZ, p = params.value;
  if (z === null || !p) return '';
  return `Z ${z.toFixed(2)} mm · ${heightAt(shown.value, z, p.layerHeight).toFixed(3)} mm`;
});

// ---- brushing ------------------------------------------------------------------------------
let timer: ReturnType<typeof setInterval> | null = null;
let action: LayerEditAction = 'decrease';
let lastZ = 0;
let pointerId: number | null = null;
function stopTimer(): void { if (timer) { clearInterval(timer); timer = null; } }

function step(): void {
  const o = obj.value;
  if (!o) return;
  const next = brush(o, working.value ?? stored.value, lastZ, action, DEFAULT_STRENGTH * (action === 'reduce' || action === 'smooth' ? 4 : 1));
  working.value = next;
  liveProfile.value = { id: o.id, profile: next };
}

function onDown(e: PointerEvent): void {
  if (!obj.value || pointerId !== null) return;
  e.preventDefault();
  const mouse = e.pointerType === 'mouse';
  if (mouse && e.button === 2) action = e.shiftKey ? 'smooth' : 'increase';
  else if (mouse && e.button === 0) action = e.shiftKey ? 'reduce' : layersUi.touchAction;
  else if (!mouse) action = layersUi.touchAction;
  else return;
  pointerId = e.pointerId;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  lastZ = zAt(e.clientY);
  layersUi.cursorZ = lastZ;
  step();
  stopTimer();
  timer = setInterval(step, 100);
}
function onMove(e: PointerEvent): void {
  if (!obj.value) return;
  const z = zAt(e.clientY);
  layersUi.cursorZ = z;
  if (pointerId === e.pointerId) { lastZ = z; step(); }
}
function onUp(e: PointerEvent): void {
  if (pointerId !== e.pointerId) return;
  pointerId = null;
  stopTimer();
  const o = obj.value, next = working.value;
  if (o && next) setLayerProfile(o.id, next, 'Variable layer height - Manual edit');
  working.value = null;
  liveProfile.value = null;
  if (e.pointerType !== 'mouse') layersUi.cursorZ = null;
}
function onLeave(): void { if (pointerId === null) layersUi.cursorZ = null; }
function onWheel(e: WheelEvent): void {
  setBandWidth(layersUi.bandWidth * (1 + 0.1 * (e.deltaY < 0 ? 1 : -1)));
}

const quality = computed({ get: () => layersUi.quality, set: (v: number) => { layersUi.quality = Math.max(0, Math.min(1, v)); } });
const radius = computed({ get: () => layersUi.radius, set: (v: number) => { layersUi.radius = Math.max(1, Math.min(10, Math.round(v))); } });
const band = computed({ get: () => layersUi.bandWidth, set: (v: number) => setBandWidth(v) });
</script>

<template>
  <section class="lh" :class="{ 'lh--phone': phone }" aria-label="Variable layer height" data-testid="layer-height-panel">
    <header class="lh__head">
      <UIcon name="i-lucide-layers-3" class="size-4 text-primary flex-none" />
      <div class="lh__title">
        <strong>Variable layer height</strong>
        <span v-if="obj">{{ obj.name }}</span>
      </div>
      <UPopover :content="{ side: 'bottom', align: 'end' }">
        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-circle-help" aria-label="Mouse shortcuts" />
        <template #content>
          <div class="lh__help">
            <template v-for="[k, v] in HELP" :key="k"><span class="text-muted">{{ k }}</span><span>{{ v }}</span></template>
          </div>
        </template>
      </UPopover>
      <UTooltip :text="layersUi.showBands ? 'Hide layer heights on the object' : 'Show layer heights on the object'">
        <UButton size="xs" :variant="layersUi.showBands ? 'soft' : 'ghost'" :color="layersUi.showBands ? 'primary' : 'neutral'" icon="i-lucide-box"
                 :aria-pressed="layersUi.showBands" aria-label="Layer heights on the object" @click="layersUi.showBands = !layersUi.showBands" />
      </UTooltip>
      <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-x" aria-label="Close" @click="layersUi.editing = false" />
    </header>

    <p v-if="!obj" class="lh__empty">Select one object to edit its layer heights.</p>
    <template v-else>
      <div class="lh__grid">
        <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-sparkles" label="Adaptive" :loading="layersUi.busy === 'adaptive'"
                 :disabled="!!layersUi.busy" data-testid="lh-adaptive" @click="runAdaptive(obj.id)" />
        <span class="lh__lbl" title="Higher print quality versus higher print speed">Quality / Speed</span>
        <USlider v-model="quality" :min="0" :max="1" :step="0.05" size="xs" class="lh__slider" aria-label="Adaptive quality" />
        <span class="lh__val">{{ quality.toFixed(2) }}</span>

        <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-waves" label="Smooth" :loading="layersUi.busy === 'smooth'"
                 :disabled="!!layersUi.busy" data-testid="lh-smooth" @click="runSmooth(obj.id)" />
        <span class="lh__lbl">Radius</span>
        <USlider v-model="radius" :min="1" :max="10" :step="1" size="xs" class="lh__slider" aria-label="Smoothing radius" />
        <span class="lh__val">{{ radius }}</span>

        <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-rotate-ccw" label="Reset" :disabled="!canReset"
                 data-testid="lh-reset" @click="resetLayerProfile(obj.id)" />
        <UCheckbox v-model="layersUi.keepMin" size="xs" label="Keep min" class="lh__span3" />
      </div>

      <div class="lh__brushes" role="radiogroup" aria-label="Brush">
        <UTooltip v-for="b in BRUSHES" :key="b.value" :text="b.hint">
          <UButton size="xs" :icon="b.icon" :label="phone ? undefined : b.label" :aria-label="b.label" role="radio" :aria-checked="layersUi.touchAction === b.value"
                   :color="layersUi.touchAction === b.value ? 'primary' : 'neutral'" :variant="layersUi.touchAction === b.value ? 'soft' : 'ghost'"
                   @click="layersUi.touchAction = b.value" />
        </UTooltip>
      </div>

      <div ref="wrap" class="lh__plot">
        <canvas ref="canvas" class="lh__canvas" :style="{ width: `${size.w}px`, height: `${size.h}px` }" data-testid="lh-editor"
                @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @pointerleave="onLeave"
                @wheel.prevent="onWheel" @contextmenu.prevent />
        <span v-if="cursorLabel" class="lh__cursor">{{ cursorLabel }}</span>
      </div>

      <footer class="lh__foot">
        <span class="lh__lbl">Edit band</span>
        <USlider v-model="band" :min="1.5" :max="10" :step="0.5" size="xs" class="lh__slider" aria-label="Edit band width" />
        <span class="lh__val">{{ band.toFixed(1) }} mm</span>
        <span class="lh__stat" :title="`Uniform: ${uniformLayers} layers`">{{ layers.length / 2 }} layers<template v-if="uniformLayers && layers.length / 2 !== uniformLayers"> (was {{ uniformLayers }})</template></span>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.lh {
  height: 100%;
  display: flex; flex-direction: column; gap: 6px; width: 316px; max-height: 100%; min-height: 0; padding: 8px;
  background: color-mix(in oklab, var(--ui-bg-elevated) 94%, transparent); border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2); box-shadow: 0 6px 24px rgb(0 0 0 / 0.35); backdrop-filter: blur(6px); font-size: 12px;
}
.lh--phone { width: 100%; }
.lh__head { display: flex; align-items: center; gap: 6px; }
.lh__title { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
.lh__title strong { color: var(--ui-text-highlighted); font-size: 12px; }
.lh__title span { color: var(--ui-text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lh__empty { margin: 0; padding: 8px 2px; color: var(--ui-text-dimmed); }
.lh__grid { display: grid; grid-template-columns: auto auto minmax(48px, 1fr) 2.2em; align-items: center; gap: 6px 8px; }
.lh__grid > :deep(button) { justify-content: flex-start; }
.lh__span3 { grid-column: span 3; }
.lh__lbl { color: var(--ui-text-muted); white-space: nowrap; }
.lh__val { font-family: var(--mono, ui-monospace, monospace); font-size: 11px; color: var(--ui-text); text-align: right; white-space: nowrap; }
.lh__slider { min-width: 60px; }
.lh__brushes { display: flex; gap: 2px; flex-wrap: wrap; border-top: 1px solid var(--ui-border); padding-top: 6px; }
.lh__plot { position: relative; flex: 1; min-height: 160px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); background: var(--ui-bg); overflow: hidden; }
.lh__canvas { position: absolute; inset: 0; display: block; touch-action: none; cursor: crosshair; }
.lh__cursor {
  position: absolute; top: 4px; right: 6px; padding: 1px 5px; border-radius: 4px; pointer-events: none;
  background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); font: 11px var(--mono, ui-monospace, monospace);
}
.lh__foot { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 4px 8px; }
.lh__stat { grid-column: 1 / -1; color: var(--ui-text-dimmed); font-size: 11px; }
.lh__help { display: grid; grid-template-columns: auto auto; gap: 4px 12px; padding: 10px 12px; font-size: 12px; }
</style>

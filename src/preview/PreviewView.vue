<template>
  <div class="pv" tabindex="-1" data-testid="preview-view">
    <div ref="host" class="pv-canvas" />

    <!-- empty / error / loading states -->
    <div v-if="!slice" class="pv-center" data-testid="preview-empty">
      <div class="pv-empty">
        <UIcon name="i-lucide-layers" class="size-10 text-dimmed" />
        <div class="text-base font-semibold text-highlighted">Slice to preview</div>
        <div class="text-sm text-muted max-w-sm">The G-code preview appears here after slicing.</div>
        <div class="flex items-center gap-1 text-xs text-dimmed pt-1">Slice with <UKbd value="ctrl" size="sm" /><UKbd value="R" size="sm" /></div>
      </div>
    </div>
    <div v-else-if="slice && !slice.report.ok && !slice.gcode.length" class="pv-center">
      <UAlert
        class="pv-card"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-x"
        title="Slicing failed"
        :description="slice.report.error ?? 'No G-code was produced.'"
      />
    </div>
    <div v-else-if="phase === 'parsing' || phase === 'uploading'" class="pv-center" data-testid="preview-loading">
      <div class="pv-card pv-progress">
        <div class="flex items-center justify-between gap-4 text-sm">
          <span class="text-highlighted">{{ phase === 'parsing' ? 'Reading G-code…' : 'Preparing preview…' }}</span>
          <span class="font-mono text-xs text-muted">{{ Math.round(progress * 100) }}%</span>
        </div>
        <UProgress :model-value="Math.round(progress * 100)" size="sm" />
      </div>
    </div>
    <div v-else-if="phase === 'error'" class="pv-center">
      <UAlert class="pv-card" color="error" variant="subtle" icon="i-lucide-circle-x" title="Could not read G-code" :description="errorMsg" />
    </div>
    <div v-if="contextLost" class="pv-center">
      <UAlert class="pv-card" color="warning" variant="subtle" icon="i-lucide-monitor-x" title="Graphics context lost" description="Waiting for the GPU to recover…" />
    </div>

    <!-- slicer warnings -->
    <UAlert
      v-if="warnings.length && !warningsDismissed"
      class="pv-warnings"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="warnings.length === 1 ? 'Slicer warning' : `${warnings.length} slicer warnings`"
      :close="{ 'aria-label': 'Dismiss warnings' }"
      :actions="warnings.length > 3 ? [{ label: showAllWarnings ? 'Show fewer' : `+${warnings.length - 3} more`, size: 'xs', variant: 'link', color: 'neutral', onClick: () => { showAllWarnings = !showAllWarnings } }] : undefined"
      orientation="vertical"
      role="status"
      data-testid="preview-warnings"
      @update:open="warningsDismissed = true"
    >
      <template #description>
        <ul class="pv-warn-list">
          <li v-for="(w, i) in shownWarnings" :key="i">{{ w.message }}</li>
        </ul>
      </template>
    </UAlert>

    <template v-if="parsed && phase !== 'error'">
      <!-- left: legend (Orca: top-left) -->
      <div class="pv-left">
        <LegendPanel
          :scheme="scheme"
          :features="featureRows"
          :feature-visible="featureVisible"
          :tool-rows="summary?.tools ?? []"
          :tool-colors="legendToolColors"
          :color-changes="colorPrint ? colorPrint.colors.slice(colorPrint.base) : []"
          :range="range"
          :summary="summary!"
          :options="options"
          v-model:collapsed="legendCollapsed"
          :current-layer="hi"
          :layer-time="currentLayerTime"
          @update:scheme="scheme = $event"
          @toggle-feature="toggleFeature"
          @set-all-features="setAllFeatures"
          @update:options="options = $event"
        />
      </div>

      <!-- top-right: view cube + camera/tool buttons -->
      <div class="pv-topright">
        <!-- the view cube (drawn by the renderer) sits above this group -->
        <div v-if="cubeAttached" class="pv-cube-space" />
        <UFieldGroup size="sm" class="pv-tools">
          <UDropdownMenu v-if="!cubeAttached" :items="viewItems" :content="{ align: 'end' }">
            <UButton icon="i-lucide-box" trailing-icon="i-lucide-chevron-down" variant="outline" aria-label="Camera view" />
          </UDropdownMenu>
          <UTooltip text="Fit print" :kbds="['F']">
            <UButton icon="i-lucide-scan" variant="outline" aria-label="Fit print" data-testid="preview-fit" @click="fit()" />
          </UTooltip>
          <UTooltip text="G-code viewer" :kbds="['G']">
            <UButton
              icon="i-lucide-file-code"
              :variant="showViewer ? 'solid' : 'outline'"
              :color="showViewer ? 'primary' : 'neutral'"
              aria-label="G-code viewer"
              :aria-pressed="showViewer"
              data-testid="preview-gcode-toggle"
              @click="showViewer = !showViewer"
            />
          </UTooltip>
          <UPopover :content="{ align: 'end' }">
            <UButton icon="i-lucide-keyboard" variant="outline" aria-label="Keyboard shortcuts" />
            <template #content>
              <div class="pv-keys">
                <div class="text-xs font-semibold text-muted pb-1">Preview shortcuts</div>
                <template v-for="k in SHORTCUTS" :key="k.label">
                  <span class="flex gap-0.5"><UKbd v-for="x in k.keys" :key="x" :value="x" size="sm" /></span>
                  <span class="text-xs">{{ k.label }}</span>
                </template>
              </div>
            </template>
          </UPopover>
        </UFieldGroup>
      </div>

      <!-- right: g-code viewer + vertical layer slider (Orca) -->
      <div class="pv-right">
        <GcodeViewer
          v-if="showViewer && bytes && curSeg >= 0"
          :bytes="bytes"
          :anchor-offset="parsed.byteOffset[curSeg]"
          :anchor-line-no="parsed.lineNo[curSeg]"
          @pick="pickLine"
          @close="showViewer = false"
        />
        <LayerSlider v-model:lo="lo" v-model:hi="hi" v-model:single="single" :count="parsed.layerCount" :zs="parsed.layerZ"
                     :ticks="ticks" can-edit @add="cgMenu?.openAdd($event)" @menu="cgMenu?.openMenu($event)" />
      </div>

      <!-- bottom: horizontal move slider + current move (Orca) -->
      <div class="pv-bottom">
        <MoveSlider ref="moveSlider" v-model:value="move" :max="layerMoves - 1">
          <template v-if="curSeg >= 0" #popup>
            <span class="pv-line" data-testid="preview-current-line">
              <span class="pv-line-no">{{ (parsed.lineNo[curSeg] + 1).toLocaleString() }}</span>
              <span class="pv-line-text"><span v-for="(t, i) in currentTokens" :key="i" :class="`t-${t.kind}`">{{ t.text }}</span></span>
            </span>
          </template>
        </MoveSlider>
        <div v-if="curMeta" class="pv-meta" data-testid="preview-move-meta">
          <span class="inline-flex items-center gap-1.5 text-highlighted">
            <i class="pv-swatch" :style="{ background: curMeta.color }" />{{ curMeta.feature }}
          </span>
          <span>Layer {{ hi + 1 }}</span>
          <span>{{ curMeta.pos }}</span>
          <span>{{ curMeta.speed }}</span>
          <span v-if="curMeta.size">{{ curMeta.size }}</span>
        </div>
      </div>
    </template>
    <CustomGcodeMenu ref="cgMenu" />
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { bedFromConfig, lastSlice, resolvedConfig } from '../app/state';
import type { FlatConfig, SliceResult } from '../engine/types';
import { parseGcodeAsync } from './parser/client';
import type { ParseHandle } from './parser/client';
import type { ParseOptions, ParsedGcode } from './parser/types';
import { FEATURES, Feature, isExtrusionFeature } from './parser/features';
import { PreviewRenderer } from './render/PreviewRenderer';
import type { ViewPreset } from './render/PreviewRenderer';
import { hexCss, toolColorsFromConfig } from './render/colors';
import type { ValueRange } from './render/colors';
import { buildFeatureRows, buildSummary } from './summary';
import {
  colorScheme as scheme, featureVisible, layerHi as hi, layerLo as lo, legendCollapsed, moveIndex as move,
  onCameraCommand, previewData as parsed, previewOptions as options, showGcodeViewer as showViewer,
  singleLayer as single, cameraCommand,
} from './store';
import type { LegendOptions } from './summary';
import { attachViewCube } from './viewCube';
import type { ViewCubeHandle } from './viewCube';
import { registerPreviewActions } from './actions';
import { lineText, tokenize } from './gcodeText';
import LayerSlider from './controls/LayerSlider.vue';
import MoveSlider from './controls/MoveSlider.vue';
import LegendPanel from './LegendPanel.vue';
import GcodeViewer from './GcodeViewer.vue';
import CustomGcodeMenu from './CustomGcodeMenu.vue';
import { colorPrintSlots, sliderTicks } from './customGcode';
import { plateCustomGcodes } from '../plates/store';
import { activePlate } from '../project/store';
import { bindCameraPrefs } from '../viewport/cameraPrefs';

const VIEWS: Array<{ id: ViewPreset; label: string; key: string }> = [
  { id: 'iso', label: 'Isometric', key: '0' },
  { id: 'top', label: 'Top', key: '1' },
  { id: 'bottom', label: 'Bottom', key: '2' },
  { id: 'front', label: 'Front', key: '3' },
  { id: 'back', label: 'Back', key: '4' },
  { id: 'left', label: 'Left', key: '5' },
  { id: 'right', label: 'Right', key: '6' },
];
/** Fallback camera menu while no view cube is attached. */
const viewItems = VIEWS.map((v) => ({ label: `${v.label} view`, kbds: [v.key], onSelect: () => setView(v.id) }));

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['↑', '↓'], label: 'Layer up / down (Shift: ×10)' },
  { keys: ['←', '→'], label: 'Previous / next move (Shift: ×10)' },
  { keys: ['Home', 'End'], label: 'First layer / all layers' },
  { keys: ['0'], label: 'Isometric view' },
  { keys: ['1', '…', '6'], label: 'Top, bottom, front, back, left, right' },
  { keys: ['F'], label: 'Fit print' },
  { keys: ['T'], label: 'Toggle travel moves' },
  { keys: ['L'], label: 'Toggle legend' },
  { keys: ['G'], label: 'Toggle G-code viewer' },
];

const host = ref<HTMLDivElement | null>(null);
const moveSlider = ref<InstanceType<typeof MoveSlider> | null>(null);
let renderer: PreviewRenderer | null = null;
const rendererRef = shallowRef<PreviewRenderer | null>(null);

const slice = computed<SliceResult | null>(() => lastSlice.value);
const bytes = shallowRef<Uint8Array | null>(null);
const phase = ref<'idle' | 'parsing' | 'uploading' | 'ready' | 'error'>('idle');
const progress = ref(0);
const errorMsg = ref('');
const contextLost = ref(false);

const range = ref<ValueRange | null>(null);
const warningsDismissed = ref(false);
const showAllWarnings = ref(false);

const toolColors = computed(() => toolColorsFromConfig(resolvedConfig.value));
// Orca colour print: colour changes in the G-code give later layers new colours (Filament scheme).
const colorPrint = computed(() => (parsed.value ? colorPrintSlots(parsed.value, toolColors.value) : null));
const legendToolColors = computed(() => colorPrint.value?.colors ?? toolColors.value);
/** Custom G-code markers on the layer slider (the active plate's items). */
const ticks = computed(() => (parsed.value ? sliderTicks(plateCustomGcodes(activePlate.value), parsed.value.layerZ, toolColors.value) : []));
const cgMenu = ref<InstanceType<typeof CustomGcodeMenu> | null>(null);

const warnings = computed(() => slice.value?.report.warnings ?? []);
const shownWarnings = computed(() => (showAllWarnings.value ? warnings.value : warnings.value.slice(0, 3)));

const summary = computed(() => (parsed.value ? buildSummary(parsed.value, slice.value?.report ?? null) : null));
const featureRows = computed(() => {
  const p = parsed.value, sm = summary.value;
  if (!p || !sm) return [];
  return buildFeatureRows(p, sm.timeSec, sm.totalMm > 0 ? { mm: sm.totalMm, g: sm.totalG } : undefined);
});

const topStart = computed(() => parsed.value?.layerStart[hi.value] ?? 0);
const layerMoves = computed(() => {
  const p = parsed.value;
  if (!p) return 0;
  return p.layerStart[hi.value + 1] - p.layerStart[hi.value];
});
/** Current (last visible) segment, or -1. */
const curSeg = computed(() => (layerMoves.value > 0 ? topStart.value + Math.min(move.value, layerMoves.value - 1) : -1));
const currentLayerTime = computed(() => {
  const p = parsed.value;
  if (!p) return null;
  const est = p.stats.estimatedTimeSec;
  const total = summary.value?.timeSec ?? est;
  return est > 0 ? (p.layerTime[hi.value] * total) / est : p.layerTime[hi.value];
});

const currentLineText = computed(() => {
  const p = parsed.value, b = bytes.value;
  if (!p || !b || curSeg.value < 0) return '';
  return lineText(b, p.byteOffset[curSeg.value]);
});
const currentTokens = computed(() => tokenize(currentLineText.value));
const curMeta = computed(() => {
  const p = parsed.value, s = curSeg.value;
  if (!p || s < 0) return null;
  const i = (s + 1) * 3;
  const f = FEATURES[p.feature[s]];
  return {
    feature: f?.label ?? '',
    color: hexCss(f?.color ?? 0x999999),
    pos: `X${p.points[i].toFixed(2)} Y${p.points[i + 1].toFixed(2)} Z${p.points[i + 2].toFixed(2)}`,
    speed: `${p.speed[s].toFixed(0)} mm/s`,
    size: isExtrusionFeature(p.feature[s]) ? `${(p.wh[s * 2] / 1000).toFixed(2)} × ${(p.wh[s * 2 + 1] / 1000).toFixed(2)} mm` : '',
  };
});

// ---- parsing ---------------------------------------------------------------

let handle: ParseHandle | null = null;
let framed = false;
let generation = 0;

function parseOptionsFrom(cfg: FlatConfig): ParseOptions {
  const num = (k: string) => {
    const v = cfg[k];
    const s = Array.isArray(v) ? v[0] : v;
    const n = s === undefined ? NaN : parseFloat(s);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    filamentDiameter: num('filament_diameter'),
    acceleration: num('default_acceleration') ?? num('machine_max_acceleration_extruding'),
    travelAcceleration: num('travel_acceleration') ?? num('machine_max_acceleration_travel'),
  };
}

async function load(s: SliceResult | null) {
  const gen = ++generation;
  handle?.cancel();
  handle = null;
  moveSlider.value?.stop();
  parsed.value = null;
  bytes.value = null;
  warningsDismissed.value = false;
  showAllWarnings.value = false;
  await renderer?.setData(null);
  if (!s || !s.gcode.length) { phase.value = 'idle'; return; }
  phase.value = 'parsing';
  progress.value = 0;
  const h = parseGcodeAsync(s.gcode, parseOptionsFrom(resolvedConfig.value), (done, total) => {
    if (gen === generation) progress.value = total ? done / total : 0;
  });
  handle = h;
  let data: ParsedGcode;
  try {
    data = await h.promise;
  } catch (e) {
    if (gen !== generation || (e instanceof DOMException && e.name === 'AbortError')) return;
    phase.value = 'error';
    errorMsg.value = e instanceof Error ? e.message : String(e);
    return;
  }
  if (gen !== generation) return;
  handle = null;
  if (import.meta.env.DEV) {
    console.debug(`[preview] parsed ${(s.gcode.length / 1048576).toFixed(1)} MiB, ${data.stats.lineCount.toLocaleString()} lines, ${data.segmentCount.toLocaleString()} segments, ${data.layerCount} layers in ${data.stats.parseMs.toFixed(0)} ms`);
  }
  markRaw(data);
  bytes.value = s.gcode;
  parsed.value = data;
  lo.value = 0;
  hi.value = Math.max(0, data.layerCount - 1);
  move.value = Math.max(0, data.layerStart[hi.value + 1] - data.layerStart[hi.value] - 1);
  phase.value = 'uploading';
  progress.value = 0;
  if (!renderer) { phase.value = 'ready'; return; }
  range.value = renderer.setScheme(scheme.value);
  pushRange();
  const cp = colorPrintSlots(data, toolColors.value);
  renderer.setToolColors(cp?.colors ?? toolColors.value);
  const first = renderer.setData(cp ? markRaw({ ...data, tool: cp.tool }) : data);
  // Frame the first result; keep the user's camera on re-slices.
  if (!framed) { renderer.view('iso'); framed = true; }
  await first;
  if (gen === generation) phase.value = 'ready';
}

// ---- renderer sync -------------------------------------------------------

function pushRange() {
  const p = parsed.value;
  if (!renderer || !p) return;
  const min = p.layerStart[lo.value];
  const max = curSeg.value >= 0 ? curSeg.value : topStart.value - 1;
  renderer.setRange(min, max, topStart.value);
  const atEnd = move.value >= layerMoves.value - 1;
  renderer.setToolhead(atEnd ? -1 : curSeg.value);
}

watch(hi, (h, old) => {
  const p = parsed.value;
  if (!p) return;
  if (single.value && lo.value !== h) lo.value = h;
  if (h !== old) move.value = Math.max(0, p.layerStart[h + 1] - p.layerStart[h] - 1);
});
watch(single, (on) => { lo.value = on ? hi.value : 0; });
watch([lo, hi, move, parsed], pushRange);

watch(scheme, (s) => {
  if (!renderer) return;
  range.value = renderer.setScheme(s);
});
/** Feature visibility with the Travel / Wipe options folded in (both draw as lines). */
function effectiveVisibility(): boolean[] {
  const v = featureVisible.value.slice();
  v[Feature.Travel] = options.value.travel;
  v[Feature.Wipe] = options.value.wipe;
  return v;
}
function applyOptions(o: LegendOptions) {
  if (!renderer) return;
  renderer.setFeatureVisibility(effectiveVisibility());
  renderer.setTravelVisible(o.travel || o.wipe);
  renderer.setMarkers(o.retracts, o.seams, o.unretracts);
  renderer.setDimBelow(o.dimBelow ? 0.55 : 0);
  renderer.setToolheadEnabled(o.toolMarker);
}
watch(featureVisible, () => renderer?.setFeatureVisibility(effectiveVisibility()), { deep: true });
watch(options, applyOptions, { deep: true });
watch(legendToolColors, (c) => renderer?.setToolColors(c));
watch(resolvedConfig, (cfg) => renderer?.setBed(bedFromConfig(cfg)));
watch(lastSlice, (s) => { void load(s); });

function toggleFeature(id: number) {
  const v = featureVisible.value.slice();
  v[id] = !v[id];
  featureVisible.value = v;
}
function setAllFeatures(on: boolean) {
  featureVisible.value = featureVisible.value.map((_, i) => (isExtrusionFeature(i) ? on : true));
}

/** Jump the sliders to the move of a clicked G-code line. */
function pickLine(offset: number) {
  const p = parsed.value;
  if (!p || !p.segmentCount) return;
  // byteOffset is non-decreasing: find the last segment whose line starts ≤ offset.
  let a = 0, b = p.segmentCount - 1;
  if (p.byteOffset[0] > offset) return;
  while (a < b) { const m = (a + b + 1) >> 1; if (p.byteOffset[m] <= offset) a = m; else b = m - 1; }
  let l = 0, r = p.layerCount - 1;
  while (l < r) { const m = (l + r + 1) >> 1; if (p.layerStart[m] <= a) l = m; else r = m - 1; }
  if (l < lo.value) lo.value = l;
  hi.value = l;
  // hi watcher resets move; set after it runs
  queueMicrotask(() => { move.value = a - p.layerStart[l]; });
}

// ---- mount -------------------------------------------------------------------

let offCamera: (() => void) | null = null;
let offCameraPrefs: (() => void) | null = null;
const unregisterActions = registerPreviewActions();

onMounted(() => {
  if (!host.value) return;
  try {
    renderer = new PreviewRenderer(host.value, {
      onBuildProgress: (f) => { if (phase.value === 'uploading') progress.value = f; },
      onContextLost: (lost) => { contextLost.value = lost; },
    });
  } catch (e) {
    phase.value = 'error';
    errorMsg.value = `WebGL2 is not available: ${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  rendererRef.value = markRaw(renderer);
  if (import.meta.env.DEV) (window as unknown as { __previewRenderer?: PreviewRenderer }).__previewRenderer = renderer;
  renderer.setBed(bedFromConfig(resolvedConfig.value));
  renderer.setToolColors(toolColors.value);
  applyOptions(options.value);
  offCamera = onCameraCommand((c) => {
    if (c.kind === 'fit') renderer?.fit(); else renderer?.view(c.preset);
  });
  // Preferences → Camera (zoom to mouse, reverse zoom, orbit speed / centre, swapped buttons).
  offCameraPrefs = bindCameraPrefs({ controls: renderer.controls, camera: renderer.camera, host: host.value });
  void load(lastSlice.value);
});

// ---- view cube -----------------------------------------------------------------

const cubeAttached = ref(false);
let cube: ViewCubeHandle | null = null;
watch(rendererRef, (r) => {
  if (cube || !r || !host.value) return;
  cube = attachViewCube(r, host.value);
  cubeAttached.value = cube !== null;
});

onBeforeUnmount(() => {
  generation++;
  handle?.cancel();
  handle = null;
  offCamera?.();
  offCamera = null;
  offCameraPrefs?.();
  offCameraPrefs = null;
  parsed.value = null;
  unregisterActions();
  cube?.dispose();
  cube = null;
  renderer?.dispose();
  renderer = null;
  rendererRef.value = null;
});

function setView(v: ViewPreset) { cameraCommand({ kind: 'view', preset: v }); }
function fit() { cameraCommand({ kind: 'fit' }); }
</script>

<style scoped>
.pv {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-0, var(--ui-bg));
  color: var(--ui-text);
  font-size: 13px;
  outline: none;
  /* own stacking context: overlay z-indexes stay below Nuxt UI portals */
  isolation: isolate;
}
.pv-canvas { position: absolute; inset: 0; }
.pv-center {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  z-index: 4;
}
.pv-center > * { pointer-events: auto; }
.pv-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 20px 28px;
  text-align: center;
}
.pv-card { max-width: 420px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.4); background-color: var(--ui-bg); }
.pv-progress {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 280px;
  padding: 14px 18px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
}

.pv-warnings {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  width: min(560px, calc(100% - 480px));
  min-width: 260px;
  background-color: color-mix(in srgb, var(--ui-bg) 88%, var(--ui-warning));
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
  z-index: 3;
}
.pv-warn-list { margin: 0; padding-left: 1em; list-style: disc; }

.pv-left {
  position: absolute;
  top: 10px;
  left: 10px;
  bottom: 96px;
  display: flex;
  flex-direction: column;
  pointer-events: none;
  z-index: 2;
}
.pv-left > * { pointer-events: auto; }
.pv-topright {
  pointer-events: none;
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  z-index: 2;
}
.pv-cube-space { width: 96px; height: 100px; pointer-events: none; }
.pv-topright > :not(.pv-cube-space) { pointer-events: auto; }
.pv-keys { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: center; padding: 10px 12px; }
.pv-keys > :first-child { grid-column: 1 / -1; }

.pv-right {
  position: absolute;
  top: 160px;
  right: 10px;
  bottom: 96px;
  display: flex;
  /* room for the layer slider's thumb labels, which hang off its left edge */
  gap: 64px;
  z-index: 2;
}
.pv-bottom {
  position: absolute;
  left: 344px;
  right: 60px;
  bottom: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 10px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: color-mix(in srgb, var(--ui-bg) 94%, transparent);
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
  z-index: 2;
}
@media (max-width: 900px) {
  .pv-bottom { left: 10px; }
  .pv-left { bottom: 110px; }
}
.pv-line {
  display: flex;
  gap: 8px;
  align-items: center;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  white-space: pre;
}
.pv-line-no { flex: none; color: var(--ui-text-dimmed); font-variant-numeric: tabular-nums; }
.pv-line-text { overflow: hidden; text-overflow: ellipsis; color: var(--ui-text); }
.pv-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  padding: 0 4px;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--ui-text-muted);
  font-variant-numeric: tabular-nums;
}
.pv-swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.35); }
.t-cmd { color: var(--ui-info); font-weight: 600; }
.t-axis { color: var(--ui-warning); }
.t-num { color: var(--ui-text-highlighted); }
.t-comment { color: var(--ui-text-dimmed); font-style: italic; }
</style>

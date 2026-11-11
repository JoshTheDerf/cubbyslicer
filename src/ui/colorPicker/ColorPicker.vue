<script setup lang="ts">
/**
 * Orca 2.5's colour picker (resources/web/dialog/ColorPickerDialog): a hue × lightness spectrum with
 * a saturation slider, hex / opacity / HSL / RGB fields, Solid / Gradient (2–7 colours, − / + and a
 * stop per colour), the original colour and the save-to-favourites button with 16 favourite slots,
 * and a palette sidebar (Basic Colors, Orca Palette, RAL Classic, Gradients) with a filter.
 * Screen sampling uses the browser's EyeDropper where there is one. State logic: ./model.ts.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
  activeColor, addFavorite, addGradientColor, applySelection, createState, exportSelection, FAVORITE_SLOTS, hslToRgb, normalizeFavorites,
  normalizeSelection, paletteMatches, removeGradientColor, rgbToHsl, selectionBackground, setAlphaPercent, setHex, setMode, setRgb, toHex,
  type PickerOptions, type PickerState, type Selection,
} from './model';
import { PALETTE_LABELS, PALETTES, type PaletteId } from './palettes';
import { readJson, writeJson } from '../../lib/storage';

const props = withDefaults(defineProps<{ selection: Selection; options?: PickerOptions; preserveNotice?: boolean }>(), { options: () => ({}) });
const emit = defineEmits<{ confirm: [Selection]; cancel: [] }>();

const STORE = 'cubby-slicer:color-picker';
interface Stored { favorites?: unknown; sidebar_open?: boolean; palette?: string }
const stored = readJson<Stored>(STORE) ?? {};

const state = reactive(createState(props.options, props.selection) ?? createState(props.options)!) as PickerState;
const original = exportSelection(state)!;
const favorites = ref<Selection[]>(normalizeFavorites(stored.favorites));
const sidebar = ref(stored.sidebar_open === true);
const paletteIds = computed<PaletteId[]>(() => (['basic', 'orca', 'ral', 'gradient'] as PaletteId[]).filter((p) => p !== 'gradient' || state.options.allowGradient));
const palette = ref<PaletteId>(paletteIds.value.includes(stored.palette as PaletteId) ? stored.palette as PaletteId : 'basic');
const searching = ref(false);
const query = ref('');
const tick = ref(0); // bumped on every state change (the state object is mutated in place)
const changed = () => { tick.value++; };
function persist(): void { writeJson(STORE, { favorites: favorites.value, sidebar_open: sidebar.value, palette: palette.value }); }
watch([sidebar, palette], persist);

// ---- HSL memory (hue of greys, hue 360) ----
let hslMemory: [number, number, number] = [0, 0, 50];
function displayHsl(c: readonly number[]): [number, number, number] {
  const rgb = hslToRgb(...hslMemory);
  if (!rgb.every((v, i) => v === c[i])) hslMemory = rgbToHsl(c[0], c[1], c[2]);
  return hslMemory;
}
const color = computed(() => { void tick.value; return [...activeColor(state)]; });
const hsl = computed(() => { void tick.value; return displayHsl(color.value); });
const current = computed(() => { void tick.value; return exportSelection(state); });
function setHslChannel(i: number, v: number): void {
  const next = [...displayHsl(activeColor(state))] as [number, number, number];
  next[i] = v;
  hslMemory = next;
  setRgb(state, hslToRgb(...next));
  changed();
}

// ---- spectrum ----
const canvas = ref<HTMLCanvasElement | null>(null);
let paintedSat = -1;
function paint(): void {
  const cv = canvas.value;
  const ctx = cv?.getContext('2d');
  if (!cv || !ctx) return;
  const r = cv.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(r.width)); cv.height = Math.max(1, Math.round(r.height));
  const hue = ctx.createLinearGradient(0, 0, cv.width, 0);
  for (let i = 0; i <= 6; i++) hue.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
  ctx.fillStyle = hue; ctx.fillRect(0, 0, cv.width, cv.height);
  const shade = ctx.createLinearGradient(0, 0, 0, cv.height);
  shade.addColorStop(0, '#FFFFFF'); shade.addColorStop(0.5, '#FFFFFF00'); shade.addColorStop(0.5, '#00000000'); shade.addColorStop(1, '#000000');
  ctx.fillStyle = shade; ctx.fillRect(0, 0, cv.width, cv.height);
  // The spectrum follows the saturation: desaturating blends toward the row's grey.
  const sat = hsl.value[1];
  if (sat < 100) {
    const grey = ctx.createLinearGradient(0, 0, 0, cv.height);
    grey.addColorStop(0, '#FFFFFF'); grey.addColorStop(1, '#000000');
    ctx.globalAlpha = 1 - sat / 100;
    ctx.fillStyle = grey; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalAlpha = 1;
  }
  paintedSat = sat;
}
watch(() => hsl.value[1], (s) => { if (s !== paintedSat) paint(); });
let ro: ResizeObserver | null = null;
onMounted(() => { nextTick(paint); if (canvas.value) { ro = new ResizeObserver(paint); ro.observe(canvas.value); } });
onBeforeUnmount(() => ro?.disconnect());
const indicator = computed(() => ({ left: `${hsl.value[0] / 360 * 100}%`, top: `${(1 - hsl.value[2] / 100) * 100}%` }));
const round1 = (v: number) => Math.round(v * 10) / 10;
function sample(e: PointerEvent): void {
  const cv = canvas.value!;
  const r = cv.getBoundingClientRect();
  const frac = (client: number, start: number, size: number, px: number) => Math.max(0, Math.min(px - 1, Math.floor((client - start) * px / size))) / Math.max(1, px - 1);
  hslMemory = [round1(frac(e.clientX, r.left, r.width, cv.width) * 360), displayHsl(activeColor(state))[1], round1((1 - frac(e.clientY, r.top, r.height, cv.height)) * 100)];
  setRgb(state, hslToRgb(...hslMemory));
  changed();
}
function specDown(e: PointerEvent): void { canvas.value!.setPointerCapture(e.pointerId); sample(e); }
function specMove(e: PointerEvent): void { if (canvas.value!.hasPointerCapture(e.pointerId)) sample(e); }
function specKey(e: KeyboardEvent): void {
  const step = e.shiftKey ? 10 : 1;
  const [h, s, l] = hsl.value;
  if (e.key === 'ArrowLeft') hslMemory = [Math.max(0, h - step), s, l];
  else if (e.key === 'ArrowRight') hslMemory = [Math.min(360, h + step), s, l];
  else if (e.key === 'ArrowUp') hslMemory = [h, s, Math.min(100, l + step)];
  else if (e.key === 'ArrowDown') hslMemory = [h, s, Math.max(0, l - step)];
  else return;
  e.preventDefault();
  setRgb(state, hslToRgb(...hslMemory));
  changed();
}

// ---- fields ----
const hexText = ref('');
const hexBad = ref(false);
const hexEl = ref<HTMLInputElement | null>(null);
const shownHex = computed(() => toHex(color.value).slice(1, state.options.allowAlpha ? 9 : 7));
watch(shownHex, (h) => { if (document.activeElement !== hexEl.value) { hexText.value = h; hexBad.value = false; } }, { immediate: true });
function onHex(): void {
  const t = hexText.value.trim().replace(/^#/, '');
  const ok = /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(t) && (state.options.allowAlpha || t.length === 6) && setHex(state, `#${t}`);
  hexBad.value = !ok;
  if (ok) changed();
}
const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
function onNum(kind: 'r' | 'g' | 'b' | 'h' | 's' | 'l' | 'o', raw: string): void {
  if (raw === '') return;
  const v = Number(raw);
  if (!Number.isFinite(v)) return;
  if (kind === 'o') { setAlphaPercent(state, clampTo(v, 0, 100)); changed(); return; }
  const i = 'rgb'.indexOf(kind);
  if (i >= 0) { const rgb = color.value.slice(0, 3); rgb[i] = clampTo(v, 0, 255); setRgb(state, rgb); changed(); return; }
  setHslChannel('hsl'.indexOf(kind), clampTo(v, 0, kind === 'h' ? 360 : 100));
}
function wheel(kind: 'r' | 'g' | 'b' | 'h' | 's' | 'l' | 'o', e: WheelEvent, cur: number): void {
  e.preventDefault();
  onNum(kind, String(cur + (e.deltaY > 0 ? -1 : 1)));
}
const rgbFields = computed(() => (['r', 'g', 'b'] as const).map((k, i) => ({ k, label: k.toUpperCase(), title: ['Red', 'Green', 'Blue'][i], v: color.value[i], max: 255 })));
const hslFields = computed(() => (['h', 's', 'l'] as const).map((k, i) => ({ k, label: k.toUpperCase(), title: ['Hue', 'Saturation', 'Lightness'][i], v: Math.round(hsl.value[i]), max: i ? 100 : 360 })));
const alphaPct = computed(() => Math.round(color.value[3] / 255 * 100));
const opacityOpen = ref(false);
const satTrack = computed(() => `linear-gradient(to right, hsl(${hsl.value[0]},0%,${hsl.value[2]}%), hsl(${hsl.value[0]},100%,${hsl.value[2]}%))`);
const opaTrack = computed(() => { const [r, g, b] = color.value; return `linear-gradient(to right, rgba(${r},${g},${b},0), rgb(${r},${g},${b}))`; });

// ---- mode / gradient ----
const gradient = computed(() => { void tick.value; return state.mode === 'gradient'; });
function toggleMode(): void { if (setMode(state, gradient.value ? 'solid' : 'gradient')) { opacityOpen.value = false; changed(); } }
const stops = computed(() => { void tick.value; return state.mode === 'gradient' ? state.gradient!.map((c) => toHex(c)) : []; });
const multi = computed(() => state.maxGradientColors > 2);
function pickStop(i: number): void { state.active = i; changed(); }
function addStop(): void { if (addGradientColor(state)) changed(); }
function removeStop(): void { if (removeGradientColor(state)) changed(); }

// ---- palettes / favourites ----
const entries = computed(() => {
  const q = searching.value ? query.value.trim() : '';
  return (PALETTES[palette.value] ?? []).map((e) => {
    const sel: Selection = { type: e.grad ? 'gradient' : 'solid', colors: e.grad ? e.grad.split('-') : [e.hex!] };
    return { e, sel, ok: !!normalizeSelection(sel, state.options, state.maxGradientColors), bg: selectionBackground(normalizeSelection(sel, { allowGradient: true, allowAlpha: true }, 7) ?? sel) };
  }).filter((x) => x.ok && paletteMatches(x.e, q));
});
function usePalette(x: { e: { hex?: string; grad?: string }; sel: Selection }): void {
  // Solid palette colours edit the active stop while gradient mode is on.
  const ok = x.e.grad ? applySelection(state, x.sel) : setHex(state, x.e.hex!.toUpperCase());
  if (ok) changed();
}
const shownFavorites = computed(() => {
  const vis = favorites.value.filter((f) => normalizeSelection(f, { ...state.options, allowAlpha: true }, state.maxGradientColors));
  return Array.from({ length: FAVORITE_SLOTS }, (_, i) => vis[i] ?? null);
});
function saveFavorite(): void {
  const sel = current.value;
  if (!sel) return;
  favorites.value = addFavorite(favorites.value, sel);
  persist();
}
function useSelection(sel: Selection): void { if (applySelection(state, sel)) changed(); }
function toggleSearch(): void { searching.value = !searching.value; if (!searching.value) query.value = ''; else nextTick(() => filterEl.value?.focus()); }
const filterEl = ref<HTMLInputElement | null>(null);

// ---- screen sampling (EyeDropper API) ----
const canSample = typeof window !== 'undefined' && 'EyeDropper' in window;
async function sampleScreen(): Promise<void> {
  try {
    const r = await new (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper().open();
    const m = /^#?([0-9a-f]{6})/i.exec(r.sRGBHex);
    if (m) { const a = activeColor(state)[3]; setHex(state, `#${m[1]}`); activeColor(state)[3] = a; changed(); }
  } catch { /* cancelled */ }
}

function confirm(): void { const sel = current.value; if (sel && !hexBad.value) emit('confirm', sel); }
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && searching.value) { e.stopPropagation(); toggleSearch(); }
  else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); confirm(); }
}
defineExpose({ confirm });
</script>

<template>
  <div class="cp" :class="{ 'cp--side': sidebar }" data-testid="color-picker" @keydown="onKey">
    <p v-if="preserveNotice" class="cp__notice">The current multi-color selection is kept until you choose a different color.</p>
    <div class="cp__main">
      <div v-if="sidebar" class="cp__left">
        <div class="cp__palette" role="listbox" aria-label="Palette colours">
          <button v-for="x in entries" :key="x.e.name + (x.e.hex ?? x.e.grad)" type="button" class="cp__item" :title="x.e.name" role="option" :aria-selected="false" @click="usePalette(x)">
            <span class="cp__isw" :style="{ background: x.bg }" /><span class="cp__iname">{{ x.e.name }}</span>
          </button>
          <p v-if="!entries.length" class="cp__empty">No matching colors</p>
        </div>
        <div class="cp__ptools">
          <select v-if="!searching" v-model="palette" class="cp__select" aria-label="Palette">
            <option v-for="id in paletteIds" :key="id" :value="id">{{ PALETTE_LABELS[id] }}</option>
          </select>
          <input v-else ref="filterEl" v-model="query" type="search" class="cp__filter" placeholder="Filter colors" aria-label="Filter colors" autocomplete="off" spellcheck="false">
          <button type="button" class="cp__icon" :aria-pressed="searching" :title="searching ? 'Close search' : 'Search colors'" @click="toggleSearch">
            <UIcon :name="searching ? 'i-lucide-x' : 'i-lucide-search'" class="size-4" />
          </button>
        </div>
      </div>

      <div class="cp__right">
        <div class="cp__specrow">
          <input class="cp__sat" type="range" min="0" max="100" step="0.1" :value="hsl[1]" aria-label="Saturation" :style="{ '--track': satTrack }"
                 @input="(e) => setHslChannel(1, Number((e.target as HTMLInputElement).value))">
          <div class="cp__spec">
            <canvas ref="canvas" class="cp__canvas" tabindex="0" aria-label="Hue and lightness" @pointerdown="specDown" @pointermove="specMove" @keydown="specKey" />
            <span class="cp__ind" :style="indicator" />
          </div>
        </div>

        <div class="cp__grid">
          <div class="cp__col">
            <button v-if="state.options.allowGradient" type="button" class="cp__mode" role="switch" :aria-checked="gradient" data-testid="color-mode" @click="toggleMode">
              <span :class="{ on: !gradient }">Solid</span><span :class="{ on: gradient }">Gradient</span>
            </button>
            <div class="cp__hexrow">
              <label class="cp__field cp__field--hex" :class="{ bad: hexBad }"><span>#</span>
                <input ref="hexEl" v-model="hexText" type="text" :maxlength="state.options.allowAlpha ? 9 : 7" aria-label="Hex color" spellcheck="false" autocomplete="off"
                       @input="onHex" @blur="() => { if (!hexBad) hexText = shownHex; }">
              </label>
              <label v-if="state.options.allowAlpha" class="cp__field cp__field--num" title="Opacity percent" @focusin="opacityOpen = true">
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M0,1v10c0,.55.45,1,1,1h10c.55,0,1-.45,1-1V1c0-.55-.45-1-1-1H1C.45,0,0,.45,0,1ZM6,6v5H1v-5h5V1h5v5h-5Z" fill="#999" /></svg>
                <input type="number" min="0" max="100" :value="alphaPct" aria-label="Opacity percent" @input="(e) => onNum('o', (e.target as HTMLInputElement).value)" @wheel="(e) => wheel('o', e, alphaPct)">
              </label>
            </div>
            <div class="cp__third">
              <input v-if="opacityOpen" class="cp__sat cp__opa" type="range" min="0" max="100" step="0.1" :value="color[3] / 255 * 100" aria-label="Opacity"
                     :style="{ '--track': opaTrack }" @input="(e) => { setAlphaPercent(state, Number((e.target as HTMLInputElement).value)); changed(); }" @blur="opacityOpen = false">
              <div v-else class="cp__gbar" :class="{ invisible: !gradient }" role="group" aria-label="Gradient">
                <div class="cp__gtrack" :style="{ background: current ? selectionBackground(current) : undefined }">
                  <button v-for="(c, i) in stops" :key="`${stops.length}-${i}`" type="button" class="cp__gthumb" :class="{ on: state.active === i }"
                          :style="{ left: `calc(10px + (100% - 20px) * ${stops.length > 1 ? i / (stops.length - 1) : 0})`, background: c }"
                          :aria-pressed="state.active === i" :aria-label="stops.length === 2 ? (i ? 'Gradient end' : 'Gradient start') : `Gradient color ${i + 1}`" @click="pickStop(i)" />
                </div>
                <span v-if="multi" class="cp__gbtns">
                  <button v-if="stops.length > 2" type="button" class="cp__gbtn" title="Remove color" aria-label="Remove color" @click="removeStop">−</button>
                  <button type="button" class="cp__gbtn" :aria-disabled="stops.length >= state.maxGradientColors"
                          :title="stops.length >= state.maxGradientColors ? `Up to ${state.maxGradientColors} colors supported.` : 'Add color'" aria-label="Add color" @click="addStop">+</button>
                </span>
              </div>
            </div>
          </div>
          <div class="cp__col">
            <label v-for="f in hslFields" :key="f.k" class="cp__field cp__field--num" :title="f.title"><span>{{ f.label }}</span>
              <input type="number" min="0" :max="f.max" step="1" :value="f.v" :aria-label="f.title" @input="(e) => onNum(f.k, (e.target as HTMLInputElement).value)" @wheel="(e) => wheel(f.k, e, f.v)">
            </label>
          </div>
          <div class="cp__col">
            <label v-for="f in rgbFields" :key="f.k" class="cp__field cp__field--num" :title="f.title"><span>{{ f.label }}</span>
              <input type="number" min="0" :max="f.max" step="1" :value="f.v" :aria-label="f.title" @input="(e) => onNum(f.k, (e.target as HTMLInputElement).value)" @wheel="(e) => wheel(f.k, e, f.v)">
            </label>
          </div>
        </div>

        <div class="cp__bottom">
          <button type="button" class="cp__prev" :title="`Original color\n${original.colors.join(' → ')}`" aria-label="Original color" @click="useSelection(original)">
            <span class="cp__sw" :style="{ background: selectionBackground(original) }" />
            <span class="cp__badge cp__badge--orig"><UIcon name="i-lucide-rotate-ccw" class="size-3" /></span>
          </button>
          <button type="button" class="cp__prev" :title="`Save current color\n${current?.colors.join(' → ') ?? ''}`" aria-label="Save current color" data-testid="color-save" @click="saveFavorite">
            <span class="cp__sw" :style="{ background: current ? selectionBackground(current) : undefined }" />
            <span class="cp__badge"><UIcon name="i-lucide-star" class="size-3" /></span>
          </button>
          <div class="cp__favs" aria-label="Favorite colors">
            <button v-for="(f, i) in shownFavorites" :key="i" type="button" class="cp__fav" :class="{ empty: !f }" :disabled="!f"
                    :title="f ? f.colors.join(' → ') : undefined" :aria-label="f ? `Favorite ${f.colors.join(' to ')}` : 'Empty favorite'" @click="f && useSelection(f)">
              <span v-if="f" class="cp__sw" :style="{ background: selectionBackground(f) }" />
            </button>
          </div>
        </div>

        <div class="cp__actions">
          <button type="button" class="cp__icon" :aria-expanded="sidebar" title="Palettes" aria-label="Palettes" data-testid="color-palettes" @click="sidebar = !sidebar">
            <UIcon name="i-lucide-panel-left" class="size-4" />
          </button>
          <button v-if="canSample" type="button" class="cp__icon" title="Pick color from screen" aria-label="Pick color from screen" @click="sampleScreen">
            <UIcon name="i-lucide-pipette" class="size-4" />
          </button>
          <span class="flex-1" />
          <UButton size="sm" label="OK" :disabled="hexBad || !current" data-testid="color-ok" @click="confirm" />
          <UButton size="sm" color="neutral" variant="outline" label="Cancel" @click="emit('cancel')" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cp { --chk: repeating-conic-gradient(#D9D9D9 0 25%, #FFFFFF 0 50%) 0 0 / 8px 8px; display: flex; flex-direction: column; gap: 8px; padding: 10px; width: 330px; max-width: calc(100vw - 16px); font-size: 12px; color: var(--ui-text); }
.cp--side { width: 520px; }
.cp__notice { font-size: 11px; color: var(--ui-text-muted); }
.cp__main { display: flex; gap: 10px; min-height: 0; }
.cp__left { width: 180px; flex: none; display: flex; flex-direction: column; gap: 6px; }
.cp__palette { flex: 1; min-height: 0; max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; scrollbar-width: thin; }
.cp__item { display: flex; align-items: center; gap: 8px; padding: 3px 4px; border-radius: 4px; text-align: left; cursor: pointer; }
.cp__item:hover, .cp__item:focus-visible { background: var(--ui-bg-elevated); outline: none; }
.cp__isw { width: 16px; height: 16px; border-radius: 3px; flex: none; border: 1px solid var(--ui-border); }
.cp__iname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp__empty { padding: 8px 4px; color: var(--ui-text-muted); }
.cp__ptools { display: flex; gap: 4px; }
.cp__select, .cp__filter { flex: 1; min-width: 0; height: 26px; padding: 0 6px; border: 1px solid var(--ui-border-accented); border-radius: 4px; background: var(--ui-bg); color: var(--ui-text); font-size: 12px; }
.cp__right { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.cp__specrow { display: flex; flex-direction: column; gap: 6px; }
.cp__spec { position: relative; height: 150px; border-radius: 4px; overflow: hidden; }
.cp__canvas { width: 100%; height: 100%; display: block; cursor: crosshair; touch-action: none; }
.cp__canvas:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; }
.cp__ind { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px rgb(0 0 0 / .5); pointer-events: none; }
.cp__sat { appearance: none; width: 100%; height: 12px; border-radius: 6px; background: var(--track); cursor: pointer; }
.cp__opa { background: var(--track), var(--chk); }
.cp__sat::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 1px solid rgb(0 0 0 / .4); }
.cp__sat::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 1px solid rgb(0 0 0 / .4); }
.cp__grid { display: grid; grid-template-columns: 2.1fr 1fr 1fr; gap: 6px; }
.cp__col { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cp__mode { display: flex; height: 24px; padding: 2px; border-radius: 12px; background: var(--ui-bg-elevated); border: 1px solid var(--ui-border); }
.cp__mode span { flex: 1; display: flex; align-items: center; justify-content: center; border-radius: 10px; font-size: 11px; color: var(--ui-text-muted); }
.cp__mode span.on { background: var(--ui-primary); color: var(--ui-bg); }
.cp__hexrow { display: flex; gap: 4px; }
.cp__field { display: flex; align-items: center; gap: 3px; height: 24px; padding: 0 4px; border: 1px solid var(--ui-border-accented); border-radius: 4px; background: var(--ui-bg); min-width: 0; }
.cp__field:focus-within { border-color: var(--ui-primary); }
.cp__field.bad { border-color: var(--ui-error); }
.cp__field span { color: var(--ui-text-muted); font-size: 11px; width: 10px; flex: none; }
.cp__field input { flex: 1; min-width: 0; width: 100%; border: 0; background: transparent; color: var(--ui-text); font: 12px var(--mono, monospace); outline: none; }
.cp__field--hex { flex: 1; }
.cp__field--num input { -moz-appearance: textfield; }
.cp__field--num input::-webkit-inner-spin-button { display: none; }
.cp__hexrow .cp__field--num { width: 50px; flex: none; }
.cp__field--hex input { font-size: 11px; letter-spacing: -.2px; }
.cp__third { height: 24px; display: flex; align-items: center; }
.cp__gbar { display: flex; align-items: center; gap: 4px; width: 100%; }
.cp__gbar.invisible { visibility: hidden; }
.cp__gtrack { position: relative; flex: 1; height: 12px; border-radius: 6px; }
.cp__gthumb { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px rgb(0 0 0 / .45); cursor: pointer; }
.cp__gthumb.on { box-shadow: 0 0 0 2px var(--ui-primary); }
.cp__gbtns { display: flex; gap: 2px; }
.cp__gbtn { width: 18px; height: 18px; border-radius: 4px; border: 1px solid var(--ui-border-accented); line-height: 14px; font-size: 13px; color: var(--ui-text); }
.cp__gbtn[aria-disabled="true"] { opacity: .45; cursor: default; }
.cp__bottom { display: flex; align-items: center; gap: 6px; }
.cp__prev { position: relative; width: 32px; height: 32px; flex: none; border-radius: 50%; overflow: hidden; background: var(--chk); border: 1px solid var(--ui-border-accented); cursor: pointer; }
.cp__prev .cp__sw { position: absolute; inset: 0; }
.cp__badge { position: absolute; right: -1px; bottom: -1px; display: flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; background: #009688; color: #fff; }
.cp__badge--orig { background: #ff6f00; }
.cp__favs { flex: 1; display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; }
.cp__fav { position: relative; aspect-ratio: 1; border-radius: 3px; overflow: hidden; background: var(--chk); border: 1px solid var(--ui-border); cursor: pointer; }
.cp__fav.empty { background: var(--ui-bg-elevated); cursor: default; }
.cp__fav .cp__sw { position: absolute; inset: 0; }
.cp__fav:not(.empty):hover { outline: 2px solid var(--ui-primary); }
.cp__actions { display: flex; align-items: center; gap: 6px; }
.cp__icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 4px; color: var(--ui-text-muted); }
.cp__icon:hover, .cp__icon[aria-expanded="true"], .cp__icon[aria-pressed="true"] { background: var(--ui-bg-elevated); color: var(--ui-text); }
/* Phones (the popover is a bottom sheet): the palette above the editor, touch-sized stops and swatches
   instead of the dialogs' blanket 40 px minimum (src/style.css), which would break the rows apart. */
@media (max-width: 640px), (max-height: 500px) {
  .cp, .cp--side { width: 100%; max-width: none; }
  .cp__main { flex-direction: column; }
  .cp__left { width: auto; }
  .cp__palette { max-height: 140px; }
  .cp .cp__gthumb.cp__gthumb, .cp .cp__fav.cp__fav, .cp .cp__gbtn.cp__gbtn, .cp .cp__prev.cp__prev { min-height: 0; min-width: 0; }
  .cp__gthumb { width: 22px; height: 22px; margin: -11px 0 0 -11px; }
  .cp__gtrack { height: 16px; }
  .cp__third { height: 32px; }
  .cp__gbtn { width: 30px; height: 30px; font-size: 16px; }
  .cp__prev { width: 40px; height: 40px; }
  .cp__favs { grid-template-columns: repeat(8, minmax(0, 1fr)); }
  .cp__field { height: auto; }
  .cp__spec { height: 130px; }
  .cp__hexrow .cp__field--num { width: 66px; }
  .cp__grid { grid-template-columns: 1.9fr 1fr 1fr; }
}
</style>

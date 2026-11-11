<script setup lang="ts">
/**
 * Add / edit a mixed filament, laid out like Orca's MixedFilamentDialog:
 * Effect Preview on the left; on the right the summary, "Select Mixed
 * Materials" (2–3 physical filaments of one type, + Add Material / - Delete
 * Material), "Gradient Effect" with its direction and the draggable gradient
 * curve (two filaments), the Ratio bar (two filaments) or the triangle picker
 * (three), each percentage click-to-type; then the Mixing Recommendations and
 * the type warning. "Match a colour" is Orca's ColorDecomposeDialog recipe.
 *
 * A curve read from a project is kept exactly (values and tangents) until it
 * is edited; Orca's direction switch mirrors the curve instead of resetting it.
 */
import { computed, reactive, ref, watch } from 'vue';
import AppDialog from '../ui/AppDialog.vue';
import { currentPresets } from '../presets/store';
import { linearCurve, pigmentLerp, type GradientAnchor } from './mixer';
import { defError, MAX_COMPONENTS, MIN_COMPONENT_RATIO, mixedColour, mixedRamp, recommendations, type MixedDef } from './model';
import { addMixedFilament, physicalTypes, updateMixedFilament, type MixedFilament } from './store';
import { mixedRecommend } from '../engine/client';
import { parseColour, toHex } from '../lib/colour';
import { reversePoints } from './curveEdit';
import { applyManualRatio, barRatio } from './ratioEdit';
import GradientCurveEditor from './GradientCurveEditor.vue';
import TrianglePicker from './TrianglePicker.vue';
import RatioLabel from './RatioLabel.vue';

const props = defineProps<{ target: MixedFilament | 'new' | null }>();
const emit = defineEmits<{ close: [] }>();

const open = computed({ get: () => props.target !== null, set: (v: boolean) => { if (!v) emit('close'); } });
const p = computed(() => currentPresets.value);
const colours = computed(() => p.value.physicalColours());
const types = computed(() => physicalTypes());
const nameOf = (c: number) => p.value.infos.value.filaments[c - 1]?.name ?? `Filament ${c}`;
const colourOf = (c: number) => (c >= 1 ? colours.value[c - 1] : undefined) ?? '#D9D9D9';

const d = reactive<MixedDef>(blank());

function blank(): MixedDef {
  return { components: [1, 2], ratios: [50, 50], gradient: false, direction: 'ab', curve: [], perPart: false };
}

watch(() => props.target, (t) => {
  const src = t && t !== 'new' ? t : blank();
  // The curve's anchors are copied as they are: an unedited curve saves back byte for byte.
  Object.assign(d, { ...src, components: [...src.components], ratios: [...src.ratios], curve: src.curve.map((a) => ({ ...a })) });
  if (d.components.length < 2) Object.assign(d, blank());
}, { immediate: true });

const title = computed(() => (props.target && props.target !== 'new' ? 'Edit Mixed Filament' : 'Add Mixed Filament'));
const two = computed(() => d.components.length === 2);
const three = computed(() => d.components.length >= 3);

// ---- materials (rebuild_all_combos: a combo lists the filaments the others don't use; other types dimmed) ----
function itemsFor(i: number) {
  const others = d.components.filter((_, k) => k !== i);
  const otherTypes = new Set(others.filter((c) => c >= 1 && c <= types.value.length).map((c) => types.value[c - 1] || 'PLA'));
  const items = colours.value.map((_, j) => j + 1).filter((c) => !others.includes(c)).map((c) => {
    const t = types.value[c - 1] || 'PLA';
    const dim = otherTypes.size > 0 && !otherTypes.has(t);
    return { value: c, label: `${c} · ${nameOf(c)}${types.value[c - 1] ? ` (${types.value[c - 1]})` : ''}`, class: dim ? 'opacity-50' : undefined };
  });
  return d.components[i] === 0 ? [{ value: 0, label: '-- Select --' }, ...items] : items;
}
const canAdd = computed(() => d.components.length < MAX_COMPONENTS && colours.value.length > d.components.length);
const addTip = computed(() => (canAdd.value ? '' : three.value ? 'Maximum 3 materials for mixing' : 'Maximum number of components reached'));
function addMaterial(): void {
  if (!canAdd.value) return;
  const next = colours.value.findIndex((_, i) => !d.components.includes(i + 1));
  if (next < 0) return;
  const n = d.components.length;
  d.components.push(next + 1);
  // on_add_material: 100 / (n + 1) each, the new one takes the rest.
  const each = Math.trunc(100 / (n + 1));
  d.ratios = [...new Array<number>(n).fill(each), 100 - each * n];
  d.gradient = false;
  d.perPart = false;
}
function deleteMaterial(): void {
  if (d.components.length <= 2) return;
  d.components.splice(2);
  d.ratios = [50, 50];
}

// ---- ratios ----
function setRatio(i: number, v: number): void { d.ratios = applyManualRatio(d.ratios, i, v); }
const bar = ref<HTMLElement | null>(null);
let barDrag = false;
function barAt(e: PointerEvent): void {
  const b = bar.value!.getBoundingClientRect();
  const r = barRatio(e.clientX - b.left, b.width);
  d.ratios = [r, 100 - r];
}
function barDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  barDrag = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  barAt(e);
}
function barMove(e: PointerEvent): void { if (barDrag) barAt(e); }
function barUp(e: PointerEvent): void {
  barDrag = false;
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
}
function barKey(e: KeyboardEvent): void {
  const step = e.shiftKey ? 10 : 1;
  // The bar runs from the first filament (left) to the second (right): right = more of the second.
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setRatio(0, d.ratios[0] - step);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setRatio(0, d.ratios[0] + step);
  else if (e.key === 'Home') setRatio(0, 100 - MIN_COMPONENT_RATIO);
  else if (e.key === 'End') setRatio(0, MIN_COMPONENT_RATIO);
  else return;
  e.preventDefault();
}
/** draw_mixed_ratio_blend_bar: the pigment blend from the first filament (left) to the second (right). */
const barCss = computed(() => {
  const a = parseColour(colourOf(d.components[0])), b = parseColour(colourOf(d.components[1]));
  if (!a || !b) return 'transparent';
  const stops = Array.from({ length: 17 }, (_, i) => {
    const m = pigmentLerp([a.r, a.g, a.b], [b.r, b.g, b.b], i / 16);
    return `${toHex({ r: m[0], g: m[1], b: m[2] })} ${(i / 16 * 100).toFixed(1)}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
});

// ---- gradient ----
const directionItems = computed(() => [
  { value: 'ab', from: d.components[0], to: d.components[1] },
  { value: 'ba', from: d.components[1], to: d.components[0] },
].map((it) => ({ ...it, label: `${it.from} → ${it.to}` })));
/** The curve the editor shows: the stored one, or the direction's straight line. */
const editorPoints = computed<GradientAnchor[]>(() => (d.curve.length >= 2 ? d.curve : linearCurve(d.direction)));
function onCurve(pts: GradientAnchor[]): void { d.curve = pts; }
/** on_gradient_direction_changed: mirror the curve so shape work survives the switch. */
function setDirection(v: 'ab' | 'ba'): void {
  if (v === d.direction) return;
  d.direction = v;
  if (d.curve.length >= 2) d.curve = reversePoints(d.curve);
}
watch(() => d.gradient, (g) => { if (!g) d.perPart = false; });

const result = computed<MixedDef>(() => {
  const gradient = d.gradient && two.value;
  return {
    components: [...d.components], ratios: [...d.ratios], gradient, direction: d.direction,
    curve: gradient ? d.curve : [], perPart: gradient && d.perPart,
  };
});
const error = computed(() => defError(result.value, types.value));
const blended = computed(() => mixedColour(result.value, colours.value));
const ramp = computed(() => mixedRamp(result.value, colours.value, 80));
const preview = computed(() => {
  if (!ramp.value.length) return blended.value;
  const step = 100 / ramp.value.length;
  return `linear-gradient(to top, ${ramp.value.map((c, i) => `${c} ${(i * step).toFixed(1)}% ${((i + 1) * step).toFixed(1)}%`).join(', ')})`;
});
/** Summary (A → B for a gradient, else each with its share). */
const summary = computed(() => {
  if (d.gradient && two.value) {
    const [a, b] = d.direction === 'ab' ? d.components : [d.components[1], d.components[0]];
    return { gradient: true, items: [{ c: a, pct: null as number | null }, { c: b, pct: null as number | null }] };
  }
  return { gradient: false, items: d.components.map((c, i) => ({ c, pct: d.ratios[i] as number | null })) };
});

// ---- recommendations ----
const recs = computed(() => recommendations(colours.value, types.value, three.value));
function pick(r: { components: number[]; ratios: number[] }): void {
  d.components = [...r.components];
  d.ratios = [...r.ratios];
  if (d.components.length > 2) { d.gradient = false; d.perPart = false; }
}

// ---- match a colour (ColorDecomposeDialog: the engine's recipe from the physical filaments) ----
const matchTarget = ref('#808080');
const matching = ref(false);
const matchNote = ref('');
async function matchColour(): Promise<void> {
  matching.value = true;
  matchNote.value = '';
  try {
    const r = await mixedRecommend({
      target: matchTarget.value, mode: 'filaments', materialType: types.value[d.components[0] - 1] || undefined,
      filaments: colours.value.map((color, i) => ({ color, type: types.value[i] || 'PLA', name: p.value.infos.value.filaments[i]?.name })),
    });
    const comps = r.components.filter((c) => c.filament >= 1 && c.ratio > 0).slice(0, MAX_COMPONENTS);
    if (!r.valid || comps.length < 2) { matchNote.value = 'No mix of these filaments comes close to that colour.'; return; }
    d.components = comps.map((c) => c.filament);
    // Whole percent, each at least the minimum, summing to 100 (the last takes the rounding).
    const raw = comps.map((c) => Math.max(MIN_COMPONENT_RATIO, Math.round(c.ratio)));
    raw[raw.length - 1] = Math.max(MIN_COMPONENT_RATIO, 100 - raw.slice(0, -1).reduce((a, b) => a + b, 0));
    d.ratios = raw;
    if (d.components.length > 2) d.gradient = false;
    matchNote.value = `Closest mix: ${r.color.toUpperCase()}`;
  } catch (e) {
    matchNote.value = `Couldn't match the colour: ${(e as Error).message}`;
  } finally { matching.value = false; }
}

function save(): void {
  if (error.value) return;
  const t = props.target;
  if (t && t !== 'new') updateMixedFilament(t.id, result.value);
  else addMixedFilament(result.value);
  emit('close');
}
</script>

<template>
  <AppDialog v-model:open="open" :title="title" size="xl" fullscreen confirm-label="OK" test-id="mixed-editor"
             :confirm-disabled="!!error" @confirm="save">
   <div class="me">
    <div class="me__top">
      <div class="me__preview">
        <div class="me__swatch" :style="{ background: preview }" role="img" data-testid="mixed-preview"
             :aria-label="`Colour ${blended}${ramp.length ? ' along the height, bottom to top' : ''}`" />
        <span class="me__muted">Effect Preview</span>
      </div>

      <div class="me__right">
        <div class="me__summary" data-testid="mixed-summary">
          <template v-for="(it, i) in summary.items" :key="i">
            <span v-if="i > 0" class="me__sym">{{ summary.gradient ? '→' : '+' }}</span>
            <span class="me__chip" :style="{ background: colourOf(it.c) }"><span>{{ it.c || '?' }}</span></span>
            <span v-if="it.pct !== null" class="me__pct">{{ it.pct }}%</span>
          </template>
        </div>

        <span class="me__muted">Select Mixed Materials</span>
        <div v-for="(_c, i) in d.components" :key="i" class="me__row">
          <span class="me__rowlbl">Filament {{ i + 1 }}</span>
          <USelect v-model="d.components[i]" :items="itemsFor(i)" value-key="value" size="sm" class="min-w-0 flex-1" :aria-label="`Filament ${i + 1}`">
            <template #leading>
              <span class="me__sw" :style="{ background: colourOf(d.components[i]) }" />
            </template>
          </USelect>
        </div>
        <div class="me__btns">
          <UButton size="sm" color="neutral" variant="outline" label="+ Add Material" block :disabled="!canAdd" :title="addTip || undefined" @click="addMaterial" />
          <UButton v-if="three" size="sm" color="neutral" variant="outline" label="- Delete Material" block title="Remove the third material" @click="deleteMaterial" />
        </div>

        <template v-if="two">
          <div class="me__row me__grad">
            <UCheckbox v-model="d.gradient" label="Gradient Effect" />
            <USelect v-if="d.gradient" :model-value="d.direction" :items="directionItems" value-key="value" size="sm" class="w-36"
                     aria-label="Gradient direction (bottom to top)" @update:model-value="(v: unknown) => setDirection(v as 'ab' | 'ba')">
              <template #default="{ modelValue }">
                <span v-for="it in directionItems.filter((x) => x.value === modelValue)" :key="it.value" class="me__dir">
                  <span class="me__chip me__chip--sm" :style="{ background: colourOf(it.from) }"><span>{{ it.from }}</span></span>→
                  <span class="me__chip me__chip--sm" :style="{ background: colourOf(it.to) }"><span>{{ it.to }}</span></span>
                </span>
              </template>
              <template #item-label="{ item }">
                <span class="me__dir">
                  <span class="me__chip me__chip--sm" :style="{ background: colourOf(item.from) }"><span>{{ item.from }}</span></span>→
                  <span class="me__chip me__chip--sm" :style="{ background: colourOf(item.to) }"><span>{{ item.to }}</span></span>
                </span>
              </template>
            </USelect>
          </div>
          <GradientCurveEditor v-if="d.gradient" :points="editorPoints" :color-low="colourOf(d.components[0])" :color-high="colourOf(d.components[1])"
                               :label-low="`Filament ${d.components[0]}`" :label-high="`Filament ${d.components[1]}`" @update:points="onCurve" />
          <UCheckbox v-if="d.gradient" v-model="d.perPart" label="Enable per-part gradient effect" />
        </template>

        <div v-if="two && !d.gradient" class="me__ratio">
          <span class="me__muted">Ratio</span>
          <div ref="bar" class="me__bar" :style="{ background: barCss }" role="slider" tabindex="0" data-testid="mixed-ratio-bar"
               :aria-valuenow="d.ratios[0]" :aria-valuemin="MIN_COMPONENT_RATIO" :aria-valuemax="100 - MIN_COMPONENT_RATIO"
               :aria-valuetext="`Filament ${d.components[0]} ${d.ratios[0]} %, filament ${d.components[1]} ${d.ratios[1]} %`" aria-label="Mixing ratio"
               @pointerdown="barDown" @pointermove="barMove" @pointerup="barUp" @pointercancel="barUp" @keydown="barKey">
            <span class="me__div" :style="{ left: `${d.ratios[1]}%` }" />
          </div>
          <div class="me__ends">
            <RatioLabel :value="d.ratios[0]" :label="`Filament ${d.components[0]} share`" @commit="(v) => setRatio(0, v)" />
            <RatioLabel :value="d.ratios[1]" :label="`Filament ${d.components[1]} share`" @commit="(v) => setRatio(1, v)" />
          </div>
        </div>

        <TrianglePicker v-if="three" class="self-center" :colours="[colourOf(d.components[0]), colourOf(d.components[1]), colourOf(d.components[2])]"
                        :ratios="d.ratios" :names="[`Filament ${d.components[0]}`, `Filament ${d.components[1]}`, `Filament ${d.components[2]}`]"
                        @drag="(r) => (d.ratios = [...r])" @edit="setRatio" />
      </div>
    </div>

    <div v-if="recs.length" class="me__sec">
      <div class="me__rule"><span>Mixing Recommendations</span></div>
      <div class="me__recs">
        <button v-for="(r, i) in recs" :key="i" type="button" class="me__rec" :style="{ background: r.color }"
                :title="r.components.map((c) => nameOf(c)).join(' + ')"
                :aria-label="`Use ${r.components.map((c, k) => `filament ${c} ${r.ratios[k]} %`).join(', ')}`" @click="pick(r)" />
      </div>
    </div>

    <div v-if="colours.length >= 2" class="me__sec">
      <div class="me__rule"><span>Match a colour</span></div>
      <div class="me__row">
        <input v-model="matchTarget" type="color" class="me__pick" aria-label="Colour to match">
        <UButton size="xs" variant="soft" icon="i-lucide-pipette" label="Find mix" :loading="matching" @click="matchColour" />
        <span v-if="matchNote" class="me__hint" data-testid="mixed-match-note">{{ matchNote }}</span>
      </div>
    </div>

    <div v-if="error" class="me__warn" role="alert" data-testid="mixed-error"><span class="me__bang">!</span>{{ error }}</div>
   </div>
  </AppDialog>
</template>

<style scoped>
.me { display: flex; flex-direction: column; gap: 14px; }
.me__top { display: flex; gap: 20px; align-items: flex-start; }
.me__preview { flex: none; width: 129px; display: flex; flex-direction: column; align-items: center; gap: 4px; padding-top: 24px; }
.me__swatch { width: 80px; height: 80px; border-radius: 6px; border: 1px solid var(--ui-border); }
.me__right { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.me__summary { display: flex; align-items: center; gap: 4px; min-height: 40px; padding: 0 13px; background: var(--ui-bg-elevated); border-radius: 4px; font-size: var(--fs-sm); color: var(--ui-text-highlighted); }
.me__sym { padding: 0 2px; }
.me__pct { margin-right: 4px; font-variant-numeric: tabular-nums; }
.me__chip { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 4px; border: 1px solid var(--line-strong); flex: none; }
.me__chip > span { font-size: 10px; font-weight: 600; color: #fff; text-shadow: 0 0 2px #000, 0 0 1px #000; }
.me__chip--sm { width: 18px; height: 18px; }
.me__muted { font-size: var(--fs-xs); color: var(--ui-text-muted); }
.me__row { display: flex; align-items: center; gap: 8px; }
.me__rowlbl { width: 64px; flex: none; font-size: var(--fs-sm); color: var(--ui-text-toned); }
.me__btns { display: flex; gap: 6px; }
.me__grad { justify-content: flex-start; gap: 12px; min-height: 32px; }
.me__dir { display: inline-flex; align-items: center; gap: 6px; }
.me__sw { width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--line-strong); display: inline-block; }
.me__ratio { display: flex; flex-direction: column; gap: 4px; }
.me__bar { position: relative; height: 27px; border-radius: 3px; cursor: ew-resize; touch-action: none; }
.me__bar:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
/* The divider keeps its contrast over filament colour in both themes (Orca: grey 4 px under white 2 px). */
.me__div { position: absolute; top: 0; bottom: 0; width: 4px; margin-left: -2px; background: #505050; pointer-events: none; }
.me__div::after { content: ''; position: absolute; top: 0; bottom: 0; left: 1px; width: 2px; background: #fff; }
.me__ends { display: flex; justify-content: space-between; }
.me__sec { display: flex; flex-direction: column; gap: 6px; }
.me__rule { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--ui-text-dimmed); }
.me__rule::after { content: ''; flex: 1; height: 1px; background: var(--ui-border); }
.me__recs { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; max-height: 116px; overflow-y: auto; background: var(--ui-bg-elevated); border-radius: 4px; }
.me__rec { width: 20px; height: 20px; border-radius: 3px; border: 1px solid var(--line-strong); cursor: pointer; }
.me__rec:hover, .me__rec:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 1px; }
.me__pick { width: 32px; height: 24px; padding: 0; border: 1px solid var(--line-strong); border-radius: 4px; background: none; flex: none; }
.me__hint { font-size: var(--fs-xs); color: var(--ui-text-muted); }
.me__warn { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 8px 10px; border: 1px solid #D01B1B; border-radius: 4px; background: var(--ui-bg-elevated); font-size: var(--fs-xs); color: #D01B1B; }
.me__bang { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 14px; height: 14px; border-radius: 50%; background: #D01B1B; color: #fff; font-size: 10px; font-weight: 700; }
/* Phones: preview above the form. */
@media (max-width: 640px) {
  .me__top { flex-direction: column; align-items: stretch; gap: 10px; }
  .me__preview { width: auto; flex-direction: row; justify-content: center; padding-top: 0; gap: 10px; }
  .me__swatch { width: 56px; height: 56px; }
}
/* Phones (incl. landscape): a touch-sized colour picker. */
@media (max-width: 640px), (max-height: 500px) {
  .me__pick { width: 44px; height: 40px; }
}
</style>

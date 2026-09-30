<script setup lang="ts">
/**
 * Edit / create a Full Spectrum mixed filament (FullSpectrum
 * MixedFilamentDialog): a static blend of 2+ filaments, a gradient along Z
 * (2 colours: A share from bottom to top; 3+: ordered stops with a solid
 * window per interior colour), or a manual layer pattern. Advanced: layer
 * cadence, Local-Z sublayer cap and per-filament surface bias.
 */
import { computed, reactive, ref, watch } from 'vue';
import { mobileDialog } from '../ui/mobileDialog';
import { currentPresets } from '../presets/store';
import { previewBackground } from './preview';
import { editMixedFilaments, filamentColourOf, type MixedDefinition, type MixedFilament } from './store';

const props = defineProps<{ target: MixedFilament | 'new' | null }>();
const emit = defineEmits<{ close: [] }>();

const open = computed({ get: () => props.target !== null, set: (v: boolean) => { if (!v) emit('close'); } });
const p = computed(() => currentPresets.value);
const physical = computed(() => p.value.selection.filaments.length);
const filamentItems = computed(() => p.value.selection.filaments.map((_, i) => ({ value: i + 1, label: `Filament ${i + 1}` })));

type Mode = 'blend' | 'gradient' | 'pattern';
const d = reactive<MixedDefinition>(blank());
const mode = ref<Mode>('blend');
const patternText = ref('');
const busy = ref(false);
const advanced = ref(false);

function blank(): MixedDefinition {
  return {
    kind: 'blend', components: [{ id: 1, percent: 50 }, { id: 2, percent: 50 }], distribution: 'simple', cadence: { a: 1, b: 1 },
    localZMax: 0, gradient: { enabled: false, start: 1, end: 0, stops: [], solidWidths: [] }, offsets: [], offsetA: 0, offsetB: 0,
    perimeterModulation: false, pattern: [],
  };
}

watch(() => props.target, (t) => {
  const src: MixedDefinition = t && t !== 'new' ? JSON.parse(JSON.stringify(t)) : blank();
  Object.assign(d, blank(), src);
  if (d.components.length < 2) d.components = [{ id: 1, percent: 50 }, { id: Math.min(2, physical.value), percent: 50 }];
  mode.value = d.kind === 'pattern' ? 'pattern' : d.gradient.enabled ? 'gradient' : 'blend';
  patternText.value = d.pattern.map((g) => g.join('')).join(', ') || '1122';
  advanced.value = false;
}, { immediate: true });

const title = computed(() => { const t = props.target; return !t || t === 'new' ? 'New mixed filament' : `Mixed filament ${t.id}`; });

// ---- components ----
function addComponent(): void {
  const used = new Set(d.components.map((c) => c.id));
  const next = filamentItems.value.find((f) => !used.has(f.value))?.value ?? 1;
  d.components.push({ id: next, percent: Math.round(100 / (d.components.length + 1)) });
  normalise();
  d.gradient.stops = [];
}
function removeComponent(i: number): void {
  if (d.components.length <= 2) return;
  d.components.splice(i, 1);
  normalise();
  d.gradient.stops = [];
}
function moveComponent(i: number, dir: -1 | 1): void {
  const j = i + dir;
  if (j < 0 || j >= d.components.length) return;
  [d.components[i], d.components[j]] = [d.components[j], d.components[i]];
}
/** Keep weights summing to 100 (the last one takes the remainder). */
function normalise(changed?: number): void {
  const n = d.components.length;
  if (changed === undefined) { d.components.forEach((c, i) => { c.percent = i < n - 1 ? Math.floor(100 / n) : 100 - Math.floor(100 / n) * (n - 1); }); return; }
  const rest = 100 - d.components[changed].percent;
  const others = d.components.filter((_, i) => i !== changed);
  const sum = others.reduce((a, c) => a + c.percent, 0) || others.length;
  let left = rest;
  others.forEach((c, k) => { c.percent = k === others.length - 1 ? Math.max(0, left) : Math.round((c.percent / sum) * rest); left -= c.percent; });
}
function setWeight(i: number, v: number): void { d.components[i].percent = Math.max(0, Math.min(100, Math.round(v))); normalise(i); }
const duplicate = computed(() => new Set(d.components.map((c) => c.id)).size !== d.components.length);

// ---- gradient ----
const multi = computed(() => d.components.length > 2);
/** Stops for N components: anchor, midpoint, anchor, … (2N-1), initialised evenly. */
const stops = computed<number[]>(() => {
  const n = d.components.length;
  if (d.gradient.stops.length === 2 * n - 1) return d.gradient.stops;
  return Array.from({ length: 2 * n - 1 }, (_, i) => i / (2 * n - 2));
});
function setStop(i: number, v: number): void {
  const s = stops.value.slice();
  const lo = i > 0 ? s[i - 1] : 0, hi = i < s.length - 1 ? s[i + 1] : 1;
  s[i] = Math.max(lo, Math.min(hi, v / 100));
  d.gradient.stops = s;
}
const stopLabel = (i: number) => (i % 2 === 0 ? `F${d.components[i / 2]?.id} at` : `F${d.components[(i - 1) / 2]?.id}/F${d.components[(i + 1) / 2]?.id} midpoint`);
const widths = computed(() => d.components.map((_, i) => Math.round((d.gradient.solidWidths[i] ?? 0) * 100)));
function setWidth(i: number, v: number): void {
  const w = d.components.map((_, k) => d.gradient.solidWidths[k] ?? 0);
  w[i] = Math.max(0, Math.min(1, v / 100));
  d.gradient.solidWidths = w.every((x) => x === 0) ? [] : w;
}

// ---- pattern ----
const patternGroups = computed<number[][] | null>(() => {
  const groups = patternText.value.split(/[,;/]+/).map((g) => g.trim()).filter(Boolean)
    .map((g) => [...g.matchAll(/\[(\d+)\]|(\d)/g)].map((m) => Number(m[1] ?? m[2])));
  if (!groups.length || groups.some((g) => !g.length || g.some((x) => x < 1 || x > physical.value))) return null;
  return groups;
});

// ---- offsets ----
const offsets = computed(() => d.components.map((_, i) => d.offsets[i] ?? (i === 0 ? d.offsetA : d.offsetB)));
function setOffset(i: number, v: number): void {
  const o = offsets.value.slice();
  o[i] = Math.max(-2, Math.min(2, Number.isFinite(v) ? v : 0));
  d.offsets = o;
}

const preview = computed(() => previewBackground({ ...d, kind: mode.value === 'pattern' ? 'pattern' : 'blend', gradient: { ...d.gradient, enabled: mode.value === 'gradient', stops: multi.value ? stops.value : d.gradient.stops }, pattern: patternGroups.value ?? [] }, filamentColourOf));
const valid = computed(() => mode.value === 'pattern' ? !!patternGroups.value : !duplicate.value && d.components.length >= 2);

async function save(): Promise<void> {
  if (!valid.value) return;
  const def: Partial<MixedDefinition> = {
    kind: mode.value === 'pattern' ? 'pattern' : 'blend',
    components: d.components.map((c) => ({ id: c.id, percent: c.percent })),
    distribution: d.distribution, cadence: { ...d.cadence }, localZMax: d.localZMax,
    gradient: { ...d.gradient, enabled: mode.value === 'gradient', stops: mode.value === 'gradient' && multi.value ? stops.value : d.gradient.stops },
    offsets: d.offsets, perimeterModulation: d.perimeterModulation,
    pattern: mode.value === 'pattern' ? patternGroups.value ?? [] : [],
  };
  if (mode.value === 'pattern' && patternGroups.value) {
    // The pattern's filaments are also its aggregate blend (UI summaries, display colour).
    const ids = [...new Set(patternGroups.value.flat())];
    const all = patternGroups.value.flat();
    if (ids.length >= 2) def.components = ids.map((id) => ({ id, percent: Math.round((all.filter((x) => x === id).length / all.length) * 100) }));
  }
  busy.value = true;
  const ok = await editMixedFilaments([props.target === 'new' || !props.target
    ? { op: 'add_definition', definition: def }
    : { op: 'set', stableId: props.target.stableId, definition: def }]);
  busy.value = false;
  if (ok) emit('close');
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :fullscreen="mobileDialog" :ui="{ content: 'sm:max-w-xl', body: 'flex gap-4' }">
    <template #body>
      <div class="me__strip" :style="{ background: preview }" role="img" aria-label="Colour along the height (bottom to top)">
        <span class="me__top">top</span><span class="me__bot">bottom</span>
      </div>
      <div class="me__form">
        <URadioGroup v-model="mode" orientation="horizontal" size="sm" aria-label="Kind"
                     :items="[{ value: 'blend', label: 'Blend' }, { value: 'gradient', label: 'Gradient' }, { value: 'pattern', label: 'Pattern' }]" />

        <template v-if="mode !== 'pattern'">
          <div class="me__sec">
            <div class="me__head">
              <span>{{ mode === 'gradient' ? 'Colours, bottom to top' : 'Filaments' }}</span>
              <UButton size="xs" variant="ghost" icon="i-lucide-plus" label="Filament" :disabled="d.components.length >= physical" @click="addComponent" />
            </div>
            <div v-for="(c, i) in d.components" :key="i" class="me__comp">
              <span class="me__sw" :style="{ background: filamentColourOf(c.id) }" />
              <USelect v-model="c.id" :items="filamentItems" value-key="value" size="xs" class="w-32" :aria-label="`Component ${i + 1} filament`" />
              <template v-if="mode === 'blend'">
                <USlider :model-value="c.percent" :min="0" :max="100" :step="1" size="xs" class="flex-1" :aria-label="`Component ${i + 1} share`"
                         @update:model-value="(v: unknown) => setWeight(i, Number(v))" />
                <span class="me__num">{{ c.percent }}%</span>
              </template>
              <template v-else>
                <span class="flex-1" />
                <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-up" square :disabled="i === d.components.length - 1" aria-label="Move up (later)" @click="moveComponent(i, 1)" />
                <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-down" square :disabled="i === 0" aria-label="Move down (earlier)" @click="moveComponent(i, -1)" />
              </template>
              <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-x" square :disabled="d.components.length <= 2" :aria-label="`Remove component ${i + 1}`" @click="removeComponent(i)" />
            </div>
            <p v-if="duplicate" class="me__err">Use each filament once.</p>
          </div>

          <div v-if="mode === 'gradient'" class="me__sec">
            <div class="me__head"><span>Gradient</span></div>
            <template v-if="!multi">
              <div class="me__row">
                <span class="me__lbl">Bottom</span>
                <USlider :model-value="Math.round(d.gradient.start * 100)" :min="0" :max="100" size="xs" class="flex-1" aria-label="First filament share at the bottom"
                         @update:model-value="(v: unknown) => { d.gradient.start = Number(v) / 100; }" />
                <span class="me__num">F{{ d.components[0].id }} {{ Math.round(d.gradient.start * 100) }}%</span>
              </div>
              <div class="me__row">
                <span class="me__lbl">Top</span>
                <USlider :model-value="Math.round(d.gradient.end * 100)" :min="0" :max="100" size="xs" class="flex-1" aria-label="First filament share at the top"
                         @update:model-value="(v: unknown) => { d.gradient.end = Number(v) / 100; }" />
                <span class="me__num">F{{ d.components[0].id }} {{ Math.round(d.gradient.end * 100) }}%</span>
              </div>
            </template>
            <template v-else>
              <div v-for="(s, i) in stops" :key="i" class="me__row">
                <span class="me__lbl me__lbl--wide">{{ stopLabel(i) }}</span>
                <USlider :model-value="Math.round(s * 100)" :min="0" :max="100" size="xs" class="flex-1" :aria-label="stopLabel(i)"
                         @update:model-value="(v: unknown) => setStop(i, Number(v))" />
                <span class="me__num">{{ Math.round(s * 100) }}%</span>
              </div>
              <div v-for="(w, i) in widths" :key="`w${i}`" class="me__row">
                <span class="me__lbl me__lbl--wide">F{{ d.components[i].id }} solid width</span>
                <USlider :model-value="w" :min="0" :max="50" size="xs" class="flex-1" :aria-label="`Filament ${d.components[i].id} solid width`"
                         @update:model-value="(v: unknown) => setWidth(i, Number(v))" />
                <span class="me__num">{{ w || 'auto' }}{{ w ? '%' : '' }}</span>
              </div>
            </template>
            <p class="me__hint">Gradients print with Local-Z sublayers over the object's height (see Colour mixing settings: gradient Local-Z height, minimum sublayer).</p>
          </div>
        </template>

        <div v-else class="me__sec">
          <div class="me__head"><span>Layer pattern</span></div>
          <UInput v-model="patternText" size="sm" placeholder="1122, 2211" aria-label="Pattern" class="font-mono" />
          <p v-if="!patternGroups" class="me__err">Use filament numbers 1–{{ physical }} (e.g. 1122; [10] for two digits). Separate wall groups with commas.</p>
          <p v-else class="me__hint">Repeats bottom to top, one filament per layer; comma-separated groups apply to successive walls.</p>
        </div>

        <button type="button" class="me__adv" :aria-expanded="advanced" @click="advanced = !advanced">
          <UIcon :name="advanced ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5" /> Advanced
        </button>
        <div v-if="advanced" class="me__sec">
          <div v-if="mode === 'blend' && !multi" class="me__row">
            <span class="me__lbl me__lbl--wide">Distribution</span>
            <USelect v-model="d.distribution" size="xs" class="flex-1" aria-label="Distribution"
                     :items="[{ value: 'simple', label: 'Blend (Local-Z)' }, { value: 'layer_cycle', label: 'Whole-layer cycle' }]" value-key="value" />
          </div>
          <div v-if="mode === 'blend' && d.distribution === 'layer_cycle'" class="me__row">
            <span class="me__lbl me__lbl--wide">Layers of F{{ d.components[0].id }} / F{{ d.components[1].id }}</span>
            <UInputNumber v-model="d.cadence.a" :min="1" :max="100" size="xs" class="w-20" aria-label="Layers of the first filament" />
            <UInputNumber v-model="d.cadence.b" :min="1" :max="100" size="xs" class="w-20" aria-label="Layers of the second filament" />
          </div>
          <div class="me__row">
            <span class="me__lbl me__lbl--wide">Local-Z max sublayers</span>
            <UInputNumber v-model="d.localZMax" :min="0" :max="64" size="xs" class="w-24" aria-label="Local-Z maximum sublayers (0 = no cap)" />
            <span class="me__hint">0 = no cap</span>
          </div>
          <div class="me__head"><span>Surface bias (mm; negative expands, positive recesses)</span></div>
          <div v-for="(c, i) in d.components" :key="`o${i}`" class="me__row">
            <span class="me__sw" :style="{ background: filamentColourOf(c.id) }" />
            <span class="me__lbl">F{{ c.id }}</span>
            <UInputNumber :model-value="offsets[i]" :min="-2" :max="2" :step="0.01" size="xs" class="w-28" :format-options="{ maximumFractionDigits: 2 }"
                          :aria-label="`Filament ${c.id} surface offset`" @update:model-value="(v: unknown) => setOffset(i, Number(v))" />
          </div>
          <UCheckbox v-model="d.perimeterModulation" label="Outer wall only (perimeter modulation)" size="sm" />
          <p class="me__hint">Surface bias applies when "Enable mixed filament bias" is on in the colour mixing settings.</p>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton color="primary" :label="target === 'new' ? 'Add' : 'Save'" :loading="busy" :disabled="!valid" @click="save" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.me__strip { position: relative; width: 44px; flex: none; min-height: 280px; border-radius: var(--radius); border: 1px solid var(--line-strong); }
.me__top, .me__bot { position: absolute; left: 50%; transform: translateX(-50%); font-size: 10px; color: #fff; text-shadow: 0 0 3px #000; }
.me__top { top: 4px; }
.me__bot { bottom: 4px; }
.me__form { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.me__sec { display: flex; flex-direction: column; gap: 6px; }
.me__head { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-sm); font-weight: 600; color: var(--fg-1); }
.me__comp, .me__row { display: flex; align-items: center; gap: 6px; }
.me__sw { width: 16px; height: 16px; border-radius: 4px; border: 1px solid var(--line-strong); flex: none; }
.me__num { width: 64px; text-align: right; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--fg-1); }
.me__lbl { width: 48px; font-size: var(--fs-xs); color: var(--fg-2); flex: none; }
.me__lbl--wide { width: 128px; }
.me__hint { font-size: var(--fs-xs); color: var(--fg-2); }
.me__err { font-size: var(--fs-xs); color: var(--ui-error); }
/* Phones: the strip follows the form's height instead of setting it. */
@media (max-width: 640px), (max-height: 500px) { .me__strip { width: 32px; min-height: 160px; } }
.me__adv { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); color: var(--fg-1); align-self: flex-start; }
</style>

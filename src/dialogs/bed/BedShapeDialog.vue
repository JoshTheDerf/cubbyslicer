<script setup lang="ts">
/**
 * Orca BedShapeDialog: printable area (rectangular: size + origin; circular:
 * diameter; custom: points / loaded from an STL outline), max print height,
 * and a custom bed texture (SVG / PNG) and bed model (STL). Applies to the
 * selected printer preset as unsaved edits (printable_area / printable_height
 * / bed_custom_texture / bed_custom_model; bed_shape / max_print_height on
 * preFlight). Textures and models are stored in this browser (IndexedDB).
 */
import { computed, reactive, ref, watch } from 'vue';
import { phone } from '../../app/shell/uiState';
import { pickFiles } from '../../app/shell/download';
import { parseModelFile } from '../../project/import';
import { currentPresets } from '../../presets/store';
import { asArray, formatNumber } from '../../presets/values';
import { toast } from '../../ui';
import { dialogs } from '../state';
import { bedPoints, convexHullXY, parseBed, parseCustomText, serializeBed, type BedModel, type BedType } from './bedShape';
import { assetLabel, bedAssetUrl, storeBedAsset } from './customBed';

const p = computed(() => currentPresets.value);
const areaKey = computed(() => (p.value.schema.value && !p.value.schema.value.options.printable_area && p.value.schema.value.options.bed_shape ? 'bed_shape' : 'printable_area'));
const heightKey = computed(() => (p.value.schema.value && !p.value.schema.value.options.printable_height && p.value.schema.value.options.max_print_height ? 'max_print_height' : 'printable_height'));
const hasTexture = computed(() => !p.value.schema.value || !!p.value.schema.value.options.bed_custom_texture);
const hasModel = computed(() => !p.value.schema.value || !!p.value.schema.value.options.bed_custom_model);

const model = reactive<BedModel>(parseBed([]));
const customText = ref('');
const height = ref(250);
const texture = ref('');
const bedModel = ref('');
const textureUrl = ref<string | null>(null);
const busy = ref(false);

const single = (v: unknown) => String(Array.isArray(v) ? v[0] ?? '' : v ?? '');
watch(() => dialogs.bedShape, (o) => {
  if (!o) return;
  const m = parseBed(asArray(p.value.value('printer', areaKey.value)));
  Object.assign(model, m);
  customText.value = serializeBed(m.custom.length ? m.custom : bedPoints(m)).join('\n');
  height.value = Number(single(p.value.value('printer', heightKey.value))) || 0;
  texture.value = single(p.value.value('printer', 'bed_custom_texture'));
  bedModel.value = single(p.value.value('printer', 'bed_custom_model'));
});
watch(texture, async (t) => { textureUrl.value = t ? await bedAssetUrl(t) : null; }, { immediate: true });

const typeItems = [
  { value: 'rect', label: 'Rectangular', icon: 'i-lucide-square' },
  { value: 'circle', label: 'Circular', icon: 'i-lucide-circle' },
  { value: 'custom', label: 'Custom', icon: 'i-lucide-pentagon' },
];
const type = computed({ get: () => model.type, set: (t: BedType) => { if (t === 'custom' && model.type !== 'custom') customText.value = serializeBed(bedPoints(model)).join('\n'); model.type = t; } });
const custom = computed(() => parseCustomText(customText.value));
watch(custom, (c) => { if (model.type === 'custom') model.custom = c.pts; });
const pts = computed(() => bedPoints(model));
const invalid = computed(() => (model.type === 'custom' && custom.value.bad) || pts.value.length < 3
  || (model.type === 'rect' && !(model.rect.width > 0 && model.rect.depth > 0)) || (model.type === 'circle' && !(model.circle.diameter > 0)));

const view = computed(() => {
  const all = pts.value.length ? pts.value : [[0, 0], [100, 100]] as Array<[number, number]>;
  const xs = all.map((q) => q[0]), ys = all.map((q) => q[1]);
  const minX = Math.min(...xs, 0), maxX = Math.max(...xs, 0), minY = Math.min(...ys, 0), maxY = Math.max(...ys, 0);
  const pad = Math.max(maxX - minX, maxY - minY) * 0.08 + 1;
  return { x: minX - pad, y: -maxY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad, minX, maxX, minY, maxY };
});
const bounds = computed(() => {
  const xs = pts.value.map((q) => q[0]), ys = pts.value.map((q) => q[1]);
  return xs.length ? { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) } : null;
});
const poly = computed(() => pts.value.map((q) => `${q[0]},${-q[1]}`).join(' '));

async function loadShapeStl(): Promise<void> {
  const [f] = await pickFiles('.stl,.obj,.3mf', false);
  if (!f) return;
  try {
    const r = await parseModelFile(f.name, await f.arrayBuffer());
    const all = r.objects.flatMap((o) => Array.from(o.positions));
    const hull = convexHullXY(all);
    if (hull.length < 3) throw new Error('The model has no usable outline.');
    customText.value = serializeBed(hull).join('\n');
    model.type = 'custom';
  } catch (e) { toast.error(`Couldn’t load ${f.name}.`, { detail: (e as Error)?.message }); }
}

async function pick(kind: 'texture' | 'model'): Promise<void> {
  const [f] = await pickFiles(kind === 'texture' ? '.svg,.png,image/svg+xml,image/png' : '.stl,model/stl', false);
  if (!f) return;
  if (f.size > 32 * 1048576) { toast.error(`${f.name} is too large.`, { detail: 'The limit is 32 MB.' }); return; }
  busy.value = true;
  try {
    const ref = await storeBedAsset(f);
    if (kind === 'texture') texture.value = ref; else bedModel.value = ref;
  } catch (e) {
    toast.error(`Couldn’t store ${f.name}.`, { detail: (e as Error)?.message });
  } finally { busy.value = false; }
}

function apply(): void {
  if (invalid.value) return;
  const pr = p.value;
  pr.setValue('printer', areaKey.value, serializeBed(pts.value));
  if (height.value > 0) pr.setValue('printer', heightKey.value, String(height.value));
  if (hasTexture.value) pr.setValue('printer', 'bed_custom_texture', texture.value);
  if (hasModel.value) pr.setValue('printer', 'bed_custom_model', bedModel.value);
  dialogs.bedShape = false;
}
const num = (v: number | null | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const fmt = formatNumber;
</script>

<template>
  <UModal v-model:open="dialogs.bedShape" title="Bed shape" :description="`Printer: ${p.infos.value.printer.name}`" :fullscreen="phone"
          :ui="{ content: 'sm:max-w-3xl', body: 'flex flex-col gap-4' }">
    <template #body>
      <div class="bs">
        <div class="bs__form">
          <h4>Shape</h4>
          <UTabs v-model="type" :items="typeItems" :content="false" size="xs" />
          <template v-if="model.type === 'rect'">
            <div class="bs__grid">
              <UFormField label="Size X" hint="mm"><UInputNumber :model-value="model.rect.width" :min="1" size="sm" @update:model-value="(v: number | null) => (model.rect.width = num(v, 220))" /></UFormField>
              <UFormField label="Size Y" hint="mm"><UInputNumber :model-value="model.rect.depth" :min="1" size="sm" @update:model-value="(v: number | null) => (model.rect.depth = num(v, 220))" /></UFormField>
              <UFormField label="Origin X" hint="mm"><UInputNumber :model-value="model.rect.originX" size="sm" @update:model-value="(v: number | null) => (model.rect.originX = num(v))" /></UFormField>
              <UFormField label="Origin Y" hint="mm"><UInputNumber :model-value="model.rect.originY" size="sm" @update:model-value="(v: number | null) => (model.rect.originY = num(v))" /></UFormField>
            </div>
            <p class="bs__note">Distance of the coordinates origin (X0 Y0) from the front-left corner of the bed.</p>
          </template>
          <template v-else-if="model.type === 'circle'">
            <UFormField label="Diameter" hint="mm" description="The origin (X0 Y0) is the centre of the bed.">
              <UInputNumber :model-value="model.circle.diameter" :min="1" size="sm" class="w-32" @update:model-value="(v: number | null) => (model.circle.diameter = num(v, 200))" />
            </UFormField>
          </template>
          <template v-else>
            <UFormField label="Points" description="One “XxY” point per line, in mm." :error="custom.bad ? 'Some lines are not valid points.' : undefined">
              <UTextarea v-model="customText" :rows="7" spellcheck="false" class="w-full" :ui="{ base: 'font-mono text-xs' }" />
            </UFormField>
            <UButton size="xs" variant="outline" icon="i-lucide-file-box" label="Load shape from STL…" class="self-start" @click="loadShapeStl" />
          </template>

          <h4>Height</h4>
          <UFormField label="Max print height" hint="mm">
            <UInputNumber :model-value="height" :min="0" size="sm" class="w-32" @update:model-value="(v: number | null) => (height = num(v))" />
          </UFormField>

          <template v-if="hasTexture || hasModel">
            <h4>Appearance</h4>
            <div v-if="hasTexture" class="bs__file">
              <span class="bs__flabel">Texture</span>
              <span class="bs__fname" :title="texture">{{ texture ? assetLabel(texture) : 'Default' }}</span>
              <UButton size="xs" variant="outline" label="Load…" :loading="busy" @click="pick('texture')" />
              <UButton v-if="texture" size="xs" variant="ghost" color="error" icon="i-lucide-x" square aria-label="Remove texture" @click="texture = ''" />
            </div>
            <div v-if="hasModel" class="bs__file">
              <span class="bs__flabel">Model</span>
              <span class="bs__fname" :title="bedModel">{{ bedModel ? assetLabel(bedModel) : 'Default' }}</span>
              <UButton size="xs" variant="outline" label="Load…" :loading="busy" @click="pick('model')" />
              <UButton v-if="bedModel" size="xs" variant="ghost" color="error" icon="i-lucide-x" square aria-label="Remove model" @click="bedModel = ''" />
            </div>
            <p class="bs__note">SVG / PNG texture and STL model, stored in this browser. They replace the printer vendor’s bed visuals.</p>
          </template>
        </div>
        <figure class="bs__preview">
          <svg :viewBox="`${view.x} ${view.y} ${view.w} ${view.h}`" preserveAspectRatio="xMidYMid meet" aria-label="Bed preview">
            <defs><clipPath id="bs-clip"><polygon :points="poly" /></clipPath></defs>
            <image v-if="textureUrl && bounds" :href="textureUrl" :x="bounds.minX" :y="-bounds.maxY" :width="bounds.maxX - bounds.minX" :height="bounds.maxY - bounds.minY"
                   preserveAspectRatio="none" clip-path="url(#bs-clip)" opacity="0.9" />
            <polygon v-if="pts.length >= 3" :points="poly" class="bs__poly" :class="{ 'bs__poly--tex': !!textureUrl }" />
            <line :x1="0" :y1="0" :x2="view.w * 0.12" :y2="0" class="bs__ax bs__ax--x" />
            <line :x1="0" :y1="0" :x2="0" :y2="-view.h * 0.12" class="bs__ax bs__ax--y" />
            <circle cx="0" cy="0" :r="view.w * 0.008" class="bs__origin" />
          </svg>
          <figcaption v-if="bounds">{{ fmt(bounds.maxX - bounds.minX) }} × {{ fmt(bounds.maxY - bounds.minY) }} mm · origin ({{ fmt(-bounds.minX) }}, {{ fmt(-bounds.minY) }})</figcaption>
        </figure>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" @click="dialogs.bedShape = false" />
        <UButton color="primary" label="Apply" :disabled="invalid" @click="apply" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.bs { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 20px; align-items: start; }
.bs__form { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.bs__form h4 { margin: 6px 0 0; font-size: 12px; font-weight: 600; color: var(--ui-text-highlighted); text-transform: uppercase; letter-spacing: .04em; }
.bs__form h4:first-child { margin-top: 0; }
.bs__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.bs__note { margin: 0; font-size: 11px; color: var(--ui-text-dimmed); }
.bs__file { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.bs__flabel { width: 56px; color: var(--ui-text-muted); }
.bs__fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-text-toned); }
.bs__preview { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.bs__preview svg { width: 100%; aspect-ratio: 1; background: var(--ui-bg-muted); border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
.bs__preview figcaption { font-size: 11px; color: var(--ui-text-dimmed); text-align: center; }
.bs__poly { fill: color-mix(in srgb, var(--ui-primary) 18%, transparent); stroke: var(--ui-primary); stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
.bs__poly--tex { fill: transparent; }
.bs__ax { stroke-width: 2px; vector-effect: non-scaling-stroke; }
.bs__ax--x { stroke: #ef5b5b; }
.bs__ax--y { stroke: #19c37d; }
.bs__origin { fill: var(--ui-text-highlighted); }
@media (max-width: 640px) { .bs { grid-template-columns: 1fr; } .bs__preview { max-width: 280px; margin: 0 auto; } }
</style>

<script setup lang="ts">
/**
 * Orca BedShapeDialog, two uses:
 * - the printer's bed (`dialogs.bedShape`): printable area (rectangular: size
 *   + origin; circular: diameter; custom: points / loaded from an STL
 *   outline), max print height, and a custom bed texture (SVG / PNG) and bed
 *   model (STL). Applies to the selected printer preset as unsaved edits
 *   (printable_area / printable_height / bed_custom_texture / bed_custom_model;
 *   bed_shape / max_print_height on preFlight). Textures and models are stored
 *   in this browser (IndexedDB).
 * - any other polygon option from a settings row (`shapeRequest`: excluded bed
 *   area, wrapping exclusion area): shape only, answered to the caller, with
 *   Clear for options that may be empty.
 */
import { computed, reactive, ref, watch } from 'vue';
import { mobileDialog, shortScreen } from '../../ui/mobileDialog';
import AppDialog from '../../ui/AppDialog.vue';
import { pickFiles } from '../../app/shell/download';
import { parseModelFile } from '../../project/import';
import { currentPresets } from '../../presets/store';
import { asList, SCALAR, toNumber, valueAt } from '../../lib/configValue';
import { formatNumber } from '../../presets/values';
import { toast } from '../../ui';
import { dialogs } from '../state';
import { bedPoints, convexHullXY, parseBed, parseCustomText, serializeBed, type BedModel, type BedType } from './bedShape';
import { assetLabel, bedAssetUrl, storeBedAsset } from './customBed';
import { shapeRequest } from './request';

const p = computed(() => currentPresets.value);
const areaKey = computed(() => (p.value.schema.value && !p.value.schema.value.options.printable_area && p.value.schema.value.options.bed_shape ? 'bed_shape' : 'printable_area'));
const heightKey = computed(() => (p.value.schema.value && !p.value.schema.value.options.printable_height && p.value.schema.value.options.max_print_height ? 'max_print_height' : 'printable_height'));

/** Area mode: editing another polygon option for a settings row. */
const area = computed(() => shapeRequest.current.value);
const open = computed({
  get: () => dialogs.bedShape || !!area.value,
  set: (v: boolean) => { if (!v) { dialogs.bedShape = false; shapeRequest.open.value = false; } },
});
const hasTexture = computed(() => !area.value && (!p.value.schema.value || !!p.value.schema.value.options.bed_custom_texture));
const hasModel = computed(() => !area.value && (!p.value.schema.value || !!p.value.schema.value.options.bed_custom_model));

const model = reactive<BedModel>(parseBed([]));
const customText = ref('');
const height = ref(250);
const texture = ref('');
const bedModel = ref('');
const textureUrl = ref<string | null>(null);
const busy = ref(false);

const single = (key: string) => valueAt(p.value.value('printer', key), SCALAR) ?? '';
function load(points: string[]): void {
  const m = parseBed(points);
  Object.assign(model, m);
  customText.value = serializeBed(m.custom.length ? m.custom : bedPoints(m)).join('\n');
}
watch(() => dialogs.bedShape, (o) => {
  if (!o) return;
  load(asList(p.value.value('printer', areaKey.value)));
  height.value = toNumber(single(heightKey.value), 0);
  texture.value = single('bed_custom_texture');
  bedModel.value = single('bed_custom_model');
});
watch(area, (r) => {
  if (!r) return;
  load(r.points);
  // Fewer than 3 points ("0x0") is Orca's "no area": start from an empty custom outline.
  if (parseCustomText(r.points.join('\n')).pts.length < 3) { model.type = 'custom'; customText.value = ''; }
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
const empty = computed(() => !!area.value?.allowEmpty && model.type === 'custom' && !customText.value.trim());
const invalid = computed(() => !empty.value && ((model.type === 'custom' && custom.value.bad) || pts.value.length < 3
  || (model.type === 'rect' && !(model.rect.width > 0 && model.rect.depth > 0)) || (model.type === 'circle' && !(model.circle.diameter > 0))));
/** Area mode places a rectangle by its front-left corner (the bed's own uses Orca's origin offset). */
const cornerX = computed({ get: () => -model.rect.originX || 0, set: (v: number) => { model.rect.originX = -v; } });
const cornerY = computed({ get: () => -model.rect.originY || 0, set: (v: number) => { model.rect.originY = -v; } });

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
  if (area.value) { shapeRequest.answer(empty.value ? [] : serializeBed(pts.value)); return; }
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
  <AppDialog v-model:open="open" :title="area ? area.title : 'Bed shape'" size="3xl" fullscreen body-class="flex flex-col gap-4"
             :description="shortScreen ? undefined : area ? 'Polygon in bed coordinates, in millimetres.' : `Printer: ${p.infos.value.printer.name}`"
             confirm-label="Apply" :confirm-disabled="invalid" @confirm="apply">
    <template v-if="area?.allowEmpty" #footer-start>
      <UButton variant="ghost" color="error" label="Clear" @click="shapeRequest.answer([])" />
    </template>
      <div class="bs">
        <div class="bs__form dlg-flow">
          <h4>Shape</h4>
          <UTabs v-model="type" :items="typeItems" :content="false" size="xs" class="dlg-span" />
          <template v-if="model.type === 'rect'">
            <div class="bs__grid dlg-span">
              <UFormField label="Size X" hint="mm"><UInputNumber :model-value="model.rect.width" :min="1" size="sm" @update:model-value="(v: number | null) => (model.rect.width = num(v, 220))" /></UFormField>
              <UFormField label="Size Y" hint="mm"><UInputNumber :model-value="model.rect.depth" :min="1" size="sm" @update:model-value="(v: number | null) => (model.rect.depth = num(v, 220))" /></UFormField>
              <template v-if="area">
                <UFormField label="Corner X" hint="mm"><UInputNumber :model-value="cornerX" size="sm" @update:model-value="(v: number | null) => (cornerX = num(v))" /></UFormField>
                <UFormField label="Corner Y" hint="mm"><UInputNumber :model-value="cornerY" size="sm" @update:model-value="(v: number | null) => (cornerY = num(v))" /></UFormField>
              </template>
              <template v-else>
                <UFormField label="Origin X" hint="mm"><UInputNumber :model-value="model.rect.originX" size="sm" @update:model-value="(v: number | null) => (model.rect.originX = num(v))" /></UFormField>
                <UFormField label="Origin Y" hint="mm"><UInputNumber :model-value="model.rect.originY" size="sm" @update:model-value="(v: number | null) => (model.rect.originY = num(v))" /></UFormField>
              </template>
            </div>
            <p class="bs__note dlg-span">{{ area ? 'Position of the rectangle’s front-left corner on the bed.' : 'Distance of the coordinates origin (X0 Y0) from the front-left corner of the bed.' }}</p>
          </template>
          <template v-else-if="model.type === 'circle'">
            <UFormField label="Diameter" hint="mm" description="The origin (X0 Y0) is the centre.">
              <UInputNumber :model-value="model.circle.diameter" :min="1" size="sm" class="w-32" @update:model-value="(v: number | null) => (model.circle.diameter = num(v, 200))" />
            </UFormField>
          </template>
          <template v-else>
            <UFormField label="Points" description="One “XxY” point per line, in mm." :error="custom.bad ? 'Some lines are not valid points.' : undefined">
              <UTextarea v-model="customText" :rows="7" spellcheck="false" class="w-full" :ui="{ base: 'font-mono text-xs' }" />
            </UFormField>
            <UButton size="xs" variant="outline" icon="i-lucide-file-box" label="Load shape from STL…" class="self-start" @click="loadShapeStl" />
          </template>

          <template v-if="!area">
            <h4>Height</h4>
            <div class="bs__hrow">
              <UFormField label="Max print height" hint="mm">
                <UInputNumber :model-value="height" :min="0" size="sm" class="w-32" @update:model-value="(v: number | null) => (height = num(v))" />
              </UFormField>
            </div>
          </template>
          <!-- Phones: a thumbnail preview beside the height and appearance rows instead of a column. -->
          <figure v-if="mobileDialog && !shortScreen" class="bs__preview bs__preview--sm">
            <svg :viewBox="`${view.x} ${view.y} ${view.w} ${view.h}`" preserveAspectRatio="xMidYMid meet" aria-label="Shape preview">
              <defs><clipPath id="bs-clip-sm"><polygon :points="poly" /></clipPath></defs>
              <image v-if="textureUrl && bounds && !area" :href="textureUrl" :x="bounds.minX" :y="-bounds.maxY" :width="bounds.maxX - bounds.minX" :height="bounds.maxY - bounds.minY"
                     preserveAspectRatio="none" clip-path="url(#bs-clip-sm)" opacity="0.9" />
              <polygon v-if="pts.length >= 3" :points="poly" class="bs__poly" :class="{ 'bs__poly--tex': !!textureUrl && !area }" />
              <line :x1="0" :y1="0" :x2="view.w * 0.12" :y2="0" class="bs__ax bs__ax--x" />
              <line :x1="0" :y1="0" :x2="0" :y2="-view.h * 0.12" class="bs__ax bs__ax--y" />
              <circle cx="0" cy="0" :r="view.w * 0.008" class="bs__origin" />
            </svg>
            <figcaption v-if="bounds">{{ fmt(bounds.maxX - bounds.minX) }} × {{ fmt(bounds.maxY - bounds.minY) }} mm · {{ area ? `from (${fmt(bounds.minX)}, ${fmt(bounds.minY)})` : `origin (${fmt(-bounds.minX)}, ${fmt(-bounds.minY)})` }}</figcaption>
          </figure>

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
            <p class="bs__note bs__note--secondary dlg-span">SVG / PNG texture and STL model, stored in this browser. They replace the printer vendor’s bed visuals.</p>
          </template>
        </div>
        <figure v-if="!mobileDialog || shortScreen" class="bs__preview">
          <svg :viewBox="`${view.x} ${view.y} ${view.w} ${view.h}`" preserveAspectRatio="xMidYMid meet" aria-label="Shape preview">
            <defs><clipPath id="bs-clip"><polygon :points="poly" /></clipPath></defs>
            <image v-if="textureUrl && bounds && !area" :href="textureUrl" :x="bounds.minX" :y="-bounds.maxY" :width="bounds.maxX - bounds.minX" :height="bounds.maxY - bounds.minY"
                   preserveAspectRatio="none" clip-path="url(#bs-clip)" opacity="0.9" />
            <polygon v-if="pts.length >= 3" :points="poly" class="bs__poly" :class="{ 'bs__poly--tex': !!textureUrl && !area }" />
            <line :x1="0" :y1="0" :x2="view.w * 0.12" :y2="0" class="bs__ax bs__ax--x" />
            <line :x1="0" :y1="0" :x2="0" :y2="-view.h * 0.12" class="bs__ax bs__ax--y" />
            <circle cx="0" cy="0" :r="view.w * 0.008" class="bs__origin" />
          </svg>
          <figcaption v-if="bounds">{{ fmt(bounds.maxX - bounds.minX) }} × {{ fmt(bounds.maxY - bounds.minY) }} mm · {{ area ? `from (${fmt(bounds.minX)}, ${fmt(bounds.minY)})` : `origin (${fmt(-bounds.minX)}, ${fmt(-bounds.minY)})` }}</figcaption>
        </figure>
      </div>
  </AppDialog>
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
.bs__preview--sm figcaption { font-size: 10px; }
/* Portrait phones: the thumbnail sits in a second column beside the height and appearance rows. */
@media (max-width: 640px) and (min-height: 501px) {
  .bs__form { display: grid; grid-template-columns: minmax(0, 1fr) 128px; grid-auto-flow: row dense; column-gap: 12px; }
  .bs__form > * { grid-column: 1 / -1; }
  .bs__form > .bs__hrow, .bs__form > .bs__file { grid-column: 1; }
  .bs__form > .bs__preview--sm { grid-column: 2; grid-row: span 3; }
}
@media (max-width: 640px), (max-height: 500px) {
  .bs { grid-template-columns: 1fr; }
  .bs__form h4 { display: none; }
}
@media (max-height: 500px) and (min-width: 560px) {
  .bs { grid-template-columns: minmax(0, 1fr) 150px; gap: 16px; }
  .bs__note--secondary { display: none; }
  .bs__hrow { grid-row: span 2; }
  .bs__file { grid-column: 2; }
  .bs__grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
</style>

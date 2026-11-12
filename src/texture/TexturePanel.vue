<script setup lang="ts">
/**
 * Texture displacement (Orca 2.5 GLGizmoTextureDisplacement, Standard mode):
 * the selected object's layer stack — texture, depth, tiling, rotation,
 * midlevel, smoothing, edge fade, invert, mapping, tile, blend — painted onto
 * the whole model, previewed live as real geometry (desktop's Normal view)
 * and baked into the mesh. Brush painting, the UV editor, From view / Model UV
 * mapping, colours, Pro mode and the Quality section aren't built yet.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial } from 'three';
import { getMeshPaint, getObject, meshTexture, objects, selectedIds, selectedPart } from '../project/store';
import type { TextureLayer } from '../project/types';
import { toast } from '../ui';
import ToolPanel from '../tools/ToolPanel.vue';
import { closeTool, toolScene } from '../tools/state';
import { ToolOverlay, render } from '../tools/overlay';
import { isPainted, runBake, textureParts, type PartResult } from './bake';
import {
  addTextureLayer, anyPartPainted, bakeTexture, eraseWholeModel, paintedSlotsOf, removeTextureLayer, selectWholeModel, stackOf, updateTextureLayer, type LayerTexture,
} from './commands';
import { importTextureFile, libraryImage, textureLibrary, type LibraryTexture } from './library';
import { BlendMode, MAX_TEXTURE_LAYERS, Projection, TileMethod, bool, enumInt, layerName, layerSlot, num, projectionOf } from './model';

const objId = computed(() => selectedPart.value?.objectId ?? (selectedIds.value.length === 1 ? selectedIds.value[0] : null));
const obj = computed(() => (objId.value ? getObject(objId.value) : undefined));
const stack = computed(() => { void meshTexture.value; return obj.value ? stackOf(obj.value) : undefined; });
const layers = computed(() => stack.value?.layers ?? []);
const painted = computed(() => { void meshTexture.value; return obj.value ? paintedSlotsOf(obj.value) : new Set<number>(); });

const activeSlot = ref(-1);
const expanded = ref<Record<number, boolean>>({});
const picking = ref<number | null>(null);
const library = shallowRef<LibraryTexture[]>([]);
const baking = ref(false);
const previewing = ref(false);
const active = computed<TextureLayer | undefined>(() => layers.value.find((l) => layerSlot(l) === activeSlot.value));

// Reopening puts the user back on the layer they were editing (options.active_slot).
watch([objId, layers], () => {
  if (layers.value.some((l) => layerSlot(l) === activeSlot.value)) return;
  const want = num(stack.value?.options ?? {}, 'active_slot', 0);
  activeSlot.value = layerSlot(layers.value.find((l) => layerSlot(l) === want) ?? layers.value[0] ?? { json: { slot: -1 }, image: null });
}, { immediate: true });

// ---- layers --------------------------------------------------------------------------

async function firstLibraryTexture(): Promise<LayerTexture | null> {
  const lib = library.value.length ? library.value : await textureLibrary();
  const t = lib[0];
  if (!t) return null;
  try { return { name: t.name, path: decodeURIComponent(t.url.split('/').pop() ?? t.name), image: await libraryImage(t) }; } catch { return null; }
}

async function addLayer(): Promise<void> {
  const id = objId.value;
  if (!id) return;
  if (layers.value.length >= MAX_TEXTURE_LAYERS) { toast.error('Maximum number of texture displacement layers reached.'); return; }
  // A textureless layer looks broken, so a new one starts on the first library texture (desktop).
  const slot = addTextureLayer(id, await firstLibraryTexture());
  if (slot < 0) return;
  activeSlot.value = slot;
  expanded.value = { ...expanded.value, [slot]: true };
}

function setField(slot: number, key: string, value: unknown, drag = false): void {
  if (!objId.value) return;
  updateTextureLayer(objId.value, slot, { [key]: value }, drag ? { mergeKey: `texture:${objId.value}:${slot}:${key}` } : {});
}

async function pickLibrary(slot: number, t: LibraryTexture): Promise<void> {
  const id = objId.value;
  if (!id) return;
  try {
    const image = await libraryImage(t);
    updateTextureLayer(id, slot, {}, { texture: { name: t.name, path: decodeURIComponent(t.url.split('/').pop() ?? t.name), image } });
    picking.value = null;
  } catch {
    toast.error('Could not load the selected texture.');
  }
}

const fileInput = ref<HTMLInputElement | null>(null);
let importSlot = -1;
function importImage(slot: number): void { importSlot = slot; fileInput.value?.click(); }
async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  const id = objId.value;
  if (!f || !id || importSlot < 0) return;
  try {
    const t = await importTextureFile(f);
    updateTextureLayer(id, importSlot, {}, { texture: { name: t.name, path: f.name, image: t.image } });
    picking.value = null;
  } catch (err) {
    toast.error((err as Error)?.message || 'Could not load the selected image.');
  }
}

function removeLayer(slot: number): void {
  if (objId.value) removeTextureLayer(objId.value, slot);
  if (picking.value === slot) picking.value = null;
}

// Thumbnails of the layers' own images.
const thumbUrls = new WeakMap<Uint8Array, string>();
const allUrls: string[] = [];
function thumb(l: TextureLayer): string | undefined {
  if (!l.image) return undefined;
  let u = thumbUrls.get(l.image);
  if (!u) { u = URL.createObjectURL(new Blob([l.image as BlobPart], { type: 'image/png' })); thumbUrls.set(l.image, u); allUrls.push(u); }
  return u;
}

// ---- rows (desktop's ranges and help) ----------------------------------------------------

interface NumRow { key: string; label: string; min: number; max: number; step: number; def: number; digits: number; unit: string; tip: string }
const MAIN_ROWS: NumRow[] = [
  { key: 'depth_mm', label: 'Depth', min: 0.01, max: 10, step: 0.01, def: 0.4, digits: 3, unit: 'mm',
    tip: 'Height of the relief: how far white in the texture lifts the surface, in millimetres. Black does not move it at all, unless Midlevel says otherwise.' },
  { key: 'tiling_scale', label: 'Tile size', min: 0.2, max: 200, step: 0.1, def: 12.5, digits: 2, unit: 'mm',
    tip: 'How wide one copy of the texture is on the model. Smaller repeats the pattern more often and makes its detail finer; with Tile off, this is the size of the single copy.' },
  { key: 'rotation_deg', label: 'Rotation', min: 0, max: 360, step: 1, def: 0, digits: 0, unit: '°',
    tip: 'Turns the texture on the surface, in degrees - for lining a pattern up with an edge of the model.' },
];
const MORE_ROWS: NumRow[] = [
  { key: 'midlevel', label: 'Midlevel', min: 0, max: 10, step: 0.01, def: 0, digits: 2, unit: '',
    tip: 'Which gray stays where the surface already is. At 0 the texture only pushes outwards; at 0.5 mid-gray stays put, so darker grays cut in and lighter ones still push out - one image both embosses and engraves.\n\nWhat cuts in has to fit: inside a sharp corner or through a thin wall, a deep cut can pass through the other side.' },
  { key: 'smoothing', label: 'Smoothing', min: 0, max: 1, step: 0.01, def: 0, digits: 2, unit: '',
    tip: 'Blurs the image before it is used, which rounds off hard steps and removes speckle from a noisy photo. Raise it if the relief looks harsh or grainy; it costs fine detail.' },
];
const MAPPINGS = [
  { id: Projection.Triplanar, icon: 'i-lucide-box', label: 'Triplanar (blended)',
    tip: 'Triplanar - projects the texture from all three axes at once and blends between them, so a patch wrapping around a sharp edge has no seam.' },
  { id: Projection.Cylindrical, icon: 'i-lucide-cylinder', label: 'Cylindrical',
    tip: 'Cylindrical - wraps the texture around the painted area\'s own center, for round shapes.' },
  { id: Projection.Spherical, icon: 'i-lucide-globe', label: 'Spherical',
    tip: 'Spherical - wraps the texture around the painted area\'s own center in both directions.' },
];
/** Mappings a project can carry that this panel can't edit yet: shown by name only. */
const OTHER_MAPPING: Record<number, string> = { [Projection.LSCM]: 'Unwrap (LSCM)', [Projection.ViewProjected]: 'From view', [Projection.ModelUV]: 'Model UV' };
// Desktop's Blend list order.
const BLENDS = [
  { label: 'Add', value: BlendMode.Add }, { label: 'Override', value: BlendMode.Override }, { label: 'Subtract', value: BlendMode.Subtract },
  { label: 'Multiply', value: BlendMode.Multiply }, { label: 'Divide', value: BlendMode.Divide },
];
const clamp = (v: number, r: NumRow) => Math.min(r.max, Math.max(r.min, v));
const fmt = (l: TextureLayer, r: NumRow) => num(l.json, r.key, r.def);

// ---- paint (whole model) ----------------------------------------------------------------

const busy = computed(() => baking.value);
function selectAll(): void { if (objId.value && active.value) selectWholeModel(objId.value, activeSlot.value); }
function eraseAll(): void { if (objId.value && active.value) eraseWholeModel(objId.value, activeSlot.value); }
const selectAllNa = computed(() => (busy.value ? 'Wait for the bake to finish.' : !active.value ? 'Add a layer first.' : ''));
const eraseAllNa = computed(() => (busy.value ? 'Wait for the bake to finish.' : !active.value ? 'Add a layer first.'
  : !painted.value.has(activeSlot.value) ? 'The active layer has no paint yet.' : ''));

// ---- live preview (desktop's Normal view: the real geometry Bake will produce) ------------------

const overlay = new ToolOverlay('texture');
const previewMaterial = new MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.75, metalness: 0.05 });
let generation = 0;
let running = false;
let pending = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function setHidden(ids: string[]): void { toolScene.value?.setToolHidden(ids); }

function showPreview(id: string, results: PartResult[]): void {
  overlay.attach();
  overlay.clear();
  const o = getObject(id);
  if (!o || !results.length) { setHidden([]); render(); return; }
  for (const part of textureParts(o)) {
    const r = results.find((x) => x.part.partId === part.partId && x.part.mesh.id === part.mesh.id);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(r ? r.positions : part.mesh.positions, 3));
    g.setIndex(new BufferAttribute(r ? r.indices : part.mesh.indices, 1));
    g.computeVertexNormals();
    const m = new Mesh(g, previewMaterial);
    m.matrixAutoUpdate = false;
    m.matrix.fromArray(part.matrix);
    overlay.add(m);
  }
  setHidden([id]);
  render();
}

function clearPreview(): void {
  overlay.clear();
  setHidden([]);
  render();
}

/** Anything the preview depends on: the object, its placement, meshes, stack and masks. */
const previewKey = computed(() => {
  const o = obj.value;
  if (!o) return '';
  void meshTexture.value;
  const parts = textureParts(o);
  return JSON.stringify([o.id, o.position, o.rotation, o.scale, parts.map((p) => [p.mesh.id, p.matrix.map((v) => +v.toFixed(5))])])
    + `|${parts.map((p) => tokenOf(p.texture)).join('.')}|${tokenOf(stack.value)}`;
});
const tokens = new WeakMap<object, number>();
let tokenSeq = 0;
function tokenOf(v: object | undefined): number {
  if (!v) return 0;
  let t = tokens.get(v);
  if (t === undefined) { t = ++tokenSeq; tokens.set(v, t); }
  return t;
}

function schedulePreview(): void {
  generation++;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void runPreview(); }, 350);
}

async function runPreview(): Promise<void> {
  // One run at a time; changes meanwhile collapse into one follow-up (desktop's preview job).
  if (running) { pending = true; return; }
  const id = objId.value, o = obj.value;
  if (!id || !o || !stack.value?.layers.length || !anyPartPainted(o)) { clearPreview(); return; }
  const my = generation;
  running = true;
  previewing.value = true;
  try {
    const r = await runBake(id, { preview: true, stale: () => my !== generation });
    if (r && my === generation && objId.value === id) showPreview(id, r.filter((x) => x.indices.length));
  } catch (e) {
    if (my === generation) toast.error('The texture displacement preview failed.', { detail: (e as Error)?.message });
  } finally {
    running = false;
    previewing.value = false;
    if (pending || my !== generation) { pending = false; if (!timer) void runPreview(); }
  }
}

watch(previewKey, schedulePreview);
watch(toolScene, () => { overlay.attach(); render(); });

// ---- bake --------------------------------------------------------------------------------

/** Other painting a bake resets (desktop carries it across; not built yet). */
const paintWarning = computed(() => {
  const o = obj.value;
  if (!o) return false;
  void objects.value;
  return textureParts(o).some((p) => isPainted(p.texture) && Object.keys(getMeshPaint(p.mesh.id)).length > 0);
});
const bakeNa = computed(() => (!obj.value ? '' : !layers.value.length || !painted.value.size ? 'Nothing is painted yet.' : ''));

async function bake(): Promise<void> {
  const id = objId.value;
  if (!id || baking.value || bakeNa.value) return;
  baking.value = true;
  generation++; // a preview finishing now is stale
  try {
    const r = await bakeTexture(id);
    if (!r.ok) toast.error(r.message ?? 'The bake failed.');
    else if (r.budgetLimited) toast.warn('The triangle budget limited the detail of the bake.');
  } catch (e) {
    toast.error('The bake failed.', { detail: (e as Error)?.message });
  } finally {
    baking.value = false;
    schedulePreview();
  }
}

onMounted(() => {
  void textureLibrary().then((l) => { library.value = l; });
  schedulePreview();
});
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  generation++;
  overlay.dispose();
  previewMaterial.dispose();
  setHidden([]);
  for (const u of allUrls) URL.revokeObjectURL(u);
});
</script>

<template>
  <ToolPanel title="Texture displacement" icon="i-lucide-brick-wall" @close="closeTool()">
    <template v-if="obj">
      <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/bmp,.png,.jpg,.jpeg,.bmp" class="hidden" @change="onFile">

      <section class="td__sec" aria-label="Paint">
        <div class="td__head">
          <h3>Paint</h3>
          <span class="td__into">{{ active ? `into ${layerName(active)}` : 'add a layer to paint' }}</span>
        </div>
        <div class="flex gap-2">
          <UTooltip :text="selectAllNa || 'Select whole model - paint every face of the model with the active layer'">
            <UButton size="sm" variant="soft" color="neutral" icon="i-lucide-box-select" label="Select whole model" :disabled="!!selectAllNa" @click="selectAll" />
          </UTooltip>
          <UTooltip :text="eraseAllNa || 'Erase whole model - clear the active layer\'s paint from every face'">
            <UButton size="sm" variant="ghost" color="neutral" icon="i-lucide-eraser" aria-label="Erase whole model" :disabled="!!eraseAllNa" @click="eraseAll" />
          </UTooltip>
        </div>
      </section>

      <section class="td__sec" aria-label="Texture layers">
        <div class="td__head">
          <h3>Texture layers</h3>
          <UButton size="xs" variant="soft" icon="i-lucide-plus" label="Add layer" :disabled="busy || layers.length >= MAX_TEXTURE_LAYERS" @click="addLayer" />
        </div>
        <p v-if="!layers.length" class="text-xs text-muted">Add a layer, pick a texture for it, then paint where it goes.</p>

        <div v-for="(l, li) in layers" :key="layerSlot(l)" class="td__card" :class="{ 'td__card--on': layerSlot(l) === activeSlot }">
          <div class="td__row-head" role="button" tabindex="0" :aria-pressed="layerSlot(l) === activeSlot"
               @click="activeSlot = layerSlot(l)" @keydown.enter.self="activeSlot = layerSlot(l)">
            <UTooltip text="Pick a different image for this layer. The paint, depth and tiling stay as they are.">
              <button type="button" class="td__thumb" :aria-label="`Texture of ${layerName(l)}`" :disabled="busy"
                      @click.stop="activeSlot = layerSlot(l); picking = picking === layerSlot(l) ? null : layerSlot(l)">
                <img v-if="thumb(l)" :src="thumb(l)" alt="">
                <UIcon v-else name="i-lucide-image-off" class="size-4 text-muted" />
              </button>
            </UTooltip>
            <span class="td__name">{{ layerName(l) }}</span>
            <span class="td__sum">{{ painted.has(layerSlot(l)) ? `${num(l.json, 'depth_mm', 0.4).toFixed(3)} mm` : 'not painted' }}</span>
            <UButton icon="i-lucide-x" size="xs" variant="ghost" color="neutral" aria-label="Remove this layer" :disabled="busy" @click.stop="removeLayer(layerSlot(l))" />
          </div>

          <div v-if="picking === layerSlot(l)" class="td__lib">
            <div class="td__lib-grid">
              <button v-for="t in library" :key="t.url" type="button" class="td__lib-item" :title="t.name" @click="pickLibrary(layerSlot(l), t)">
                <img :src="t.url" alt="" loading="lazy">
                <span>{{ t.name }}</span>
              </button>
            </div>
            <p v-if="!library.length" class="text-xs text-muted">The built-in textures aren’t available.</p>
            <UButton size="xs" variant="soft" icon="i-lucide-upload" label="Import image…" @click="importImage(layerSlot(l))" />
          </div>

          <div v-if="layerSlot(l) === activeSlot" class="td__body">
            <template v-for="r in MAIN_ROWS" :key="r.key">
              <UTooltip :text="r.tip" :content="{ side: 'right' }"><span class="td__lbl">{{ r.label }}</span></UTooltip>
              <div class="td__ctl">
                <USlider :model-value="fmt(l, r)" :min="r.min" :max="r.max" :step="r.step" size="sm" class="flex-1" :aria-label="r.label" :disabled="busy"
                         @update:model-value="(v: unknown) => setField(layerSlot(l), r.key, clamp(Number(v), r), true)" />
                <UInputNumber :model-value="fmt(l, r)" :min="r.min" :max="r.max" :step="r.step" :step-snapping="false" size="xs" class="w-24" :disabled="busy"
                              :format-options="{ maximumFractionDigits: r.digits }" :aria-label="`${r.label}${r.unit ? ` (${r.unit})` : ''}`"
                              @update:model-value="(v: unknown) => v != null && setField(layerSlot(l), r.key, clamp(Number(v), r))" />
              </div>
            </template>

            <template v-if="expanded[layerSlot(l)]">
              <template v-for="r in MORE_ROWS" :key="r.key">
                <UTooltip :text="r.tip" :content="{ side: 'right' }"><span class="td__lbl">{{ r.label }}</span></UTooltip>
                <div class="td__ctl">
                  <USlider :model-value="fmt(l, r)" :min="r.min" :max="r.max" :step="r.step" size="sm" class="flex-1" :aria-label="r.label" :disabled="busy"
                           @update:model-value="(v: unknown) => setField(layerSlot(l), r.key, clamp(Number(v), r), true)" />
                  <UInputNumber :model-value="fmt(l, r)" :min="r.min" :max="r.max" :step="r.step" :step-snapping="false" size="xs" class="w-24" :disabled="busy"
                                :format-options="{ maximumFractionDigits: r.digits }" :aria-label="r.label"
                                @update:model-value="(v: unknown) => v != null && setField(layerSlot(l), r.key, clamp(Number(v), r))" />
                </div>
                <p v-if="r.key === 'midlevel' && num(l.json, 'midlevel', 0) > 0 && num(l.json, 'depth_mm', 0.4) > 1" class="td__warn">
                  Deep inward displacement may self-intersect.
                </p>
              </template>

              <UTooltip text="Flattens the relief as it approaches the edge of the painted area, so it blends into the bare surface instead of stopping at a step.">
                <UCheckbox class="td__lbl" size="sm" label="Edge fade" :disabled="busy" :model-value="bool(l.json, 'edge_smoothing', false)"
                           @update:model-value="(v: unknown) => setField(layerSlot(l), 'edge_smoothing', !!v)" />
              </UTooltip>
              <div class="td__ctl">
                <USlider :model-value="num(l.json, 'edge_smoothing_amount', 0.5)" :min="0.02" :max="1" :step="0.01" size="sm" class="flex-1"
                         aria-label="Edge fade amount" :disabled="busy || !bool(l.json, 'edge_smoothing', false)"
                         @update:model-value="(v: unknown) => setField(layerSlot(l), 'edge_smoothing_amount', Number(v), true)" />
                <UInputNumber :model-value="num(l.json, 'edge_smoothing_amount', 0.5)" :min="0.02" :max="1" :step="0.01" :step-snapping="false" size="xs" class="w-24"
                              :format-options="{ maximumFractionDigits: 2 }" aria-label="Edge fade amount" :disabled="busy || !bool(l.json, 'edge_smoothing', false)"
                              @update:model-value="(v: unknown) => v != null && setField(layerSlot(l), 'edge_smoothing_amount', Math.min(1, Math.max(0.02, Number(v))))" />
              </div>

              <UTooltip text="Turns the relief inside out: what stood out is cut in, and the other way round. The same as using a negative of the image.">
                <UCheckbox class="td__full" size="sm" label="Invert" :disabled="busy" :model-value="bool(l.json, 'invert', false)"
                           @update:model-value="(v: unknown) => setField(layerSlot(l), 'invert', !!v)" />
              </UTooltip>

              <span class="td__lbl">Mapping</span>
              <div class="td__ctl">
                <UTooltip v-for="m in MAPPINGS" :key="m.id" :text="m.tip">
                  <UButton size="xs" :icon="m.icon" :aria-label="m.label" :aria-pressed="projectionOf(l) === m.id" :disabled="busy"
                           :variant="projectionOf(l) === m.id ? 'soft' : 'ghost'" :color="projectionOf(l) === m.id ? 'primary' : 'neutral'"
                           @click="setField(layerSlot(l), 'projection_method', m.id)" />
                </UTooltip>
                <span v-if="OTHER_MAPPING[projectionOf(l)]" class="text-xs text-muted">{{ OTHER_MAPPING[projectionOf(l)] }}</span>
              </div>

              <UTooltip text="Repeats the texture across the painted area. Off places one copy, like a decal, at the size set by Tile size.">
                <UCheckbox class="td__lbl" size="sm" label="Tile" :disabled="busy" :model-value="bool(l.json, 'tile_enabled', true)"
                           @update:model-value="(v: unknown) => setField(layerSlot(l), 'tile_enabled', !!v)" />
              </UTooltip>
              <div class="td__ctl">
                <UTooltip :text="bool(l.json, 'tile_enabled', true) ? 'Repeat' : 'Turn Tile on to choose how the texture repeats.'">
                  <UButton size="xs" icon="i-lucide-repeat" aria-label="Repeat" :disabled="busy || !bool(l.json, 'tile_enabled', true)"
                           :aria-pressed="enumInt(l.json, 'tile_method', 0) === TileMethod.Repeat"
                           :variant="enumInt(l.json, 'tile_method', 0) === TileMethod.Repeat ? 'soft' : 'ghost'"
                           :color="enumInt(l.json, 'tile_method', 0) === TileMethod.Repeat ? 'primary' : 'neutral'"
                           @click="setField(layerSlot(l), 'tile_method', TileMethod.Repeat)" />
                </UTooltip>
                <UTooltip :text="bool(l.json, 'tile_enabled', true) ? 'Mirrored repeat - every other tile is flipped, so edges meet seamlessly' : 'Turn Tile on to choose how the texture repeats.'">
                  <UButton size="xs" icon="i-lucide-flip-horizontal-2" aria-label="Mirrored repeat" :disabled="busy || !bool(l.json, 'tile_enabled', true)"
                           :aria-pressed="enumInt(l.json, 'tile_method', 0) === TileMethod.MirroredRepeat"
                           :variant="enumInt(l.json, 'tile_method', 0) === TileMethod.MirroredRepeat ? 'soft' : 'ghost'"
                           :color="enumInt(l.json, 'tile_method', 0) === TileMethod.MirroredRepeat ? 'primary' : 'neutral'"
                           @click="setField(layerSlot(l), 'tile_method', TileMethod.MirroredRepeat)" />
                </UTooltip>
              </div>

              <UTooltip :text="li === 0 ? 'The base layer has nothing beneath it to combine with, so it always adds.'
                : 'What this layer does where it overlaps the ones below. Add and Subtract pile relief on or carve it away. Override replaces them, so only this layer\'s relief is left where it is painted. Multiply and Divide scale what is underneath, which turns this layer into a mask over it - there, Depth acts as a strength, and 1 mm leaves white areas untouched.'">
                <span class="td__lbl">Blend</span>
              </UTooltip>
              <USelect :model-value="li === 0 ? BlendMode.Add : enumInt(l.json, 'blend_mode', BlendMode.Add)" :items="BLENDS" size="xs" class="w-full"
                       aria-label="Blend" :disabled="busy || li === 0" @update:model-value="(v: unknown) => setField(layerSlot(l), 'blend_mode', Number(v))" />
            </template>

            <UButton class="td__full justify-self-start" size="xs" variant="link" color="neutral"
                     :label="expanded[layerSlot(l)] ? 'Fewer settings' : 'More settings'"
                     @click="expanded = { ...expanded, [layerSlot(l)]: !expanded[layerSlot(l)] }" />
          </div>
        </div>
      </section>

      <p v-if="paintWarning" class="td__warn">Baking resets this object’s support, seam, color and fuzzy skin painting.</p>
    </template>
    <p v-else class="text-sm text-muted">Select one object to add a texture to it.</p>

    <template #footer>
      <span v-if="previewing && !baking" class="td__status"><UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" /> Updating preview…</span>
      <UButton size="sm" variant="ghost" label="Close" @click="closeTool()" />
      <UTooltip :text="bakeNa || 'Turn the painted height maps into real geometry. The area you painted is refined, displaced and simplified in one run; Undo takes it back.'">
        <UButton size="sm" color="primary" :label="baking ? 'Baking...' : 'Bake'" :loading="baking" :disabled="!obj || baking || !!bakeNa" @click="bake" />
      </UTooltip>
    </template>
  </ToolPanel>
</template>

<style scoped>
.td__sec { display: flex; flex-direction: column; gap: 6px; }
.td__head { display: flex; align-items: center; gap: 8px; }
.td__head h3 { margin: 0; flex: 1; font: 600 var(--fs-xs) var(--font); text-transform: uppercase; letter-spacing: .04em; color: var(--fg-1); }
.td__into { font-size: var(--fs-xs); color: var(--fg-2, var(--fg-1)); }
.td__card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-2); }
.td__card--on { border-color: color-mix(in srgb, var(--ui-primary) 60%, var(--line)); }
.td__row-head { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 6px; cursor: pointer; }
.td__thumb { width: 32px; height: 32px; flex: none; border-radius: 4px; overflow: hidden; border: 1px solid var(--line); background: var(--bg-1); display: grid; place-items: center; cursor: pointer; }
.td__thumb img { width: 100%; height: 100%; object-fit: cover; }
.td__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.td__sum { font-size: var(--fs-xs); color: var(--fg-1); white-space: nowrap; }
.td__lib { padding: 6px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; }
.td__lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 6px; max-height: 220px; overflow-y: auto; }
.td__lib-item { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 2px; border: 1px solid transparent; border-radius: 4px; background: none; cursor: pointer; font-size: 10px; color: var(--fg-1); }
.td__lib-item:hover, .td__lib-item:focus-visible { border-color: var(--ui-primary); }
.td__lib-item img { width: 56px; height: 56px; object-fit: cover; border-radius: 3px; }
.td__lib-item span { max-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.td__body { display: grid; grid-template-columns: 80px 1fr; gap: 6px 8px; align-items: center; padding: 6px 8px 4px; border-top: 1px solid var(--line); }
.td__lbl { font-size: var(--fs-xs); color: var(--fg-1); }
.td__ctl { display: flex; align-items: center; gap: 6px; min-width: 0; }
.td__full, .td__warn { grid-column: 1 / -1; }
.td__warn { margin: 0; font-size: var(--fs-xs); color: var(--ui-warning, #d97706); }
.td__status { margin-right: auto; display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); color: var(--fg-1); }
</style>

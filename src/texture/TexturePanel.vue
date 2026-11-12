<script setup lang="ts">
/**
 * Texture displacement (Orca 2.5 GLGizmoTextureDisplacement, Standard mode):
 * the selected object's layer stack — texture (built-in or the user's own),
 * depth, tiling, rotation, placement, midlevel, smoothing, edge fade, invert,
 * mapping, tile, blend, image adjustments, order — painted with Brush / Face /
 * Connected area or onto the whole model, previewed live as real geometry
 * (Normal view) or shaded on (Fast view), optionally with the wireframe, and
 * baked into the mesh. The UV editor (and with it the Checker / Distortion
 * views), From view / Model UV mapping, colours, Pro mode and the Quality
 * section aren't built yet.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { BufferAttribute, BufferGeometry, Box3, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three';
import { getObject, meshTexture, selectedIds, selectedPart } from '../project/store';
import type { TextureLayer } from '../project/types';
import { SliceCancelled, engineLaneStartupMs, releaseEngineLane, toolCancelsInPlace, warmEngineLane } from '../engine/client';
import { toast } from '../ui';
import ToolPanel from '../tools/ToolPanel.vue';
import { closeTool, toolScene } from '../tools/state';
import { ToolOverlay, render } from '../tools/overlay';
import { runBake, textureParts, type PartResult } from './bake';
import {
  addTextureLayer, anyPartPainted, bakeTexture, eraseWholeModel, moveTextureLayer, saveAdjustedCopy, paintedSlotsOf, removeTextureLayer, selectWholeModel, stackOf, updateTextureLayer, type LayerTexture,
} from './commands';
import { importTextureFile, libraryImage, textureLibrary, type LibraryTexture } from './library';
import { ANGLE_MAX, ANGLE_MIN, RADIUS_MAX, RADIUS_MIN, TextureMaskPainter, maskUi, type MaskTool } from './paint';
import { confirmAction, touch } from '../app/shell/uiState';
import { BlendMode, MAX_TEXTURE_LAYERS, Projection, TileMethod, bool, enumInt, layerName, layerSlot, num, orderedLayers, projectionOf } from './model';
import { FastViewMaterial, fastViewable, patchFrame } from './fastView';
import { PlacementHandle, paintAnchor } from './placement';
import { IDENTITY_ADJUST, applyTextureAdjustments, decodeLayerImage, downscaleHeight, encodeHeightPng, isIdentity, type TextureAdjustments } from './image';
import { loadUserTextures, removeUserTexture, saveUserTexture, touchUserTexture, userTextures, type UserTexture } from './userLibrary';
import { resetTextureUi, textureUi } from './viewState';

const objId = computed(() => selectedPart.value?.objectId ?? (selectedIds.value.length === 1 ? selectedIds.value[0] : null));
const obj = computed(() => (objId.value ? getObject(objId.value) : undefined));
const stack = computed(() => { void meshTexture.value; return obj.value ? stackOf(obj.value) : undefined; });
// Desktop lists the layers by slot: the first is the base, each next one blends onto those before.
const layers = computed(() => orderedLayers(stack.value));
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

/** "My textures": picking one makes it the most recently used (desktop touch_user_texture). */
function pickUser(slot: number, t: UserTexture): void {
  if (!objId.value) return;
  updateTextureLayer(objId.value, slot, {}, { texture: { name: t.name, path: `${t.name}.png`, image: t.image } });
  touchUserTexture(t.id);
  picking.value = null;
}

/** remove_user_texture, after desktop's question. Layers already using it keep their image. */
async function removeUser(t: UserTexture): Promise<void> {
  const ok = await confirmAction({
    title: 'Remove texture', danger: true, confirmLabel: 'Remove',
    message: `Remove "${t.name}" from My textures?\n\nThe image is deleted from this browser's texture library. Layers already using it keep it.`,
  });
  if (!ok) return;
  try { await removeUserTexture(t.id); } catch { toast.error('Could not delete the texture.'); }
}

const userThumbs = new WeakMap<Uint8Array, string>();
function userThumb(t: UserTexture): string {
  let u = userThumbs.get(t.image);
  if (!u) { u = URL.createObjectURL(new Blob([t.image as BlobPart], { type: 'image/png' })); userThumbs.set(t.image, u); allUrls.push(u); }
  return u;
}

const fileInput = ref<HTMLInputElement | null>(null);
let importSlot = -1;
function importImage(slot: number): void { importSlot = slot; fileInput.value?.click(); }
/** import_custom_texture: converted, saved to My textures (unique name), and put on the layer. */
async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  const id = objId.value;
  if (!f || !id || importSlot < 0) return;
  try {
    const t = await importTextureFile(f);
    let saved: UserTexture | null = null;
    try { saved = await saveUserTexture(t.name, t.image); } catch { toast.warn('The image is on the layer, but it could not be saved to My textures.'); }
    const name = saved?.name ?? t.name;
    updateTextureLayer(id, importSlot, {}, { texture: { name, path: f.name, image: t.image } });
    picking.value = null;
  } catch (err) {
    toast.error((err as Error)?.message || 'Could not load the selected image.');
  }
}

/** Move up / Move down (move_texture_layer): the active layer and the panel's state follow the slots. */
function moveLayer(slot: number, toIndex: number): void {
  if (!objId.value || busy.value) return;
  const map = moveTextureLayer(objId.value, slot, toIndex);
  if (!map.size) return;
  const remap = (s: number) => map.get(s) ?? s;
  activeSlot.value = remap(activeSlot.value);
  if (picking.value !== null) picking.value = remap(picking.value);
  const ex: Record<number, boolean> = {};
  for (const [k, v] of Object.entries(expanded.value)) ex[remap(Number(k))] = v;
  expanded.value = ex;
  if (adjusting.value) adjusting.value = { ...adjusting.value, slot: remap(adjusting.value.slot) };
}

function removeLayer(slot: number): void {
  if (objId.value) removeTextureLayer(objId.value, slot);
  if (picking.value === slot) picking.value = null;
  if (adjusting.value?.slot === slot) closeAdjust();
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

// ---- paint (brush / face / connected area, whole model) ------------------------------------

const busy = computed(() => baking.value);
const painter = new TextureMaskPainter(() => objId.value, () => activeSlot.value);
// Sessions are per part and slot; the tint follows the stored masks (strokes, undo, whole model, bridge).
watch([objId, activeSlot], () => painter.reset());
// Painting and Adjust placement are mutually exclusive click modes (desktop).
watch(() => [!!active.value && !busy.value && !textureUi.placing, toolScene.value] as const, ([on]) => { painter.setEnabled(false); painter.setEnabled(on); }, { immediate: true });
const MASK_TOOLS: Array<{ id: MaskTool; icon: string; label: string; tip: string }> = [
  { id: 'brush', icon: 'i-lucide-brush', label: 'Brush', tip: 'Brush - paint over the surface by dragging' },
  { id: 'face', icon: 'i-lucide-triangle', label: 'Face', tip: 'Face - click individual triangles' },
  { id: 'area', icon: 'i-lucide-paint-bucket', label: 'Connected area',
    tip: 'Connected area - flood-fill the region reachable without crossing an edge sharper than the angle threshold' },
];
const paintLegend = computed(() => {
  const press = touch.value ? 'Drag on the model' : 'Left mouse';
  const wheel = maskUi.tool === 'brush' ? 'Brush size' : maskUi.tool === 'area' ? 'Angle threshold' : '';
  return [
    [press, maskUi.erase ? 'Erase' : 'Paint'],
    ...(touch.value ? [] : [['Right mouse', maskUi.erase ? 'Paint' : 'Erase'], ['Shift + left mouse', 'Erase']]),
    ...(wheel && !touch.value ? [['Ctrl / Alt + wheel', wheel]] : []),
  ];
});
function selectAll(): void { if (objId.value && active.value) selectWholeModel(objId.value, activeSlot.value); }
function eraseAll(): void { if (objId.value && active.value) eraseWholeModel(objId.value, activeSlot.value); }
const selectAllNa = computed(() => (busy.value ? 'Wait for the bake to finish.' : !active.value ? 'Add a layer first.' : ''));
const eraseAllNa = computed(() => (busy.value ? 'Wait for the bake to finish.' : !active.value ? 'Add a layer first.'
  : !painted.value.has(activeSlot.value) ? 'The active layer has no paint yet.' : ''));

// ---- views (desktop's View row: Normal / Fast, Wireframe) --------------------------------------

/** Raised by every change the preview depends on; a run that finishes under an older one is dropped. */
let generation = 0;
let unmounted = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The run in flight: aborting it stops the engine mid-run (or, without cross-origin isolation, terminates the background lane). */
let runAbort: AbortController | null = null;
let runStart = 0;
/** Duration of the last finished preview: without in-place cancel, a run is only cancelled when restarting the engine is cheaper than letting it finish. */
let lastRunMs = Infinity;

const adjusting = shallowRef<{ slot: number; adj: TextureAdjustments } | null>(null);
/** The live adjustment's full-size image per slot, standing in for the layer's own in the preview and bake. */
const liveImages = shallowRef<Record<string, Uint8Array> | undefined>(undefined);

const placement = new PlacementHandle((offset, final) => {
  if (!objId.value || !active.value) return;
  const slot = activeSlot.value;
  if (final) { schedulePreview(); return; }
  updateTextureLayer(objId.value, slot, { offset }, { label: 'Adjust texture placement', mergeKey: `texture:${objId.value}:${slot}:offset` });
});

const overlay = new ToolOverlay('texture');
// Flat-shaded like the scene's objects (and desktop's volumes), so Normal and Fast read alike.
const previewMaterial = new MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.75, metalness: 0.05, flatShading: true });
const wireMaterial = new MeshBasicMaterial({ color: 0x1f2a30, wireframe: true, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const fastMaterial = new FastViewMaterial();
/** The last Normal preview shown (kept so the wireframe or a view switch can redraw it without a run). */
let lastPreview: { id: string; results: PartResult[] } | null = null;

const fastNa = computed(() => (!active.value ? 'Add a layer first.' : !active.value.image?.length ? 'Pick a texture for the active layer first.'
  : !fastViewable(active.value) ? 'The Fast view shades the Triplanar, Cylindrical and Spherical mappings; this layer uses another one.' : ''));
// A layer the Fast view can't shade falls back to Normal (desktop drops Checker / Distortion the same way).
watch(fastNa, (na) => { if (na && textureUi.view === 'fast') textureUi.view = 'normal'; }, { immediate: true });

function setHidden(ids: string[]): void { toolScene.value?.setToolHidden(ids); }

function addMesh(geometry: BufferGeometry, matrix: number[], material: MeshStandardMaterial): void {
  const m = new Mesh(geometry, material);
  m.matrixAutoUpdate = false;
  m.matrix.fromArray(matrix);
  overlay.add(m);
  if (textureUi.wireframe) {
    const w = new Mesh(geometry, wireMaterial);
    w.matrixAutoUpdate = false;
    w.matrix.fromArray(matrix);
    w.renderOrder = 6;
    overlay.add(w);
  }
}

function geometryOf(positions: Float32Array, indices: Uint32Array): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(new BufferAttribute(indices, 1));
  return g;
}

/** Drop what the views drew (the materials are kept). */
function clearOverlay(): void {
  for (const c of [...overlay.group.children]) {
    overlay.group.remove(c);
    const m = c as Mesh;
    if (m.material !== wireMaterial) m.geometry?.dispose();
  }
}

/** Normal: the displaced parts in place of the object; without a preview only the wireframe (if on) over the object. */
function showPreview(id: string, results: PartResult[] | null): void {
  overlay.attach();
  clearOverlay();
  const o = getObject(id);
  lastPreview = results?.length ? { id, results } : null;
  if (!o || !results?.length) {
    if (o && textureUi.wireframe) for (const part of textureParts(o)) addMesh(geometryOf(part.mesh.positions, part.mesh.indices), part.matrix, previewMaterial);
    // Only the wire meshes stay: the object itself is shown.
    for (const c of [...overlay.group.children]) if ((c as Mesh).material !== wireMaterial) overlay.group.remove(c);
    setHidden([]);
    render();
    return;
  }
  for (const part of textureParts(o)) {
    const r = results.find((x) => x.part.partId === part.partId && x.part.mesh.id === part.mesh.id);
    addMesh(geometryOf(r ? r.positions : part.mesh.positions, r ? r.indices : part.mesh.indices), part.matrix, previewMaterial);
  }
  setHidden([id]);
  render();
}

function clearPreview(): void {
  if (objId.value) showPreview(objId.value, null); else { clearOverlay(); setHidden([]); render(); }
}

/** Fast-view render timing (the last update: change → frame drawn), for the e2e measurement. */
const fastStats = { lastMs: 0, frames: 0 };
let fastSeq = 0;

/**
 * Fast (desktop rebuild_shaded_preview_mesh + render_shaded_preview_mesh): the
 * object's parts as they are, and the active layer's paint on its first model
 * part drawn again over them with the relief shaded on. Rebuilt when the paint
 * changes; a layer setting only updates uniforms.
 */
async function renderFast(): Promise<void> {
  const seq = ++fastSeq;
  const t0 = performance.now();
  const o = obj.value, l = active.value;
  if (!o || !l || textureUi.view !== 'fast') return;
  const parts = textureParts(o);
  const owner = parts[0];
  const patch = owner ? await painter.patchOf(owner) : null;
  if (seq !== fastSeq || textureUi.view !== 'fast') return;
  overlay.attach();
  clearOverlay();
  lastPreview = null;
  for (const part of parts) addMesh(geometryOf(part.mesh.positions, part.mesh.indices), part.matrix, previewMaterial);
  if (owner && patch?.indices.length) {
    const anchor = [owner.matrix[12], owner.matrix[13], owner.matrix[14]];
    const frame = projectionOf(l) === Projection.Triplanar ? null : patchFrame(patch.positions, patch.indices, new Matrix4().fromArray(owner.matrix), anchor);
    fastFrame = { anchor, frame };
    if (fastMaterial.setLayer(l, anchor, frame, liveAdjust(layerSlot(l)))) {
      const m = new Mesh(geometryOf(patch.positions, patch.indices), fastMaterial);
      m.matrixAutoUpdate = false;
      m.matrix.fromArray(owner.matrix);
      m.renderOrder = 4;
      overlay.add(m);
    }
  }
  setHidden([o.id]);
  render();
  requestAnimationFrame(() => { fastStats.lastMs = performance.now() - t0; fastStats.frames++; });
}
let fastFrame: { anchor: number[]; frame: ReturnType<typeof patchFrame> | null } | null = null;

/** A layer setting changed in the Fast view: only the uniforms move (desktop: they are shader inputs). */
function refreshFastUniforms(): void {
  const l = active.value;
  if (textureUi.view !== 'fast' || !l || !fastFrame) return;
  const t0 = performance.now();
  fastMaterial.setLayer(l, fastFrame.anchor, fastFrame.frame, liveAdjust(layerSlot(l)));
  render();
  requestAnimationFrame(() => { fastStats.lastMs = performance.now() - t0; fastStats.frames++; });
}

function redrawView(): void {
  if (textureUi.view === 'fast') void renderFast();
  else if (objId.value) showPreview(objId.value, lastPreview?.id === objId.value ? lastPreview.results : null);
}

painter.onTint = () => { if (textureUi.view === 'fast') void renderFast(); void refreshAnchor(); };

watch(() => textureUi.view, (v, was) => {
  painter.setStrokeOnlyTint(v === 'fast');
  if (v === 'fast') { generation++; runAbort?.abort(); void renderFast(); }
  else if (was === 'fast') { fastFrame = null; clearPreview(); schedulePreview(); }
}, { immediate: true });
watch(() => textureUi.wireframe, () => redrawView());
// The active layer's settings: uniforms in Fast; its slot or texture: the patch / texture too.
watch(() => [active.value, adjusting.value?.adj] as const, ([l], [was]) => {
  if (textureUi.view !== 'fast') return;
  if (l && was && layerSlot(l) === layerSlot(was) && l.image === was.image && projectionOf(l) === projectionOf(was)) refreshFastUniforms();
  else void renderFast();
}, { deep: true });

// ---- live preview (desktop's Normal view: the real geometry Bake will produce) ------------------

/** What restarting the background engine lane costs: measured on its last start (8-11 s on a loaded 6-core machine), else a guess. */
const restartMs = () => engineLaneStartupMs('background') || 5000;
/** The engine's progress of the current preview / bake (desktop's bake job percentage; null = not reported yet), and its part. */
const progress = ref<number | null>(null);
const partNote = ref('');
function startProgress(): void { progress.value = null; partNote.value = ''; }
const onPart = (i: number, n: number) => { partNote.value = n > 1 ? `part ${i + 1} of ${n}` : ''; };
const onProgress = (p: number) => { progress.value = p; };
const progressNote = computed(() => [progress.value === null ? '' : `${progress.value} %`, partNote.value].filter(Boolean).join(' · '));

/** Anything the preview depends on: the object, its placement, meshes, stack, masks and a live image adjustment. */
const previewKey = computed(() => {
  const o = obj.value;
  if (!o) return '';
  void meshTexture.value;
  const parts = textureParts(o);
  return JSON.stringify([o.id, o.position, o.rotation, o.scale, parts.map((p) => [p.mesh.id, p.matrix.map((v) => +v.toFixed(5))])])
    + `|${parts.map((p) => tokenOf(p.texture)).join('.')}|${tokenOf(stack.value)}|${tokenOf(liveImages.value)}`;
});
const tokens = new WeakMap<object, number>();
let tokenSeq = 0;
function tokenOf(v: object | undefined): number {
  if (!v) return 0;
  let t = tokens.get(v);
  if (t === undefined) { t = ++tokenSeq; tokens.set(v, t); }
  return t;
}

/**
 * A change: the run in flight is now stale (desktop raises its preview
 * generation and the job aborts mid-run through still_wanted()). The engine
 * stops at its next progress check when the page is cross-origin isolated;
 * otherwise stopping means terminating the background engine, done only when
 * the run is likely to take longer than restarting it (else it finishes and
 * is dropped). The newest state runs next; never more than one run queued.
 * The Fast view skips the engine run altogether (desktop rebuild_preview), and
 * a placement drag waits for the release.
 */
function schedulePreview(): void {
  generation++;
  if (running && runAbort && (toolCancelsInPlace('texture_displacement') || lastRunMs - (performance.now() - runStart) > restartMs())) runAbort.abort();
  if (timer) clearTimeout(timer);
  if (textureUi.view === 'fast' || placement.dragging) return;
  timer = setTimeout(() => { timer = null; void runPreview(); }, 350);
}

async function runPreview(): Promise<void> {
  if (running || baking.value || textureUi.view === 'fast') return; // the run in flight starts the next one when it ends
  const id = objId.value, o = obj.value;
  if (!id || !o || !stack.value?.layers.length || !anyPartPainted(o)) { clearPreview(); return; }
  const my = generation;
  const ac = new AbortController();
  running = true;
  runAbort = ac;
  runStart = performance.now();
  previewing.value = true;
  startProgress();
  try {
    const r = await runBake(id, { preview: true, stale: () => my !== generation, signal: ac.signal, onPart, onProgress, images: liveImages.value });
    if (r && my === generation && objId.value === id && textureUi.view === 'normal') {
      lastRunMs = performance.now() - runStart;
      showPreview(id, r.filter((x) => x.indices.length));
    }
  } catch (e) {
    if (e instanceof SliceCancelled) warmEngineLane('background'); // restarts the lane if the cancel terminated it
    else if (my === generation) toast.error('The texture displacement preview failed.', { detail: (e as Error)?.message });
  } finally {
    running = false;
    runAbort = null;
    previewing.value = false;
    if (my !== generation && !timer && !unmounted) void runPreview();
  }
}

watch(previewKey, () => { schedulePreview(); void painter.refreshTint(); });
watch(toolScene, () => { overlay.attach(); render(); });

// ---- Adjust placement (desktop's Adjust Texture mode) ---------------------------------------------

/** update_adjust_anchor: from the active layer's paint on the first model part. False when it has none. */
async function refreshAnchor(): Promise<boolean> {
  if (!textureUi.placing) return false;
  const o = obj.value, l = active.value;
  const owner = o ? textureParts(o)[0] : undefined;
  const patch = owner ? await painter.patchOf(owner) : null;
  if (!owner || !l || !patch?.indices.length) { placement.update(null, null, 1); return false; }
  const size = new Box3().setFromArray(owner.mesh.positions).getSize(new Vector3()).length();
  const img = l.image ? decodeLayerImage(l.image) : null;
  placement.update(paintAnchor(patch.positions, patch.indices, new Matrix4().fromArray(owner.matrix), size), l, img ? img.width / img.height : 1);
  return true;
}

async function togglePlacement(): Promise<void> {
  if (textureUi.placing) { textureUi.placing = false; return; }
  textureUi.placing = true;
  if (!(await refreshAnchor())) { textureUi.placing = false; toast.error('Paint something with this layer first.'); }
}
watch(() => textureUi.placing, (on) => { placement.setEnabled(on && !!toolScene.value); if (on) void refreshAnchor(); });
// The handle follows the layer (offset, tile size, rotation) and the object.
watch(() => [active.value, obj.value?.position, obj.value?.rotation, obj.value?.scale] as const, () => { if (textureUi.placing) void refreshAnchor(); });
// Another layer, or the settings hidden: placement stops (desktop).
watch([activeSlot, objId], () => { textureUi.placing = false; });

// ---- image adjustments (desktop's "Adjust image" window) -----------------------------------------

const adjustCanvas = shallowRef<HTMLCanvasElement | null>(null);
// A function ref: the canvas sits inside the layer list's v-for, where a plain ref collects an array.
function setAdjustCanvas(el: unknown): void { adjustCanvas.value = el instanceof HTMLCanvasElement ? el : null; }
const adjustLayer = computed(() => (adjusting.value ? layers.value.find((l) => layerSlot(l) === adjusting.value!.slot) : undefined));
const adjustHasColour = computed(() => { const l = adjustLayer.value; return !!(l?.image && decodeLayerImage(l.image)?.rgb); });
const ADJUST_PREVIEW_MAX_PX = 192;
const ADJUST_ROWS: Array<{ key: keyof TextureAdjustments; label: string; min: number; max: number; step: number; tip?: string }> = [
  { key: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.01 },
  { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01 },
  { key: 'sharpness', label: 'Sharpness', min: 0, max: 1, step: 0.01,
    tip: 'Brings out the finest detail in the image. Applied after Blur, so the two can be used together: blur away the speckle, then sharpen the edges that remain.' },
  { key: 'blur', label: 'Blur', min: 0, max: 1, step: 0.01,
    tip: 'Blurs the image itself. The layer\'s own Smoothing slider softens the relief without altering the image, and is the one to reach for first.' },
  { key: 'hue_deg', label: 'Hue', min: -180, max: 180, step: 1 },
];

function liveAdjust(slot: number): TextureAdjustments | null {
  return adjusting.value?.slot === slot && !isIdentity(adjusting.value.adj) ? adjusting.value.adj : null;
}

function openAdjust(slot: number): void {
  closeAdjust();
  const l = layers.value.find((x) => layerSlot(x) === slot);
  if (!l?.image || !decodeLayerImage(l.image)) { toast.error('Could not load the selected texture.'); return; }
  adjusting.value = { slot, adj: { ...IDENTITY_ADJUST } };
  picking.value = null;
}

/** Every exit that isn't Save as copy: the layer is left as it was found (close_image_adjust). */
function closeAdjust(): void {
  if (adjustTimer) { clearTimeout(adjustTimer); adjustTimer = null; }
  adjusting.value = null;
  if (liveImages.value) liveImages.value = undefined;
}

function setAdjust(key: keyof TextureAdjustments, v: number): void {
  if (!adjusting.value) return;
  adjusting.value = { ...adjusting.value, adj: { ...adjusting.value.adj, [key]: v } };
}

// The box shows the adjusted image at once (a small copy); the model follows a moment after the last change
// (desktop: on slider release), with the full-size image standing in for the layer's.
let adjustTimer: ReturnType<typeof setTimeout> | null = null;
watch([adjusting, adjustCanvas, adjustLayer], () => {
  const a = adjusting.value, l = adjustLayer.value, cv = adjustCanvas.value;
  if (!a || !l?.image) return;
  const src = decodeLayerImage(l.image);
  if (!src) { closeAdjust(); return; }
  if (cv) {
    const small = applyTextureAdjustments(downscaleHeight(src, ADJUST_PREVIEW_MAX_PX), a.adj);
    cv.width = small.width; cv.height = small.height;
    const ctx = cv.getContext('2d');
    if (ctx) {
      const id = ctx.createImageData(small.width, small.height);
      for (let i = 0; i < small.width * small.height; i++) {
        const [r, g, b] = small.rgb ? [small.rgb[i * 3], small.rgb[i * 3 + 1], small.rgb[i * 3 + 2]] : [small.pixels[i], small.pixels[i], small.pixels[i]];
        id.data[i * 4] = r; id.data[i * 4 + 1] = g; id.data[i * 4 + 2] = b; id.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(id, 0, 0);
    }
  }
  if (adjustTimer) clearTimeout(adjustTimer);
  adjustTimer = setTimeout(() => {
    adjustTimer = null;
    const cur = adjusting.value;
    if (!cur || cur !== a) return;
    liveImages.value = isIdentity(cur.adj) ? undefined : { [String(cur.slot)]: encodeHeightPng(applyTextureAdjustments(src, cur.adj)) };
  }, 250);
});

/** commit_image_adjust (saveAdjustedCopy); on failure the panel stays open with the edit. */
async function saveAdjustCopy(): Promise<void> {
  const a = adjusting.value, id = objId.value;
  if (!a || !id) return;
  try {
    if (await saveAdjustedCopy(id, a.slot, a.adj)) toast.info('Saved to My textures.');
    closeAdjust();
  } catch (e) {
    toast.error((e as Error)?.message || 'Failed to save the adjusted texture.');
  }
}
// The layer went away under the panel (removed, or undone).
watch(adjustLayer, (l) => { if (adjusting.value && !l) closeAdjust(); });
watch(objId, () => closeAdjust());

// ---- bake --------------------------------------------------------------------------------

const bakeNa = computed(() => (!obj.value ? '' : !layers.value.length || !painted.value.size ? 'Nothing is painted yet.' : ''));

let bakeAbort: AbortController | null = null;

async function bake(): Promise<void> {
  const id = objId.value;
  if (!id || baking.value || bakeNa.value) return;
  baking.value = true;
  generation++; // a preview finishing now is stale
  runAbort?.abort(); // and the bake shouldn't wait behind it
  const ac = new AbortController();
  bakeAbort = ac;
  startProgress();
  try {
    const r = await bakeTexture(id, { signal: ac.signal, onPart, onProgress, images: liveImages.value });
    if (r.cancelled) toast.info('Bake cancelled.');
    else if (!r.ok) toast.error(r.message ?? 'The bake failed.');
    else if (r.budgetLimited) toast.warn('The triangle budget limited the detail of the bake.');
  } catch (e) {
    toast.error('The bake failed.', { detail: (e as Error)?.message });
  } finally {
    baking.value = false;
    bakeAbort = null;
    if (!unmounted) { schedulePreview(); if (textureUi.view === 'fast') void renderFast(); }
  }
}

/** Desktop's bake job can be cancelled from its progress bar. */
function cancelBake(): void { bakeAbort?.abort(); }

// Dev / e2e hook: the Fast view's last update time.
if (typeof window !== 'undefined') (window as unknown as { __cubbyTextureFast?: typeof fastStats }).__cubbyTextureFast = fastStats;

onMounted(() => {
  void textureLibrary().then((l) => { library.value = l; });
  void loadUserTextures();
  // The background engine starts while the user picks a texture and paints, not on the first preview.
  warmEngineLane('background');
  schedulePreview();
});
onBeforeUnmount(() => {
  unmounted = true;
  if (timer) clearTimeout(timer);
  if (adjustTimer) clearTimeout(adjustTimer);
  generation++;
  runAbort?.abort();
  // A bake still running finishes (and commits) first; the lane's instance goes after.
  releaseEngineLane('background');
  painter.onTint = null;
  painter.dispose();
  placement.dispose();
  overlay.dispose();
  previewMaterial.dispose();
  wireMaterial.dispose();
  fastMaterial.dispose();
  setHidden([]);
  resetTextureUi();
  for (const u of allUrls) URL.revokeObjectURL(u);
});
</script>

<template>
  <ToolPanel title="Texture displacement" icon="i-lucide-brick-wall" @close="closeTool()">
    <template v-if="obj">
      <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/bmp,.png,.jpg,.jpeg,.bmp" class="hidden" @change="onFile">

      <section class="td__sec" aria-label="View">
        <div class="td__tools" role="group" aria-label="View">
          <span class="td__lbl td__lbl--v">View</span>
          <UTooltip text="Normal - the real geometry, exactly what Bake will produce. Slower to update">
            <UButton size="sm" icon="i-lucide-mountain" aria-label="Normal" :aria-pressed="textureUi.view === 'normal'"
                     :variant="textureUi.view === 'normal' ? 'soft' : 'ghost'" :color="textureUi.view === 'normal' ? 'primary' : 'neutral'"
                     @click="textureUi.view = 'normal'" />
          </UTooltip>
          <UTooltip :text="fastNa || 'Fast - the relief is only shaded on, not built, and only for the layer you are editing. Updates instantly while you paint'">
            <UButton size="sm" icon="i-lucide-zap" aria-label="Fast" :aria-pressed="textureUi.view === 'fast'" :disabled="!!fastNa"
                     :variant="textureUi.view === 'fast' ? 'soft' : 'ghost'" :color="textureUi.view === 'fast' ? 'primary' : 'neutral'"
                     @click="textureUi.view = 'fast'" />
          </UTooltip>
          <span class="td__vsep" aria-hidden="true" />
          <UTooltip text="Wireframe - overlay the mesh edges; independent of the view">
            <UButton size="sm" icon="i-lucide-grid-3x3" aria-label="Wireframe" :aria-pressed="textureUi.wireframe"
                     :variant="textureUi.wireframe ? 'soft' : 'ghost'" :color="textureUi.wireframe ? 'primary' : 'neutral'"
                     @click="textureUi.wireframe = !textureUi.wireframe" />
          </UTooltip>
        </div>
      </section>

      <section class="td__sec" aria-label="Paint">
        <div class="td__head">
          <h3>Paint</h3>
          <span class="td__into">{{ active ? `into ${layerName(active)}` : 'add a layer to paint' }}</span>
          <UTooltip text="Paint - add the active layer where you click or drag. The right button erases, and so does holding Shift.">
            <UButton size="xs" icon="i-lucide-plus" aria-label="Paint" :aria-pressed="!maskUi.erase" :variant="!maskUi.erase ? 'soft' : 'ghost'"
                     :color="!maskUi.erase ? 'primary' : 'neutral'" @click="maskUi.erase = false" />
          </UTooltip>
          <UTooltip text="Erase - remove the active layer where you click or drag. The right button paints.">
            <UButton size="xs" icon="i-lucide-minus" aria-label="Erase" :aria-pressed="maskUi.erase" :variant="maskUi.erase ? 'soft' : 'ghost'"
                     :color="maskUi.erase ? 'primary' : 'neutral'" @click="maskUi.erase = true" />
          </UTooltip>
        </div>
        <div class="td__tools" role="radiogroup" aria-label="Paint tool">
          <UTooltip v-for="t in MASK_TOOLS" :key="t.id" :text="t.tip">
            <UButton size="sm" :icon="t.icon" :aria-label="t.label" role="radio" :aria-checked="maskUi.tool === t.id"
                     :variant="maskUi.tool === t.id ? 'soft' : 'ghost'" :color="maskUi.tool === t.id ? 'primary' : 'neutral'" @click="maskUi.tool = t.id" />
          </UTooltip>
          <span class="td__vsep" aria-hidden="true" />
          <UTooltip :text="selectAllNa || 'Select whole model - paint every face of the model with the active layer'">
            <UButton size="sm" variant="ghost" color="neutral" icon="i-lucide-box-select" aria-label="Select whole model" :disabled="!!selectAllNa" @click="selectAll" />
          </UTooltip>
          <UTooltip :text="eraseAllNa || 'Erase whole model - clear the active layer\'s paint from every face'">
            <UButton size="sm" variant="ghost" color="neutral" icon="i-lucide-eraser" aria-label="Erase whole model" :disabled="!!eraseAllNa" @click="eraseAll" />
          </UTooltip>
          <UIcon v-if="maskUi.busy" name="i-lucide-loader-circle" class="size-3.5 animate-spin text-dimmed ml-auto" />
        </div>
        <div v-if="maskUi.tool === 'brush'" class="td__ctl">
          <UTooltip text="Brush size"><span class="td__lbl td__lbl--w">Size</span></UTooltip>
          <USlider v-model="maskUi.radius" :min="RADIUS_MIN" :max="RADIUS_MAX" :step="0.05" size="sm" class="flex-1" aria-label="Brush size" />
          <UInputNumber v-model="maskUi.radius" :min="RADIUS_MIN" :max="RADIUS_MAX" :step="0.2" :step-snapping="false" size="xs" class="w-20"
                        :format-options="{ maximumFractionDigits: 2 }" aria-label="Brush size (mm)" />
          <UTooltip text="Circle - paints everything under the brush as seen from the camera">
            <UButton size="xs" icon="i-lucide-circle" aria-label="Circle" :aria-pressed="maskUi.cursor === 'circle'"
                     :variant="maskUi.cursor === 'circle' ? 'soft' : 'ghost'" :color="maskUi.cursor === 'circle' ? 'primary' : 'neutral'" @click="maskUi.cursor = 'circle'" />
          </UTooltip>
          <UTooltip text="Sphere - paints only within a ball around the point under the cursor">
            <UButton size="xs" icon="i-lucide-globe" aria-label="Sphere" :aria-pressed="maskUi.cursor === 'sphere'"
                     :variant="maskUi.cursor === 'sphere' ? 'soft' : 'ghost'" :color="maskUi.cursor === 'sphere' ? 'primary' : 'neutral'" @click="maskUi.cursor = 'sphere'" />
          </UTooltip>
        </div>
        <div v-else-if="maskUi.tool === 'area'" class="td__ctl">
          <UTooltip text="Angle threshold - the fill stops at edges sharper than this"><span class="td__lbl td__lbl--w">Angle</span></UTooltip>
          <USlider v-model="maskUi.angle" :min="ANGLE_MIN" :max="ANGLE_MAX" :step="1" size="sm" class="flex-1" aria-label="Angle threshold" />
          <UInputNumber v-model="maskUi.angle" :min="ANGLE_MIN" :max="ANGLE_MAX" :step="1" size="xs" class="w-20" aria-label="Angle threshold (°)" />
        </div>
        <p v-else class="text-xs text-muted m-0">Click a triangle to paint it.</p>
        <dl v-if="active" class="td__legend">
          <template v-for="[k, v] in paintLegend" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
        </dl>
        <p v-if="maskUi.error" class="td__warn">{{ maskUi.error }}</p>
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
            <template v-if="layerSlot(l) === activeSlot">
              <UTooltip text="Adjust image - brightness, contrast, sharpness, blur and hue, shown on the image and on the model as you set them. Save as copy writes the result to your texture library and points this layer at it.">
                <UButton icon="i-lucide-sliders-horizontal" size="xs" variant="ghost" color="neutral" aria-label="Adjust image" :disabled="busy || !l.image"
                         :aria-pressed="adjusting?.slot === layerSlot(l)" @click.stop="adjusting?.slot === layerSlot(l) ? closeAdjust() : openAdjust(layerSlot(l))" />
              </UTooltip>
              <UTooltip text="Move up - applied earlier">
                <UButton icon="i-lucide-arrow-up" size="xs" variant="ghost" color="neutral" aria-label="Move up" :disabled="busy || li === 0"
                         @click.stop="moveLayer(layerSlot(l), li - 1)" />
              </UTooltip>
              <UTooltip text="Move down - applied later">
                <UButton icon="i-lucide-arrow-down" size="xs" variant="ghost" color="neutral" aria-label="Move down" :disabled="busy || li + 1 >= layers.length"
                         @click.stop="moveLayer(layerSlot(l), li + 2)" />
              </UTooltip>
            </template>
            <UButton icon="i-lucide-x" size="xs" variant="ghost" color="neutral" aria-label="Remove this layer" :disabled="busy" @click.stop="removeLayer(layerSlot(l))" />
          </div>

          <div v-if="picking === layerSlot(l)" class="td__lib">
            <h4 class="td__lib-h">Built-in</h4>
            <div class="td__lib-grid">
              <button v-for="t in library" :key="t.url" type="button" class="td__lib-item" :title="t.name" @click="pickLibrary(layerSlot(l), t)">
                <img :src="t.url" alt="" loading="lazy">
                <span>{{ t.name }}</span>
              </button>
            </div>
            <p v-if="!library.length" class="text-xs text-muted">The built-in textures aren’t available.</p>
            <h4 class="td__lib-h">My textures</h4>
            <div class="td__lib-grid" aria-label="My textures">
              <div v-for="t in userTextures" :key="t.id" class="td__lib-user">
                <button type="button" class="td__lib-item" :title="t.name" @click="pickUser(layerSlot(l), t)">
                  <img :src="userThumb(t)" alt="">
                  <span>{{ t.name }}</span>
                </button>
                <UButton class="td__lib-del" icon="i-lucide-x" size="xs" color="neutral" variant="solid" :aria-label="`Remove ${t.name} from My textures`"
                         @click="removeUser(t)" />
              </div>
              <UTooltip text="Import your own image as a height map. It is converted to the format the slicer bakes from and saved to your texture library in this browser, kept separate from the built-in textures.">
                <button type="button" class="td__lib-item td__lib-add" aria-label="Import image" @click="importImage(layerSlot(l))">
                  <UIcon name="i-lucide-plus" class="size-5" />
                  <span>Import…</span>
                </button>
              </UTooltip>
            </div>
            <p class="text-xs text-muted m-0">PNG, JPG or BMP - converted to a height map on import. Remove one of yours with its ×.</p>
          </div>

          <div v-if="adjusting?.slot === layerSlot(l)" class="td__adj" role="group" aria-label="Adjust image">
            <canvas :ref="setAdjustCanvas" class="td__adj-img" aria-label="Adjusted image" />
            <div class="td__adj-rows">
              <template v-for="r in ADJUST_ROWS" :key="r.key">
                <UTooltip :text="r.tip ?? r.label" :content="{ side: 'right' }"><span class="td__lbl">{{ r.label }}</span></UTooltip>
                <USlider :model-value="adjusting.adj[r.key]" :min="r.min" :max="r.max" :step="r.step" size="sm" :aria-label="r.label"
                         :disabled="r.key === 'hue_deg' && !adjustHasColour" @update:model-value="(v: unknown) => setAdjust(r.key, Number(v))" />
                <span class="td__adj-val">{{ r.key === 'hue_deg' ? `${Math.round(adjusting.adj[r.key])}°` : adjusting.adj[r.key].toFixed(2) }}</span>
              </template>
            </div>
            <p v-if="!adjustHasColour" class="text-xs text-muted m-0">This texture is grayscale, so it has no hue to shift.</p>
            <p class="text-xs text-muted m-0">The model follows the sliders. Save as copy writes the adjusted image to your texture library and points this layer at it.</p>
            <div class="td__adj-btns">
              <UButton size="xs" variant="ghost" color="neutral" label="Reset" @click="adjusting && (adjusting = { ...adjusting, adj: { ...IDENTITY_ADJUST } })" />
              <span class="flex-1" />
              <UButton size="xs" variant="ghost" color="neutral" label="Cancel" @click="closeAdjust" />
              <UButton size="xs" variant="soft" label="Save as copy" :disabled="isIdentity(adjusting.adj) || busy" @click="saveAdjustCopy" />
            </div>
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
              <div class="td__ctl">
                <USelect :model-value="li === 0 ? BlendMode.Add : enumInt(l.json, 'blend_mode', BlendMode.Add)" :items="BLENDS" size="xs" class="flex-1 min-w-0"
                         aria-label="Blend" :disabled="busy || li === 0" @update:model-value="(v: unknown) => setField(layerSlot(l), 'blend_mode', Number(v))" />
                <UTooltip text="Adjust placement - drag the handle on the model to move the texture">
                  <UButton size="xs" icon="i-lucide-move" aria-label="Adjust placement" :aria-pressed="textureUi.placing" :disabled="busy"
                           :variant="textureUi.placing ? 'soft' : 'ghost'" :color="textureUi.placing ? 'primary' : 'neutral'" @click="togglePlacement" />
                </UTooltip>
              </div>
            </template>

            <UButton class="td__full justify-self-start" size="xs" variant="link" color="neutral"
                     :label="expanded[layerSlot(l)] ? 'Fewer settings' : 'More settings'"
                     @click="expanded[layerSlot(l)] && (textureUi.placing = false); expanded = { ...expanded, [layerSlot(l)]: !expanded[layerSlot(l)] }" />
          </div>
        </div>
      </section>

    </template>
    <p v-else class="text-sm text-muted">Select one object to add a texture to it.</p>

    <template #footer>
      <span v-if="previewing && !baking" class="td__status" role="status">
        <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" /> Updating preview…{{ progressNote ? ` ${progressNote}` : '' }}
      </span>
      <span v-else-if="baking" class="td__status" role="status">{{ progressNote || 'Starting…' }}</span>
      <UButton v-if="baking" size="sm" variant="ghost" color="neutral" label="Cancel" @click="cancelBake" />
      <UButton v-else size="sm" variant="ghost" label="Close" @click="closeTool()" />
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
.td__tools { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.td__vsep { width: 1px; align-self: stretch; margin: 4px 4px; background: var(--line); }
.td__lbl--w { width: 34px; flex: none; }
.td__lbl--v { margin-right: 6px; }
.td__lib-h { margin: 2px 0 0; font: 600 var(--fs-xs) var(--font); color: var(--fg-1); }
.td__lib-user { position: relative; }
.td__lib-del { position: absolute; top: 0; right: 0; opacity: 0; }
.td__lib-user:hover .td__lib-del, .td__lib-del:focus-visible { opacity: 1; }
@media (hover: none) { .td__lib-del { opacity: .85; } }
.td__lib-add { justify-content: center; min-height: 72px; border-style: dashed; border-color: var(--line); }
.td__adj { padding: 6px 8px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; }
.td__adj-img { width: 100%; max-width: 192px; align-self: center; image-rendering: auto; border-radius: 4px; border: 1px solid var(--line); background: var(--bg-1); }
.td__adj-rows { display: grid; grid-template-columns: 70px 1fr 40px; gap: 6px 8px; align-items: center; }
.td__adj-val { font-size: var(--fs-xs); color: var(--fg-1); text-align: right; font-variant-numeric: tabular-nums; }
.td__adj-btns { display: flex; align-items: center; gap: 4px; }
.td__legend { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; margin: 0; font-size: var(--fs-xs); color: var(--fg-2, var(--fg-1)); }
.td__legend dd { margin: 0; }
.td__status { margin-right: auto; display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); color: var(--fg-1); }
</style>

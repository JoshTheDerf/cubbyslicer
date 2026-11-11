<script setup lang="ts">
/**
 * Prepare (plater) viewport. Owns one PrepareScene, feeds it the project
 * store and turns scene callbacks into store mutations.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  activePlate, bed, clearSelection, endGesture, getMesh, layOnFace, meshRevision, objectIssues, objects, plateBedOf, plates, select, selectedIds,
  selectedPart, setActivePlate, setPartTransform, setTransforms,
} from '../project/store';
import type { MeshData, ObjectIssue } from '../project/types';
import { registerViewport, setSectionRatio, toggleLayOnFace, viewportState } from './controller';
import { massMarkers, prepareMassBodies } from './massMarkers';
import type { MassMarker } from './massProps';
import MassDetails from './MassDetails.vue';
import { activeView } from '../app/state';
import { plateOf } from '../project/store';
import { attachLayerBands } from '../layers/bands3d';
import { PrepareScene, type SceneItem } from './scene';
import { bindToolScene, toolState } from '../tools/state';
import { assembledObjects, assemblyUi } from '../tools/assembly/assembly';
import { installPaintOverlays } from '../paint/controller';
import { useEffectiveBedAssets } from '../dialogs/bed/customBed';
import { bindCameraPrefs } from './cameraPrefs';
import { activeEngine, resolvedConfig } from '../app/state';
import { collisionVolumesFromConfig } from './collisionVolumes';
import { currentPresets } from '../presets/store';
import { SCALAR, toNumber, valueAt } from '../lib/configValue';
import { filamentColourOf, mixedFilaments } from '../mixed/store';
import { cadChild, cadObject, cadSupportOf, setNodeTransform } from '../cad/commands';
import { RENDER_TO_ZUP } from '../cad/api';
import { cadLocalMeshes, cadWasmLoaded, evaluateNodeLocal } from '../cad/build';
import { findIn, parentFrameMatrix } from '../cad/tree';
import { cleanTransform } from '../cad/frames';
import { mat4Multiply } from '../project/math';
import type { CadNodeTarget, ImexPlateView } from './scene';
import {
  computeImexZoneLayout, effectiveImexMode, effectivePhysicalExtruderMap, headLanes, imexHeadFilament, imexHeadTransforms, imexTheme, isImexPrinter,
} from '../plates/imex';
import { setPlateHeadFilament } from '../plates/store';
import AnchoredMenu from '../app/shell/AnchoredMenu.vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import { toThreeColor } from '../lib/colour';
import { beltOpenY, buildPlateUp, isBeltPrinter } from './belt';
import { moveTower, startTowerPreview, towerViews } from '../app/towerPreview';
import { startBeltPurge } from '../app/beltPurge';
import { startPlateSpiralWatch } from '../plates/spiral';

const emit = defineEmits<{ contextmenu: [id: string | null, x: number, y: number]; hover: [id: string | null] }>();

const host = ref<HTMLElement | null>(null);
const scene = shallowRef<PrepareScene | null>(null);
const box = ref<{ x: number; y: number; w: number; h: number } | null>(null);
const failed = ref<string | null>(null);

const blocking = (l: ObjectIssue[] | undefined) => !!l?.some((i) => i !== 'overlap');

const multiFilament = () => currentPresets.value.selection.filaments.length > 1;

function items(): SceneItem[] {
  const out: SceneItem[] = [];
  // Assembly View: display copies at the assembled poses (tools/assembly).
  const list = toolState.active === 'assembly' ? assembledObjects(objects.value, getMesh, assemblyUi.explosion) : objects.value;
  for (const o of list) {
    const mesh = getMesh(o.meshId);
    if (!mesh) continue;
    let partMeshes: Map<string, MeshData> | undefined;
    for (const p of o.parts ?? []) { const pm = getMesh(p.meshId); if (pm) (partMeshes ??= new Map()).set(p.meshId, pm); }
    // Orca draws objects in their filament's colour once there are several filaments.
    const tinted = !o.color && multiFilament() ? { ...o, color: filamentColourOf(toNumber(valueAt(o.overrides.extruder, SCALAR), 1) || 1) } : o;
    out.push({ obj: tinted, mesh, warn: blocking(objectIssues.value.get(o.id)), partMeshes });
  }
  return out;
}

onMounted(() => {
  if (!host.value) return;
  try {
    const s = new PrepareScene(host.value, {
      onPick: (id, mode) => { if (id) select([id], mode); else clearSelection(); },
      onBoxSelect: (ids, additive) => select(ids, additive ? 'add' : 'replace'),
      onBoxRect: (r) => { box.value = r; },
      onTransformEnd: (res, kind) => {
        setTransforms(res, kind === 'translate' ? 'Move' : kind === 'rotate' ? 'Rotate' : 'Scale', { drop: kind !== 'translate' });
        endGesture(); // one gizmo drag = one undo step
      },
      onLayOnFace: (id, n) => { layOnFace(id, n); toggleLayOnFace(false); },
      onContextMenu: (id, x, y) => {
        if (id && !selectedIds.value.includes(id)) select([id]);
        emit('contextmenu', id, x, y);
      },
      onHover: (id) => emit('hover', id),
      onPlateClick: (i) => setActivePlate(i),
      onCadNodeTransformEnd: (objectId, nodeId, t, kind) => {
        void setNodeTransform(objectId, nodeId, cleanTransform(t), kind === 'translate' ? 'Move shape' : kind === 'rotate' ? 'Rotate shape' : 'Scale shape');
        endGesture();
      },
      onPartTransformEnd: (objectId, partId, t, kind) => {
        setPartTransform(objectId, partId, t, kind === 'translate' ? 'Move part' : kind === 'rotate' ? 'Rotate part' : 'Scale part');
        endGesture();
      },
      onTowerMove: (plate, x, y) => { moveTower(plate, x, y); endGesture(); },
      onSectionWheel: (dir) => setSectionRatio(viewportState.section.ratio + dir * 0.01),
      onMassMarker: (m) => { massPick.value = m; },
      onImexGhostHover: (head, x, y) => { ghostTip.value = head === null ? null : { text: ghostTipText(head), x, y }; },
      onImexGhostClick: (head, x, y) => openGhostPicker(head, x, y),
    });
    scene.value = s;
    if (import.meta.env.DEV) (window as unknown as { __cubbyScene?: PrepareScene }).__cubbyScene = s;
    bindToolScene(s);
    installPaintOverlays();
    stopLayerBands = attachLayerBands(s);
    s.setPlates(bed.value, plates.value.length, activePlate.value);
    s.setBedAssets(bedAssets.value);
    stopCameraPrefs = bindCameraPrefs({
      controls: s.orbit, camera: () => s.camera, host: host.value, requestRender: () => s.orbit.dispatchEvent({ type: 'change' }),
      pickRoots: () => s.scene.children.filter((c) => c !== s.gizmo.object),
    });
    s.setGizmoMode(viewportState.gizmo);
    s.sync(items(), selectedIds.value);
    registerViewport({
      setView: (p) => s.setView(p),
      fitSelection: () => s.fitSelection(),
      fitBed: () => s.fitBed(),
      zoom: (d) => s.zoom(d),
      capture: (o) => s.capture(o),
    });
  } catch (e) {
    failed.value = (e as Error)?.message || 'WebGL is unavailable';
  }
});

watch([bed, () => plates.value.length, activePlate], ([b, n, a]) => scene.value?.setPlates(b, n, a));
// Vendor bed model / texture, or the printer's custom ones (Bed shape dialog).
const bedAssets = useEffectiveBedAssets();
watch(bedAssets, (a) => scene.value?.setBedAssets(a));
watch([objects, selectedIds, objectIssues, meshRevision, () => toolState.active === 'assembly', () => assemblyUi.explosion,
  () => currentPresets.value.filamentColours().join(), mixedFilaments], () => scene.value?.sync(items(), selectedIds.value), { deep: true });
watch(() => viewportState.gizmo, (m) => scene.value?.setGizmoMode(m));
watch([() => viewportState.camera, scene], ([t]) => scene.value?.setCameraType(t), { immediate: true });
watch([() => viewportState.snap, scene], ([v]) => scene.value?.setSnapIncrement(v), { immediate: true });
watch([selectedPart, scene], ([p]) => scene.value?.setActivePart(p), { immediate: true });
// A CubbyCAD child node picked in the shape tree: the gizmo edits it in its own frame.
function cadTarget(): CadNodeTarget | null {
  const c = cadChild.value, o = cadObject.value;
  if (!c || !o?.cad) return null;
  const root = o.cad.node;
  const node = findIn(root, c.nodeId)?.node;
  if (!node) return null;
  const t = node.transform ?? {};
  return {
    objectId: o.id, nodeId: node.id,
    frame: mat4Multiply(RENDER_TO_ZUP, parentFrameMatrix(root, node.id)),
    position: t.position ?? [0, 0, 0], rotation: t.rotation ?? [0, 0, 0, 1], scale: t.scale ?? [1, 1, 1],
    mesh: evaluateNodeLocal(node),
    readOnly: !!node.locked || cadSupportOf(o).get(node.id)?.editable === false,
  };
}
watch([cadChild, () => cadObject.value?.cad?.node, cadWasmLoaded, cadLocalMeshes, scene], () => scene.value?.setActiveCadNode(cadTarget()), { immediate: true });
// The accent follows the engine (App.vue sets <html data-engine>); post-flush so the CSS is applied.
watch(activeEngine, () => scene.value?.refreshAccent(), { flush: 'post' });
watch(() => viewportState.layOnFace, (on) => scene.value?.setLayOnFace(on));
// Orca 2.5 IDEX/IQEX parallel modes: zones on each plate in a parallel mode, ghosts of the other carriages' prints.
const imexViews = computed((): Array<ImexPlateView | null> => {
  const cfg = resolvedConfig.value;
  if (!isImexPrinter(cfg)) return [];
  const theme = imexTheme(cfg);
  const filaments = currentPresets.value.selection.filaments.length;
  return plates.value.map((p, i) => {
    const mode = effectiveImexMode(cfg, p.config);
    const pb = plateBedOf(i);
    const layout = computeImexZoneLayout(cfg, mode, pb);
    if (!layout.primaryZone) return null;
    const heads = imexHeadTransforms(cfg, mode, layout, pb);
    const colourOf = (h: number) => {
      const slot = filaments > 1 ? imexHeadFilament(h, p.config, filaments, effectivePhysicalExtruderMap(cfg)) : 0;
      return slot ? toThreeColor(filamentColourOf(slot)) : null;
    };
    return { layout, theme, heads, colourOf };
  });
});
watch([imexViews, scene], ([v]) => scene.value?.setImex(v), { immediate: true });
// Ghost copies (Plater::format_imex_ghost_tooltip / on_imex_ghost_click): which filament a carriage prints;
// a head with two or more filament lanes gets the picker (IMEXFilamentPickerPopover).
const ghostTip = shallowRef<{ text: string; x: number; y: number } | null>(null);
function ghostTipText(head: number): string {
  const cfg = resolvedConfig.value;
  const n = currentPresets.value.selection.filaments.length;
  const slot = imexHeadFilament(head, plates.value[activePlate.value]?.config, n, effectivePhysicalExtruderMap(cfg));
  return slot ? `T${head} -> filament ${slot}` : `T${head} — no filament routed\nAdd an extruder in the Machine tab so this head has a filament slot.`;
}
const ghostMenu = shallowRef<{ open: boolean; x: number; y: number; items: DropdownMenuItem[][] }>({ open: false, x: 0, y: 0, items: [] });
function openGhostPicker(head: number, x: number, y: number): void {
  const pem = effectivePhysicalExtruderMap(resolvedConfig.value);
  const lanes = headLanes(pem, head).filter((l) => l < currentPresets.value.selection.filaments.length);
  if (lanes.length < 2) return; // single-lane head: the tooltip already says it all
  const plate = activePlate.value;
  const current = imexHeadFilament(head, plates.value[plate]?.config, currentPresets.value.selection.filaments.length, pem);
  ghostMenu.value = {
    open: true, x, y,
    items: [[{ label: `T${head}`, type: 'label' }], lanes.map((l) => ({
      label: `Filament ${l + 1}`, type: 'checkbox' as const, checked: current === l + 1,
      chip: { color: 'neutral' as const, style: { background: filamentColourOf(l + 1) } },
      onSelect: () => setPlateHeadFilament(plate, head, l + 1, pem),
    }))],
  };
}
// Orca 2.5 belt printers: the tilt line and the open Y axis on each plate.
const beltView = computed(() => (isBeltPrinter(resolvedConfig.value) ? { up: buildPlateUp(resolvedConfig.value), openY: beltOpenY(resolvedConfig.value) } : null));
watch([beltView, scene, () => plates.value.length], ([v]) => scene.value?.setBelt(v), { immediate: true });
// The prime tower of every plate that prints one (desktop's wipe tower volume), draggable.
startTowerPreview();
// Belt printers: the belt purge prism object(s) (desktop ensure_belt_purge_tower).
startBeltPurge();
// Objects arriving on a spiral vase plate get the vase settings (desktop notify_instance_update).
startPlateSpiralWatch();
watch([towerViews, scene, bed, () => plates.value.length], ([v]) => scene.value?.setTowers(v), { immediate: true });
// Orca 2.5 view options: X-Ray, section view (shared with Preview), focus mode, center of mass.
watch([() => viewportState.xray, scene], ([on]) => scene.value?.setXray(on), { immediate: true });
watch([() => viewportState.section.ratio, () => viewportState.section.normal, scene],
  ([r, n]) => scene.value?.setSection(r, n), { immediate: true });
// "Set viewing angle" (or the first cut) aims the plane from whichever view is showing.
watch(() => viewportState.section.aim, () => {
  if (activeView.value === 'prepare' && scene.value) viewportState.section.normal = scene.value.cameraFacing();
});
watch([() => viewportState.focusMode, scene], ([on]) => scene.value?.setFocusMode(on), { immediate: true });
const massPick = shallowRef<{ marker: MassMarker; x: number; y: number } | null>(null);
let massTimer: ReturnType<typeof setTimeout> | null = null;
let massGen = 0;
function refreshMass(): void {
  if (massTimer) clearTimeout(massTimer);
  massTimer = setTimeout(() => {
    massTimer = null;
    // Desktop hides the markers while a tool other than move / rotate / scale / lay on face is open.
    const on = viewportState.centerOfMass && !toolState.active;
    const input = { objects: objects.value, mesh: getMesh, config: resolvedConfig.value, plateOf: (o: { id: string }) => plateOf(o.id) };
    scene.value?.setMassMarkers(on ? massMarkers(input) : []);
    // Assemblies: their united bodies come asynchronously (manifold-3d); redraw once they are in.
    const gen = ++massGen;
    if (on) void prepareMassBodies(input).then((fresh) => { if (fresh && gen === massGen) scene.value?.setMassMarkers(massMarkers(input)); });
  }, 120);
}
watch([() => viewportState.centerOfMass, objects, meshRevision, resolvedConfig, () => toolState.active, scene], refreshMass, { deep: true, immediate: true });
// Orca 2.5 toolhead collision volumes (printer settings), drawn on every plate.
const collisionVolumes = computed(() => collisionVolumesFromConfig(resolvedConfig.value));
watch([collisionVolumes, () => viewportState.showCollisionVolumes, scene], ([v, all]) => scene.value?.setCollisionVolumes(v, all), { immediate: true });

let stopLayerBands: (() => void) | null = null;
let stopCameraPrefs: (() => void) | null = null;
onBeforeUnmount(() => {
  stopLayerBands?.();
  stopCameraPrefs?.();
  registerViewport(null);
  bindToolScene(null);
  scene.value?.dispose();
  scene.value = null;
});
</script>

<template>
  <div ref="host" class="vp" :class="{ 'vp--layflat': viewportState.layOnFace }">
    <div v-if="ghostTip" class="vp__tip" :style="{ left: `${ghostTip.x + 12}px`, top: `${ghostTip.y + 16}px` }" data-testid="imex-ghost-tip">{{ ghostTip.text }}</div>
    <AnchoredMenu v-model:open="ghostMenu.open" :x="ghostMenu.x" :y="ghostMenu.y" :items="ghostMenu.items" />
    <MassDetails v-if="massPick" :marker="massPick.marker" :x="massPick.x" :y="massPick.y" @close="scene?.closeMarker()" />
    <div v-if="box" class="vp__marquee" :style="{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` }" />
    <div v-if="failed" class="vp__fail">
      <strong>3D view unavailable</strong>
      <span>{{ failed }}. Enable hardware acceleration in your browser to use the plater.</span>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.vp {
  position: relative; width: 100%; height: 100%; overflow: hidden;
  background: radial-gradient(120% 90% at 50% 0%, var(--vp-bg-top), var(--vp-bg) 70%);
  user-select: none;
}
.vp :deep(.vp-canvas) { position: absolute; inset: 0; display: block; outline: none; touch-action: none; }
/* Gizmo dimension labels / rotation readout (CSS2DRenderer, @cubby/shared/gizmo). */
.vp :deep(.vp-labels) { position: absolute; inset: 0; pointer-events: none; }
.vp :deep(.cubby-3d-label) { background: color-mix(in srgb, var(--bg-1) 92%, transparent); color: var(--fg-0); }
.vp :deep(.cubby-3d-label-input) { background: var(--bg-2); color: var(--fg-0); }
.vp__tip {
  position: fixed; z-index: calc(var(--z-toolbar) + 3); pointer-events: none; white-space: pre-line; max-width: 320px;
  padding: 4px 8px; border-radius: 4px; font-size: var(--fs-sm); color: var(--fg-0); background: color-mix(in srgb, var(--bg-1) 94%, transparent);
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
}
.vp__marquee {
  position: absolute; pointer-events: none; z-index: 2;
  border: 1px dashed var(--info);
  background: color-mix(in srgb, var(--info) 10%, transparent);
}
.vp__fail {
  position: absolute; inset: 0; display: grid; place-content: center; gap: 6px; text-align: center; padding: 24px;
  color: var(--fg-1); font-size: var(--fs-md);
}
.vp__fail strong { color: var(--fg-0); font-size: var(--fs-lg); }
</style>

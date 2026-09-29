<script setup lang="ts">
/**
 * Prepare (plater) viewport. Owns one PrepareScene, feeds it the project
 * store and turns scene callbacks into store mutations.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  activePlate, bed, clearSelection, getMesh, layOnFace, meshRevision, objectIssues, objects, plates, select, selectedIds,
  selectedPart, setActivePlate, setPartTransform, setTransforms,
} from '../project/store';
import type { MeshData, ObjectIssue } from '../project/types';
import { registerViewport, toggleLayOnFace, viewportState } from './controller';
import { attachLayerBands } from '../layers/bands3d';
import { PrepareScene, type SceneItem } from './scene';
import { bindToolScene, toolState } from '../tools/state';
import { assembledObjects, assemblyUi } from '../tools/assembly/assembly';
import { installPaintOverlays } from '../paint/controller';
import { useEffectiveBedAssets } from '../dialogs/bed/customBed';
import { bindCameraPrefs } from './cameraPrefs';
import { activeEngine } from '../app/state';
import { currentPresets } from '../presets/store';
import { asArray } from '../presets/values';
import { filamentColourOf, mixedFilaments } from '../mixed/store';

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
    const tinted = !o.color && multiFilament() ? { ...o, color: filamentColourOf(Number(asArray(o.overrides.extruder)[0]) || 1) } : o;
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
      onTransformEnd: (res, mode) => {
        setTransforms(res, mode === 'translate' ? 'Move' : mode === 'rotate' ? 'Rotate' : 'Scale', { drop: mode !== 'translate' });
      },
      onLayOnFace: (id, n) => { layOnFace(id, n); toggleLayOnFace(false); },
      onContextMenu: (id, x, y) => {
        if (id && !selectedIds.value.includes(id)) select([id]);
        emit('contextmenu', id, x, y);
      },
      onHover: (id) => emit('hover', id),
      onPlateClick: (i) => setActivePlate(i),
      onPartTransformEnd: (objectId, partId, t, mode) => setPartTransform(objectId, partId, t,
        mode === 'translate' ? 'Move part' : mode === 'rotate' ? 'Rotate part' : 'Scale part'),
    });
    scene.value = s;
    bindToolScene(s);
    installPaintOverlays();
    stopLayerBands = attachLayerBands(s);
    s.setPlates(bed.value, plates.value.length, activePlate.value);
    s.setBedAssets(bedAssets.value);
    stopCameraPrefs = bindCameraPrefs({
      controls: s.orbit, camera: s.camera, host: host.value, requestRender: () => s.orbit.dispatchEvent({ type: 'change' }),
      pickRoots: () => s.scene.children.filter((c) => c !== s.gizmo.getHelper()),
    });
    s.setGizmoMode(viewportState.gizmo);
    s.sync(items(), selectedIds.value);
    registerViewport({
      setView: (p) => s.setView(p),
      fitSelection: () => s.fitSelection(),
      fitBed: () => s.fitBed(),
      zoom: (d) => s.zoom(d),
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
  () => currentPresets.value.selection.filaments.map((_, i) => currentPresets.value.filamentColour(i)).join(), mixedFilaments], () => scene.value?.sync(items(), selectedIds.value), { deep: true });
watch(() => viewportState.gizmo, (m) => scene.value?.setGizmoMode(m));
watch([selectedPart, scene], ([p]) => scene.value?.setActivePart(p), { immediate: true });
// The accent follows the engine (App.vue sets <html data-engine>); post-flush so the CSS is applied.
watch(activeEngine, () => scene.value?.refreshAccent(), { flush: 'post' });
watch(() => viewportState.layOnFace, (on) => scene.value?.setLayOnFace(on));

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

<script setup lang="ts">
/**
 * Cut (Orca GLGizmoCut3D, key C): a cut plane through the selected object —
 * height + tilt, planar or dovetail (tongue & groove), what to do with each
 * half (keep / place on cut / flip) — and, for planar cuts, connectors
 * (plug / dowel / snap) placed by clicking the cut surface. The cut itself
 * runs Orca's Cut code in the engine; the pieces replace the object (undoable).
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, Plane, Vector3 } from 'three';
import { getObject, meshRevision, objectInfo, selectedIds } from '../../project/store';
import type { Vec3 } from '../../project/math';
import type { ToolPointerEvent } from '../../viewport/scene';
import { touch } from '../../app/shell/uiState';
import { toast } from '../../ui';
import ToolPanel from '../ToolPanel.vue';
import { closeTool, installHandler, toolScene } from '../state';
import { COLORS, ToolOverlay, circleLine, polyline, render } from '../overlay';
import type { Loop } from '../brim/brimEars';
import {
  crossSection, defaultSettings, insideSection, performCut, planeMatrix, planeNormal, validate,
  type ConnectorShape, type ConnectorStyle, type ConnectorType, type CutSettings, type PartAction,
} from './cut';

const objId = ref<string | null>(selectedIds.value.length === 1 ? selectedIds.value[0] : null);
const obj = computed(() => (objId.value ? getObject(objId.value) ?? null : null));
const info = computed(() => (objId.value ? objectInfo.value.get(objId.value) ?? null : null));

function initial(): CutSettings {
  const i = info.value;
  if (!i) return defaultSettings([0, 0, 0], 10);
  return defaultSettings([(i.min[0] + i.max[0]) / 2, (i.min[1] + i.max[1]) / 2, (i.min[2] + i.max[2]) / 2], i.max[2] - i.min[2]);
}
const s = reactive<CutSettings>(initial());
const tab = ref<'cut' | 'connectors'>('cut');
const busy = ref(false);
const selectedConnector = ref(-1);

const zMin = computed(() => info.value?.min[2] ?? 0);
const zMax = computed(() => info.value?.max[2] ?? 10);
const height = computed({
  get: () => +(s.center[2] - zMin.value).toFixed(2),
  set: (h: number) => { s.center = [s.center[0], s.center[1], zMin.value + Math.max(0, Math.min(zMax.value - zMin.value, h))]; },
});

const loops = shallowRef<Loop[]>([]);
function recompute(): void { loops.value = objId.value ? crossSection(objId.value, s) : []; }
const check = computed(() => validate(s, loops.value));
const hasConnectors = computed(() => s.mode === 'plane' && s.connectors.length > 0);

const modeItems = [{ value: 'plane', label: 'Planar' }, { value: 'groove', label: 'Dovetail' }];
const actionItems: Array<{ value: PartAction; label: string }> = [
  { value: 'keep', label: 'Keep' }, { value: 'place', label: 'Place on cut' }, { value: 'flip', label: 'Flip upside down' },
];
const typeItems: Array<{ value: ConnectorType; label: string }> = [{ value: 'plug', label: 'Plug' }, { value: 'dowel', label: 'Dowel' }, { value: 'snap', label: 'Snap' }];
const styleItems: Array<{ value: ConnectorStyle; label: string }> = [{ value: 'prism', label: 'Prism' }, { value: 'frustum', label: 'Frustum' }];
const shapeItems: Array<{ value: ConnectorShape; label: string }> = [
  { value: 'circle', label: 'Circle' }, { value: 'square', label: 'Square' }, { value: 'hexagon', label: 'Hexagon' }, { value: 'triangle', label: 'Triangle' },
];

// ---- 3D ----
const overlay = new ToolOverlay('cut');
const hoverPt = ref<[number, number] | null>(null);

function planeQuad(size: number): Mesh {
  const h = size / 2;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([-h, -h, 0, h, -h, 0, h, h, 0, -h, -h, 0, h, h, 0, -h, h, 0], 3));
  const m = new Mesh(g, new MeshBasicMaterial({ color: check.value.ok ? 0xa0e0ff : 0xef5b5b, opacity: 0.28, transparent: true, side: DoubleSide, depthWrite: false }));
  m.renderOrder = 24;
  return m;
}

function draw(): void {
  overlay.attach();
  overlay.clear();
  const i = info.value;
  if (!i) { render(); return; }
  const pm = planeMatrix(s);
  const diag = Math.hypot(i.max[0] - i.min[0], i.max[1] - i.min[1], i.max[2] - i.min[2]) * 1.25 + 10;
  const quad = planeQuad(diag);
  quad.applyMatrix4(pm);
  overlay.add(quad);
  const toW = (u: number, v: number, z = 0.02) => new Vector3(u, v, z).applyMatrix4(pm);
  for (const l of loops.value) overlay.add(polyline(l.pts.map(([u, v]) => toW(u, v)), check.value.ok ? 0xffffff : COLORS.warn, true));
  // Normal arrow (towards the upper part).
  const c = new Vector3(...s.center), n = planeNormal(s);
  overlay.add(polyline([c, c.clone().addScaledVector(n, Math.max(6, diag * 0.15))], COLORS.first));
  if (s.mode === 'plane') {
    const nn: Vec3 = [n.x, n.y, n.z];
    s.connectors.forEach((k, idx) => {
      const ok = insideSection(loops.value, [k.u, k.v]);
      const w = toW(k.u, k.v);
      overlay.add(circleLine([w.x, w.y, w.z], nn, k.radius, !ok ? COLORS.warn : idx === selectedConnector.value ? COLORS.earSelected : COLORS.second, 40));
    });
    if (tab.value === 'connectors' && hoverPt.value) {
      const w = toW(hoverPt.value[0], hoverPt.value[1]);
      overlay.add(circleLine([w.x, w.y, w.z], nn, s.connectorSize / 2, COLORS.hover, 40));
    }
  }
  render();
}

/** Ray → plane-local point on the cut plane. */
function planePoint(e: ToolPointerEvent): [number, number] | null {
  const n = planeNormal(s);
  const hit = e.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(n, new Vector3(...s.center)), new Vector3());
  if (!hit) return null;
  const l = hit.applyMatrix4(planeMatrix(s).invert());
  return [l.x, l.y];
}

function connectorAt(p: [number, number]): number {
  let best = -1, bd = Infinity;
  s.connectors.forEach((k, i) => { const d = Math.hypot(k.u - p[0], k.v - p[1]); if (d <= k.radius && d < bd) { bd = d; best = i; } });
  return best;
}

function onPointer(e: ToolPointerEvent): boolean {
  if (!obj.value || tab.value !== 'connectors' || s.mode !== 'plane') return false;
  const p = e.kind === 'leave' ? null : planePoint(e);
  if (e.kind === 'hover' || e.kind === 'leave') {
    hoverPt.value = p && insideSection(loops.value, p) && connectorAt(p) < 0 ? p : null;
    draw();
    return true;
  }
  if (!p) return false;
  const i = connectorAt(p);
  if (e.kind === 'context') {
    if (i < 0) return false;
    s.connectors.splice(i, 1);
    selectedConnector.value = -1;
    return true;
  }
  if (e.kind !== 'click') return false;
  if (i >= 0) { selectedConnector.value = i === selectedConnector.value ? -1 : i; draw(); return true; }
  if (!insideSection(loops.value, p)) return true;
  s.connectors.push({ u: p[0], v: p[1], radius: s.connectorSize / 2, height: s.connectorDepth });
  selectedConnector.value = s.connectors.length - 1;
  return true;
}

function applySizeToAll(): void {
  for (const k of s.connectors) { k.radius = s.connectorSize / 2; k.height = s.connectorDepth; }
}
function removeSelected(): void {
  if (selectedConnector.value < 0) return;
  s.connectors.splice(selectedConnector.value, 1);
  selectedConnector.value = -1;
}
function resetPlane(): void {
  const d = initial();
  s.center = d.center; s.rotX = 0; s.rotY = 0;
}

async function cut(): Promise<void> {
  if (!objId.value || !check.value.ok || busy.value) return;
  busy.value = true;
  try {
    const ids = await performCut(objId.value, JSON.parse(JSON.stringify(s)) as CutSettings);
    toast.success(ids.length === 1 ? 'Cut into parts.' : `Cut into ${ids.length} objects.`, { timeout: 2000 });
    closeTool();
  } catch (e) {
    toast.error('The cut failed.', { detail: (e as Error)?.message ?? String(e) });
  } finally { busy.value = false; }
}

function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedConnector.value >= 0) { e.preventDefault(); e.stopImmediatePropagation(); removeSelected(); }
  if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); void cut(); }
}

// Changing the selection to another single object retargets the tool.
watch(selectedIds, (ids) => {
  if (busy.value) return;
  if (ids.length === 1 && ids[0] !== objId.value) {
    objId.value = ids[0];
    Object.assign(s, initial());
  }
});
watch(() => [s.center, s.rotX, s.rotY, objId.value, meshRevision.value], recompute, { deep: true, immediate: true });
watch([() => JSON.stringify(s), loops, tab, selectedConnector], draw);
watch(toolScene, () => { installHandler({ onPointer, hideGizmo: true, cursor: 'crosshair' }); draw(); });
onMounted(() => {
  installHandler({ onPointer, hideGizmo: true, cursor: 'crosshair' });
  window.addEventListener('keydown', onKey, true);
  draw();
});
onBeforeUnmount(() => { installHandler(null); window.removeEventListener('keydown', onKey, true); overlay.dispose(); });
</script>

<template>
  <ToolPanel title="Cut" icon="i-lucide-scissors" @close="closeTool()">
    <p v-if="!obj" class="text-xs text-muted">Select one object to cut.</p>
    <template v-else>
      <UTabs v-model="tab" :items="[{ value: 'cut', label: 'Cut' }, { value: 'connectors', label: 'Connectors', disabled: s.mode !== 'plane' }]" :content="false" size="xs" />
      <template v-if="tab === 'cut'">
        <div class="ct__grid">
          <span class="ct__lbl">Mode</span>
          <URadioGroup v-model="s.mode" :items="modeItems" orientation="horizontal" size="sm" />
          <span class="ct__lbl">Height</span>
          <div class="flex items-center gap-2">
            <USlider v-model="height" :min="0" :max="+(zMax - zMin).toFixed(2)" :step="0.1" size="sm" class="flex-1" aria-label="Cut height" />
            <UInputNumber v-model="height" :step="0.1" size="xs" class="w-24" :format-options="{ maximumFractionDigits: 2 }" aria-label="Cut height (mm)" />
          </div>
          <span class="ct__lbl">Tilt X</span>
          <div class="flex items-center gap-2">
            <USlider v-model="s.rotX" :min="-90" :max="90" :step="1" size="sm" class="flex-1" aria-label="Tilt about X" />
            <UInputNumber v-model="s.rotX" :min="-90" :max="90" size="xs" class="w-24" aria-label="Tilt about X (degrees)" />
          </div>
          <span class="ct__lbl">Tilt Y</span>
          <div class="flex items-center gap-2">
            <USlider v-model="s.rotY" :min="-90" :max="90" :step="1" size="sm" class="flex-1" aria-label="Tilt about Y" />
            <UInputNumber v-model="s.rotY" :min="-90" :max="90" size="xs" class="w-24" aria-label="Tilt about Y (degrees)" />
          </div>
        </div>
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-rotate-ccw" label="Reset plane" class="self-start" @click="resetPlane" />

        <template v-if="s.mode === 'groove'">
          <div class="ct__grid">
            <span class="ct__lbl">Depth</span><UInputNumber v-model="s.groove.depth" :min="0.1" :step="0.1" size="xs" aria-label="Groove depth (mm)" />
            <span class="ct__lbl">Width</span><UInputNumber v-model="s.groove.width" :min="0.1" :step="0.1" size="xs" aria-label="Groove width (mm)" />
            <span class="ct__lbl">Flaps angle</span><UInputNumber v-model="s.groove.flapsAngle" :min="1" :max="89" size="xs" aria-label="Flaps angle (degrees)" />
            <span class="ct__lbl">Groove angle</span><UInputNumber v-model="s.groove.angle" :min="-89" :max="89" size="xs" aria-label="Groove angle (degrees)" />
          </div>
        </template>

        <div class="ct__parts">
          <div class="ct__part">
            <div class="ct__ph"><span class="ct__dot ct__dot--up" />Upper part</div>
            <UCheckbox v-model="s.keepUpper" label="Keep" :disabled="hasConnectors || s.keepAsParts" />
            <USelect v-model="s.upper" :items="actionItems" size="xs" :disabled="(!s.keepUpper && !hasConnectors) || s.keepAsParts" aria-label="Upper part placement" />
          </div>
          <div class="ct__part">
            <div class="ct__ph"><span class="ct__dot ct__dot--lo" />Lower part</div>
            <UCheckbox v-model="s.keepLower" label="Keep" :disabled="hasConnectors || s.keepAsParts" />
            <USelect v-model="s.lower" :items="actionItems" size="xs" :disabled="(!s.keepLower && !hasConnectors) || s.keepAsParts" aria-label="Lower part placement" />
          </div>
        </div>
        <UCheckbox v-model="s.keepAsParts" label="Cut to parts (one object)" :disabled="hasConnectors" />
      </template>

      <template v-else>
        <p class="text-xs text-muted">
          {{ touch ? 'Tap' : 'Click' }} the cut surface to add a connector; {{ touch ? 'tap' : 'click' }} one to select it<template v-if="!touch">, right-click to remove it</template>.
        </p>
        <div class="ct__grid">
          <span class="ct__lbl">Type</span><URadioGroup v-model="s.connectorType" :items="typeItems" orientation="horizontal" size="sm" />
          <template v-if="s.connectorType !== 'snap'">
            <span class="ct__lbl">Style</span><URadioGroup v-model="s.connectorStyle" :items="styleItems" orientation="horizontal" size="sm" />
            <span class="ct__lbl">Shape</span><USelect v-model="s.connectorShape" :items="shapeItems" size="xs" aria-label="Connector shape" />
          </template>
          <span class="ct__lbl">Size</span><UInputNumber v-model="s.connectorSize" :min="0.5" :step="0.5" size="xs" aria-label="Connector diameter (mm)" />
          <span class="ct__lbl">Depth</span><UInputNumber v-model="s.connectorDepth" :min="0.5" :step="0.5" size="xs" aria-label="Connector depth (mm)" />
          <span class="ct__lbl">Size tolerance</span><UInputNumber v-model="s.radiusTolerance" :min="0" :max="50" :step="1" size="xs" aria-label="Size tolerance (%)" />
          <span class="ct__lbl">Depth tolerance</span><UInputNumber v-model="s.heightTolerance" :min="0" :max="50" :step="1" size="xs" aria-label="Depth tolerance (%)" />
        </div>
        <div class="flex gap-2 flex-wrap">
          <UButton size="xs" color="neutral" variant="outline" label="Apply size to all" :disabled="!s.connectors.length" @click="applySizeToAll" />
          <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-trash-2" label="Remove selected" :disabled="selectedConnector < 0" @click="removeSelected" />
          <UButton size="xs" color="neutral" variant="outline" label="Remove all" :disabled="!s.connectors.length" @click="s.connectors.splice(0); selectedConnector = -1" />
        </div>
        <p class="text-xs text-muted">{{ s.connectors.length }} connector{{ s.connectors.length === 1 ? '' : 's' }}. With connectors both parts are kept.</p>
      </template>

      <p v-if="!check.ok" class="ct__err">{{ check.reason }}</p>
    </template>
    <template #footer>
      <UButton block color="primary" icon="i-lucide-scissors" label="Perform cut" :loading="busy" :disabled="!obj || !check.ok" @click="cut" />
    </template>
  </ToolPanel>
</template>

<style scoped>
.ct__grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; }
.ct__lbl { font-size: 12px; color: var(--ui-text-muted); white-space: nowrap; }
.ct__parts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ct__part { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--ui-border); border-radius: var(--radius); }
.ct__ph { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.ct__dot { width: 8px; height: 8px; border-radius: 50%; }
.ct__dot--up { background: #ff8a00; }
.ct__dot--lo { background: #3ddc84; }
.ct__err { font-size: 12px; color: var(--ui-error); }
</style>

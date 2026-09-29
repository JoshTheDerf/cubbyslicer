<script setup lang="ts">
/**
 * Brim ears (Orca GLGizmoBrimEars, key E): click the object to drop an ear
 * at that spot of its bottom outline, auto-generate ears at sharp corners
 * (max angle / detection radius), select (click) and delete (right click,
 * Delete key, buttons). Ears only print with brim type "painted", as in Orca.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Matrix4, Plane, Vector3 } from 'three';
import { getObject, objectInfo, objects, meshRevision, selectedIds, setBrimPoints, setObjectOverride } from '../../project/store';
import { resolvedConfig } from '../../app/state';
import type { BrimPoint } from '../../project/types';
import type { Vec3, Pt } from '../../project/math';
import type { ToolPointerEvent } from '../../viewport/scene';
import { touch } from '../../app/shell/uiState';
import ToolPanel from '../ToolPanel.vue';
import { closeTool, installHandler, toolScene } from '../state';
import { COLORS, ToolOverlay, circleLine, disc, render, volumeMatrix, volumeMesh } from '../overlay';
import { transformed, mergeMeshes } from '../geom/meshUtil';
import { EAR_DEFAULTS, autoEarPoints, defaultHeadDiameter, detectionRadiusMax, invalidEars, sliceAtZ, type Loop } from './brimEars';

const objId = computed(() => (selectedIds.value.length === 1 ? selectedIds.value[0] : null));
const obj = computed(() => (objId.value ? getObject(objId.value) ?? null : null));

const cfgNum = (k: string, d: number) => {
  const v = resolvedConfig.value[k];
  const s = Array.isArray(v) ? v[0] : v;
  const n = parseFloat(String(s ?? ''));
  return Number.isFinite(n) ? n : d;
};
const nozzle = computed(() => cfgNum('nozzle_diameter', 0.4));
const initialWidth = computed(() => {
  const v = resolvedConfig.value.initial_layer_line_width;
  const s = String((Array.isArray(v) ? v[0] : v) ?? '');
  return s.endsWith('%') ? (parseFloat(s) / 100) * nozzle.value : parseFloat(s) || nozzle.value * 1.25;
});

const diameter = ref(defaultHeadDiameter(initialWidth.value, nozzle.value));
const maxAngle = ref(EAR_DEFAULTS.maxAngle);
const detection = ref(EAR_DEFAULTS.detectionRadius);
const selected = ref<Set<number>>(new Set());
const hoverEar = ref(-1);
const overlay = new ToolOverlay('brim');

/** First layer of the object: model parts sliced 0.1 mm above its bottom (world XY). */
const layer = shallowRef<{ loops: Loop[]; bottom: number } | null>(null);
function computeLayer(): void {
  const o = obj.value;
  const info = o ? objectInfo.value.get(o.id) : undefined;
  if (!o || !info) { layer.value = null; return; }
  const vols = [{ partId: null as string | null }, ...(o.parts ?? []).filter((p) => p.type === 'part').map((p) => ({ partId: p.id as string | null }))];
  const meshes = vols.flatMap((v) => {
    const m = volumeMesh(o.id, v.partId), w = volumeMatrix(o.id, v.partId);
    return m && w ? [{ positions: transformed(m.positions, w), indices: m.indices }] : [];
  });
  const all = mergeMeshes(meshes);
  layer.value = { loops: sliceAtZ(all.positions, all.indices, info.min[2] + 0.1), bottom: info.min[2] };
}

const points = computed<BrimPoint[]>(() => obj.value?.brimPoints ?? []);
function objMatrix(): Matrix4 | null {
  const m = obj.value ? volumeMatrix(obj.value.id, null) : null;
  return m ? new Matrix4().fromArray(m) : null;
}
const worldPts = computed(() => {
  void objects.value;
  const m = objMatrix();
  if (!m) return [];
  return points.value.map((b) => ({ p: new Vector3(...b.pos).applyMatrix4(m), r: b.radius }));
});
const invalid = computed(() => {
  const l = layer.value;
  return l ? invalidEars(worldPts.value.map((w) => ({ p: [w.p.x, w.p.y] as Pt, r: w.r })), l.loops) : new Set<number>();
});
const detectionMax = computed(() => (layer.value ? detectionRadiusMax(layer.value.loops) : 100));

const brimType = computed(() => {
  const o = obj.value;
  const own = o?.overrides.brim_type;
  const v = own ?? resolvedConfig.value.brim_type;
  return (Array.isArray(v) ? v[0] : v) as string | undefined;
});
const hasBrimType = computed(() => 'brim_type' in resolvedConfig.value || !!obj.value?.overrides.brim_type);

function toLocal(x: number, y: number): Vec3 | null {
  const m = objMatrix();
  const l = layer.value;
  if (!m || !l) return null;
  const v = new Vector3(x, y, l.bottom - 0.0001).applyMatrix4(m.clone().invert());
  return [v.x, v.y, v.z];
}

function commit(pts: BrimPoint[], label: string): void {
  if (obj.value) setBrimPoints(obj.value.id, pts, label);
}

function earAt(e: ToolPointerEvent): number {
  const l = layer.value;
  if (!l) return -1;
  const hit = e.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), -l.bottom), new Vector3());
  if (!hit) return -1;
  let best = -1, bd = Infinity;
  worldPts.value.forEach((w, i) => { const d = Math.hypot(w.p.x - hit.x, w.p.y - hit.y); if (d <= w.r && d < bd) { bd = d; best = i; } });
  return best;
}

function onPointer(e: ToolPointerEvent): boolean {
  if (!obj.value) return false;
  if (e.kind === 'hover' || e.kind === 'leave') {
    const i = e.kind === 'hover' ? earAt(e) : -1;
    if (i !== hoverEar.value) { hoverEar.value = i; draw(); }
    return true;
  }
  const i = earAt(e);
  if (e.kind === 'context') {
    if (i < 0) return false;
    commit(points.value.filter((_, k) => k !== i), 'Delete brim ear');
    selected.value = new Set();
    return true;
  }
  if (e.kind !== 'click') return false;
  if (i >= 0) {
    const s = new Set(selected.value);
    if (s.has(i)) s.delete(i); else { if (!e.shift && !e.ctrl) s.clear(); s.add(i); }
    selected.value = s;
    draw();
    return true;
  }
  if (selected.value.size) { selected.value = new Set(); draw(); return true; }
  if (e.hit && e.hit.objectId === obj.value.id) {
    const pos = toLocal(e.hit.point.x, e.hit.point.y);
    if (pos) commit([...points.value, { pos, radius: diameter.value / 2 }], 'Add brim ear');
    return true;
  }
  return false;
}

function autoGenerate(): void {
  const l = layer.value;
  if (!l) return;
  const pts = autoEarPoints(l.loops, detection.value, maxAngle.value);
  const add = pts.map(([x, y]) => toLocal(x, y)).filter((p): p is Vec3 => !!p).map((pos) => ({ pos, radius: diameter.value / 2 }));
  if (add.length) commit([...points.value, ...add], 'Auto generate brim ear');
}
function deleteSelected(): void {
  if (!selected.value.size) return;
  commit(points.value.filter((_, i) => !selected.value.has(i)), 'Delete brim ear');
  selected.value = new Set();
}
function deleteAll(): void { commit([], 'Delete all brim ears'); selected.value = new Set(); }
function applyRadiusToSelected(): void {
  if (!selected.value.size) return;
  commit(points.value.map((b, i) => (selected.value.has(i) ? { ...b, radius: diameter.value / 2 } : b)), 'Brim ears edit');
}
function setPainted(): void { if (obj.value) setObjectOverride(obj.value.id, 'brim_type', 'painted'); }

function draw(): void {
  overlay.attach();
  overlay.clear();
  const l = layer.value;
  if (l) {
    worldPts.value.forEach((w, i) => {
      const c = new Vector3(w.p.x, w.p.y, l.bottom + 0.02);
      const color = invalid.value.has(i) ? COLORS.warn : selected.value.has(i) ? COLORS.earSelected : COLORS.ear;
      overlay.add(disc(c, w.r, color, hoverEar.value === i ? 0.85 : 0.6));
      overlay.add(circleLine([c.x, c.y, c.z + 0.01], [0, 0, 1], w.r, color, 48));
    });
  }
  render();
}

function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected.value.size) { e.preventDefault(); e.stopImmediatePropagation(); deleteSelected(); }
}

watch([obj, meshRevision], () => { computeLayer(); draw(); }, { deep: true });
watch([worldPts, invalid, selected], draw);
watch(objId, () => { selected.value = new Set(); });
watch(toolScene, () => { installHandler({ onPointer, hideGizmo: true }); draw(); });
onMounted(() => {
  computeLayer();
  installHandler({ onPointer, hideGizmo: true });
  window.addEventListener('keydown', onKey, true);
  draw();
});
onBeforeUnmount(() => { installHandler(null); window.removeEventListener('keydown', onKey, true); overlay.dispose(); });
</script>

<template>
  <ToolPanel title="Brim ears" icon="i-lucide-circle-dot" @close="closeTool()">
    <template v-if="obj">
      <p class="text-xs text-muted">
        {{ touch ? 'Tap' : 'Click' }} the object to add an ear at its base; {{ touch ? 'tap' : 'click' }} an ear to select it<template v-if="!touch">, right-click to delete it</template>.
      </p>
      <div class="be__grid">
        <span class="be__lbl">Head diameter</span>
        <div class="flex items-center gap-2">
          <USlider v-model="diameter" :min="EAR_DEFAULTS.headDiameterMin" :max="EAR_DEFAULTS.headDiameterMax" :step="0.1" size="sm" class="flex-1" aria-label="Head diameter" />
          <UInputNumber v-model="diameter" :min="EAR_DEFAULTS.headDiameterMin" :max="EAR_DEFAULTS.headDiameterMax" :step="0.1" size="xs" class="w-20" :format-options="{ maximumFractionDigits: 1 }" aria-label="Head diameter (mm)" />
        </div>
        <span class="be__lbl">Max angle</span>
        <div class="flex items-center gap-2">
          <USlider v-model="maxAngle" :min="0" :max="180" :step="1" size="sm" class="flex-1" aria-label="Max angle" />
          <UInputNumber v-model="maxAngle" :min="0" :max="180" :step="1" size="xs" class="w-20" aria-label="Max angle (°)" />
        </div>
        <span class="be__lbl">Detection radius</span>
        <div class="flex items-center gap-2">
          <USlider v-model="detection" :min="0" :max="Math.max(1, Math.floor(detectionMax))" :step="0.1" size="sm" class="flex-1" aria-label="Detection radius" />
          <UInputNumber v-model="detection" :min="0" :max="detectionMax" :step="0.1" size="xs" class="w-20" :format-options="{ maximumFractionDigits: 1 }" aria-label="Detection radius (mm)" />
        </div>
      </div>
      <div class="flex flex-wrap gap-2">
        <UTooltip text="Generate brim ears using Max angle and Detection radius">
          <UButton size="sm" color="primary" variant="soft" icon="i-lucide-wand-sparkles" label="Auto-generate" @click="autoGenerate" />
        </UTooltip>
        <UButton size="sm" variant="ghost" label="Apply size to selected" :disabled="!selected.size" @click="applyRadiusToSelected" />
      </div>
      <p class="text-xs text-dimmed">{{ points.length }} ear{{ points.length === 1 ? '' : 's' }}<template v-if="selected.size"> · {{ selected.size }} selected</template></p>
      <UAlert v-if="hasBrimType && brimType !== 'painted'" color="warning" variant="subtle" icon="i-lucide-triangle-alert"
              title="Brim type is not “painted”" description="The brim ears will not take effect."
              :actions="[{ label: 'Set brim type to painted', color: 'warning', variant: 'solid', size: 'xs', onClick: setPainted }]" />
      <UAlert v-if="invalid.size" color="error" variant="subtle" icon="i-lucide-circle-alert"
              :title="`${invalid.size} invalid brim ear${invalid.size === 1 ? '' : 's'}`" description="They don’t touch the first layer (shown in red)." />
    </template>
    <p v-else class="text-sm text-muted">Select one object to edit its brim ears.</p>
    <template #footer>
      <UButton size="sm" variant="ghost" color="error" label="Delete selected" :disabled="!selected.size" @click="deleteSelected" />
      <UButton size="sm" variant="ghost" color="error" label="Delete all" :disabled="!points.length" @click="deleteAll" />
      <UButton size="sm" color="primary" label="Done" @click="closeTool()" />
    </template>
  </ToolPanel>
</template>

<style scoped>
.be__grid { display: grid; grid-template-columns: 96px 1fr; gap: 6px 8px; align-items: center; }
.be__lbl { font-size: var(--fs-xs); color: var(--fg-1); }
</style>

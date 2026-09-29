<script setup lang="ts">
/**
 * Measure tool (Orca GLGizmoMeasure, key U): hover highlights the point /
 * edge / circle / plane under the cursor (Shift = exact surface point),
 * clicks pick feature 1 and 2; the panel shows distance, angle and ΔXYZ and
 * can scale the object so a distance becomes a given value.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Matrix4, Vector3 } from 'three';
import { getObject, meshRevision, objects, setTransforms } from '../../project/store';
import type { MeshData } from '../../project/types';
import type { ToolPointerEvent } from '../../viewport/scene';
import { touch } from '../../app/shell/uiState';
import ToolPanel from '../ToolPanel.vue';
import { closeTool, installHandler, toolScene } from '../state';
import { COLORS, ToolOverlay, arcLine, circleLine, lineSegments, pointMarker, render, triHighlight, volumeMatrix, volumeMesh, worldPerPixel } from '../overlay';
import { FEATURE_LABELS, analyzeMesh, dist, pickFeature, transformFeature, type Feature, type MeshAnalysis, type V3 } from './features';
import { measure, primaryDistance, type Measurement } from './measure';
import type { Vec3 } from '../../project/math';

interface FeatureRef { objectId: string; partId: string | null; local: Feature }

const analyses = new WeakMap<MeshData, MeshAnalysis>();
function analysisOf(m: MeshData): MeshAnalysis {
  let a = analyses.get(m);
  if (!a) { a = analyzeMesh(m.positions, m.indices); analyses.set(m, a); }
  return a;
}

const hovered = shallowRef<FeatureRef | null>(null);
const selected = shallowRef<FeatureRef[]>([]);
const overlay = new ToolOverlay('measure');

function world(ref: FeatureRef): Feature | null {
  const m = volumeMatrix(ref.objectId, ref.partId);
  return m ? transformFeature(ref.local, m) : null;
}

const worldSel = computed(() => {
  void objects.value; void meshRevision.value;
  return selected.value.map(world);
});

const result = computed<Measurement | null>(() => {
  const [a, b] = worldSel.value;
  return a && b ? measure(a, b) : null;
});

function sameRef(a: FeatureRef | null, b: FeatureRef | null): boolean {
  return !!a && !!b && a.objectId === b.objectId && a.partId === b.partId && JSON.stringify(a.local) === JSON.stringify(b.local);
}

function refFromEvent(e: ToolPointerEvent): FeatureRef | null {
  const h = e.hit;
  if (!h) return null;
  const mesh = volumeMesh(h.objectId, h.partId);
  if (!mesh) return null;
  const a = analysisOf(mesh);
  const inv = new Matrix4().copy(h.object.matrixWorld).invert();
  const local = h.point.clone().applyMatrix4(inv);
  // Pick tolerance: ~8 px, in mesh units.
  const scale = Math.cbrt(Math.abs(h.object.matrixWorld.determinant())) || 1;
  const tol = (worldPerPixel(h.point) * (touch.value || e.pointerType === 'touch' ? 16 : 8)) / scale;
  const f = pickFeature(a, h.faceIndex, [local.x, local.y, local.z], tol, e.shift);
  return { objectId: h.objectId, partId: h.partId, local: f };
}

function onPointer(e: ToolPointerEvent): boolean {
  if (e.kind === 'hover') {
    const r = refFromEvent(e);
    if (!sameRef(r, hovered.value)) { hovered.value = r; draw(); }
    return true;
  }
  if (e.kind === 'leave') { if (hovered.value) { hovered.value = null; draw(); } return true; }
  if (e.kind === 'click') {
    const r = refFromEvent(e) ?? null;
    if (!r) { selected.value = []; draw(); return true; }
    const cur = selected.value;
    const at = cur.findIndex((c) => sameRef(c, r));
    if (at >= 0) selected.value = cur.filter((_, i) => i !== at);
    else if (cur.length < 2) selected.value = [...cur, r];
    else selected.value = [cur[0], r];
    hovered.value = null;
    draw();
    return true;
  }
  return false;
}

function drawFeature(ref: FeatureRef, color: number): void {
  const f = world(ref);
  if (!f) return;
  if (f.type === 'point') overlay.add(pointMarker(f.p, color, 5));
  else if (f.type === 'edge') {
    overlay.add(lineSegments([f.a, f.b], color));
    overlay.add(pointMarker(f.a, color, 3)); overlay.add(pointMarker(f.b, color, 3));
  } else if (f.type === 'circle') {
    overlay.add(circleLine(f.c, f.n, f.r, color));
    overlay.add(pointMarker(f.c, color, 3));
  } else {
    const mesh = volumeMesh(ref.objectId, ref.partId);
    const m = volumeMatrix(ref.objectId, ref.partId);
    if (!mesh || !m || ref.local.type !== 'plane') return;
    const hl = overlay.add(triHighlight(mesh, analysisOf(mesh).planes[ref.local.plane].tris, color, 0.5));
    hl.matrixAutoUpdate = false;
    hl.matrix.fromArray(m);
  }
}

function draw(): void {
  overlay.attach();
  overlay.clear();
  selected.value.forEach((s, i) => drawFeature(s, i === 0 ? COLORS.first : COLORS.second));
  if (hovered.value && !selected.value.some((s) => sameRef(s, hovered.value))) drawFeature(hovered.value, COLORS.hover);
  const r = result.value;
  const d = r ? primaryDistance(r) : undefined;
  if (d && d.value > 1e-6) {
    overlay.add(lineSegments([d.from, d.to], COLORS.dim));
    overlay.add(pointMarker(d.from, COLORS.dim, 3)); overlay.add(pointMarker(d.to, COLORS.dim, 3));
  }
  if (r?.angle) {
    const a = r.angle;
    const rad = Math.max(a.radius * 0.6, worldPerPixel(new Vector3(...a.center)) * 40);
    overlay.add(arcLine(a.center, a.dirA, a.dirB, rad, COLORS.dim));
    const tip = (dir: V3): V3 => [a.center[0] + dir[0] * rad * 1.15, a.center[1] + dir[1] * rad * 1.15, a.center[2] + dir[2] * rad * 1.15];
    overlay.add(lineSegments([a.center, tip(a.dirA), a.center, tip(a.dirB)], COLORS.dim, 0.6));
  }
  render();
}

// ---- panel text -----------------------------------------------------------------

const fmt = (v: number, d = 3) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(d).replace(/\.?0+$/, ''));
function describe(f: Feature | null): string {
  if (!f) return '—';
  switch (f.type) {
    case 'point': return `(${f.p.map((v) => fmt(v, 2)).join(', ')})`;
    case 'edge': return `length ${fmt(dist(f.a, f.b))} mm`;
    case 'circle': return `Ø ${fmt(f.r * 2)} mm (r ${fmt(f.r)})`;
    case 'plane': return `normal (${f.n.map((v) => fmt(v, 2)).join(', ')})`;
  }
}
const rows = computed(() => worldSel.value.map((f, i) => ({ i, label: f ? FEATURE_LABELS[f.type] : '—', text: describe(f) })));
const hoverText = computed(() => {
  const h = hovered.value;
  if (!h) return null;
  const f = world(h);
  return f ? `${FEATURE_LABELS[f.type]} · ${describe(f)}` : null;
});

// ---- scale to match -----------------------------------------------------------------

const sameObject = computed(() => selected.value.length === 2 && selected.value[0].objectId === selected.value[1].objectId);
const scaleTarget = ref<number | null>(null);
watch(result, (r) => { const d = r ? primaryDistance(r) : undefined; scaleTarget.value = d ? Number(d.value.toFixed(3)) : null; }, { immediate: true });
function applyScale(): void {
  const r = result.value;
  const d = r ? primaryDistance(r) : undefined;
  const want = scaleTarget.value;
  if (!d || !(d.value > 1e-6) || !want || !(want > 0) || !sameObject.value) return;
  const f = want / d.value;
  if (Math.abs(f - 1) < 1e-6) return;
  const o = getObject(selected.value[0].objectId);
  if (!o) return;
  setTransforms([{ id: o.id, scale: o.scale.map((s) => s * f) as Vec3 }], 'Scale to measured size');
}

function restart(): void { selected.value = []; hovered.value = null; draw(); }

onMounted(() => { installHandler({ onPointer, hideGizmo: true }); draw(); });
watch(toolScene, () => { installHandler({ onPointer, hideGizmo: true }); draw(); });
watch([objects, meshRevision], () => {
  // Drop features of deleted volumes; redraw with the new transforms.
  const keep = selected.value.filter((s) => volumeMesh(s.objectId, s.partId));
  if (keep.length !== selected.value.length) selected.value = keep;
  if (hovered.value && !volumeMesh(hovered.value.objectId, hovered.value.partId)) hovered.value = null;
  draw();
}, { deep: true });
onBeforeUnmount(() => { installHandler(null); overlay.dispose(); });
</script>

<template>
  <ToolPanel title="Measure" icon="i-lucide-ruler" @close="closeTool()">
    <p class="text-xs text-muted">
      {{ touch ? 'Tap' : 'Click' }} two features: points, edges, circles or planes.
      <template v-if="!touch">Hold <UKbd value="Shift" size="sm" /> to pick any point on the surface.</template>
    </p>
    <div class="ms__sel">
      <div v-for="r in [0, 1]" :key="r" class="ms__row">
        <span class="ms__dot" :style="{ background: r === 0 ? '#ff8a00' : '#3ddc84' }" />
        <span class="ms__k">{{ rows[r]?.label ?? (r === 0 ? 'Select first feature' : 'Select second feature') }}</span>
        <span class="ms__v">{{ rows[r]?.text ?? '' }}</span>
      </div>
      <div v-if="hoverText" class="ms__hover text-xs text-dimmed">{{ hoverText }}</div>
    </div>
    <dl v-if="result" class="ms__res">
      <template v-if="result.strict">
        <dt>Distance</dt><dd>{{ fmt(result.strict.value) }} mm</dd>
      </template>
      <template v-if="result.infinite && (!result.strict || Math.abs(result.infinite.value - result.strict.value) > 1e-4)">
        <dt>{{ result.strict ? 'Perpendicular' : 'Distance' }}</dt><dd>{{ fmt(result.infinite.value) }} mm</dd>
      </template>
      <template v-if="result.angle">
        <dt>Angle</dt><dd>{{ fmt(result.angle.deg, 2) }}°</dd>
      </template>
      <template v-if="result.delta">
        <dt>Δ X / Y / Z</dt>
        <dd class="ms__xyz">
          <span class="text-(--vp-axis-x)">{{ fmt(Math.abs(result.delta[0]), 2) }}</span>
          <span class="text-(--vp-axis-y)">{{ fmt(Math.abs(result.delta[1]), 2) }}</span>
          <span class="text-(--vp-axis-z)">{{ fmt(Math.abs(result.delta[2]), 2) }}</span>
        </dd>
      </template>
    </dl>
    <p v-else-if="selected.length === 2" class="text-xs text-muted">No measurement between these features.</p>
    <div v-if="result && primaryDistance(result)" class="ms__scale">
      <UFormField label="Scale to distance" size="xs" :ui="{ help: 'text-xs' }" :help="sameObject ? 'Scales the object uniformly so this distance matches.' : 'Pick both features on the same object to scale it.'">
        <div class="flex gap-2 items-center">
          <UInputNumber v-model="scaleTarget" :min="0.001" :step="0.1" :format-options="{ maximumFractionDigits: 3 }" size="sm" class="w-32"
                        :disabled="!sameObject" aria-label="Target distance in mm" @keydown.enter="applyScale" />
          <span class="text-xs text-dimmed">mm</span>
          <UButton size="sm" color="primary" variant="soft" label="Scale" :disabled="!sameObject" @click="applyScale" />
        </div>
      </UFormField>
    </div>
    <template #footer>
      <UButton size="sm" variant="ghost" icon="i-lucide-rotate-ccw" label="Restart selection" :disabled="!selected.length" @click="restart" />
    </template>
  </ToolPanel>
</template>

<style scoped>
.ms__sel { display: flex; flex-direction: column; gap: 4px; }
.ms__row { display: grid; grid-template-columns: 10px auto 1fr; gap: 6px; align-items: center; }
.ms__dot { width: 10px; height: 10px; border-radius: 50%; }
.ms__k { font-weight: 600; }
.ms__v { text-align: right; color: var(--fg-1); font-family: var(--font-mono, monospace); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms__hover { padding-left: 16px; }
.ms__res { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; padding: 6px 8px; background: var(--bg-2); border-radius: var(--radius); }
.ms__res dt { color: var(--fg-1); }
.ms__res dd { margin: 0; text-align: right; font-family: var(--font-mono, monospace); font-weight: 600; }
.ms__xyz { display: flex; gap: 10px; justify-content: flex-end; }
</style>

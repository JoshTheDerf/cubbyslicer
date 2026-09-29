<script setup lang="ts">
/**
 * Orca's "Object manipulation" panel as a collapsible floating card (bottom-
 * left of the canvas): position, rotation (degrees, XYZ Euler), scale (%)
 * and size of the primary selection (mm or inches, Preferences → Units), with a
 * uniform-scale lock.
 */
import { computed, ref, watch } from 'vue';
import { eulerFromQuat, quatFromEuler, type Vec3 } from '../project/math';
import { dropToBed, objectInfo, objectLocalBBox, primarySelection, selectedIds, setTransforms } from '../project/store';
import { fromDisplayLength, lengthUnit, preferences, toDisplayLength } from '../app/preferences';

const LS = 'cubby-slicer:transform-collapsed';
const lock = ref(true);
// Phones start collapsed (the panel would cover most of the view).
const collapsed = ref((() => {
  if (typeof matchMedia !== 'undefined' && matchMedia('(max-width: 640px)').matches) return true;
  try { return localStorage.getItem(LS) === '1'; } catch { return false; }
})());
watch(collapsed, (v) => { try { localStorage.setItem(LS, v ? '1' : '0'); } catch { /* ignore */ } });

const obj = primarySelection;
const multi = computed(() => selectedIds.value.length > 1);
const info = computed(() => (obj.value ? objectInfo.value.get(obj.value.id) : undefined));

const DEG = 180 / Math.PI;
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d || 0; // no "-0"
const rot = computed<Vec3>(() => {
  if (!obj.value) return [0, 0, 0];
  return eulerFromQuat(obj.value.rotation).map((r) => round(r * DEG)) as Vec3;
});
const scalePct = computed(() => obj.value?.scale.map((s) => round(Math.abs(s) * 100)) ?? [100, 100, 100]);
/** Size along the object's own axes (bbox of its mesh + model parts × |scale|). */
const localBox = computed(() => (obj.value ? objectLocalBBox(obj.value) : null));
const size = computed(() => {
  const o = obj.value, b = localBox.value;
  if (!o || !b) return [0, 0, 0];
  return [0, 1, 2].map((i) => round((b.max[i] - b.min[i]) * Math.abs(o.scale[i])));
});
/** Footprint centre + bottom Z, like Orca. */
const shown = computed(() => {
  const i = info.value;
  if (!i) return [0, 0, 0];
  return [round((i.min[0] + i.max[0]) / 2), round((i.min[1] + i.max[1]) / 2), round(i.min[2])];
});

const valid = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function setPos(axis: number, v: number | null | undefined) {
  const o = obj.value;
  if (!o || !valid(v)) return;
  const d = v - shown.value[axis];
  if (Math.abs(d) < 1e-6) return;
  const p = [...o.position] as Vec3;
  p[axis] += d;
  setTransforms([{ id: o.id, position: p }], 'Move', { drop: false });
}
function setRot(axis: number, v: number | null | undefined) {
  const o = obj.value;
  if (!o || !valid(v) || Math.abs(v - rot.value[axis]) < 1e-6) return;
  const e = [...rot.value] as Vec3;
  e[axis] = v;
  setTransforms([{ id: o.id, rotation: quatFromEuler(e[0] / DEG, e[1] / DEG, e[2] / DEG) }], 'Rotate');
}
function setScale(axis: number, pct: number | null | undefined) {
  const o = obj.value;
  if (!o || !valid(pct) || !(pct > 0) || Math.abs(pct - scalePct.value[axis]) < 1e-6) return;
  const f = pct / 100;
  const cur = o.scale;
  const sign = (i: number) => Math.sign(cur[i]) || 1;
  const s: Vec3 = lock.value
    ? (cur.map((c, i) => sign(i) * Math.abs(c) * (f / Math.abs(cur[axis]))) as Vec3)
    : (cur.map((c, i) => (i === axis ? sign(i) * f : c)) as Vec3);
  setTransforms([{ id: o.id, scale: s }], 'Scale');
}
function setSize(axis: number, mm: number | null | undefined) {
  const o = obj.value, b = localBox.value;
  if (!o || !b || !valid(mm) || !(mm > 0) || Math.abs(mm - size.value[axis]) < 1e-6) return;
  const ext = b.max[axis] - b.min[axis];
  if (!(ext > 0)) return;
  setScale(axis, (mm / ext) * 100);
}

const AX = ['X', 'Y', 'Z'] as const;
const AX_COLOR = ['text-(--vp-axis-x)', 'text-(--vp-axis-y)', 'text-(--vp-axis-z)'];
// Preferences → Units: lengths shown (and typed) in mm or inches.
const inch = computed(() => preferences.units === 'imperial');
const L = (v: number[]) => v.map((x) => round(toDisplayLength(x), inch.value ? 3 : 2));
const fromL = (fn: (axis: number, v: number | null | undefined) => void) => (axis: number, v: number | null | undefined) => fn(axis, valid(v) ? fromDisplayLength(v) : v);
const rows = computed(() => [
  { key: 'pos', label: 'Position', unit: lengthUnit(), values: L(shown.value), step: inch.value ? 0.05 : 1, min: undefined as number | undefined, set: fromL(setPos) },
  { key: 'rot', label: 'Rotation', unit: '°', values: rot.value, step: 5, min: undefined, set: setRot },
  { key: 'scale', label: 'Scale', unit: '%', values: scalePct.value, step: 5, min: 0.1, set: setScale },
  { key: 'size', label: 'Size', unit: lengthUnit(), values: L(size.value), step: inch.value ? 0.05 : 1, min: inch.value ? 0.001 : 0.01, set: fromL(setSize) },
]);
const fmt = computed(() => ({ maximumFractionDigits: inch.value ? 3 : 2 }));
</script>

<template>
  <section v-if="obj" class="tp" aria-label="Object manipulation">
    <header class="tp__head">
      <UButton :icon="collapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" color="neutral" variant="ghost" size="xs"
               :aria-expanded="!collapsed" aria-label="Toggle object manipulation" @click="collapsed = !collapsed" />
      <span class="tp__name" :title="obj.name">{{ obj.name }}</span>
      <span v-if="multi" class="text-xs text-dimmed whitespace-nowrap">+{{ selectedIds.length - 1 }} more</span>
      <UTooltip text="Drop to bed">
        <UButton icon="i-lucide-arrow-down-to-line" color="neutral" variant="ghost" size="xs" aria-label="Drop to bed" @click="dropToBed()" />
      </UTooltip>
    </header>
    <div v-show="!collapsed">
      <div class="tp__grid">
        <span />
        <span v-for="(a, i) in AX" :key="a" class="text-center text-xs font-semibold" :class="AX_COLOR[i]">{{ a }}</span>
        <span />
        <template v-for="r in rows" :key="r.key">
          <span class="text-xs text-muted">{{ r.label }}</span>
          <UInputNumber v-for="(a, i) in AX" :key="`${r.key}${a}`" :model-value="r.values[i]" :step="r.step" :min="r.min"
                        :format-options="fmt" :increment="false" :decrement="false" size="xs" :aria-label="`${r.label} ${a}`"
                        :ui="{ base: 'px-1.5 text-center font-mono' }" @update:model-value="r.set(i, $event)" />
          <span class="text-xs text-dimmed">{{ r.unit }}</span>
        </template>
      </div>
      <UCheckbox v-model="lock" label="Uniform scale" size="xs" class="tp__lock" />
    </div>
  </section>
</template>

<style scoped>
.tp {
  width: 330px; max-width: calc(100vw - 24px); padding: 4px 8px 8px;
  background: color-mix(in srgb, var(--bg-1) 94%, transparent);
  border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: var(--shadow); backdrop-filter: blur(6px);
}
.tp__head { display: flex; align-items: center; gap: 4px; margin-bottom: 2px; }
.tp__name { flex: 1; min-width: 0; font: 600 var(--fs-sm) var(--font); color: var(--fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp__grid { display: grid; grid-template-columns: 56px repeat(3, minmax(0, 1fr)) 18px; gap: 4px; align-items: center; }
.tp__lock { margin: 8px 0 0 60px; }
</style>

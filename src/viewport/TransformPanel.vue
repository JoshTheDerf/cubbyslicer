<script setup lang="ts">
/**
 * Orca's "Object manipulation" panel as a collapsible floating card (bottom-
 * left of the canvas): position, rotation (degrees, XYZ Euler), scale (%)
 * and size of the selection (mm or inches, Preferences → Units). Each row
 * ends in its own tool: drop to bed, reset rotation, reset scale, and the
 * uniform-scale lock for scale and size.
 *
 * Several objects are edited as one group in world coordinates, like Orca:
 * position and size are the selection's bounding box, rotation and scale
 * read 0° / 100% and apply about the group's centre (always uniformly).
 */
import { computed, ref, watch } from 'vue';
import { eulerFromQuat, quatFromEuler, type Vec3 } from '../project/math';
import { dropToBed, objectInfo, objectLocalBBox, primarySelection, selectedIds, selectedObjects, setTransforms } from '../project/store';
import { fromDisplayLength, lengthUnit, preferences, toDisplayLength } from '../app/preferences';
import { groupMove, groupRotate, groupScale } from './groupTransform';

const LS = 'cubby-slicer:transform-collapsed';
const lock = ref(true);
// Phones start collapsed (the panel would cover most of the view).
const collapsed = ref((() => {
  if (typeof matchMedia !== 'undefined' && matchMedia('(max-width: 640px)').matches) return true;
  try { return localStorage.getItem(LS) === '1'; } catch { return false; }
})());
watch(collapsed, (v) => { try { localStorage.setItem(LS, v ? '1' : '0'); } catch { /* ignore */ } });

const obj = primarySelection;
const group = computed(() => selectedObjects.value.length > 1);
const uniform = computed(() => group.value || lock.value);
/** Group rows read 0° / 100% again after each edit: remount their inputs. */
const nonce = ref(0);

const DEG = 180 / Math.PI;
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d || 0; // no "-0"

/** World bbox of the selection (one object or the group). */
const box = computed(() => {
  const ids = group.value ? selectedIds.value : obj.value ? [obj.value.id] : [];
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const id of ids) {
    const i = objectInfo.value.get(id);
    if (!i) continue;
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], i.min[k]); max[k] = Math.max(max[k], i.max[k]); }
  }
  return min[0] <= max[0] ? { min, max } : null;
});
const centre = computed<Vec3>(() => (box.value ? box.value.min.map((v, i) => (v + box.value!.max[i]) / 2) as Vec3 : [0, 0, 0]));

const rot = computed<Vec3>(() => {
  if (!obj.value || group.value) return [0, 0, 0];
  return eulerFromQuat(obj.value.rotation).map((r) => round(r * DEG)) as Vec3;
});
const scalePct = computed(() => (group.value || !obj.value ? [100, 100, 100] : obj.value.scale.map((s) => round(Math.abs(s) * 100))));
/** Size along the object's own axes (bbox of its mesh + model parts × |scale|); a group's world bbox. */
const localBox = computed(() => (obj.value && !group.value ? objectLocalBBox(obj.value) : null));
const size = computed(() => {
  if (group.value) { const b = box.value; return b ? [0, 1, 2].map((i) => round(b.max[i] - b.min[i])) : [0, 0, 0]; }
  const o = obj.value, b = localBox.value;
  if (!o || !b) return [0, 0, 0];
  return [0, 1, 2].map((i) => round((b.max[i] - b.min[i]) * Math.abs(o.scale[i])));
});
/** Footprint centre + bottom Z, like Orca. */
const shown = computed(() => {
  const b = box.value;
  if (!b) return [0, 0, 0];
  return [round((b.min[0] + b.max[0]) / 2), round((b.min[1] + b.max[1]) / 2), round(b.min[2])];
});
const rotated = computed(() => rot.value.some((r) => r !== 0));
const scaled = computed(() => scalePct.value.some((s) => s !== 100));

const valid = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const items = () => selectedObjects.value.map((o) => ({ id: o.id, position: o.position, rotation: o.rotation, scale: o.scale }));

function setPos(axis: number, v: number | null | undefined) {
  const o = obj.value;
  if (!o || !valid(v)) return;
  const d = v - shown.value[axis];
  if (Math.abs(d) < 1e-6) return;
  const delta: Vec3 = [0, 0, 0];
  delta[axis] = d;
  setTransforms(groupMove(group.value ? items() : [o], delta), 'Move', { drop: false });
}
function setRot(axis: number, v: number | null | undefined) {
  const o = obj.value;
  if (!o || !valid(v) || Math.abs(v - rot.value[axis]) < 1e-6) return;
  if (group.value) {
    setTransforms(groupRotate(items(), axis, v / DEG, centre.value), 'Rotate');
    nonce.value++;
    return;
  }
  const e = [...rot.value] as Vec3;
  e[axis] = v;
  setTransforms([{ id: o.id, rotation: quatFromEuler(e[0] / DEG, e[1] / DEG, e[2] / DEG) }], 'Rotate');
}
function setScale(axis: number, pct: number | null | undefined) {
  const o = obj.value;
  if (!o || !valid(pct) || !(pct > 0) || Math.abs(pct - scalePct.value[axis]) < 1e-6) return;
  if (group.value) {
    setTransforms(groupScale(items(), pct / 100, centre.value), 'Scale');
    nonce.value++;
    return;
  }
  const f = pct / 100;
  const cur = o.scale;
  const sign = (i: number) => Math.sign(cur[i]) || 1;
  const s: Vec3 = lock.value
    ? (cur.map((c, i) => sign(i) * Math.abs(c) * (f / Math.abs(cur[axis]))) as Vec3)
    : (cur.map((c, i) => (i === axis ? sign(i) * f : c)) as Vec3);
  setTransforms([{ id: o.id, scale: s }], 'Scale');
}
function setSize(axis: number, mm: number | null | undefined) {
  if (!valid(mm) || !(mm > 0) || Math.abs(mm - size.value[axis]) < 1e-6) return;
  if (group.value) {
    if (size.value[axis] > 0) setScale(axis, (mm / size.value[axis]) * 100);
    return;
  }
  const b = localBox.value;
  if (!obj.value || !b) return;
  const ext = b.max[axis] - b.min[axis];
  if (!(ext > 0)) return;
  setScale(axis, (mm / ext) * 100);
}
function resetRotation() {
  const o = obj.value;
  if (o) setTransforms([{ id: o.id, rotation: [0, 0, 0, 1] }], 'Reset rotation');
}
function resetScale() {
  const o = obj.value;
  if (o) setTransforms([{ id: o.id, scale: o.scale.map((s) => Math.sign(s) || 1) as Vec3 }], 'Reset scale'); // keeps mirroring
}

const AX = ['X', 'Y', 'Z'] as const;
const AX_COLOR = ['text-(--vp-axis-x)', 'text-(--vp-axis-y)', 'text-(--vp-axis-z)'];
// Preferences → Units: lengths shown (and typed) in mm or inches.
const inch = computed(() => preferences.units === 'imperial');
const L = (v: number[]) => v.map((x) => round(toDisplayLength(x), inch.value ? 3 : 2));
const fromL = (fn: (axis: number, v: number | null | undefined) => void) => (axis: number, v: number | null | undefined) => fn(axis, valid(v) ? fromDisplayLength(v) : v);

interface RowTool { icon: string; label: string; run: () => void; show: boolean; pressed?: boolean; disabled?: boolean }
const rows = computed(() => {
  const g = group.value;
  return [
    { key: 'pos', label: 'Position', unit: lengthUnit(), values: L(shown.value), step: inch.value ? 0.05 : 1, min: undefined as number | undefined, set: fromL(setPos),
      tool: { icon: 'i-lucide-arrow-down-to-line', label: 'Drop to bed', run: () => dropToBed(), show: true } as RowTool },
    { key: `rot${g ? nonce.value : ''}`, label: 'Rotation', unit: '°', values: rot.value, step: 5, min: undefined, set: setRot,
      tool: { icon: 'i-lucide-rotate-ccw', label: 'Reset rotation', run: resetRotation, show: !g && rotated.value } as RowTool },
    { key: `scale${g ? nonce.value : ''}`, label: 'Scale', unit: '%', values: scalePct.value, step: 5, min: 0.1, set: setScale,
      tool: { icon: 'i-lucide-rotate-ccw', label: 'Reset scale', run: resetScale, show: !g && scaled.value } as RowTool },
    { key: 'size', label: 'Size', unit: lengthUnit(), values: L(size.value), step: inch.value ? 0.05 : 1, min: inch.value ? 0.001 : 0.01, set: fromL(setSize),
      tool: {
        icon: uniform.value ? 'i-lucide-link' : 'i-lucide-unlink', show: true, pressed: uniform.value, disabled: g,
        label: g ? 'Several objects always scale uniformly' : uniform.value ? 'Uniform scale: on' : 'Uniform scale: off',
        run: () => { lock.value = !lock.value; },
      } as RowTool },
  ];
});
const fmt = computed(() => ({ maximumFractionDigits: inch.value ? 3 : 2 }));
const title = computed(() => (group.value ? `${selectedObjects.value.length} objects` : obj.value?.name ?? ''));
const summary = computed(() => `${L(size.value).join(' × ')} ${lengthUnit()}`);
</script>

<template>
  <section v-if="obj" class="tp" :class="{ 'tp--collapsed': collapsed }" aria-label="Object manipulation">
    <header class="tp__head">
      <UButton :icon="collapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" color="neutral" variant="ghost" size="xs"
               :aria-expanded="!collapsed" aria-label="Toggle object manipulation" @click="collapsed = !collapsed" />
      <span class="tp__name" :title="title">{{ title }}</span>
      <span v-if="group" class="tp__badge">World</span>
      <span v-if="collapsed" class="tp__sum">{{ summary }}</span>
    </header>
    <div v-show="!collapsed" class="tp__grid">
      <span />
      <span v-for="(a, i) in AX" :key="a" class="text-center text-xs font-semibold" :class="AX_COLOR[i]">{{ a }}</span>
      <span /><span />
      <template v-for="r in rows" :key="r.key">
        <span class="text-xs text-muted">{{ r.label }}</span>
        <UInputNumber v-for="(a, i) in AX" :key="`${r.key}${a}`" :model-value="r.values[i]" :step="r.step" :min="r.min"
                      :format-options="fmt" :step-snapping="false" :increment="false" :decrement="false" size="xs" :aria-label="`${r.label} ${a}`"
                      :ui="{ base: 'px-1.5 text-center font-mono' }" @update:model-value="r.set(i, $event)" />
        <span class="text-xs text-dimmed">{{ r.unit }}</span>
        <UTooltip v-if="r.tool.show" :text="r.tool.label">
          <UButton :icon="r.tool.icon" :aria-label="r.tool.label" :aria-pressed="r.tool.pressed" :disabled="r.tool.disabled"
                   :color="r.tool.pressed ? 'primary' : 'neutral'" variant="ghost" size="xs" class="justify-center" @click="r.tool.run()" />
        </UTooltip>
        <span v-else />
      </template>
    </div>
  </section>
</template>

<style scoped>
.tp {
  width: 316px; max-width: calc(100vw - 24px); padding: 4px 6px 6px;
  background: color-mix(in srgb, var(--bg-1) 94%, transparent);
  border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: var(--shadow); backdrop-filter: blur(6px);
}
.tp--collapsed { width: auto; max-width: min(316px, calc(100vw - 24px)); padding-bottom: 4px; }
.tp__head { display: flex; align-items: center; gap: 4px; margin-bottom: 2px; }
.tp--collapsed .tp__head { margin-bottom: 0; }
.tp__name { flex: 1; min-width: 0; font: 600 var(--fs-sm) var(--font); color: var(--fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp__badge { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-2); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.tp__sum { font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--fg-2); white-space: nowrap; padding-right: 4px; }
.tp__grid { display: grid; grid-template-columns: 50px repeat(3, minmax(0, 1fr)) 20px 24px; gap: 4px; align-items: center; }
</style>

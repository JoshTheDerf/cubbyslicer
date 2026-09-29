<script setup lang="ts">
/**
 * OBJ colours → filaments (Orca ObjColorDialog): cluster the model's face
 * colours, map clusters to filament slots (color match / append / manual),
 * then colour-paint the object (per-triangle filament states → Orca paint
 * strings via the engine) and set its base filament.
 */
import { computed, ref, watch } from 'vue';
import { getMesh, getObject, setObjectOverride } from '../../project/store';
import * as store from '../../project/store';
import { currentPresets } from '../../presets/store';
import { paintFromStates } from '../../engine/client';
import type { PaintMap } from '../../engine/types';
import { pickFiles } from '../../app/shell/download';
import { toast } from '../../ui';
import { colorDistance, fallbackColor, kmeans, nearestFilaments, paintStates, parseMtl, recommendedClusters, type WeightedColor } from './objColor';
import { objColorRequest } from './request';

const MAX_COLORS = 16; // Orca EnforcerBlockerType::ExtruderMax
const NEW = 0; // slot value meaning "append as a new filament"

const open = computed({
  get: () => !!objColorRequest.value,
  set: (v: boolean) => { if (!v) finish(); },
});
const item = computed(() => objColorRequest.value?.item ?? null);

/** Group colours (with fallbacks for unknown materials, overridable by a loaded MTL). */
const mtl = ref<Map<string, string>>(new Map());
const groupColors = computed(() => item.value?.faceGroups.groups.map((g, i) => g.color ?? mtl.value.get(g.name) ?? fallbackColor(i)) ?? []);
const unknown = computed(() => item.value?.faceGroups.groups.filter((g) => !g.color && !mtl.value.has(g.name)).length ?? 0);
const weights = computed(() => {
  const w = new Array<number>(groupColors.value.length).fill(0);
  const tri = item.value?.faceGroups.tri;
  if (tri) for (let t = 0; t < tri.length; t++) if (tri[t] < w.length) w[tri[t]]++;
  return w;
});
const inputColors = computed<WeightedColor[]>(() => groupColors.value.map((c, i) => ({ color: c, weight: weights.value[i] })).filter((c) => c.weight > 0));
const inputIndex = computed(() => groupColors.value.map((_, i) => i).filter((i) => weights.value[i] > 0));
const recommended = computed(() => Math.min(MAX_COLORS, recommendedClusters(inputColors.value, MAX_COLORS)));
const count = ref(1);
const clustering = computed(() => kmeans(inputColors.value, Math.max(1, Math.min(count.value || 1, recommended.value))));
const clusterWeights = computed(() => {
  const w = new Array<number>(clustering.value.centers.length).fill(0);
  clustering.value.labels.forEach((l, i) => { w[l] += inputColors.value[i].weight; });
  return w;
});

const p = computed(() => currentPresets.value);
const filaments = computed(() => p.value.selection.filaments.map((_, i) => p.value.filamentColour(i)));
const semm = computed(() => {
  const v = p.value.value('printer', 'single_extruder_multi_material');
  return (Array.isArray(v) ? v[0] : v) === '1';
});
const canAppend = computed(() => semm.value && filaments.value.length < 64);

/** Per cluster: 1-based filament slot, or NEW. */
const mapping = ref<number[]>([]);
function colorMatch(): void { mapping.value = nearestFilaments(clustering.value.centers, filaments.value); }
function append(): void { mapping.value = clustering.value.centers.map(() => NEW); }
function reset(): void { mapping.value = clustering.value.centers.map(() => 1); }

watch(item, (it) => {
  if (!it) return;
  mtl.value = new Map();
  count.value = recommended.value;
}, { immediate: true });
watch(clustering, () => {
  // Orca opens with the clusters appended as new filaments when possible, else colour-matched.
  if (canAppend.value && filaments.value.length === 1 && colorDistance(filaments.value[0], clustering.value.centers[0] ?? '#000') > 1) append();
  else colorMatch();
}, { immediate: true });

const slotItems = computed(() => [
  ...filaments.value.map((c, i) => ({ label: `Filament ${i + 1}`, value: i + 1, chip: c })),
  ...(canAppend.value ? [{ label: 'New filament', value: NEW, chip: '' }] : []),
]);
const newCount = computed(() => mapping.value.filter((s) => s === NEW).length);

async function loadMtl(): Promise<void> {
  const [f] = await pickFiles('.mtl', false);
  if (!f) return;
  const m = parseMtl(await f.text());
  if (!m.size) { toast.warn(`No material colours in ${f.name}.`); return; }
  mtl.value = m;
}

const busy = ref(false);
async function apply(): Promise<void> {
  const it = item.value;
  const o = it ? getObject(it.objectId) : undefined;
  const mesh = o ? getMesh(o.meshId) : undefined;
  if (!it || !o || !mesh) { finish(); return; }
  busy.value = true;
  try {
    // Append new filaments with the cluster colours.
    const slots = mapping.value.slice();
    if (newCount.value) {
      const base = filaments.value.length;
      await p.value.setFilamentCount(base + newCount.value);
      let k = 0;
      slots.forEach((s, c) => {
        if (s !== NEW) return;
        p.value.setFilamentColour(base + k, clustering.value.centers[c]);
        slots[c] = base + k + 1;
        k++;
      });
    }
    // group → cluster (groups without faces keep -1 → unpainted).
    const groupCluster = new Array<number>(groupColors.value.length).fill(-1);
    inputIndex.value.forEach((g, i) => { groupCluster[g] = clustering.value.labels[i]; });
    const { base, states } = paintStates(it.faceGroups.tri, groupCluster.map((c) => (c < 0 ? 1e9 : c)), slots);
    if (base !== 1) setObjectOverride(o.id, 'extruder', String(base));
    if (states.length) {
      const setMeshPaint = (store as unknown as { setMeshPaint?: (meshId: string, layer: 'color', paint: PaintMap | null) => void }).setMeshPaint;
      if (!setMeshPaint) throw new Error('Colour painting storage is not available in this build.');
      const paint = await paintFromStates({ positions: mesh.positions, indices: mesh.indices }, states);
      setMeshPaint(mesh.id, 'color', paint);
    }
    toast.success(`Mapped ${clustering.value.centers.length} colour${clustering.value.centers.length === 1 ? '' : 's'} of ${it.name} to filaments.`, { timeout: 2600 });
    finish();
  } catch (e) {
    toast.error('Couldn’t apply the colours.', { detail: (e as Error)?.message });
  } finally {
    busy.value = false;
  }
}

function finish(): void {
  const r = objColorRequest.value;
  objColorRequest.value = null;
  r?.resolve();
}
</script>

<template>
  <UModal v-model:open="open" title="Import OBJ colours" :description="item ? `${item.name}: map the model’s colours to filaments.` : ''" :ui="{ content: 'sm:max-w-lg' }">
    <template #body>
      <div v-if="item" class="oc">
        <UAlert v-if="unknown" color="warning" variant="subtle" icon="i-lucide-triangle-alert"
                :title="`${unknown} material${unknown === 1 ? '' : 's'} without colour`"
                description="The MTL file wasn’t provided. Placeholder colours are shown; load the MTL to use the real ones."
                :actions="[{ label: 'Load MTL…', size: 'xs', color: 'warning', variant: 'solid', onClick: loadMtl }]" />
        <div class="flex items-center gap-3 flex-wrap">
          <span class="text-sm">Number of colours</span>
          <UInputNumber v-model="count" :min="1" :max="recommended" size="sm" class="w-28" aria-label="Number of colours" />
          <span class="text-xs text-dimmed">({{ recommended }} recommended)</span>
        </div>
        <div>
          <p class="oc__h">Current filaments</p>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="(c, i) in filaments" :key="i" class="oc__chip" :style="{ background: c }" :title="`Filament ${i + 1}: ${c}`">{{ i + 1 }}</span>
          </div>
        </div>
        <div>
          <div class="flex items-center gap-2 mb-1.5">
            <p class="oc__h mb-0! flex-1">Matching</p>
            <UButton size="xs" variant="soft" label="Color match" title="Approximate colour matching" @click="colorMatch" />
            <UButton size="xs" variant="soft" label="Append" :disabled="!canAppend" title="Append to existing filaments" @click="append" />
            <UButton size="xs" variant="ghost" label="Reset" title="Reset mapped extruders" @click="reset" />
          </div>
          <div class="oc__grid">
            <div v-for="(c, i) in clustering.centers" :key="i" class="oc__row">
              <span class="oc__sw" :style="{ background: c }" :title="c" />
              <UIcon name="i-lucide-arrow-right" class="size-3.5 text-dimmed" />
              <USelect :model-value="mapping[i]" :items="slotItems" size="xs" class="flex-1 min-w-0" :aria-label="`Filament for colour ${i + 1}`"
                       @update:model-value="(v: number) => { const m = mapping.slice(); m[i] = v; mapping = m; }">
                <template #leading>
                  <span class="oc__dot" :style="{ background: mapping[i] === 0 ? c : filaments[(mapping[i] ?? 1) - 1] }" />
                </template>
                <template #item-leading="{ item: it }">
                  <span class="oc__dot" :style="{ background: (it as { chip: string }).chip || c }" />
                </template>
              </USelect>
              <span class="text-xs text-dimmed w-12 text-right">{{ Math.round((clusterWeights[i] / Math.max(1, item.faceGroups.tri.length)) * 100) }}%</span>
            </div>
          </div>
        </div>
        <p v-if="!canAppend && clustering.centers.length > filaments.length" class="text-xs text-dimmed">
          This printer has {{ filaments.length }} filament slot{{ filaments.length === 1 ? '' : 's' }}. Enable “Single extruder multi-material” in the printer settings to add more.
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Keep uncoloured" @click="finish" />
        <UButton color="primary" :loading="busy" label="Apply" @click="apply" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.oc { display: flex; flex-direction: column; gap: 14px; font-size: var(--fs-sm); }
.oc__h { margin: 0 0 6px; font-weight: 600; color: var(--fg-1); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.oc__chip { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 4px; font: 600 11px var(--font); color: #fff; text-shadow: 0 0 2px #000; border: 1px solid var(--line-strong); }
.oc__grid { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; }
.oc__row { display: flex; align-items: center; gap: 8px; }
.oc__sw { width: 22px; height: 22px; border-radius: 4px; border: 1px solid var(--line-strong); flex: none; }
.oc__dot { width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--line-strong); display: inline-block; }
</style>

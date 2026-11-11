<script setup lang="ts">
/**
 * Toolhead collision volumes (Orca 2.5 `bed_exclude_volumes` /
 * `extruder_bed_exclude_volumes`): a list of prisms, each a polygon with an
 * optional Z range, drawn over the bed outline. Answers `volumesRequest` with
 * the serialized string ("ZMIN..ZMAX;XxY,…|…").
 */
import { computed, ref, watch } from 'vue';
import AppDialog from '../../ui/AppDialog.vue';
import { shortScreen } from '../../ui/mobileDialog';
import { formatNumber, parsePoint } from '../../presets/values';
import { boxVolume, parseVolumes, serializeVolumes, type CollisionVolume, type Pt } from './collisionVolumes';
import { volumesRequest } from './request';
import { parseCustomText } from './bedShape';

interface Row { zMin: number | null; zMax: number | null; text: string }

const req = computed(() => volumesRequest.current.value);
const rows = ref<Row[]>([]);
const unparsed = ref(0);
const toRow = (v: CollisionVolume): Row => ({ zMin: v.zMin, zMax: v.zMax, text: v.points.map(([x, y]) => `${formatNumber(x)}x${formatNumber(y)}`).join('\n') });
watch(req, (r) => {
  if (!r) return;
  const { volumes, bad } = parseVolumes(r.value, r.printableHeight || Infinity);
  rows.value = volumes.map(toRow);
  unparsed.value = bad;
});

const parsed = computed(() => rows.value.map((r) => parseCustomText(r.text)));
const rowError = (i: number): string | undefined => {
  const p = parsed.value[i];
  if (p.bad) return 'Some lines are not valid “XxY” points.';
  if (p.pts.length < 3) return 'A volume needs at least 3 points.';
  const r = rows.value[i];
  if (r.zMin !== null && r.zMax !== null && !(r.zMin < r.zMax)) return 'The Z range is empty.';
  return undefined;
};
const invalid = computed(() => rows.value.some((_, i) => !!rowError(i)));
const volumes = computed<CollisionVolume[]>(() => rows.value.map((r, i) => ({ zMin: r.zMin, zMax: r.zMax, points: parsed.value[i].pts })));
const serialized = computed(() => serializeVolumes(volumes.value));

function addBox(): void {
  const b = bedPts.value;
  const cx = b.length ? (Math.min(...b.map((p) => p[0])) + Math.max(...b.map((p) => p[0]))) / 2 : 0;
  const cy = b.length ? (Math.min(...b.map((p) => p[1])) + Math.max(...b.map((p) => p[1]))) / 2 : 0;
  rows.value = [...rows.value, toRow(boxVolume(cx - 20, cy - 20, cx + 20, cy + 20))];
}
const remove = (i: number) => { rows.value = rows.value.filter((_, j) => j !== i); };
const num = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---- preview ---------------------------------------------------------------------------
const bedPts = computed<Pt[]>(() => (req.value?.bed ?? []).map((s) => parsePoint(s)).filter((p): p is Pt => !!p));
const view = computed(() => {
  const all = [...bedPts.value, ...volumes.value.flatMap((v) => v.points)];
  if (!all.length) return { x: -10, y: -110, w: 120, h: 120 };
  const xs = all.map((q) => q[0]), ys = all.map((q) => q[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = Math.max(maxX - minX, maxY - minY) * 0.06 + 1;
  return { x: minX - pad, y: -maxY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
});
const svgPoly = (pts: Pt[]) => pts.map(([x, y]) => `${x},${-y}`).join(' ');
const zLabel = (v: CollisionVolume) => (v.zMin === null && v.zMax === null ? 'full height' : `Z ${v.zMin === null ? '0' : formatNumber(v.zMin)}–${v.zMax === null ? 'top' : formatNumber(v.zMax)}`);
</script>

<template>
  <AppDialog v-model:open="volumesRequest.open.value" :title="req?.title ?? 'Collision volumes'" size="3xl" fullscreen
             :description="shortScreen ? undefined : 'Prisms the toolhead must not enter: a polygon on the bed, optionally limited to a height range. Added to the excluded bed area.'"
             confirm-label="Apply" :confirm-disabled="invalid" @confirm="volumesRequest.answer(serialized)">
    <template #footer-start>
      <UButton variant="ghost" icon="i-lucide-plus" label="Add volume" @click="addBox" />
    </template>
    <div class="cv">
      <div class="cv__list">
        <p v-if="unparsed" class="cv__warn">{{ unparsed }} volume{{ unparsed > 1 ? 's' : '' }} in the current value couldn’t be read and will be dropped.</p>
        <p v-if="!rows.length" class="cv__empty">No collision volumes. “Add volume” starts with a 40 × 40 mm box in the middle of the bed.</p>
        <section v-for="(r, i) in rows" :key="i" class="cv__row" :data-testid="`collision-volume-${i}`">
          <header class="cv__head">
            <strong>Volume {{ i + 1 }}</strong>
            <UButton size="xs" variant="ghost" color="error" icon="i-lucide-trash-2" square :aria-label="`Remove volume ${i + 1}`" @click="remove(i)" />
          </header>
          <div class="cv__z">
            <UFormField label="From Z" hint="mm" description="Empty: the bed">
              <UInputNumber :model-value="r.zMin ?? undefined" :min="0" size="sm" placeholder="bed" @update:model-value="(v: number | null) => (r.zMin = num(v))" />
            </UFormField>
            <UFormField label="To Z" hint="mm" description="Empty: printable height">
              <UInputNumber :model-value="r.zMax ?? undefined" :min="0" size="sm" placeholder="top" @update:model-value="(v: number | null) => (r.zMax = num(v))" />
            </UFormField>
          </div>
          <UFormField label="Outline" description="One “XxY” point per line, in mm." :error="rowError(i)">
            <UTextarea v-model="r.text" :rows="4" autoresize :maxrows="8" spellcheck="false" class="w-full" :ui="{ base: 'font-mono text-xs' }" />
          </UFormField>
        </section>
      </div>
      <figure class="cv__preview">
        <svg :viewBox="`${view.x} ${view.y} ${view.w} ${view.h}`" preserveAspectRatio="xMidYMid meet" aria-label="Collision volume preview">
          <polygon v-if="bedPts.length >= 3" :points="svgPoly(bedPts)" class="cv__bed" />
          <g v-for="(v, i) in volumes" :key="i">
            <polygon v-if="v.points.length >= 3" :points="svgPoly(v.points)" class="cv__vol" :class="{ 'cv__vol--z': v.zMin !== null || v.zMax !== null }" />
          </g>
        </svg>
        <figcaption>
          <span v-for="(v, i) in volumes" :key="i">{{ i + 1 }}: {{ zLabel(v) }}</span>
        </figcaption>
      </figure>
    </div>
  </AppDialog>
</template>

<style scoped>
.cv { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 20px; align-items: start; }
.cv__list { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.cv__row { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
.cv__head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
.cv__z { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.cv__warn { margin: 0; font-size: 12px; color: var(--ui-warning); }
.cv__empty { margin: 0; font-size: 12px; color: var(--ui-text-dimmed); }
.cv__preview { margin: 0; display: flex; flex-direction: column; gap: 6px; position: sticky; top: 0; }
.cv__preview svg { width: 100%; aspect-ratio: 1; background: var(--ui-bg-muted); border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
.cv__preview figcaption { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--ui-text-dimmed); }
.cv__bed { fill: color-mix(in srgb, var(--ui-primary) 10%, transparent); stroke: var(--ui-border-accented); stroke-width: 1px; vector-effect: non-scaling-stroke; }
.cv__vol { fill: color-mix(in srgb, var(--ui-error) 30%, transparent); stroke: var(--ui-error); stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
.cv__vol--z { stroke-dasharray: 4 3; }
@media (max-width: 640px), (max-height: 500px) {
  .cv { grid-template-columns: 1fr; }
  .cv__preview { position: static; max-width: 260px; }
}
</style>

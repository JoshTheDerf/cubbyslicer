<script setup lang="ts">
/**
 * Orca 2.5 sidebar nozzle line per extruder: diameter (mixed nozzle sizes on
 * H2D / X2D: each nozzle its own size) and flow type (`nozzle_volume_type`:
 * Standard, High Flow, …; Hybrid on an extruder with a nozzle rack, where each
 * filament then picks its own flow type in Filament grouping). Shown for
 * printers with several extruders or several flow types.
 *
 * On an extruder with a nozzle rack (H2C) a second line sets how many nozzles
 * of each flow type the rack holds (`extruder_nozzle_stats`, desktop's "Set
 * the physical nozzle count"): one type unless the extruder is Hybrid. The
 * counts live in the project and go to the engine with every slice. The pencil opens desktop's
 * "Set nozzle count" dialog (the extruder card's click in Orca's sidebar).
 */
import { computed } from 'vue';
import { asList } from '../../lib/configValue';
import { maxNozzleCounts, nozzleTotal, parseNozzleStats } from '../nozzleMaps';
import { currentPresets } from '../store';
import { nozzleCountDialog } from '../../dialogs/nozzleCount';

const p = computed(() => currentPresets.value);
const extruders = computed(() => p.value.extruders());
const volumes = computed(() => p.value.nozzleVolumeTypes());
const diameters = computed(() => asList(p.value.value('printer', 'nozzle_diameter')));
const show = computed(() => extruders.value.length > 1 || extruders.value.some((e) => e.volumeTypes.length > 1 || e.multiNozzle));
const bbl = computed(() => extruders.value.length === 2 && p.value.infos.value.printer.vendor === 'BBL');
const label = (e: number) => (bbl.value ? (e === 0 ? 'Left' : 'Right') : extruders.value.length > 1 ? `T${e + 1}` : 'Nozzle');

const stats = computed(() => p.value.nozzleStats());
const rackMax = computed(() => maxNozzleCounts({ extruder_max_nozzle_count: p.value.value('printer', 'extruder_max_nozzle_count') ?? '1' }, extruders.value.length));
/** Rack line of an extruder: each offered type's count (Hybrid: every type; else the selected one), or null. */
function rack(e: number): { types: Array<{ type: string; count: number; max: number }>; total: number; max: number } | null {
  const st = stats.value;
  if (!st || !extruders.value[e]?.multiNozzle) return null;
  const c = parseNozzleStats(st[e] ?? '');
  const total = nozzleTotal(c), max = rackMax.value[e];
  const shown = volumes.value[e] === 'Hybrid' ? extruders.value[e].volumeTypes : [volumes.value[e]];
  return { types: shown.map((t) => ({ type: t, count: c[t] ?? 0, max: max - total + (c[t] ?? 0) })), total, max };
}

const SIZES = ['0.2', '0.4', '0.6', '0.8'];
const sizeItems = (e: number) => [...new Set([...SIZES, diameters.value[e] ?? '0.4'])].sort((a, b) => Number(a) - Number(b)).map((v) => ({ value: v, label: `${v} mm` }));
const flowItems = (e: number) => [
  ...extruders.value[e].volumeTypes.map((t) => ({ value: t, label: t })),
  ...(extruders.value[e].multiNozzle ? [{ value: 'Hybrid', label: 'Hybrid (per filament)' }] : []),
];
function setDiameter(e: number, v: string): void {
  const next = diameters.value.slice();
  next[e] = v;
  p.value.setValue('printer', 'nozzle_diameter', next);
}
</script>

<template>
  <div v-if="show" class="en" aria-label="Nozzles">
    <div v-for="(ex, e) in extruders" :key="e" class="en__row">
      <span class="en__lbl">{{ label(e) }}</span>
      <USelect v-if="extruders.length > 1" :model-value="diameters[e] ?? diameters[0]" :items="sizeItems(e)" value-key="value" size="xs" class="w-24"
               :aria-label="`${label(e)} nozzle diameter`" @update:model-value="(v: unknown) => setDiameter(e, String(v))" />
      <USelect :model-value="volumes[e]" :items="flowItems(e)" value-key="value" size="xs" class="min-w-0 flex-1" :disabled="flowItems(e).length < 2"
               :aria-label="`${label(e)} nozzle flow`" :title="`${ex.type}: nozzle flow type (picks the profile values for it)`"
               @update:model-value="(v: unknown) => p.setNozzleVolumeType(e, String(v))" />
      <div v-if="rack(e)" class="en__rack" :data-testid="`nozzle-rack-${e}`">
        <span v-for="r in rack(e)!.types" :key="r.type" class="en__count">
          <span class="en__type">{{ r.type }}</span>
          <UInputNumber :model-value="r.count" :min="0" :max="r.max" :step="1" size="xs" class="w-20"
                        :aria-label="`${label(e)} ${r.type} nozzles`" @update:model-value="(v: unknown) => p.setNozzleCount(e, r.type, Number(v) || 0)" />
        </span>
        <span class="en__total" :title="'Nozzles in the rack (extruder_max_nozzle_count)'">{{ rack(e)!.total }} / {{ rack(e)!.max }}</span>
        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-pencil" square :aria-label="`Set ${label(e)} nozzle count`" title="Set nozzle count"
                 :data-testid="`nozzle-count-edit-${e}`" @click="nozzleCountDialog.ask({ extruder: e })" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.en { display: flex; flex-direction: column; gap: 4px; }
.en__row { display: flex; align-items: center; gap: 6px; font-size: 12px; flex-wrap: wrap; }
.en__rack { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex-basis: 100%; padding-left: 48px; }
.en__count { display: inline-flex; align-items: center; gap: 4px; }
.en__type, .en__total { color: var(--ui-text-dimmed); }
.en__lbl { width: 42px; color: var(--ui-text-dimmed); flex: none; }
</style>

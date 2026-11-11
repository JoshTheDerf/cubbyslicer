<script setup lang="ts">
/**
 * Orca 2.5's "Set nozzle count" (Widgets/MultiNozzleSync.cpp ManualNozzleCountDialog): how many nozzles of
 * each flow type an extruder's rack holds — its own type, or every type for a Hybrid extruder — each 0 to
 * the rack size, with Orca's errors; Confirm writes `extruder_nozzle_stats` for the project.
 */
import { computed, ref, watch } from 'vue';
import AppDialog from '../ui/AppDialog.vue';
import { currentPresets } from '../presets/store';
import { maxNozzleCounts, nozzleTotal, parseNozzleStats } from '../presets/nozzleMaps';
import { nozzleCountDialog, nozzleCountError, nozzleCountTypes, orcaForceNoZero } from './nozzleCount';

const req = nozzleCountDialog.current;
const p = computed(() => currentPresets.value);
const counts = ref<Record<string, number>>({});
const extruder = computed(() => req.value?.extruder ?? 0);
const volumeType = computed(() => p.value.nozzleVolumeTypes()[extruder.value] ?? 'Standard');
const types = computed(() => nozzleCountTypes(volumeType.value, p.value.extruders()[extruder.value]?.volumeTypes ?? []));
const max = computed(() => maxNozzleCounts({ extruder_max_nozzle_count: p.value.value('printer', 'extruder_max_nozzle_count') ?? '1' }, Math.max(1, p.value.extruders().length))[extruder.value] ?? 1);
const items = computed(() => Array.from({ length: max.value + 1 }, (_, i) => ({ value: i, label: String(i) })));
const total = computed(() => types.value.reduce((a, t) => a + (counts.value[t] ?? 0), 0));
// manuallySetNozzleCount: a non-zero count for a Hybrid extruder or while the other extruder has none.
const otherTotal = computed(() => {
  const stats = p.value.nozzleStats() ?? [];
  if (stats.length < 2) return null;
  return stats.reduce((a, s, e) => (e === extruder.value ? a : a + nozzleTotal(parseNozzleStats(s))), 0);
});
const error = computed(() => nozzleCountError(total.value, max.value, orcaForceNoZero(volumeType.value, otherTotal.value)));
const side = computed(() => (p.value.extruders().length === 2 ? (extruder.value === 0 ? 'Left extruder' : 'Right extruder') : `Extruder ${extruder.value + 1}`));

watch(req, (r) => {
  if (!r) return;
  const c = parseNozzleStats(p.value.nozzleStats()?.[r.extruder] ?? '');
  counts.value = Object.fromEntries(types.value.map((t) => [t, c[t] ?? 0]));
});

function confirm(): void {
  if (error.value) return;
  const ok = p.value.setNozzleCounts(extruder.value, Object.fromEntries(types.value.map((t) => [t, counts.value[t] ?? 0])));
  nozzleCountDialog.answer(ok);
}
</script>

<template>
  <AppDialog v-model:open="nozzleCountDialog.open.value" title="Set nozzle count" :description="side" size="sm" cancel-label=""
             confirm-label="Confirm" :confirm-disabled="!!error" test-id="nozzle-count" @confirm="confirm">
    <div class="nc">
      <UIcon name="i-lucide-pen-tool" class="nc__icon" aria-hidden="true" />
      <div class="nc__rows">
        <p class="nc__title">Please set nozzle count</p>
        <label v-for="t in types" :key="t" class="nc__row">
          <span class="nc__lbl">{{ t }}</span>
          <USelect v-model="counts[t]" :items="items" value-key="value" size="sm" class="w-24" :aria-label="`${t} nozzles`" />
        </label>
        <p v-if="error" class="nc__err" role="alert">{{ error }}</p>
      </div>
    </div>
  </AppDialog>
</template>

<style scoped>
.nc { display: flex; gap: 16px; align-items: center; }
.nc__icon { width: 48px; height: 48px; flex: none; color: var(--ui-text-dimmed); }
.nc__rows { display: flex; flex-direction: column; gap: 10px; }
.nc__title { font-size: var(--fs-sm); color: var(--ui-text-highlighted); }
.nc__row { display: flex; align-items: center; gap: 8px; }
.nc__lbl { width: 110px; font-size: var(--fs-sm); color: var(--ui-text-toned); }
.nc__err { font-size: var(--fs-xs); color: #E14747; }
</style>

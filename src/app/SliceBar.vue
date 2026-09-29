<template>
  <!-- Orca's top-right slice controls: status/progress, "Slice plate" (primary), "Export G-code". -->
  <div class="slicebar flex items-center gap-2 min-w-0" :class="status" role="group" aria-label="Slicing">
    <div v-if="status === 'slicing'" class="flex items-center gap-2 min-w-0" role="status" aria-live="polite">
      <div class="flex flex-col min-w-0 gap-1" :class="phone ? 'w-20' : 'w-44'">
        <div class="flex justify-between gap-2 text-xs leading-none">
          <span class="truncate text-muted" :title="message">{{ message || 'Slicing' }}</span>
          <span class="font-mono text-default">{{ Math.round(progress) }}%</span>
        </div>
        <UProgress :model-value="progress" :max="100" size="xs" />
      </div>
      <UButton :label="phone ? undefined : 'Cancel'" :icon="phone ? 'i-lucide-x' : undefined" aria-label="Cancel slicing" color="neutral" variant="ghost" size="sm" @click="cancel()" />
    </div>

    <template v-else>
      <UTooltip v-if="status === 'error' && error" :text="error" :content="{ side: 'bottom' }">
        <UBadge color="error" variant="subtle" icon="i-lucide-circle-x" :label="compact ? undefined : 'Slicing failed'" class="cursor-default" />
      </UTooltip>

      <UPopover v-if="problems.length" :content="{ side: 'bottom', align: 'end' }">
        <UButton color="warning" variant="soft" size="sm" icon="i-lucide-triangle-alert"
                 :label="compact ? String(problems.length) : `${problems.length} setting${problems.length > 1 ? 's' : ''} to fix`" />
        <template #content>
          <div class="p-3 max-w-sm text-xs space-y-1">
            <p class="font-semibold text-highlighted">These settings block slicing</p>
            <ul class="list-disc ps-4 text-warning space-y-0.5">
              <li v-for="(p, i) in problems" :key="i">{{ p }}</li>
            </ul>
          </div>
        </template>
      </UPopover>

      <div v-if="stats && status !== 'error'" class="stats hidden lg:flex items-center gap-3 text-xs font-mono whitespace-nowrap" :class="isStale ? 'text-dimmed' : 'text-toned'"
           :title="isStale ? 'The plate or settings changed since this slice' : 'Last slice'">
        <span class="flex items-center gap-1"><UIcon name="i-lucide-clock" class="size-3.5" />{{ fmtTime(stats.printTimeSec) }}</span>
        <span class="hidden 2xl:flex items-center gap-1"><UIcon name="i-lucide-weight" class="size-3.5" />{{ total(stats.filamentG).toFixed(1) }} g</span>
        <span class="sr-only">Layers {{ stats.layers }}</span>
        <UBadge v-if="isStale" color="warning" variant="subtle" size="sm" label="outdated" class="hidden 2xl:inline-flex" />
      </div>
    </template>

    <UTooltip :text="sliceTitle" :kbds="sliceKbds" :content="{ side: 'bottom' }">
      <UButton color="primary" variant="solid" size="sm" icon="i-lucide-layers" class="font-semibold"
               :label="phone && status === 'slicing' ? undefined : phone ? 'Slice' : lastSlice && isStale ? 'Re-slice' : 'Slice plate'" :loading="status === 'slicing'"
               :aria-label="lastSlice && isStale ? 'Re-slice' : 'Slice plate'"
               :disabled="!canSlice || status === 'slicing'" @click="slice()" />
    </UTooltip>
    <UDropdownMenu v-if="plates.length > 1" :items="sliceMenu" :content="{ side: 'bottom', align: 'end' }">
      <UButton color="primary" variant="soft" size="sm" icon="i-lucide-chevron-down" aria-label="More slicing options" class="-ms-1.5"
               :disabled="status === 'slicing'" />
    </UDropdownMenu>
    <UTooltip text="Export G-code" :kbds="exportKbds" :content="{ side: 'bottom' }">
      <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-download" :label="narrow ? undefined : 'Export G-code'" aria-label="Export G-code"
               :disabled="!lastSlice || status === 'slicing'" class="export-btn" @click="exportGcode()" />
    </UTooltip>
    <PrintHostButton />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSliceController } from './slice';
import { lastSlice, resolvedConfig } from './state';
import { getSliceObjects, objects, plates } from '../project/store';
import { getConfigProblems, type ConfigProblem } from '../settings/validate';
import { bindingTokensOf } from './shell/useActions';
import PrintHostButton from '../printhost/PrintHostButton.vue';
import { compact, narrow, phone } from './shell/uiState';

const { status, progress, message, error, isStale, slice, sliceAll, cancel, exportGcode, exportAllGcode, plateStates } = useSliceController();

// Multi-plate: Orca's "Slice all" / export every sliced plate.
const sliceMenu = computed(() => [[
  { label: 'Slice all plates', icon: 'i-lucide-layers-3', disabled: !objects.value.length || problems.value.length > 0, onSelect: () => { void sliceAll(); } },
  { label: 'Export G-code of all sliced plates', icon: 'i-lucide-download', disabled: !plateStates.value.some((s) => s !== 'none'), onSelect: () => { exportAllGcode(); } },
]]);

const stats = computed(() => lastSlice.value?.report.stats ?? null);
// Only user-entered invalid values block slicing ('error'); odd values that
// ship in system profiles are tolerated by the engines ('warning').
const allProblems = computed<ConfigProblem[]>(() => {
  void resolvedConfig.value; // re-evaluate when config changes
  try { return getConfigProblems(); } catch { return []; }
});
const fmtProblem = (p: ConfigProblem) => `${p.label}${p.index !== undefined ? ` [${p.index + 1}]` : ''}: ${p.message}`;
const problems = computed(() => allProblems.value.filter((p) => p.severity === 'error').map(fmtProblem));
const hasObjects = computed(() => { void objects.value; return getSliceObjects().length > 0; });
const canSlice = computed(() => hasObjects.value && problems.value.length === 0);
const sliceTitle = computed(() =>
  !hasObjects.value ? 'Add a printable model first' : problems.value.length ? 'Fix the highlighted settings first' : 'Slice plate');
const sliceKbds = computed(() => bindingTokensOf('slice.run'));
const exportKbds = computed(() => bindingTokensOf('slice.export-gcode'));

const total = (xs: number[] | undefined) => (xs ?? []).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}
</script>

<style scoped>
@media (max-width: 760px) { .export-btn :deep(span:not(:first-child)) { display: none; } }
</style>

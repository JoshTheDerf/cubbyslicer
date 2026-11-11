<template>
  <!--
    Orca's top-right slice controls: status/progress, "Slice plate", "Export G-code" (+ Print).
    The next step is the primary button: Slice until the plate is sliced, then Print / Export.
  -->
  <div class="slicebar flex shrink-0 items-center gap-2" :class="status" role="group" aria-label="Slicing">
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
      <!-- A popover, not a tooltip: the reason has to be readable on touch screens too. -->
      <UPopover v-if="status === 'error' && error" :content="{ side: 'bottom', align: 'end' }">
        <UButton color="error" variant="soft" size="sm" icon="i-lucide-circle-x" :label="compact ? undefined : 'Slicing failed'" aria-label="Slicing failed: show why" />
        <template #content>
          <div class="p-3 max-w-sm text-xs space-y-2">
            <p class="font-semibold text-highlighted">Slicing failed</p>
            <p class="text-toned whitespace-pre-wrap break-words max-h-48 overflow-auto">{{ error }}</p>
            <div class="flex justify-end gap-1">
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" label="Copy" @click="copyError" />
              <UButton size="xs" color="primary" variant="soft" icon="i-lucide-rotate-cw" label="Try again" :disabled="!canSlice" @click="slice()" />
            </div>
          </div>
        </template>
      </UPopover>

      <UPopover v-if="problems.length" v-model:open="problemsOpen" :content="{ side: 'bottom', align: 'end' }">
        <UButton color="warning" variant="soft" size="sm" icon="i-lucide-triangle-alert"
                 :label="compact ? String(problems.length) : `${problems.length} setting${problems.length > 1 ? 's' : ''} to fix`" />
        <template #content>
          <div class="p-2 max-w-sm text-xs">
            <p class="px-1 pb-1 font-semibold text-highlighted">These settings block slicing</p>
            <!-- Each one opens its setting (in the sidebar or the printer / filament settings). -->
            <button v-for="(p, i) in problems" :key="i" type="button" class="problem" :title="`Go to ${p.label}`" @click="goTo(p.key)">
              <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0 text-warning mt-px" />
              <span class="min-w-0 flex-1"><span class="font-medium text-highlighted">{{ p.label }}{{ p.index !== undefined ? ` [${p.index + 1}]` : '' }}</span>
                <span class="block text-toned">{{ p.message }}</span></span>
              <UIcon name="i-lucide-arrow-right" class="size-3.5 shrink-0 text-dimmed mt-px" />
            </button>
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
      <UButton :color="sliced ? 'neutral' : 'primary'" :variant="sliced ? 'outline' : 'solid'" size="sm" :icon="sliced ? 'i-lucide-check' : 'i-lucide-layers'" :class="{ 'font-semibold': !sliced }"
               :label="phone && status === 'slicing' ? undefined : phone ? (sliced ? 'Sliced' : 'Slice') : sliced ? 'Sliced' : lastSlice && isStale ? 'Re-slice' : 'Slice plate'" :loading="status === 'slicing'"
               :aria-label="lastSlice && isStale ? 'Re-slice' : 'Slice plate'"
               :disabled="!canSlice || status === 'slicing'" @click="slice()" />
    </UTooltip>
    <UDropdownMenu v-if="plates.length > 1 || slicedFileOffered" :items="sliceMenu" :content="{ side: 'bottom', align: 'end' }">
      <UButton color="primary" variant="soft" size="sm" icon="i-lucide-chevron-down" aria-label="More slicing options" class="-ms-1.5"
               :disabled="status === 'slicing'" />
    </UDropdownMenu>
    <UTooltip text="Export G-code" :kbds="exportKbds" :content="{ side: 'bottom' }">
      <UButton :color="sliced && !hostReady ? 'primary' : 'neutral'" :variant="sliced && !hostReady ? 'solid' : 'outline'" size="sm" icon="i-lucide-download"
               :label="narrow ? undefined : 'Export G-code'" aria-label="Export G-code"
               :disabled="!lastSlice || status === 'slicing'" class="export-btn" @click="exportGcode()" />
    </UTooltip>
    <PrintHostButton :primary="sliced" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useSliceController } from './slice';
import { lastSlice, resolvedConfig } from './state';
import { getSliceObjects, objects, plates } from '../project/store';
import { getConfigProblems, type ConfigProblem } from '../settings/validate';
import { bindingTokensOf } from './shell/useActions';
import { exportSlicedFile } from './shell/commands/slice';
import PrintHostButton from '../printhost/PrintHostButton.vue';
import { hostReady } from '../printhost/store';
import { compact, narrow, phone } from './shell/uiState';
import { jumpToSetting } from '../settings/useLayout';
import { toast } from '../ui';

const { status, progress, message, error, isStale, slice, sliceAll, cancel, exportGcode, exportAllGcode, plateStates, slicedFileOffered } = useSliceController();

// Multi-plate: Orca's "Slice all" / export every sliced plate. Bambu Lab / "Support 3MF as gcode"
// printers: the sliced file (.gcode.3mf), as in desktop's print button menu.
const sliceMenu = computed(() => [[
  ...(plates.value.length > 1 ? [{ label: 'Slice all plates', icon: 'i-lucide-layers-3', disabled: !objects.value.length || problems.value.length > 0, onSelect: () => { void sliceAll(); } }] : []),
  ...(slicedFileOffered.value ? [
    { label: 'Export plate sliced file', icon: 'i-lucide-package', disabled: !sliced.value, onSelect: () => { exportSlicedFile(false); } },
    { label: 'Export all sliced file', icon: 'i-lucide-package', disabled: !plateStates.value.includes('done'), onSelect: () => { exportSlicedFile(true); } },
  ] : []),
  ...(plates.value.length > 1 ? [{ label: 'Export G-code of all sliced plates', icon: 'i-lucide-download', disabled: !plateStates.value.some((s) => s !== 'none'), onSelect: () => { exportAllGcode(); } }] : []),
]]);

const stats = computed(() => lastSlice.value?.report.stats ?? null);
// Only user-entered invalid values block slicing ('error'); odd values that
// ship in system profiles are tolerated by the engines ('warning').
const allProblems = computed<ConfigProblem[]>(() => {
  void resolvedConfig.value; // re-evaluate when config changes
  try { return getConfigProblems(); } catch { return []; }
});
const problems = computed(() => allProblems.value.filter((p) => p.severity === 'error'));
const problemsOpen = ref(false);
function goTo(key: string): void { problemsOpen.value = false; void nextTick(() => jumpToSetting(key)); }
function copyError(): void {
  void navigator.clipboard?.writeText(error.value ?? '').then(() => toast.info('Copied the error.'), () => {});
}
/** The active plate's slice is current: nothing left to slice. */
const sliced = computed(() => !!lastSlice.value && !isStale.value && status.value !== 'slicing' && status.value !== 'error');
const hasObjects = computed(() => { void objects.value; return getSliceObjects().length > 0; });
const canSlice = computed(() => hasObjects.value && problems.value.length === 0);
const sliceTitle = computed(() =>
  !hasObjects.value ? 'Add a printable model first' : problems.value.length ? 'Fix the highlighted settings first' : sliced.value ? 'Up to date — slice again' : 'Slice plate');
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
.problem {
  display: flex; gap: 6px; width: 100%; padding: 5px 4px; border-radius: 4px; text-align: start; cursor: pointer; line-height: 1.35;
}
.problem:hover, .problem:focus-visible { background: var(--ui-bg-elevated); outline: none; }
@media (max-width: 760px) { .export-btn :deep(span:not(:first-child)) { display: none; } }
</style>

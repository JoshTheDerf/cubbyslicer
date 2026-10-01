<script setup lang="ts">
/**
 * Orca's "Arrange options" (GLCanvas3D::_render_arrange_menu): spacing (0 =
 * auto), auto rotate, multiple materials on one plate, avoid the extrusion
 * calibration region (BBL printers that scan the first layer), align to the
 * Y axis (off while auto rotate is on), Arrange and Reset. Spacing and auto
 * rotate are kept per print sequence, as in Orca.
 */
import { computed } from 'vue';
import { mobileDialog } from '../ui/mobileDialog';
import { resolvedConfig } from '../app/state';
import { ARRANGE_SPACING_MAX, activeArrangeSet, arrangeSettings, resetArrangeSettings } from '../app/arrangeSettings';
import { arrangeSeqPrint, isBblPrinter, runArrange } from '../app/shell/arrange';
import { objects } from '../project/store';
import { dialogs } from './state';

const scalar = (v: unknown): string => String(Array.isArray(v) ? v[0] ?? '' : v ?? '');
const seqPrint = computed(() => arrangeSeqPrint(resolvedConfig.value));
const set = computed(() => activeArrangeSet(seqPrint.value));
const showCaliRegion = computed(() => isBblPrinter() && scalar(resolvedConfig.value.scan_first_layer) === '1');

const spacing = computed({
  get: () => set.value.distance,
  set: (v: number | undefined) => { set.value.distance = Math.max(0, Number.isFinite(v) ? Number(v) : 0); },
});
const rotation = computed({
  get: () => set.value.enableRotation,
  set: (v: boolean) => { set.value.enableRotation = v; if (v) arrangeSettings.alignToYAxis = false; },
});

function reset(): void { resetArrangeSettings(seqPrint.value, scalar(resolvedConfig.value.printer_structure) === 'i3'); }
function arrangeNow(): void {
  dialogs.arrange = false;
  void runArrange('all');
}
</script>

<template>
  <UModal v-model:open="dialogs.arrange" title="Arrange options" :description="seqPrint ? 'For printing by object.' : undefined" :fullscreen="mobileDialog"
          :ui="{ content: 'sm:max-w-md', body: 'flex flex-col gap-4' }">
    <template #body>
      <div class="ar__row">
        <span class="ar__lbl">Spacing</span>
        <div class="flex flex-1 items-center gap-3">
          <USlider v-model="spacing" :min="0" :max="ARRANGE_SPACING_MAX" :step="0.05" class="flex-1" aria-label="Spacing" />
          <UInputNumber v-model="spacing" :min="0" :step="0.05" :step-snapping="false" :format-options="{ maximumFractionDigits: 2 }" size="sm" class="w-28" aria-label="Spacing (mm)" />
          <span class="text-xs text-dimmed">mm</span>
        </div>
      </div>
      <p class="-mt-2 text-xs text-dimmed">0 means auto spacing.</p>
      <USeparator />
      <UCheckbox v-model="rotation" label="Auto rotate for arrangement" />
      <UCheckbox v-model="arrangeSettings.allowMultiMaterials" label="Allow multiple materials on same plate" />
      <UCheckbox v-if="showCaliRegion" v-model="arrangeSettings.avoidCaliRegion" label="Avoid extrusion calibration region" />
      <UCheckbox v-model="arrangeSettings.alignToYAxis" label="Align to Y axis" :disabled="rotation" />
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton variant="ghost" color="neutral" icon="i-lucide-rotate-ccw" label="Reset" @click="reset" />
        <div class="flex gap-2">
          <UButton variant="outline" color="neutral" label="Close" @click="dialogs.arrange = false" />
          <UButton color="primary" icon="i-lucide-layout-grid" label="Arrange" :disabled="!objects.length" @click="arrangeNow" />
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.ar__row { display: flex; align-items: center; gap: 16px; }
.ar__lbl { font-size: 13px; color: var(--ui-text); min-width: 56px; }
</style>

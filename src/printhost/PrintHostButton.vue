<script setup lang="ts">
/** "Print" button beside Export G-code — only when a print host is set up for the current printer. */
import { computed } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import { lastSlice } from '../app/state';
import { useSliceController } from '../app/slice';
import { bindingTokensOf } from '../app/shell/useActions';
import { hostMeta } from './registry';
import { cancelUpload, openWebUi } from './send';
import { boundPrinter, hostReady, openPhysicalPrinterDialog, openSendDialog, physicalPrinter, printhostUi } from './store';

const { status } = useSliceController();
const meta = computed(() => hostMeta(physicalPrinter.value?.config.type));
const canPrint = computed(() => !!meta.value?.canPrint({ printerModel: boundPrinter.value.model, variant: physicalPrinter.value?.config.variant }));
const disabled = computed(() => !lastSlice.value || status.value === 'slicing');
const kbds = computed(() => bindingTokensOf('printer.print'));
const tip = computed(() => printhostUi.uploading ? `${printhostUi.status}… ${printhostUi.progress}%` : !lastSlice.value ? 'Slice the plate first' : `${canPrint.value ? 'Print on' : 'Send to'} ${meta.value?.label ?? 'printer'}`);
const menu = computed<DropdownMenuItem[][]>(() => [[
  { label: 'Upload & Print…', icon: 'i-lucide-printer', disabled: disabled.value || !canPrint.value, onSelect: () => openSendDialog('print') },
  { label: 'Upload only…', icon: 'i-lucide-upload', disabled: disabled.value, onSelect: () => openSendDialog('upload') },
], [
  { label: 'Open printer web UI', icon: 'i-lucide-external-link', onSelect: () => openWebUi() },
  { label: 'Physical printer…', icon: 'i-lucide-router', onSelect: openPhysicalPrinterDialog },
]]);
</script>

<template>
  <UFieldGroup v-if="hostReady" size="sm" class="phb">
    <UTooltip :text="tip" :kbds="printhostUi.uploading ? undefined : kbds" :content="{ side: 'bottom' }">
      <UButton v-if="printhostUi.uploading" color="neutral" variant="outline" icon="i-lucide-x" :label="`${printhostUi.progress}%`" :loading="false"
               aria-label="Cancel upload" class="phb__main" @click="cancelUpload()" />
      <UButton v-else color="neutral" variant="outline" :icon="canPrint ? 'i-lucide-printer' : 'i-lucide-send'" :label="canPrint ? 'Print' : 'Send'"
               :disabled="disabled" class="phb__main" @click="openSendDialog(canPrint ? 'print' : 'upload')" />
    </UTooltip>
    <UDropdownMenu :items="menu" :content="{ align: 'end' }" size="sm">
      <UButton color="neutral" variant="outline" icon="i-lucide-chevron-down" aria-label="More printer actions" />
    </UDropdownMenu>
  </UFieldGroup>
</template>

<style scoped>
@media (max-width: 760px) { .phb__main :deep(span:not(:first-child)) { display: none; } }
</style>

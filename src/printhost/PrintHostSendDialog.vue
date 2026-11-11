<script setup lang="ts">
/**
 * Orca's PrintHostSendDialog: upload file name + folder, Upload vs Upload &
 * Print, and which device when the preset has several. Qidi printers with a
 * Box also pick the Box slot each filament loads from (Orca 2.5
 * QidiPrinterAgent), saved on the printer before the print starts.
 */
import { computed, ref, watch } from 'vue';
import { useSliceController } from '../app/slice';
import { currentPresets } from '../presets/store';
import AppDialog from '../ui/AppDialog.vue';
import { dialogs } from '../dialogs/state';
import { sanitizeUploadName } from './config';
import { isQidi } from './hosts/moonraker';
import { hostMeta } from './registry';
import { sendToPrinter } from './send';
import { boundPrinter, physicalPrinter, printerChoices, printhostUi, selectDevice } from './store';

const { gcodeFilename, isStale } = useSliceController();
const filename = ref('');
const folder = ref('');
/** Qidi Box slot per filament (-1: the printer's own choice). */
const slots = ref<number[]>([]);

const cfg = computed(() => physicalPrinter.value?.config ?? null);
const meta = computed(() => hostMeta(cfg.value?.type));
const canPrint = computed(() => !!meta.value?.canPrint({ printerModel: boundPrinter.value.model, variant: cfg.value?.variant }));
const host = computed(() => cfg.value?.host ?? '');
const several = computed(() => printerChoices.value.length > 1);
const deviceItems = computed(() => printerChoices.value.map((c) => ({ value: c.id, label: c.name, description: c.config.host })));
const valid = computed(() => !!filename.value.trim() && !printhostUi.uploading);
const qidiBox = computed(() => cfg.value?.type === 'moonraker' && isQidi(boundPrinter.value.model) && canPrint.value);
const filamentColours = computed(() => currentPresets.value.selection.filaments.map((_, i) => currentPresets.value.filamentColour(i)).slice(0, 16));
const slotItems = [{ value: -1, label: 'Printer’s choice' }, ...Array.from({ length: 16 }, (_, k) => ({ value: k, label: `Box ${Math.floor(k / 4) + 1} · slot ${(k % 4) + 1}` }))];

watch(() => dialogs.printhostSend, (open) => {
  if (!open) return;
  filename.value = sanitizeUploadName(gcodeFilename());
  slots.value = filamentColours.value.map((_, i) => slots.value[i] ?? -1);
});

function go(print: boolean) {
  const name = sanitizeUploadName(filename.value);
  dialogs.printhostSend = false;
  const slotMapping = print && qidiBox.value && slots.value.some((s) => s >= 0) ? slots.value.slice() : undefined;
  void sendToPrinter({ filename: name, folder: folder.value.trim(), print, slotMapping });
}
</script>

<template>
  <AppDialog v-model:open="dialogs.printhostSend" :title="printhostUi.sendMode === 'print' && canPrint ? 'Print plate' : 'Send G-code to printer'"
             :description="meta ? `${physicalPrinter?.name ?? boundPrinter.name} · ${meta.label} · ${host}` : undefined" size="md">
    <div class="space-y-3 text-sm">
      <UFormField v-if="several" label="Printer">
        <USelect :model-value="physicalPrinter?.id" :items="deviceItems" value-key="value" class="w-full" aria-label="Printer"
                 @update:model-value="(v: string) => selectDevice(v)" />
      </UFormField>
      <UFormField label="Upload as">
        <UInput v-model="filename" class="w-full" spellcheck="false" autofocus aria-label="Upload file name" @keydown.enter="valid && go(printhostUi.sendMode === 'print' && canPrint)" />
      </UFormField>
      <UFormField v-if="meta?.folder" :label="meta.folder === 'group' ? 'Group' : 'Folder'" hint="Optional">
        <UInput v-model="folder" class="w-full" spellcheck="false" :placeholder="meta.folder === 'group' ? 'Default' : 'Top level'" />
      </UFormField>
      <UFormField v-if="qidiBox" label="Qidi Box slots" hint="Upload & Print" description="Which Box slot each filament loads from.">
        <div class="grid grid-cols-2 gap-2 phone:grid-cols-1">
          <div v-for="(c, i) in filamentColours" :key="i" class="flex items-center gap-2">
            <span class="size-4 flex-none rounded-sm border border-default" :style="{ background: c }" />
            <span class="w-6 text-muted">T{{ i }}</span>
            <USelect v-model="slots[i]" :items="slotItems" value-key="value" size="sm" class="flex-1" :aria-label="`Box slot for filament ${i + 1}`" />
          </div>
        </div>
      </UFormField>
      <UAlert v-if="isStale" color="warning" variant="subtle" icon="i-lucide-triangle-alert" title="The plate changed since this slice"
              description="The last sliced G-code will be sent. Re-slice first to send the current plate." />
      <p v-if="!canPrint && meta" class="text-xs text-muted">{{ meta.label }} can only receive the file here; start the print on the printer.</p>
    </div>
    <template #footer-end>
      <UButton v-if="!meta?.printOnly" :color="printhostUi.sendMode === 'upload' || !canPrint ? 'primary' : 'neutral'" :variant="printhostUi.sendMode === 'upload' || !canPrint ? 'solid' : 'outline'"
               icon="i-lucide-upload" label="Upload" :disabled="!valid" @click="go(false)" />
      <UButton v-if="canPrint" :color="printhostUi.sendMode === 'print' || meta?.printOnly ? 'primary' : 'neutral'" :variant="printhostUi.sendMode === 'print' || meta?.printOnly ? 'solid' : 'outline'"
               icon="i-lucide-printer" label="Upload & Print" :disabled="!valid" @click="go(true)" />
    </template>
  </AppDialog>
</template>

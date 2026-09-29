<script setup lang="ts">
/** Orca's PrintHostSendDialog: upload file name + folder, Upload vs Upload & Print. */
import { computed, ref, watch } from 'vue';
import { useSliceController } from '../app/slice';
import { sanitizeUploadName } from './config';
import { hostMeta } from './registry';
import { sendToPrinter } from './send';
import { boundPrinter, physicalPrinter, printhostUi } from './store';

const { gcodeFilename, isStale } = useSliceController();
const filename = ref('');
const folder = ref('');

watch(() => printhostUi.sendOpen, (open) => {
  if (!open) return;
  filename.value = sanitizeUploadName(gcodeFilename());
});

const cfg = computed(() => physicalPrinter.value?.config ?? null);
const meta = computed(() => hostMeta(cfg.value?.type));
const canPrint = computed(() => !!meta.value?.canPrint({ printerModel: boundPrinter.value.model, variant: cfg.value?.variant }));
const host = computed(() => cfg.value?.host ?? '');
const valid = computed(() => !!filename.value.trim() && !printhostUi.uploading);

function go(print: boolean) {
  const name = sanitizeUploadName(filename.value);
  printhostUi.sendOpen = false;
  void sendToPrinter({ filename: name, folder: folder.value.trim(), print });
}
</script>

<template>
  <UModal v-model:open="printhostUi.sendOpen" :title="printhostUi.sendMode === 'print' && canPrint ? 'Print plate' : 'Send G-code to printer'"
          :description="meta ? `${meta.label} · ${host}` : undefined" :ui="{ content: 'sm:max-w-md' }">
    <template #body>
      <div class="space-y-3 text-sm">
        <UFormField label="Upload as">
          <UInput v-model="filename" class="w-full" spellcheck="false" autofocus aria-label="Upload file name" @keydown.enter="valid && go(printhostUi.sendMode === 'print' && canPrint)" />
        </UFormField>
        <UFormField v-if="meta?.folder" :label="meta.folder === 'group' ? 'Group' : 'Folder'" hint="Optional">
          <UInput v-model="folder" class="w-full" spellcheck="false" :placeholder="meta.folder === 'group' ? 'Default' : 'Top level'" />
        </UFormField>
        <UAlert v-if="isStale" color="warning" variant="subtle" icon="i-lucide-triangle-alert" title="The plate changed since this slice"
                description="The last sliced G-code will be sent. Re-slice first to send the current plate." />
        <p v-if="!canPrint && meta" class="text-xs text-muted">{{ meta.label }} can only receive the file here; start the print on the printer.</p>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="printhostUi.sendOpen = false" />
        <UButton :color="printhostUi.sendMode === 'upload' || !canPrint ? 'primary' : 'neutral'" :variant="printhostUi.sendMode === 'upload' || !canPrint ? 'solid' : 'outline'"
                icon="i-lucide-upload" label="Upload" :disabled="!valid" @click="go(false)" />
        <UButton v-if="canPrint" :color="printhostUi.sendMode === 'print' ? 'primary' : 'neutral'" :variant="printhostUi.sendMode === 'print' ? 'solid' : 'outline'"
                icon="i-lucide-printer" label="Upload & Print" :disabled="!valid" @click="go(true)" />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
/**
 * Orca's PrintHostSendDialog: upload file name + folder, Upload vs Upload &
 * Print, and which device when the preset has several. Qidi printers with a
 * Box also pick the Box slot each filament loads from (Orca 2.5
 * QidiPrinterAgent), saved on the printer before the print starts.
 */
import { computed, reactive, ref, watch } from 'vue';
import { useSliceController } from '../app/slice';
import { currentPresets } from '../presets/store';
import AppDialog from '../ui/AppDialog.vue';
import { dialogs } from '../dialogs/state';
import { sanitizeUploadName } from './config';
import { fetchQidiBox, qidiSlotItems } from './filamentSync';
import { isQidi } from './hosts/moonraker';
import { crealityInfo, crealityMultiColour, crealitySlots, defaultCfsMapping } from './hosts/creality';
import { browserEnv } from './transport';
import type { CfsSlot } from './types';
import { readJson, writeJson } from '../lib/storage';
import { SCALAR, valueAt } from '../lib/configValue';
import { hostMeta } from './registry';
import { sendToPrinter } from './send';
import { boundPrinter, hostContext, physicalPrinter, printerChoices, printhostUi, selectDevice } from './store';

const SELF_TEST_KEY = 'cubby-slicer:creality-self-test';

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
/** Creality K-series: the printer's material slots (boxsInfo), the slot per filament, the self test (Orca's Creality send dialog). */
const cfs = reactive({ multi: false, reading: false, noCfs: false, slots: [] as CfsSlot[], pick: [] as number[], selfTest: false });
const creality = computed(() => cfg.value?.type === 'crealityprint' && canPrint.value);
const cfsItems = computed(() => cfs.slots.map((x, k) => ({ value: k, label: x.boxId === 0 ? `Ext - ${x.type}` : `${x.toolId.slice(1)} - ${x.type}` })));
/** Picking the spool holder for one filament leaves the others' pickers off (the job prints from it alone). */
const extPicked = computed(() => cfs.pick.findIndex((k) => cfs.slots[k]?.boxId === 0));
const filamentTypes = computed(() => currentPresets.value.selection.filaments.map((_, i) => valueAt(currentPresets.value.value('filament', 'filament_type', i), SCALAR) ?? ''));
async function readCfs(): Promise<void> {
  const c = cfg.value;
  Object.assign(cfs, { multi: false, reading: true, noCfs: false, slots: [], pick: [] });
  cfs.selfTest = readJson<boolean>(SELF_TEST_KEY) === true;
  try {
    const ctx = hostContext(c!), env = browserEnv();
    cfs.multi = crealityMultiColour((await crealityInfo(ctx, env)).model);
    if (!cfs.multi) return;
    const r = await crealitySlots(ctx, env);
    cfs.slots = r.slots; cfs.noCfs = r.noCfs;
    cfs.pick = defaultCfsMapping(filamentColours.value.map((colour, i) => ({ colour, type: filamentTypes.value[i] ?? '' })), r.slots);
  } catch { cfs.multi = false; } finally { cfs.reading = false; }
}

/** What the Box reports per slot (QidiPrinterAgent's slot read), once read; null before / when unreadable. */
const box = ref<Awaited<ReturnType<typeof fetchQidiBox>>>(null);
const slotItems = computed(() => [{ value: -1, label: 'Printer’s choice' }, ...qidiSlotItems(box.value)]);

watch(() => dialogs.printhostSend, (open) => {
  if (!open) return;
  filename.value = sanitizeUploadName(gcodeFilename());
  slots.value = filamentColours.value.map((_, i) => slots.value[i] ?? -1);
  box.value = null;
  if (creality.value && cfg.value) void readCfs();
  if (qidiBox.value && cfg.value) void fetchQidiBox(cfg.value).then((b) => { box.value = b; }, () => { box.value = null; });
});

function go(print: boolean) {
  const name = sanitizeUploadName(filename.value);
  dialogs.printhostSend = false;
  const slotMapping = print && qidiBox.value && slots.value.some((s) => s >= 0) ? slots.value.slice() : undefined;
  writeJson(SELF_TEST_KEY, cfs.selfTest);
  const cfsJob = print && creality.value && cfs.multi ? { mapping: cfs.slots.length ? cfs.pick.map((k) => cfs.slots[k]).filter(Boolean) : [], selfTest: cfs.selfTest } : undefined;
  void sendToPrinter({ filename: name, folder: folder.value.trim(), print, slotMapping, cfs: cfsJob });
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
      <UFormField v-if="creality && (cfs.multi || cfs.reading)" label="Filament mapping" hint="Upload & Print"
                  description="The CFS slot (or the external spool) each filament prints from.">
        <p v-if="cfs.reading" class="text-xs text-muted">Reading the printer’s slots…</p>
        <p v-else-if="!cfs.slots.length" class="text-xs text-muted">{{ cfs.noCfs ? 'The printer reports no CFS connected, so the print will use the external spool.' : 'The printer did not report any filament slots, so the print will use the external spool.' }}</p>
        <div v-else class="grid grid-cols-2 gap-2 phone:grid-cols-1">
          <div v-for="(c, i) in filamentColours" :key="i" class="flex items-center gap-2">
            <span class="size-4 flex-none rounded-sm border border-default" :style="{ background: c }" />
            <span class="w-16 truncate text-muted">{{ i + 1 }} ({{ filamentTypes[i] || '?' }})</span>
            <USelect v-model="cfs.pick[i]" :items="cfsItems" value-key="value" size="sm" class="flex-1" :disabled="extPicked >= 0 && extPicked !== i"
                     :aria-label="`Slot for filament ${i + 1}`" />
          </div>
        </div>
        <UCheckbox v-if="cfs.multi" v-model="cfs.selfTest" label="Enable self-test" class="mt-2" />
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

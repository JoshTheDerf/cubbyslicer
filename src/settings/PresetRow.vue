<script setup lang="ts">
/**
 * Orca-style preset combo row: [leading slot] [preset combo] [edit] [save] [⋯].
 * Handles save / save as / rename / delete / export and the "unsaved
 * changes" prompt when switching presets.
 */
import { computed, ref, watch } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import type { EnginePresets } from '../presets/store';
import type { PresetInfo, PresetKind } from '../presets/types';
import PresetSelect from './controls/PresetSelect.vue';
import PromptDialog from './controls/PromptDialog.vue';
import { presetRequest } from './uiState';

const props = defineProps<{
  presets: EnginePresets;
  kind: PresetKind;
  index?: number;
  items: PresetInfo[];
  groupBy?: 'vendor' | 'filament' | 'none';
  /** Show the edit button (opens the printer / filament settings dialog). */
  editable?: boolean;
  /** Extra dropdown entries (e.g. "Remove filament"). */
  extraMenu?: DropdownMenuItem[];
}>();
const emit = defineEmits<{ (e: 'edit'): void; (e: 'add-printer'): void }>();

const idx = computed(() => props.index ?? 0);
const current = computed(() => props.presets.selectedInfo(props.kind, idx.value));
const dirty = computed(() => props.presets.dirtyCount(props.kind, idx.value));
const loading = computed(() => props.presets.loading.value > 0);
const kindLabel = computed(() => (props.kind === 'printer' ? 'printer' : props.kind === 'process' ? 'process' : 'filament'));
const menuOpen = ref(false);

type DialogState =
  | { type: 'saveAs' | 'rename'; error: string | null; initial: string }
  | { type: 'switch'; target: string }
  | { type: 'delete' }
  | null;
const dialog = ref<DialogState>(null);

async function doSelect(id: string, keep: boolean): Promise<void> {
  if (props.kind === 'printer') await props.presets.selectPrinter(id, { keepOverrides: keep });
  else if (props.kind === 'process') await props.presets.selectProcess(id, { keepOverrides: keep });
  else await props.presets.selectFilament(idx.value, id, { keepOverrides: keep });
}
function onSelect(id: string): void {
  if (dirty.value) dialog.value = { type: 'switch', target: id };
  else void doSelect(id, false);
}

async function save(): Promise<void> {
  if (current.value.source === 'user') await props.presets.save(props.kind, idx.value);
  else dialog.value = { type: 'saveAs', error: null, initial: suggestName() };
}
function suggestName(): string {
  const base = current.value.source === 'default' ? `My ${kindLabel.value}` : `${current.value.name} - Copy`;
  return props.presets.users.uniqueName(props.kind, base);
}

async function onDialog(action: string, value: string): Promise<void> {
  const d = dialog.value;
  if (!d) return;
  try {
    if (d.type === 'saveAs') { await props.presets.saveAs(props.kind, value, idx.value); dialog.value = null; }
    else if (d.type === 'rename') { await props.presets.renamePreset(current.value.id, value); dialog.value = null; }
    else if (d.type === 'delete') { dialog.value = null; await props.presets.deletePreset(current.value.id); }
    else if (d.type === 'switch') {
      dialog.value = null;
      if (action === 'save') {
        if (current.value.source === 'user') { await props.presets.save(props.kind, idx.value); await doSelect(d.target, false); }
        else { dialog.value = { type: 'saveAs', error: null, initial: suggestName() }; }
      } else await doSelect(d.target, action === 'transfer');
    }
  } catch (e) {
    if (d.type === 'saveAs' || d.type === 'rename') dialog.value = { ...d, error: (e as Error).message };
  }
}

watch(presetRequest, (r) => {
  if (!r || r.kind !== props.kind || r.index !== idx.value) return;
  if (r.type === 'pick') menuOpen.value = true;
  else if (r.type === 'save') void save();
  else dialog.value = { type: 'saveAs', error: null, initial: suggestName() };
});

async function exportPreset(flatten: boolean): Promise<void> {
  const { filename, json } = await props.presets.exportPreset(props.kind, idx.value, flatten);
  const blob = new Blob([JSON.stringify(json, null, 4)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const menu = computed<DropdownMenuItem[][]>(() => [
  [
    { label: 'Save as new preset…', icon: 'i-lucide-copy-plus', onSelect: () => { dialog.value = { type: 'saveAs', error: null, initial: suggestName() }; } },
    { label: 'Rename…', icon: 'i-lucide-pencil', disabled: current.value.source !== 'user', onSelect: () => { dialog.value = { type: 'rename', error: null, initial: current.value.name }; } },
    { label: 'Delete preset', icon: 'i-lucide-trash-2', color: 'error', disabled: current.value.source !== 'user', onSelect: () => { dialog.value = { type: 'delete' }; } },
  ],
  [
    { label: 'Discard unsaved changes', icon: 'i-lucide-undo-2', disabled: !dirty.value, onSelect: () => props.presets.revertAll(props.kind, idx.value) },
  ],
  [
    { label: 'Export preset (Orca JSON)', icon: 'i-lucide-download', onSelect: () => { void exportPreset(false); } },
    { label: 'Export flattened', icon: 'i-lucide-file-down', onSelect: () => { void exportPreset(true); } },
  ],
  ...(props.extraMenu?.length ? [props.extraMenu] : []),
]);
</script>

<template>
  <div class="preset-row" :data-kind="kind" :data-index="idx">
    <slot name="leading" />
    <PresetSelect v-model:open="menuOpen" :items="items" :value="current.id" :current="current" :group-by="groupBy" :modified="dirty"
                  :loading="loading" :aria-label="`${kindLabel} preset`" @select="onSelect">
      <template v-if="kind === 'printer'" #footer="{ close }">
        <UButton block size="xs" variant="ghost" icon="i-lucide-list-plus" label="Add / remove printers…" class="justify-start"
                 @click="close(); emit('add-printer')" />
      </template>
    </PresetSelect>
    <UButton v-if="editable" size="xs" variant="ghost" icon="i-lucide-square-pen" square :aria-label="`Edit ${kindLabel} settings`"
             :title="`Edit ${kindLabel} settings`" @click="emit('edit')" />
    <UButton size="xs" variant="ghost" :color="dirty ? 'warning' : 'neutral'" icon="i-lucide-save" square :disabled="!dirty && current.source === 'user'"
             :aria-label="`Save ${kindLabel} preset`" :title="current.source === 'user' ? 'Save changes to this preset' : 'Save as a new user preset…'" @click="save" />
    <UDropdownMenu :items="menu" :content="{ align: 'end' }" size="sm">
      <UButton size="xs" variant="ghost" icon="i-lucide-ellipsis-vertical" square :aria-label="`More ${kindLabel} preset actions`" />
    </UDropdownMenu>

    <PromptDialog v-if="dialog?.type === 'saveAs'" title="Save as new preset" label="Preset name" :initial="dialog.initial" :error="dialog.error"
                  :actions="[{ id: 'cancel', text: 'Cancel' }, { id: 'ok', text: 'Save' }]" @close="dialog = null" @submit="onDialog" />
    <PromptDialog v-else-if="dialog?.type === 'rename'" title="Rename preset" label="New name" :initial="dialog.initial" :error="dialog.error"
                  :actions="[{ id: 'cancel', text: 'Cancel' }, { id: 'ok', text: 'Rename' }]" @close="dialog = null" @submit="onDialog" />
    <PromptDialog v-else-if="dialog?.type === 'delete'" title="Delete preset" :message="`Delete the user preset “${current.name}”? This cannot be undone.`"
                  :actions="[{ id: 'cancel', text: 'Cancel' }, { id: 'ok', text: 'Delete', danger: true }]" @close="dialog = null" @submit="onDialog" />
    <PromptDialog v-else-if="dialog?.type === 'switch'" title="Unsaved changes"
                  :message="`“${current.name}” has ${dirty} unsaved change${dirty > 1 ? 's' : ''}. Keep them on the new preset, discard them, or save first?`"
                  :actions="[{ id: 'cancel', text: 'Cancel' }, { id: 'discard', text: 'Discard' }, { id: 'save', text: 'Save…' }, { id: 'transfer', text: 'Keep changes' }]"
                  @close="dialog = null" @submit="onDialog" />
  </div>
</template>

<style scoped>
.preset-row { display: flex; align-items: center; gap: 2px; min-width: 0; }
</style>

<script setup lang="ts">
/**
 * The settings dialogs, mounted once by the app (not by the sidebar): below
 * 1100 px the sidebar is a drawer that only exists while open, and the
 * first-run setup, settings search, add-printer, preset import and the
 * printer / filament settings dialogs must work without it. Opened through
 * `panelRequest` / `settingsUi.editor`.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useToast } from '@nuxt/ui/composables';
import { currentPresets, startPresets } from '../presets/store';
import { readJson, writeJson } from '../lib/storage';
import AddPrinterDialog from './AddPrinterDialog.vue';
import PresetSettingsModal from './PresetSettingsModal.vue';
import SettingsSearch from './SettingsSearch.vue';
import SetupWizard from './SetupWizard.vue';
import { registerPresetsSection } from './projectAdapter';
import { panelRequest, settingsUi, setupWizardState, SETUP_DONE_KEY } from './uiState';

startPresets();
registerPresetsSection();
onMounted(() => { settingsUi.hosts++; });
onBeforeUnmount(() => { settingsUi.hosts--; });

const toast = useToast();

const addPrinter = ref(false);
const searchOpen = ref(false);
const setupOpen = ref(false);
watch(() => panelRequest.focusSearch, () => { searchOpen.value = true; });
watch(() => panelRequest.addPrinter, () => { addPrinter.value = true; });
watch(() => panelRequest.setupWizard, () => { setupOpen.value = true; });
watch(() => panelRequest.closeSetupWizard, () => { if (setupOpen.value) closeSetup(); });
watch(setupOpen, (o) => { setupWizardState.open = o; }, { immediate: true });
watch(() => panelRequest.importFiles, () => fileInput.value?.click());
// First visit: walk the user through picking their printer and filament.
if (!readJson<boolean>(SETUP_DONE_KEY)) void currentPresets.value.ready.then(() => { if (!readJson<boolean>(SETUP_DONE_KEY)) setupOpen.value = true; });
function closeSetup(): void { setupOpen.value = false; writeJson(SETUP_DONE_KEY, true); }

// ---- import presets ------------------------------------------------------------------
const fileInput = ref<HTMLInputElement | null>(null);
async function onImport(ev: Event): Promise<void> {
  const files = [...((ev.target as HTMLInputElement).files ?? [])];
  (ev.target as HTMLInputElement).value = '';
  if (!files.length) return;
  const data = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  const r = await currentPresets.value.importFiles(data);
  const w = r.warnings.length ? `${r.warnings.slice(0, 6).join('\n')}${r.warnings.length > 6 ? `\n… ${r.warnings.length - 6} more` : ''}` : undefined;
  toast.add({
    title: `Imported ${r.imported.length} preset${r.imported.length === 1 ? '' : 's'}`, description: w,
    color: r.warnings.length ? 'warning' : 'success', icon: r.warnings.length ? 'i-lucide-triangle-alert' : 'i-lucide-check',
    duration: r.warnings.length ? 12000 : 4000,
  });
}
</script>

<template>
  <input ref="fileInput" type="file" multiple hidden accept=".json,.zip,.orca_printer,.orca_filament,.bbscfg,.bbsflmt,application/json,application/zip" @change="onImport" />
  <PresetSettingsModal kind="printer" @add-printer="addPrinter = true" />
  <PresetSettingsModal kind="filament" />
  <SettingsSearch v-model:open="searchOpen" />
  <AddPrinterDialog v-if="addPrinter" :presets="currentPresets" @close="addPrinter = false" />
  <SetupWizard v-if="setupOpen" @close="closeSetup" />
</template>

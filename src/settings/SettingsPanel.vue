<script setup lang="ts">
/**
 * Left settings sidebar, laid out like OrcaSlicer's Plater Sidebar:
 *
 *   Printer   — engine picker, printer combo (+ "Add / remove printers…"),
 *               edit (→ Printer settings dialog) / save, plate type + nozzle line
 *   Filament  — one row per filament: colour swatch, combo, edit / save; + / −
 *   Process   — process combo + save, Global | Objects switch, mode, search;
 *               Global: Quality / Strength / Speed / Support / Multimaterial / Others tabs
 *               Objects: <slot name="objects" /> (the shell's object list) + per-object settings
 *
 * Printer and filament settings are edited in large dialogs (PresetSettingsModal).
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import { useToast } from '@nuxt/ui/composables';
import { activeEngine } from '../app/state';
import { ENGINE_LABELS, getEngineVersion, isEngineAvailable } from '../engine/client';
import MixedFilamentsPanel from '../mixed/MixedFilamentsPanel.vue';
import type { EngineId } from '../engine/types';
import { primarySelection, selectedIds, selectedPart } from '../project/store';
import { selectedRange } from '../layers/store';
import { currentPresets, ENGINES, FILAMENT_PALETTE, setActiveEngine, startPresets } from '../presets/store';
import { asArray } from '../presets/values';
import { lsGet, lsSet } from '../presets/kv';
import AddPrinterDialog from './AddPrinterDialog.vue';
import { openPhysicalPrinterDialog } from '../printhost/store';
import ColorField from './controls/ColorField.vue';
import ModeSelect from './ModeSelect.vue';
import ObjectSettingsPanel from './ObjectSettingsPanel.vue';
import PresetRow from './PresetRow.vue';
import PresetSettingsModal from './PresetSettingsModal.vue';
import SettingsGroups from './SettingsGroups.vue';
import SettingsSearch from './SettingsSearch.vue';
import SetupWizard from './SetupWizard.vue';
import { registerPresetsSection } from './projectAdapter';
import { configProblems } from './validate';
import { registerSettingsActions } from './actions';
import { currentPageOf, jumpToSetting, pageDirty, pageIcon, selectPage, settingsLayout } from './useLayout';
import { openSettingsTab, panelRequest, settingsUi, SETUP_DONE_KEY, type SidebarSection } from './uiState';
import FilamentSectionActions from '../dialogs/FilamentSectionActions.vue';
import { openDialog } from '../dialogs/state';

defineSlots<{
  /** Shown in Process → "Objects" mode above the selected object's settings (the shell's object list). */
  objects?(): unknown;
}>();

startPresets();
registerPresetsSection();
void registerSettingsActions();
onMounted(() => { settingsUi.mounted++; });
onBeforeUnmount(() => { settingsUi.mounted--; });

const toast = useToast();
const p = computed(() => currentPresets.value);

// ---- sections ----------------------------------------------------------------------
const isOpen = (s: SidebarSection) => !settingsUi.collapsedSections.includes(s);
function toggleSection(s: SidebarSection): void {
  settingsUi.collapsedSections = isOpen(s) ? [...settingsUi.collapsedSections, s] : settingsUi.collapsedSections.filter((x) => x !== s);
}

// ---- engines -------------------------------------------------------------------
const engineInfo = reactive<Record<EngineId, { available: boolean | null; version: string }>>({
  orca: { available: null, version: '' },
  preflight: { available: null, version: '' },
  fullspectrum: { available: null, version: '' },
});
onMounted(() => {
  for (const e of ENGINES) {
    isEngineAvailable(e).then((a) => { engineInfo[e].available = a; }).catch(() => { engineInfo[e].available = false; });
    getEngineVersion(e).then((v) => { if (v) engineInfo[e].version = v.version; }).catch(() => { /* ignore */ });
  }
});
const engineTitle = (e: EngineId) => (engineInfo[e].available === false ? `${ENGINE_LABELS[e]} is not deployed` : `${ENGINE_LABELS[e]} ${engineInfo[e].version}`.trim());

// ---- dialogs / requests --------------------------------------------------------------
const addPrinter = ref(false);
const searchOpen = ref(false);
const setupOpen = ref(false);
watch(() => panelRequest.focusSearch, () => { searchOpen.value = true; });
watch(() => panelRequest.addPrinter, () => { addPrinter.value = true; });
watch(() => panelRequest.setupWizard, () => { setupOpen.value = true; });
watch(() => panelRequest.importFiles, () => fileInput.value?.click());
// First visit: walk the user through picking their printer and filament.
if (!lsGet<boolean>(SETUP_DONE_KEY)) void p.value.ready.then(() => { if (!lsGet<boolean>(SETUP_DONE_KEY)) setupOpen.value = true; });
function closeSetup(): void { setupOpen.value = false; lsSet(SETUP_DONE_KEY, true); }

const printerMenu = computed<DropdownMenuItem[][]>(() => [[
  { label: 'Add / remove printers…', icon: 'i-lucide-list-plus', onSelect: () => { addPrinter.value = true; } },
  { label: 'Printer & filament setup…', icon: 'i-lucide-wand-sparkles', onSelect: () => { setupOpen.value = true; } },
  { label: 'Physical printer…', icon: 'i-lucide-router', description: 'Send G-code over the network', onSelect: openPhysicalPrinterDialog },
], [
  { label: 'Bed shape…', icon: 'i-lucide-square-dashed', description: 'Printable area, height, custom texture / model', onSelect: () => openDialog('bedShape') },
  { label: 'Create printer…', icon: 'i-lucide-printer', onSelect: () => openDialog('createPrinter') },
  { label: 'Create filament…', icon: 'i-lucide-disc', onSelect: () => openDialog('createFilament') },
], [
  { label: 'Import presets…', icon: 'i-lucide-upload', description: 'Orca / Bambu .json, .zip, .orca_printer, .bbscfg…', onSelect: () => fileInput.value?.click() },
  { label: 'Export preset bundle…', icon: 'i-lucide-package', description: '.orca_printer / .orca_filament / .zip', onSelect: () => openDialog('exportBundle') },
]]);

// ---- printer ---------------------------------------------------------------------------
const printerItems = computed(() => p.value.printerInfos.value);
const nozzles = computed(() => asArray(p.value.value('printer', 'nozzle_diameter')).filter(Boolean));
const bedTypeDef = computed(() => p.value.bedTypeDef());
const showBedType = computed(() => {
  if (!bedTypeDef.value?.enumValues?.length) return false;
  // Orca shows the plate type for Bambu printers and printers that declare multiple / default bed types.
  const multi = asArray(p.value.value('printer', 'support_multi_bed_types'))[0] === '1';
  return multi || !!p.value.modelBedType.value || !!p.value.printerDefaultBedType() || p.value.infos.value.printer.vendor === 'BBL';
});
const bedItems = computed(() => (bedTypeDef.value?.enumValues ?? []).map((v, i) => ({ value: v, label: bedTypeDef.value?.enumLabels?.[i] || v })));

// ---- filaments -------------------------------------------------------------------------
const filamentItems = computed(() => p.value.compatible.value.filament);
const semm = computed(() => asArray(p.value.value('printer', 'single_extruder_multi_material'))[0] === '1');
const filamentCount = computed(() => p.value.selection.filaments.length);
function addFilament(): void { void p.value.setFilamentCount(filamentCount.value + 1); }
function removeFilament(i = filamentCount.value - 1): void {
  if (settingsUi.filamentSlot >= filamentCount.value - 1) settingsUi.filamentSlot = Math.max(0, filamentCount.value - 2);
  void p.value.removeFilament(i);
}
const filamentMenu = (i: number): DropdownMenuItem[] => (semm.value && filamentCount.value > 1
  ? [{ label: `Remove filament ${i + 1}`, icon: 'i-lucide-trash-2', color: 'error', onSelect: () => removeFilament(i) }] : []);

// ---- process ---------------------------------------------------------------------------
const processItems = computed(() => p.value.compatible.value.process);
const processTab = computed(() => settingsLayout.value?.process ?? null);
const processPage = computed(() => currentPageOf('process'));
const region = computed({ get: () => settingsUi.region, set: (r) => { settingsUi.region = r; } });
const singleSel = computed(() => (selectedIds.value.length === 1 ? primarySelection.value : null));
/** A part (e.g. a modifier) picked in the object list: its settings instead of the object's. */
const partSel = computed(() => (singleSel.value && selectedPart.value?.objectId === singleSel.value.id ? selectedPart.value.partId : undefined));
/** A height range modifier picked in the object list: its settings instead. */
const rangeSel = computed(() => (singleSel.value && selectedRange.value?.objectId === singleSel.value.id ? selectedRange.value.rangeId : undefined));

// ---- problems ---------------------------------------------------------------------------
const problems = computed(() => configProblems.value);
const problemErrors = computed(() => problems.value.filter((x) => x.severity === 'error').length);

// ---- import -----------------------------------------------------------------------------
const fileInput = ref<HTMLInputElement | null>(null);
async function onImport(ev: Event): Promise<void> {
  const files = [...((ev.target as HTMLInputElement).files ?? [])];
  (ev.target as HTMLInputElement).value = '';
  if (!files.length) return;
  const data = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  const r = await p.value.importFiles(data);
  const w = r.warnings.length ? `${r.warnings.slice(0, 6).join('\n')}${r.warnings.length > 6 ? `\n… ${r.warnings.length - 6} more` : ''}` : undefined;
  toast.add({
    title: `Imported ${r.imported.length} preset${r.imported.length === 1 ? '' : 's'}`, description: w,
    color: r.warnings.length ? 'warning' : 'success', icon: r.warnings.length ? 'i-lucide-triangle-alert' : 'i-lucide-check',
    duration: r.warnings.length ? 12000 : 4000,
  });
}

const schemaNote = computed(() => {
  const s = p.value.schemaSource.value;
  if (s === 'fixture') return 'Engine schema.json not found — using the bundled development schema.';
  if (s === 'none' && !p.value.loading.value) return 'No settings schema available for this engine.';
  return null;
});
</script>

<template>
  <div class="sp" data-settings-sidebar>
    <UAlert v-if="p.error.value" class="m-2" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :description="p.error.value" />

    <!-- ============ Printer ============ -->
    <section class="sp__sec" aria-label="Printer">
      <header class="sp__bar" @click="toggleSection('printer')">
        <UIcon name="i-lucide-chevron-down" class="sp__chev" :class="{ 'sp__chev--closed': !isOpen('printer') }" />
        <UIcon name="i-lucide-printer" class="sp__icon" />
        <h3 class="sp__title">Printer<span v-if="!isOpen('printer')" class="sp__sub"> | {{ p.infos.value.printer.name }}</span></h3>
        <div class="sp__acts" @click.stop>
          <UDropdownMenu :items="printerMenu" :content="{ align: 'end' }" size="sm">
            <UButton size="xs" variant="ghost" icon="i-lucide-ellipsis" square aria-label="Printer menu" />
          </UDropdownMenu>
        </div>
      </header>
      <div v-show="isOpen('printer')" class="sp__body">
        <UFieldGroup class="sp__engines" role="radiogroup" aria-label="Slicing engine">
          <UButton v-for="e in ENGINES" :key="e" size="xs" role="radio" :aria-checked="activeEngine === e" class="flex-1 justify-center"
                   :variant="activeEngine === e ? 'soft' : 'outline'" :color="activeEngine === e ? 'primary' : 'neutral'" :title="engineTitle(e)"
                   @click="setActiveEngine(e)">
            <span class="sp__led" :class="{ ok: engineInfo[e].available === true, bad: engineInfo[e].available === false }" />
            {{ ENGINE_LABELS[e] }}<small v-if="engineInfo[e].version" class="text-dimmed">{{ engineInfo[e].version }}</small>
          </UButton>
        </UFieldGroup>
        <PresetRow :presets="p" kind="printer" :items="printerItems" group-by="vendor" editable
                   @edit="openSettingsTab('printer')" @add-printer="addPrinter = true" />
        <div v-if="showBedType || nozzles.length" class="sp__info">
          <template v-if="showBedType">
            <span class="sp__lbl">Plate</span>
            <USelect :model-value="p.bedType() ?? undefined" :items="bedItems" value-key="value" size="xs" class="min-w-0 flex-1" aria-label="Plate type"
                     @update:model-value="(v: unknown) => p.setBedType(String(v))" />
          </template>
          <span v-if="nozzles.length" class="sp__nozzle" :title="`Nozzle diameter${nozzles.length > 1 ? 's' : ''}`">
            <UIcon name="i-lucide-pen-tool" class="size-3.5" />{{ nozzles.join(' / ') }} mm
          </span>
        </div>
      </div>
    </section>

    <!-- ============ Filament ============ -->
    <section class="sp__sec" aria-label="Filament">
      <header class="sp__bar" @click="toggleSection('filament')">
        <UIcon name="i-lucide-chevron-down" class="sp__chev" :class="{ 'sp__chev--closed': !isOpen('filament') }" />
        <UIcon name="i-lucide-disc" class="sp__icon" />
        <h3 class="sp__title">Filament<span v-if="filamentCount > 1" class="sp__sub"> ({{ filamentCount }})</span></h3>
        <div class="sp__acts" @click.stop>
          <FilamentSectionActions />
          <template v-if="semm">
            <UButton size="xs" variant="ghost" icon="i-lucide-plus" square aria-label="Add filament" title="Add filament" :disabled="filamentCount >= 64" @click="addFilament" />
            <UButton v-if="filamentCount > 1" size="xs" variant="ghost" icon="i-lucide-minus" square aria-label="Remove last filament" title="Remove last filament" @click="removeFilament()" />
          </template>
        </div>
      </header>
      <div v-show="isOpen('filament')" class="sp__body sp__fils">
        <PresetRow v-for="(_f, i) in p.selection.filaments" :key="`fil-${i}`" :presets="p" kind="filament" :index="i" :items="filamentItems"
                   group-by="filament" editable :extra-menu="filamentMenu(i)" @edit="openSettingsTab('filament', i)">
          <template #leading>
            <span class="sp__slotno">{{ i + 1 }}</span>
            <ColorField :model-value="p.filamentColour(i)" swatch-only size="sm" resettable :palette="FILAMENT_PALETTE" :aria-label="`Filament ${i + 1} colour`"
                        @update:model-value="(c: string) => p.setFilamentColour(i, c)" />
          </template>
        </PresetRow>
        <MixedFilamentsPanel v-if="activeEngine === 'fullspectrum'" />
      </div>
    </section>

    <!-- ============ Process ============ -->
    <section class="sp__sec sp__sec--grow" :class="{ 'sp__sec--closed': !isOpen('process') }" aria-label="Process">
      <header class="sp__bar" @click="toggleSection('process')">
        <UIcon name="i-lucide-chevron-down" class="sp__chev" :class="{ 'sp__chev--closed': !isOpen('process') }" />
        <UIcon name="i-lucide-layers" class="sp__icon" />
        <h3 class="sp__title">Process</h3>
        <div class="sp__acts" @click.stop>
          <UFieldGroup size="xs" role="radiogroup" aria-label="Edit global or per-object settings">
            <UButton v-for="r in (['global', 'objects'] as const)" :key="r" role="radio" :aria-checked="region === r" size="xs"
                     :variant="region === r ? 'solid' : 'outline'" :color="region === r ? 'primary' : 'neutral'"
                     :label="r === 'global' ? 'Global' : 'Objects'" @click="region = r; isOpen('process') || toggleSection('process')" />
          </UFieldGroup>
          <span class="flex-1" />
          <ModeSelect />
          <UButton size="xs" variant="ghost" icon="i-lucide-search" square aria-label="Search settings" title="Search settings (Ctrl+Shift+F)" @click="searchOpen = true" />
        </div>
      </header>
      <div v-show="isOpen('process')" class="sp__body sp__body--grow">
        <PresetRow :presets="p" kind="process" :items="processItems" group-by="none" />

        <template v-if="region === 'global'">
          <nav v-if="processTab" class="sp__tabs" :class="{ 'sp__tabs--wrap': processTab.pages.length > 7 }" role="tablist" aria-label="Process settings">
            <button v-for="pg in processTab.pages" :key="pg.id" type="button" role="tab" class="sp__tab" :class="{ on: processPage?.id === pg.id }"
                    :aria-selected="processPage?.id === pg.id" :title="pg.title" @click="selectPage('process', pg.id)">
              <UIcon :name="pageIcon(pg.title)" class="size-4" />
              <span class="sp__tabl">{{ pg.title }}</span>
              <span v-if="pageDirty(pg, 'process', 0)" class="sp__tdot" />
            </button>
          </nav>
          <p v-if="schemaNote" class="sp__note">{{ schemaNote }}</p>
          <UPopover v-if="problems.length" :content="{ side: 'bottom', align: 'start' }">
            <UButton class="sp__problems" size="xs" variant="soft" :color="problemErrors ? 'error' : 'warning'" icon="i-lucide-triangle-alert" block
                     :label="`${problems.length} invalid value${problems.length > 1 ? 's' : ''}${problemErrors ? '' : ' in presets'}`" trailing-icon="i-lucide-chevron-down" />
            <template #content>
              <div class="flex max-h-72 w-80 flex-col overflow-auto p-1">
                <UButton v-for="(pr, i) in problems.slice(0, 50)" :key="i" size="xs" variant="ghost" color="neutral" class="justify-start text-left"
                         @click="jumpToSetting(pr.key)">
                  <span class="min-w-0 whitespace-normal"><strong :class="pr.severity === 'error' ? 'text-error' : 'text-warning'">{{ pr.label }}</strong>{{ pr.index !== undefined ? ` [${pr.index + 1}]` : '' }}: {{ pr.message }}</span>
                </UButton>
              </div>
            </template>
          </UPopover>
          <div class="sp__scroll" data-settings-scope="process">
            <SettingsGroups kind="process" :page="processPage" />
          </div>
        </template>

        <div v-else class="sp__scroll sp__objects">
          <slot name="objects" />
          <ObjectSettingsPanel v-if="singleSel" :key="`${singleSel.id}|${partSel ?? ''}|${rangeSel ?? ''}`" :object-id="singleSel.id" :part-id="rangeSel ? undefined : partSel" :range-id="rangeSel" />
          <p v-else class="sp__hint">
            <UIcon name="i-lucide-mouse-pointer-click" class="size-4" />
            {{ selectedIds.length > 1 ? 'Select a single object to edit its settings.' : 'Select an object to override process settings for it.' }}
          </p>
        </div>
      </div>
    </section>

    <input ref="fileInput" type="file" multiple hidden accept=".json,.zip,.orca_printer,.orca_filament,.bbscfg,.bbsflmt,application/json,application/zip" @change="onImport" />
    <PresetSettingsModal kind="printer" @add-printer="addPrinter = true" />
    <PresetSettingsModal kind="filament" />
    <SettingsSearch v-model:open="searchOpen" />
    <AddPrinterDialog v-if="addPrinter" :presets="p" @close="addPrinter = false" />
    <SetupWizard v-if="setupOpen" @close="closeSetup" />
  </div>
</template>

<style scoped>
.sp { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--ui-bg); color: var(--ui-text); font-size: 13px; }
.sp__sec { display: flex; flex-direction: column; border-bottom: 1px solid var(--ui-border); flex: none; }
.sp__sec--grow { flex: 1; min-height: 0; }
.sp__sec--closed { flex: none; }
.sp__bar {
  display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 6px 0 8px; cursor: pointer; user-select: none; flex: none;
  background: var(--ui-bg-muted); border-bottom: 1px solid var(--ui-border);
}
.sp__bar:hover .sp__title { color: var(--ui-primary); }
.sp__chev { width: 14px; height: 14px; color: var(--ui-text-dimmed); transition: transform .12s; flex: none; }
.sp__chev--closed { transform: rotate(-90deg); }
.sp__icon { width: 16px; height: 16px; color: var(--ui-primary); flex: none; }
.sp__title { margin: 0; font-size: 13px; font-weight: 600; color: var(--ui-text-highlighted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sp__sub { font-weight: 400; color: var(--ui-text-muted); }
.sp__acts { display: flex; align-items: center; gap: 4px; margin-left: auto; cursor: default; }
.sp__sec--grow .sp__acts { flex: 1; margin-left: 8px; }
.sp__body { display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.sp__body--grow { flex: 1; min-height: 0; padding-bottom: 0; }
.sp__engines { width: 100%; }
.sp__led { width: 6px; height: 6px; border-radius: 50%; background: var(--ui-text-dimmed); flex: none; }
.sp__led.ok { background: var(--ui-primary); }
.sp__led.bad { background: var(--ui-error); }
.sp__info { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ui-text-muted); }
.sp__lbl { color: var(--ui-text-dimmed); }
.sp__nozzle { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; white-space: nowrap; color: var(--ui-text-toned); }
.sp__fils { gap: 4px; max-height: 40vh; overflow: auto; }
.sp__slotno { width: 14px; text-align: right; font-size: 11px; color: var(--ui-text-dimmed); flex: none; margin-right: 2px; font-variant-numeric: tabular-nums; }
.sp__fils :deep(.cf) { margin-right: 4px; }
.sp__tabs { display: flex; gap: 0; border-bottom: 1px solid var(--ui-border); margin: 0 -8px; padding: 0 4px; }
.sp__tabs--wrap { flex-wrap: wrap; }
.sp__tab {
  position: relative; flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 5px 2px 4px;
  border: 0; background: none; color: var(--ui-text-muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.sp__tab:hover { color: var(--ui-text-highlighted); }
.sp__tab.on { color: var(--ui-primary); border-bottom-color: var(--ui-primary); }
.sp__tabs--wrap .sp__tab { min-width: 64px; }
.sp__tabl { font-size: 11px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp__tdot { position: absolute; top: 4px; right: 8px; width: 6px; height: 6px; border-radius: 50%; background: var(--modified); }
.sp__note { margin: 0; font-size: 11px; color: var(--ui-warning); }
.sp__problems { justify-content: flex-start; }
.sp__scroll { flex: 1; min-height: 0; overflow: auto; margin: 0 -8px; padding: 2px 4px 24px; overscroll-behavior: contain; }
.sp__objects { display: flex; flex-direction: column; gap: 6px; }
.sp__hint { display: flex; align-items: center; gap: 6px; margin: 0; padding: 12px 8px; color: var(--ui-text-dimmed); font-size: 12px; }
</style>

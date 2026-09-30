<script setup lang="ts">
/**
 * Orca's "Printer settings" / "Filament settings" dialog (opened from the
 * edit buttons next to the sidebar combos): preset combo + save, page list
 * (Basic information, Machine G-code, Extruder N, Motion ability / Filament,
 * Cooling, Setting overrides, Advanced, …) and the page's option groups.
 */
import { computed, shallowRef } from 'vue';
import { currentPresets } from '../presets/store';
import ColorField from './controls/ColorField.vue';
import ModeSelect from './ModeSelect.vue';
import PresetRow from './PresetRow.vue';
import SettingsGroups from './SettingsGroups.vue';
import { currentPageOf, extruderCount, pageDirty, pageIcon, perExtruderKeys, selectPage, settingsLayout } from './useLayout';
import { panelRequest, settingsUi } from './uiState';
import { mobileDialog } from '../ui/mobileDialog';

const props = defineProps<{ kind: 'printer' | 'filament' }>();
const emit = defineEmits<{ (e: 'add-printer'): void }>();

const p = computed(() => currentPresets.value);
const open = computed({
  get: () => settingsUi.editor === props.kind,
  set: (v: boolean) => { if (!v && settingsUi.editor === props.kind) settingsUi.editor = null; else if (v) settingsUi.editor = props.kind; },
});
const title = computed(() => (props.kind === 'printer' ? 'Printer settings' : 'Filament settings'));
const tab = computed(() => settingsLayout.value?.[props.kind] ?? null);
const page = computed(() => (open.value ? currentPageOf(props.kind) : null));
const slotIdx = computed(() => (props.kind === 'filament' ? Math.min(settingsUi.filamentSlot, p.value.selection.filaments.length - 1) : 0));
const items = computed(() => (props.kind === 'printer' ? p.value.printerInfos.value : p.value.compatible.value.filament));

const extruderDraft = shallowRef<number | null>(null);
/** Phones: the page list becomes a select above the settings. */
const pageItems = computed(() => (tab.value?.pages ?? []).map((pg) => ({
  value: pg.id, label: pageDirty(pg, props.kind, slotIdx.value) ? `${pg.title} •` : pg.title, icon: pageIcon(pg.title),
})));

function setExtruders(n: number | null | undefined): void {
  if (typeof n === 'number' && Number.isFinite(n) && n >= 1 && n !== extruderCount.value) p.value.setExtruderCount(n, perExtruderKeys.value);
  extruderDraft.value = null;
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :fullscreen="mobileDialog"
          :ui="{ content: 'sm:max-w-5xl h-[min(88vh,920px)] flex flex-col', body: 'p-0 sm:p-0 phone:p-0 flex-1 min-h-0 flex phone:flex-col', header: 'py-3 gap-3', close: 'top-3', wrapper: 'flex-none' }">
    <template #title>
      <span class="flex items-center gap-2"><UIcon :name="kind === 'printer' ? 'i-lucide-printer' : 'i-lucide-disc'" class="size-5 text-primary" />{{ title }}</span>
    </template>
    <template v-if="!mobileDialog" #actions>
      <div class="me-1 flex min-w-0 flex-1 items-center gap-3" :data-editor="kind">
        <div v-if="kind === 'filament' && p.selection.filaments.length > 1" class="flex items-center gap-1" role="tablist" aria-label="Filament slot">
          <UButton v-for="(_f, i) in p.selection.filaments" :key="i" size="xs" :variant="slotIdx === i ? 'soft' : 'ghost'" :color="slotIdx === i ? 'primary' : 'neutral'"
                   role="tab" :aria-selected="slotIdx === i" @click="settingsUi.filamentSlot = i">
            <span class="inline-block size-3 rounded-sm" :style="{ background: p.filamentColour(i) }" />{{ i + 1 }}
          </UButton>
        </div>
        <PresetRow :key="`${kind}-${slotIdx}`" class="min-w-0 max-w-md flex-1" :presets="p" :kind="kind" :index="slotIdx" :items="items"
                   :group-by="kind === 'printer' ? 'vendor' : 'filament'" @add-printer="emit('add-printer')" />
        <span class="flex-1" />
        <ModeSelect />
        <UButton size="sm" variant="ghost" icon="i-lucide-search" aria-label="Search settings" title="Search settings (Ctrl+Shift+F)" @click="panelRequest.focusSearch++" />
      </div>
    </template>
    <template #body>
      <!-- Phones: preset, page and slot pickers stacked above the one scrolling settings region. -->
      <div v-if="mobileDialog" class="psm__bar" :data-editor="kind">
        <div class="psm__barrow">
          <PresetRow :key="`${kind}-${slotIdx}`" class="min-w-0 flex-1" :presets="p" :kind="kind" :index="slotIdx" :items="items"
                     :group-by="kind === 'printer' ? 'vendor' : 'filament'" @add-printer="emit('add-printer')" />
        </div>
        <div class="psm__barrow">
          <USelect :model-value="page?.id" :items="pageItems" value-key="value" size="sm" class="min-w-0 flex-1" aria-label="Settings page"
                   :icon="page ? pageIcon(page.title) : undefined" @update:model-value="(v: string) => selectPage(kind, v)" />
          <ModeSelect />
          <UButton size="sm" variant="ghost" icon="i-lucide-search" aria-label="Search settings" @click="panelRequest.focusSearch++" />
        </div>
        <div v-if="kind === 'filament'" class="psm__barrow">
          <div v-if="p.selection.filaments.length > 1" class="flex min-w-0 flex-1 flex-wrap items-center gap-1" role="tablist" aria-label="Filament slot">
            <UButton v-for="(_f, i) in p.selection.filaments" :key="i" size="xs" :variant="slotIdx === i ? 'soft' : 'ghost'" :color="slotIdx === i ? 'primary' : 'neutral'"
                     role="tab" :aria-selected="slotIdx === i" @click="settingsUi.filamentSlot = i">
              <span class="inline-block size-3 rounded-sm" :style="{ background: p.filamentColour(i) }" />{{ i + 1 }}
            </UButton>
          </div>
          <span v-else class="flex-1 truncate text-xs text-muted">Filament {{ slotIdx + 1 }}</span>
          <ColorField :model-value="p.filamentColour(slotIdx)" size="sm" aria-label="Filament colour" resettable
                      @update:model-value="(c: string) => p.setFilamentColour(slotIdx, c)" />
        </div>
        <div v-else-if="tab" class="psm__barrow psm__barrow--end">
          <span class="text-xs text-muted">Extruders</span>
          <UInputNumber :model-value="extruderDraft ?? extruderCount" :min="1" :max="16" size="xs" class="w-32" aria-label="Extruder count"
                        @update:model-value="setExtruders" />
        </div>
      </div>
      <nav v-else class="psm__nav" aria-label="Pages">
        <div v-if="kind === 'filament'" class="psm__slot">
          <ColorField :model-value="p.filamentColour(slotIdx)" size="sm" aria-label="Filament colour" resettable
                      @update:model-value="(c: string) => p.setFilamentColour(slotIdx, c)" />
          <span class="truncate text-xs text-muted">Filament {{ slotIdx + 1 }}</span>
        </div>
        <button v-for="pg in tab?.pages ?? []" :key="pg.id" type="button" class="psm__page" :class="{ on: page?.id === pg.id }"
                :aria-current="page?.id === pg.id ? 'page' : undefined" @click="selectPage(kind, pg.id)">
          <UIcon :name="pageIcon(pg.title)" class="size-4 flex-none" />
          <span class="flex-1 truncate">{{ pg.title }}</span>
          <span v-if="pageDirty(pg, kind, slotIdx)" class="psm__dot" :title="`${pageDirty(pg, kind, slotIdx)} modified`" />
        </button>
        <div v-if="kind === 'printer' && tab" class="psm__extr">
          <span>Extruders</span>
          <UInputNumber :model-value="extruderDraft ?? extruderCount" :min="1" :max="16" size="xs" class="w-24" aria-label="Extruder count"
                        @update:model-value="setExtruders" />
        </div>
      </nav>
      <div class="psm__content" :data-settings-scope="kind">
        <SettingsGroups :kind="kind" :page="page" :slot-index="slotIdx" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.psm__nav { width: 210px; flex: none; border-right: 1px solid var(--ui-border); padding: 8px; display: flex; flex-direction: column; gap: 1px; overflow: auto; }
.psm__slot { display: flex; align-items: center; gap: 8px; padding: 2px 4px 8px; margin-bottom: 4px; border-bottom: 1px solid var(--ui-border); }
.psm__page {
  display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 8px; border: 0; border-radius: var(--ui-radius); background: none;
  color: var(--ui-text-toned); cursor: pointer; font-size: 13px; text-align: left;
}
.psm__page:hover { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.psm__page.on { background: color-mix(in srgb, var(--ui-primary) 14%, transparent); color: var(--ui-primary); }
.psm__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--modified); }
.psm__extr { margin-top: auto; padding: 10px 4px 2px; border-top: 1px solid var(--ui-border); display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px; color: var(--ui-text-muted); }
.psm__content { flex: 1; min-width: 0; overflow: auto; padding: 8px 14px 32px; overscroll-behavior: contain; }
.psm__bar { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--ui-border); }
.psm__barrow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.psm__barrow--end { justify-content: space-between; }
@media (max-width: 640px), (max-height: 500px) {
  .psm__content { min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 4px 12px calc(24px + env(safe-area-inset-bottom)); }
}
@media (max-height: 500px) and (min-width: 560px) {
  .psm__bar { flex-direction: row; flex-wrap: wrap; }
  .psm__barrow { flex: 1 1 300px; }
  .psm__barrow--end { flex: 0 1 auto; }
}
</style>

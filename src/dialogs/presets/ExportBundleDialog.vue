<script setup lang="ts">
/**
 * Orca ExportConfigsDialog ("Export Preset Bundle"): pick an export type and
 * the user presets to include; every selected printer / filament becomes one
 * .orca_printer / .orca_filament file (importable by OrcaSlicer and by our
 * preset import), preset types become one flat .zip.
 */
import { computed, ref, watch } from 'vue';
import { phone } from '../../app/shell/uiState';
import { activeEngine } from '../../app/state';
import { downloadBytes } from '../../app/shell/download';
import { currentPresets } from '../../presets/store';
import type { UserPreset } from '../../presets/userPresets';
import { toast } from '../../ui';
import { dialogs } from '../state';
import { EXPORT_LABELS, filamentBaseName, filamentBundle, presetsZip, printerBundle, type BundleFile, type ExportKind } from './bundleExport';

const kind = ref<ExportKind>('printer_bundle');
const chosen = ref<Set<string>>(new Set());
const p = computed(() => currentPresets.value);
const users = computed(() => p.value.users?.list.value ?? []);
const byKind = (k: UserPreset['kind']) => users.value.filter((u) => u.kind === k);

watch(() => dialogs.exportBundle, (o) => { if (o) chosen.value = new Set(); });
watch(kind, () => { chosen.value = new Set(); });

const kindItems = (Object.keys(EXPORT_LABELS) as ExportKind[]).map((k) => ({ value: k, label: EXPORT_LABELS[k] }));

/** Rows to choose from for the current export type. */
const rows = computed<Array<{ id: string; label: string; detail?: string }>>(() => {
  switch (kind.value) {
    case 'printer_bundle':
    case 'printer_presets':
      return byKind('printer').map((u) => ({ id: u.id, label: u.name, detail: u.inherits ? `based on ${u.inherits}` : 'custom printer' }));
    case 'filament_bundle': {
      const groups = new Map<string, number>();
      for (const u of byKind('filament')) groups.set(filamentBaseName(u.name), (groups.get(filamentBaseName(u.name)) ?? 0) + 1);
      return [...groups.entries()].map(([name, n]) => ({ id: name, label: name, detail: `${n} preset${n === 1 ? '' : 's'}` }));
    }
    case 'filament_presets':
      return byKind('filament').map((u) => ({ id: u.id, label: u.name, detail: u.inherits ? `based on ${u.inherits}` : undefined }));
    case 'process_presets':
      return byKind('process').map((u) => ({ id: u.id, label: u.name, detail: u.inherits ? `based on ${u.inherits}` : undefined }));
  }
  return [];
});
const note = computed(() => ({
  printer_bundle: 'Only user printer presets are listed. Each printer is exported with the user filament and process presets made for it.',
  filament_bundle: 'Only filament names with user filament presets are listed; all user presets of each name are exported.',
  printer_presets: 'Each selected user printer preset is added to one zip.',
  filament_presets: 'Each selected user filament preset is added to one zip.',
  process_presets: 'Each selected user process preset is added to one zip.',
}[kind.value]));

function toggle(id: string, v: boolean): void { const s = new Set(chosen.value); if (v) s.add(id); else s.delete(id); chosen.value = s; }
const allOn = computed(() => rows.value.length > 0 && rows.value.every((r) => chosen.value.has(r.id)));
function toggleAll(v: boolean): void { chosen.value = v ? new Set(rows.value.map((r) => r.id)) : new Set(); }

async function vendorOf(u: UserPreset): Promise<string> {
  if (!u.parentId) return 'Custom';
  const info = await p.value.catalog.info(u.parentId, u.kind).catch(() => null);
  return info?.vendor || 'Custom';
}

async function exportNow(): Promise<void> {
  const out: BundleFile[] = [];
  try {
    if (kind.value === 'printer_bundle') {
      for (const id of chosen.value) {
        const pr = users.value.find((u) => u.id === id);
        if (pr) out.push(printerBundle(pr, users.value, { parentName: pr.inherits }));
      }
    } else if (kind.value === 'filament_bundle') {
      for (const name of chosen.value) {
        const list = byKind('filament').filter((u) => filamentBaseName(u.name) === name);
        out.push(filamentBundle(name, await Promise.all(list.map(async (preset) => ({ preset, vendor: await vendorOf(preset) })))));
      }
    } else {
      const k = kind.value === 'printer_presets' ? 'printer' : kind.value === 'filament_presets' ? 'filament' : 'process';
      out.push(presetsZip(k, byKind(k).filter((u) => chosen.value.has(u.id))));
    }
  } catch (e) {
    toast.error('Couldn’t export the presets.', { detail: (e as Error)?.message });
    return;
  }
  // Browsers throttle bursts of downloads: space them out a little.
  out.forEach((f, i) => setTimeout(() => downloadBytes(f.data, f.filename, 'application/zip'), i * 350));
  const n = out.reduce((s, f) => s + f.count, 0);
  toast.success(`Exported ${n} preset${n === 1 ? '' : 's'} in ${out.length} file${out.length === 1 ? '' : 's'}.`);
  dialogs.exportBundle = false;
}
</script>

<template>
  <UModal v-model:open="dialogs.exportBundle" title="Export preset bundle" :fullscreen="phone" :ui="{ content: 'sm:max-w-xl', body: 'flex flex-col gap-3' }">
    <template #body>
      <UFormField label="Export type">
        <URadioGroup v-model="kind" :items="kindItems" size="sm" />
      </UFormField>
      <UAlert v-if="activeEngine === 'preflight'" color="warning" variant="subtle" icon="i-lucide-info"
              description="These are preFlight presets: OrcaSlicer can import the files, but preFlight option names may not all be recognised." />
      <p class="text-xs text-muted">{{ note }}</p>
      <div class="eb__list">
        <label v-if="rows.length" class="eb__row eb__row--all">
          <UCheckbox :model-value="allOn" @update:model-value="(v: boolean | 'indeterminate') => toggleAll(v === true)" /> <span>Select all</span>
        </label>
        <label v-for="r in rows" :key="r.id" class="eb__row">
          <UCheckbox :model-value="chosen.has(r.id)" @update:model-value="(v: boolean | 'indeterminate') => toggle(r.id, v === true)" />
          <span class="min-w-0 flex-1 truncate">{{ r.label }}</span>
          <small v-if="r.detail" class="truncate text-dimmed">{{ r.detail }}</small>
        </label>
        <p v-if="!rows.length" class="eb__empty">No user presets of this type yet. Save a preset (or create a printer / filament) first.</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" @click="dialogs.exportBundle = false" />
        <UButton color="primary" icon="i-lucide-download" label="Export" :disabled="!chosen.size" @click="exportNow" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.eb__list { border: 1px solid var(--ui-border); border-radius: var(--ui-radius); max-height: 40vh; overflow: auto; padding: 4px; }
.eb__row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; font-size: 13px; border-radius: 4px; cursor: pointer; }
.eb__row:hover { background: var(--ui-bg-elevated); }
.eb__row--all { border-bottom: 1px solid var(--ui-border); border-radius: 0; margin-bottom: 2px; color: var(--ui-text-muted); }
.eb__row small { max-width: 45%; }
.eb__empty { margin: 0; padding: 12px; font-size: 12px; color: var(--ui-text-dimmed); }
</style>

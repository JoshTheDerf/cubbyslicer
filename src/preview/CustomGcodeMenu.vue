<script setup lang="ts">
/**
 * Orca IMSlider menus for the preview's vertical layer slider: add colour
 * change / filament change / pause / custom G-code / custom template on a
 * layer, edit or delete an existing tick, jump to a layer. Items are stored
 * per plate (plates/store.ts); changing them marks that plate's slice stale.
 */
import { computed, ref, watch } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import AnchoredMenu from '../app/shell/AnchoredMenu.vue';
import { activeEngine, resolvedConfig } from '../app/state';
import { getSchema } from '../engine/client';
import { currentPresets } from '../presets/store';
import { toast } from '../ui';
import type { CustomGcodeItem } from '../engine/types';
import { activePlate } from '../project/store';
import { phone } from '../app/shell/uiState';
import {
  addCustomGcode, clearCustomGcodes, nextChangeColor, plateCustomGcodes, removeCustomGcode, updateCustomGcode,
} from '../plates/store';
import { hexCss, toolColorsFromConfig } from './render/colors';
import { layerOfZ, zOfLayer } from './customGcode';
import { previewData, setTopLayer } from './store';

const items = computed(() => plateCustomGcodes(activePlate.value));
const colors = computed(() => toolColorsFromConfig(resolvedConfig.value));
const filamentCount = computed(() => {
  const v = resolvedConfig.value.filament_colour ?? resolvedConfig.value.extruder_colour;
  return Math.max(1, Array.isArray(v) ? v.length : String(v ?? '').split(/[;,]/).filter(Boolean).length || 1);
});
const cfgStr = (k: string) => { const v = resolvedConfig.value[k]; return (Array.isArray(v) ? v[0] : v) ?? ''; };
const hasTemplate = computed(() => !!cfgStr('template_custom_gcode').trim());
/**
 * Engines with a `color_change_gcode` (preFlight / PrusaSlicer) emit M600 for colour changes.
 * OrcaSlicer (BBS lineage) has none: its slider changes colour by changing to another
 * filament (ToolChange → change_filament_gcode), so that is what we offer there.
 */
const m600 = ref(false);
watch(activeEngine, async (e) => { m600.value = !!(await getSchema(e).catch(() => null))?.options.color_change_gcode; }, { immediate: true });

const menu = ref({ open: false, x: 0, y: 0, layer: 0 });
const zOf = (layer: number) => { const p = previewData.value; return p ? zOfLayer(p.layerZ, layer) : 0; };
const tickAt = (layer: number) => {
  const p = previewData.value;
  return p ? items.value.find((g) => layerOfZ(p.layerZ, g.z) === layer) ?? null : null;
};

function add(layer: number, item: Omit<CustomGcodeItem, 'z'>): void {
  addCustomGcode(activePlate.value, { ...item, z: zOf(layer) });
}
function addColorChange(layer: number, extruder = 1): void {
  add(layer, { type: 'color_change', extruder, color: nextChangeColor(items.value) });
}

/** "+" on the slider: Orca's add-tick. M600 engines + one filament → colour change; otherwise pick the filament. */
function openAdd(e: { x: number; y: number; layer: number }): void {
  if (filamentCount.value <= 1 && m600.value) { addColorChange(e.layer); return; }
  openMenu(e);
}

/** Orca offers "Change filament" only with 2+ filaments: add filament 2, then change to it. */
async function addFilamentAndChange(layer: number): Promise<void> {
  const z = zOf(layer);
  try {
    await currentPresets.value.setFilamentCount(2);
  } catch (err) {
    toast.error('Could not add a filament.', { detail: (err as Error)?.message ?? String(err) });
    return;
  }
  addCustomGcode(activePlate.value, { z, type: 'tool_change', extruder: 2 });
  toast.info('Added filament 2 — pick its colour in the Filament section.');
}
function openMenu(e: { x: number; y: number; layer: number }): void {
  setTopLayer(e.layer);
  menu.value = { open: true, x: e.x, y: e.y, layer: e.layer };
}

/** A filament colour dot as an avatar image (DropdownMenu has no swatch slot). */
const swatch = (i: number) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${hexCss(colors.value[i] ?? 0x999999)}" stroke="rgba(0,0,0,.4)"/></svg>`;
  return { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, alt: '' };
};
function filamentItems(onPick: (i: number) => void, current?: number): DropdownMenuItem[] {
  return Array.from({ length: filamentCount.value }, (_, i) => ({
    label: `Filament ${i + 1}${current === i + 1 ? ' (current)' : ''}`, avatar: swatch(i), onSelect: () => onPick(i + 1),
  }));
}

const menuItems = computed<DropdownMenuItem[][]>(() => {
  if (!menu.value.open) return [];
  const L = menu.value.layer;
  const t = tickAt(L);
  const clearAll: DropdownMenuItem = { label: 'Delete all custom G-codes', icon: 'i-lucide-trash', color: 'error', disabled: !items.value.length,
    onSelect: () => clearCustomGcodes(activePlate.value) };
  if (t) {
    const z = t.z;
    const edit: DropdownMenuItem[] = [];
    if (t.type === 'color_change') {
      edit.push({ label: 'Edit color…', icon: 'i-lucide-palette', onSelect: () => openColor(z, t.color ?? '#0B2C7A') });
      if (filamentCount.value > 1) edit.push({ label: 'Extruder', icon: 'i-lucide-circle-dot', children: [filamentItems((e) => updateCustomGcode(activePlate.value, z, { extruder: e }), t.extruder)] });
      edit.push({ label: 'Delete color change', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => removeCustomGcode(activePlate.value, z) });
    } else if (t.type === 'tool_change') {
      edit.push({ label: 'Change filament', icon: 'i-lucide-replace', children: [filamentItems((e) => addCustomGcode(activePlate.value, { z, type: 'tool_change', extruder: e }), t.extruder)] });
      edit.push({ label: 'Delete filament change', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => removeCustomGcode(activePlate.value, z) });
    } else if (t.type === 'pause') {
      edit.push({ label: 'Edit pause message…', icon: 'i-lucide-message-square-text', onSelect: () => openText('pause', z, t.extra ?? '') });
      edit.push({ label: 'Delete pause', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => removeCustomGcode(activePlate.value, z) });
    } else if (t.type === 'custom') {
      edit.push({ label: 'Edit custom G-code…', icon: 'i-lucide-file-code', onSelect: () => openText('custom', z, t.extra ?? '') });
      edit.push({ label: 'Delete custom G-code', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => removeCustomGcode(activePlate.value, z) });
    } else {
      edit.push({ label: 'Delete custom template', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => removeCustomGcode(activePlate.value, z) });
    }
    return [[{ type: 'label', label: `Layer ${L + 1} · ${z.toFixed(2)} mm` }], edit, [clearAll]];
  }
  const addGroup: DropdownMenuItem[] = [];
  if (filamentCount.value > 1) {
    addGroup.push({ label: 'Change filament', icon: 'i-lucide-replace', description: 'Change filament at the beginning of this layer.',
      children: [filamentItems((e) => add(L, { type: 'tool_change', extruder: e }))] });
    if (m600.value) addGroup.push({ label: 'Add color change', icon: 'i-lucide-palette', children: [filamentItems((e) => addColorChange(L, e))] });
  } else if (m600.value) {
    addGroup.push({ label: 'Add color change', icon: 'i-lucide-palette', description: 'Pause for a filament swap (M600) at this layer.', onSelect: () => addColorChange(L) });
  } else {
    addGroup.push({ label: 'Change filament…', icon: 'i-lucide-replace', description: 'Adds a second filament and changes to it at this layer.',
      onSelect: () => { void addFilamentAndChange(L); } });
  }
  addGroup.push(
    { label: 'Add pause', icon: 'i-lucide-pause', description: 'Insert a pause command at the beginning of this layer.', onSelect: () => add(L, { type: 'pause', extra: '' }) },
    { label: 'Add custom G-code…', icon: 'i-lucide-file-code', description: 'Insert custom G-code at the beginning of this layer.', onSelect: () => openText('custom', zOf(L), '', true) },
  );
  if (hasTemplate.value) addGroup.push({ label: 'Add custom template', icon: 'i-lucide-file-cog', description: 'Insert template custom G-code at the beginning of this layer.', onSelect: () => add(L, { type: 'template' }) });
  return [
    [{ type: 'label', label: `Layer ${L + 1} · ${zOf(L).toFixed(2)} mm` }],
    addGroup,
    [{ label: 'Jump to layer…', icon: 'i-lucide-arrow-up-down', onSelect: () => { jump.value = { open: true, layer: L + 1 }; } }, clearAll],
  ];
});

// ---- text (custom G-code / pause message) --------------------------------------------------
const text = ref({ open: false, kind: 'custom' as 'custom' | 'pause', z: 0, value: '', isNew: false });
function openText(kind: 'custom' | 'pause', z: number, value: string, isNew = false): void { text.value = { open: true, kind, z, value, isNew }; }
function saveText(): void {
  const t = text.value;
  if (t.kind === 'custom' && !t.value.trim()) { text.value.open = false; return; }
  if (t.isNew) addCustomGcode(activePlate.value, { z: t.z, type: 'custom', extra: t.value });
  else updateCustomGcode(activePlate.value, t.z, { extra: t.value });
  text.value.open = false;
}

// ---- colour -------------------------------------------------------------------------------
const color = ref({ open: false, z: 0, value: '#0B2C7A' });
function openColor(z: number, value: string): void { color.value = { open: true, z, value }; }
function saveColor(): void {
  const v = /^#[0-9a-f]{6}$/i.test(color.value.value) ? color.value.value : '#0B2C7A';
  updateCustomGcode(activePlate.value, color.value.z, { color: v.toUpperCase() });
  color.value.open = false;
}

// ---- jump ---------------------------------------------------------------------------------
const jump = ref({ open: false, layer: 1 });
const layerCount = computed(() => previewData.value?.layerCount ?? 1);
function doJump(): void { setTopLayer(Math.max(1, Math.min(layerCount.value, Math.round(jump.value.layer))) - 1); jump.value.open = false; }

defineExpose({ openAdd, openMenu });
</script>

<template>
  <AnchoredMenu v-model:open="menu.open" :x="menu.x" :y="menu.y" :items="menuItems" />

  <UModal v-model:open="text.open" :title="text.kind === 'pause' ? 'Pause message' : 'Custom G-code'" :fullscreen="phone"
          :description="text.kind === 'pause' ? 'Shown on printers that support it when the print pauses.' : 'Enter Custom G-code used on current layer:'">
    <template #body>
      <UTextarea v-model="text.value" :rows="text.kind === 'pause' ? 2 : 8" autoresize autofocus class="w-full font-mono" data-testid="custom-gcode-text"
                 :placeholder="text.kind === 'pause' ? 'e.g. Insert magnets' : 'M117 Hello'" />
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="text.open = false" />
        <UButton color="primary" label="OK" data-testid="custom-gcode-ok" @click="saveText" />
      </div>
    </template>
  </UModal>

  <UModal v-model:open="color.open" title="Color change" description="The colour the preview uses after this change." :ui="{ content: 'sm:max-w-xs' }">
    <template #body>
      <div class="flex flex-col items-center gap-3">
        <UColorPicker v-model="color.value" format="hex" />
        <UInput v-model="color.value" size="sm" class="w-32 font-mono" aria-label="Hex colour" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="color.open = false" />
        <UButton color="primary" label="OK" @click="saveColor" />
      </div>
    </template>
  </UModal>

  <UModal v-model:open="jump.open" title="Jump to layer" :ui="{ content: 'sm:max-w-xs' }">
    <template #body>
      <form class="flex items-center gap-2" @submit.prevent="doJump">
        <UInputNumber v-model="jump.layer" :min="1" :max="layerCount" size="sm" autofocus />
        <span class="text-sm text-muted">of {{ layerCount }}</span>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="jump.open = false" />
        <UButton color="primary" label="Go" @click="doJump" />
      </div>
    </template>
  </UModal>
</template>

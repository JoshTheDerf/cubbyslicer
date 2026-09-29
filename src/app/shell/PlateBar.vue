<script setup lang="ts">
/**
 * Plate tabs (Orca's per-plate controls, as a compact bar): one chip per
 * plate with its object count, slice state and lock, a menu per plate, and
 * "+" to add a plate. Click a chip to make that plate active (the camera
 * moves to it; Preview shows its G-code).
 */
import { computed, ref } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import {
  activePlate, moveObjectsToPlate, objectPlate, plates, renamePlate, selectedIds, setActivePlate,
} from '../../project/store';
import { MAX_PLATES, plateLabel } from '../../project/plates';
import { activeView } from '../state';
import { useSliceController } from '../slice';
import { openPlateSettings } from '../../plates/ui';
import { addPlateCmd, arrangePlate, autoOrientObjects, clearPlateCmd, deletePlateCmd, selectPlate, togglePlateLock } from './actions';

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });
const slicer = useSliceController();

const counts = computed(() => {
  const c = plates.value.map(() => 0);
  for (const p of objectPlate.value.values()) if (p >= 0 && p < c.length) c[p]++;
  return c;
});

const renaming = ref<number | null>(null);
const renameText = ref('');
function startRename(i: number): void { renaming.value = i; renameText.value = plates.value[i]?.name ?? ''; }
function commitRename(): void {
  if (renaming.value !== null) renamePlate(renaming.value, renameText.value);
  renaming.value = null;
}

function menu(i: number): DropdownMenuItem[][] {
  const p = plates.value[i];
  const multi = plates.value.length > 1;
  const run = (fn: () => unknown) => () => { setActivePlate(i); void fn(); };
  return [
    [
      { label: 'Slice this plate', icon: 'i-lucide-layers', disabled: !counts.value[i] || slicer.status.value === 'slicing', onSelect: run(() => slicer.slice()) },
      { label: 'Arrange objects on plate', icon: 'i-lucide-layout-dashboard', kbds: ['shift', 'A'], disabled: !counts.value[i] || p.locked, onSelect: run(arrangePlate) },
      { label: 'Auto orient plate', icon: 'i-lucide-compass', kbds: ['shift', 'Q'], disabled: !counts.value[i] || p.locked, onSelect: run(() => autoOrientObjects('all')) },
    ],
    [
      { label: p.locked ? 'Unlock plate' : 'Lock plate', icon: p.locked ? 'i-lucide-lock-open' : 'i-lucide-lock', onSelect: () => togglePlateLock(i) },
      { label: 'Rename…', icon: 'i-lucide-text-cursor-input', onSelect: () => startRename(i) },
      { label: 'Plate settings…', icon: 'i-lucide-settings-2', onSelect: run(() => openPlateSettings(i)) },
      { label: selectedIds.value.length > 1 ? `Move ${selectedIds.value.length} selected objects here` : 'Move selected object here', icon: 'i-lucide-move-right',
        disabled: !selectedIds.value.length || selectedIds.value.every((id) => objectPlate.value.get(id) === i),
        onSelect: () => moveObjectsToPlate(selectedIds.value.slice(), i) },
    ],
    [
      { label: 'Delete all objects on plate', icon: 'i-lucide-eraser', color: 'error', disabled: !counts.value[i], onSelect: () => clearPlateCmd(i) },
      { label: 'Delete plate', icon: 'i-lucide-square-x', color: 'error', disabled: !multi, onSelect: () => deletePlateCmd(i) },
    ],
  ];
}

const stateIcon = (i: number) => {
  const s = slicer.plateStates.value[i];
  return s === 'done' ? 'i-lucide-circle-check' : s === 'stale' ? 'i-lucide-refresh-cw' : null;
};
const stateTitle = (i: number) => {
  const s = slicer.plateStates.value[i];
  return s === 'done' ? 'Sliced' : s === 'stale' ? 'Sliced — changed since, re-slice to update' : 'Not sliced';
};

function pick(i: number): void {
  selectPlate(i);
  if (activeView.value === 'preview' && slicer.plateStates.value[i] === 'none' && counts.value[i]) void slicer.slice();
}
</script>

<template>
  <div class="platebar" :class="{ 'platebar--compact': props.compact }" role="tablist" aria-label="Plates">
    <template v-for="(p, i) in plates" :key="i">
      <UPopover v-if="renaming === i" :open="true" @update:open="(v: boolean) => { if (!v) commitRename(); }">
        <UButton size="xs" color="primary" variant="soft" :label="plateLabel(p, i)" />
        <template #content>
          <form class="p-2 flex gap-1.5" @submit.prevent="commitRename">
            <UInput v-model="renameText" size="xs" autofocus :placeholder="`Plate ${i + 1}`" maxlength="80" aria-label="Plate name" class="w-44" />
            <UButton size="xs" type="submit" color="primary" label="Rename" />
          </form>
        </template>
      </UPopover>
      <div v-else class="chip" :class="{ 'chip--on': i === activePlate }">
        <button type="button" role="tab" class="chip__main" :aria-selected="i === activePlate"
                :title="`${plateLabel(p, i)} — ${counts[i]} object${counts[i] === 1 ? '' : 's'} · ${stateTitle(i)}${p.locked ? ' · locked' : ''}`"
                @click="pick(i)" @dblclick="startRename(i)">
          <span class="chip__label">{{ props.compact && !p.name ? i + 1 : plateLabel(p, i) }}</span>
          <span v-if="counts[i]" class="chip__count">{{ counts[i] }}</span>
          <UIcon v-if="p.locked" name="i-lucide-lock" class="size-3 text-dimmed" />
          <UIcon v-if="p.config" name="i-lucide-settings-2" class="size-3 text-dimmed" title="Has plate settings" />
          <UIcon v-if="stateIcon(i)" :name="stateIcon(i)!" class="size-3" :class="slicer.plateStates.value[i] === 'done' ? 'text-primary' : 'text-warning'" />
        </button>
        <UDropdownMenu :items="menu(i)" :content="{ side: 'top', align: 'start' }" :ui="{ content: 'min-w-56' }">
          <button type="button" class="chip__more" :aria-label="`${plateLabel(p, i)} options`"><UIcon name="i-lucide-chevron-up" class="size-3" /></button>
        </UDropdownMenu>
      </div>
    </template>
    <UTooltip text="Add plate">
      <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-plus" aria-label="Add plate" :disabled="plates.length >= MAX_PLATES" @click="addPlateCmd" />
    </UTooltip>
  </div>
</template>

<style scoped>
.platebar {
  display: flex; align-items: center; gap: 4px; padding: 4px; max-width: 100%; overflow-x: auto;
  background: color-mix(in oklab, var(--ui-bg-elevated) 88%, transparent); border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2); backdrop-filter: blur(6px); scrollbar-width: thin;
}
.chip { display: inline-flex; align-items: stretch; border-radius: var(--ui-radius); border: 1px solid transparent; flex: none; }
.chip:hover { border-color: var(--ui-border-accented); }
.chip--on { border-color: var(--ui-primary); background: color-mix(in oklab, var(--ui-primary) 14%, transparent); }
.chip__main {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 4px 3px 8px; font-size: 12px; color: var(--ui-text);
  background: none; border: 0; cursor: pointer; white-space: nowrap;
}
.chip--on .chip__main { color: var(--ui-text-highlighted); font-weight: 600; }
.chip__label { max-width: 12em; overflow: hidden; text-overflow: ellipsis; }
.chip__count {
  font-size: 10px; min-width: 16px; padding: 0 4px; border-radius: 8px; text-align: center;
  background: var(--ui-bg-accented); color: var(--ui-text-muted); font-variant-numeric: tabular-nums;
}
.chip__more { display: inline-flex; align-items: center; padding: 0 5px; background: none; border: 0; color: var(--ui-text-dimmed); cursor: pointer; }
.chip__more:hover { color: var(--ui-text-highlighted); }
</style>

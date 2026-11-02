<script setup lang="ts">
/**
 * Plate tabs (Orca's per-plate controls, as a compact bar): one chip per
 * plate with its object count, problems, slice state and lock, and "+" to add
 * a plate. Click a chip to make that plate active (the camera moves to it;
 * Preview shows its G-code); double-click renames it in place. The plate's
 * menu opens from the active chip's chevron or a right-click on any chip and,
 * like the other right-click menus, lists only what applies to that plate.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import {
  activePlate, moveObjectsToPlate, objectIssues, objectPlate, objectsOnPlate, plates, renamePlate, select, selectedIds, setActivePlate,
} from '../../project/store';
import { MAX_PLATES, plateLabel } from '../../project/plates';
import { activeView } from '../state';
import { useSliceController } from '../slice';
import { openPlateSettings } from '../../plates/ui';
import {
  addPlateCmd, arrangePlate, autoOrientObjects, clearPlateCmd, deletePlateCmd, exportGcode, selectPlate, togglePlateLock,
} from './actions';
import AnchoredMenu from './AnchoredMenu.vue';

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });
const slicer = useSliceController();

const counts = computed(() => {
  const c = plates.value.map(() => 0);
  for (const p of objectPlate.value.values()) if (p >= 0 && p < c.length) c[p]++;
  return c;
});

/** Objects per plate that would stop it slicing (outside, too tall, excluded area). */
const problems = computed(() => {
  const c = plates.value.map(() => 0);
  for (const [id, list] of objectIssues.value) {
    const p = objectPlate.value.get(id) ?? -1;
    if (p >= 0 && p < c.length && list.some((l) => l !== 'overlap')) c[p]++;
  }
  return c;
});

// ---- rename in place -------------------------------------------------------------------

const renaming = ref<number | null>(null);
const renameText = ref('');
const renameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null);
function startRename(i: number): void {
  renaming.value = i; renameText.value = plates.value[i]?.name ?? '';
  void nextTick(() => { const el = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value; el?.focus(); el?.select(); });
}
function commitRename(): void {
  if (renaming.value !== null) renamePlate(renaming.value, renameText.value);
  renaming.value = null;
}
function cancelRename(): void { renaming.value = null; }

// ---- plate menu ------------------------------------------------------------------------

function menu(i: number): DropdownMenuItem[][] {
  const p = plates.value[i];
  const n = counts.value[i];
  const run = (fn: () => unknown) => () => { setActivePlate(i); void fn(); };
  const moving = selectedIds.value.filter((id) => objectPlate.value.get(id) !== i);
  const groups: Array<Array<DropdownMenuItem | false>> = [
    [
      n > 0 && slicer.status.value !== 'slicing' && { label: 'Slice this plate', icon: 'i-lucide-layers', onSelect: run(() => slicer.slice()) },
      slicer.plateStates.value[i] === 'done' && { label: 'Export G-code', icon: 'i-lucide-download', onSelect: run(exportGcode) },
    ],
    [
      n > 0 && !p.locked && { label: 'Arrange objects on plate', icon: 'i-lucide-layout-dashboard', kbds: ['shift', 'A'], onSelect: run(arrangePlate) },
      n > 0 && !p.locked && { label: 'Auto orient plate', icon: 'i-lucide-compass', kbds: ['shift', 'Q'], onSelect: run(() => autoOrientObjects('all')) },
      n > 0 && { label: 'Select objects on plate', icon: 'i-lucide-box-select', onSelect: run(() => select(objectsOnPlate(i).map((o) => o.id))) },
      moving.length > 0 && {
        label: moving.length > 1 ? `Move ${moving.length} selected objects here` : 'Move selected object here', icon: 'i-lucide-move-right',
        onSelect: () => moveObjectsToPlate(moving, i),
      },
    ],
    [
      { label: 'Rename…', icon: 'i-lucide-text-cursor-input', onSelect: () => startRename(i) },
      { label: p.locked ? 'Unlock plate' : 'Lock plate', icon: p.locked ? 'i-lucide-lock-open' : 'i-lucide-lock', onSelect: () => togglePlateLock(i) },
      { label: 'Plate settings…', icon: 'i-lucide-settings-2', onSelect: run(() => openPlateSettings(i)) },
    ],
    [
      n > 0 && { label: 'Delete all objects on plate', icon: 'i-lucide-eraser', color: 'error', onSelect: () => clearPlateCmd(i) },
      plates.value.length > 1 && { label: 'Delete plate', icon: 'i-lucide-square-x', color: 'error', onSelect: () => deletePlateCmd(i) },
    ],
  ];
  return groups.map((g) => g.filter((it): it is DropdownMenuItem => !!it)).filter((g) => g.length);
}

const menuAt = ref({ open: false, plate: 0, x: 0, y: 0 });
const menuItems = computed(() => (menuAt.value.open ? menu(menuAt.value.plate) : []));
// A press on the open menu's own chevron closes it (outside press) before the
// click lands: remember that so the click doesn't reopen it.
let closed = { plate: -1, t: 0 };
watch(() => menuAt.value.open, (v) => { if (!v) closed = { plate: menuAt.value.plate, t: performance.now() }; });

function openMenu(i: number, x: number, y: number): void { menuAt.value = { open: true, plate: i, x, y }; }
function onChipMenu(i: number, e: MouseEvent): void {
  if (renaming.value === i) return; // the name field keeps the browser's menu
  e.preventDefault();
  openMenu(i, e.clientX, e.clientY);
}
function onChevron(i: number, e: MouseEvent): void {
  if (closed.plate === i && performance.now() - closed.t < 400) return;
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(i, r.left, r.top);
}

// ---- chips -----------------------------------------------------------------------------

const stateIcon = (i: number) => {
  const s = slicer.plateStates.value[i];
  return s === 'done' ? 'i-lucide-circle-check' : s === 'stale' ? 'i-lucide-refresh-cw' : null;
};
function chipTitle(i: number): string {
  const p = plates.value[i];
  const n = counts.value[i];
  const s = slicer.plateStates.value[i];
  const parts = [plateLabel(p, i), n ? `${n} object${n === 1 ? '' : 's'}` : 'empty'];
  if (problems.value[i]) parts.push(`${problems.value[i]} won't print as placed`);
  parts.push(s === 'done' ? 'sliced' : s === 'stale' ? 'changed since slicing' : 'not sliced');
  if (p.locked) parts.push('locked');
  if (p.config) parts.push('has plate settings');
  return parts.join(' · ');
}

function pick(i: number): void {
  selectPlate(i);
  if (activeView.value === 'preview' && slicer.plateStates.value[i] === 'none' && counts.value[i]) void slicer.slice();
}

const track = ref<HTMLElement | null>(null);
// Keep the active plate in view when there are more chips than fit.
watch(activePlate, (i) => {
  void nextTick(() => track.value?.querySelector<HTMLElement>(`[data-plate="${i}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
});

/** Arrow keys move between plate tabs (WAI-ARIA tabs). */
function onKey(e: KeyboardEvent): void {
  const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0;
  if (!d || renaming.value !== null) return;
  e.preventDefault();
  const n = plates.value.length;
  const i = Number.isFinite(d) ? (activePlate.value + d + n) % n : d < 0 ? 0 : n - 1;
  pick(i);
  void nextTick(() => track.value?.querySelector<HTMLElement>(`[data-plate="${i}"] [role="tab"]`)?.focus());
}
</script>

<template>
  <div class="platebar" :class="{ 'platebar--compact': props.compact }">
    <div ref="track" class="platebar__track" role="tablist" aria-label="Plates" @keydown="onKey">
      <div v-for="(p, i) in plates" :key="i" class="chip" :data-plate="i"
           :class="{ 'chip--on': i === activePlate, 'chip--empty': !counts[i] }"
           @contextmenu="onChipMenu(i, $event)">
        <form v-if="renaming === i" class="chip__rename" @submit.prevent="commitRename">
          <input ref="renameInput" v-model="renameText" class="chip__input" maxlength="80" :placeholder="`Plate ${i + 1}`" aria-label="Plate name"
                 @blur="commitRename" @keydown.esc.stop.prevent="cancelRename">
        </form>
        <button v-else type="button" role="tab" class="chip__main" :aria-selected="i === activePlate" :tabindex="i === activePlate ? 0 : -1"
                :title="chipTitle(i)" @click="pick(i)" @dblclick="startRename(i)">
          <span class="chip__label">{{ props.compact && !p.name ? i + 1 : plateLabel(p, i) }}</span>
          <span v-if="counts[i]" class="chip__count">{{ counts[i] }}</span>
          <UIcon v-if="problems[i]" name="i-lucide-triangle-alert" class="size-3 text-warning" />
          <UIcon v-if="p.locked" name="i-lucide-lock" class="size-3 text-dimmed" />
          <UIcon v-if="p.config" name="i-lucide-settings-2" class="size-3 text-dimmed" />
          <UIcon v-if="stateIcon(i)" :name="stateIcon(i)!" class="size-3" :class="slicer.plateStates.value[i] === 'done' ? 'text-primary' : 'text-warning'" />
        </button>
        <button type="button" class="chip__more" :aria-label="`${plateLabel(p, i)} options`" aria-haspopup="menu"
                :aria-expanded="menuAt.open && menuAt.plate === i" tabindex="-1" @click="onChevron(i, $event)">
          <UIcon name="i-lucide-chevron-up" class="size-3" />
        </button>
      </div>
    </div>
    <UTooltip text="Add plate">
      <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-plus" aria-label="Add plate" class="flex-none"
               :disabled="plates.length >= MAX_PLATES" @click="addPlateCmd" />
    </UTooltip>
    <!-- Out of the bar: its transform / backdrop-filter would make the fixed anchor relative to it. -->
    <Teleport to="body"><AnchoredMenu v-model:open="menuAt.open" :x="menuAt.x" :y="menuAt.y" :items="menuItems" /></Teleport>
  </div>
</template>

<style scoped>
.platebar {
  display: flex; align-items: center; gap: 2px; padding: 4px; max-width: 100%; min-width: 0;
  background: color-mix(in oklab, var(--ui-bg-elevated) 88%, transparent); border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2); backdrop-filter: blur(6px);
}
/* Chips scroll; "+" stays put at the end. */
.platebar__track { display: flex; align-items: center; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.platebar__track::-webkit-scrollbar { display: none; }
.chip { display: inline-flex; align-items: stretch; border-radius: var(--ui-radius); border: 1px solid transparent; flex: none; }
.chip:hover { border-color: var(--ui-border-accented); }
.chip--on { border-color: var(--ui-primary); background: color-mix(in oklab, var(--ui-primary) 14%, transparent); }
.chip__main {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 2px 3px 8px; font-size: 12px; color: var(--ui-text);
  background: none; border: 0; cursor: pointer; white-space: nowrap; border-radius: var(--ui-radius);
}
.chip--empty .chip__main { color: var(--ui-text-muted); }
.chip--on .chip__main { color: var(--ui-text-highlighted); font-weight: 600; }
.chip__main:focus-visible, .chip__more:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; }
.chip__label { max-width: 12em; overflow: hidden; text-overflow: ellipsis; }
.chip__count {
  font-size: 10px; min-width: 16px; padding: 0 4px; border-radius: 8px; text-align: center;
  background: var(--ui-bg-accented); color: var(--ui-text-muted); font-variant-numeric: tabular-nums;
}
.chip__rename { display: inline-flex; padding: 1px; }
.chip__input {
  width: 11em; font-size: 12px; padding: 2px 6px; border-radius: var(--ui-radius); border: 0; outline: 1px solid var(--ui-primary);
  background: var(--ui-bg); color: var(--ui-text-highlighted);
}
.chip__more {
  display: inline-flex; align-items: center; padding: 0 5px; background: none; border: 0; color: var(--ui-text-dimmed); cursor: pointer;
  border-radius: var(--ui-radius);
}
.chip__more:hover { color: var(--ui-text-highlighted); }
/* Only the active plate shows its menu chevron (others on hover; right-click works on any). */
.chip:not(.chip--on):not(:hover) .chip__more { opacity: 0; }
@media (hover: none) { .chip:not(.chip--on) .chip__more { display: none; } }
</style>

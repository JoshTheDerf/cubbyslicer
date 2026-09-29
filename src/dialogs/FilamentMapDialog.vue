<script setup lang="ts">
/**
 * Orca FilamentMapDialog ("Filament grouping") for multi-nozzle printers
 * (e.g. Bambu H2D): Auto (Filament-saving = "Auto For Flush", Convenience =
 * "Auto For Match") or Custom, where filaments are dragged (or tapped) between
 * the left and right nozzle. Writes filament_map_mode / filament_map (1-based
 * extruder per filament) as project values.
 */
import { computed, ref, watch } from 'vue';
import { phone } from '../app/shell/uiState';
import { resolvedConfig } from '../app/state';
import { currentPresets } from '../presets/store';
import { asArray } from '../presets/values';
import { nozzleCount } from './gates';
import { dialogs } from './state';

type Mode = 'Auto For Flush' | 'Auto For Match' | 'Manual';
const mode = ref<Mode>('Auto For Flush');
const page = ref<'auto' | 'manual'>('auto');
const map = ref<number[]>([]);
const dragging = ref<number | null>(null);
const picked = ref<number | null>(null);

const p = computed(() => currentPresets.value);
const count = computed(() => p.value.selection.filaments.length);
const nozzles = computed(() => nozzleCount());
const colours = computed(() => p.value.selection.filaments.map((_, i) => p.value.filamentColour(i)));
const types = computed(() => p.value.selection.filaments.map((_, i) => asArray(p.value.value('filament', 'filament_type', i))[0] ?? ''));
const columns = computed(() => Array.from({ length: nozzles.value }, (_, k) => ({
  ext: k + 1,
  label: nozzles.value === 2 ? (k === 0 ? 'Left nozzle' : 'Right nozzle') : `Nozzle ${k + 1}`,
  items: map.value.map((e, i) => ({ i, e })).filter((x) => x.e === k + 1).map((x) => x.i),
})));

watch(() => dialogs.filamentMap, (o) => {
  if (!o) return;
  const cfg = resolvedConfig.value;
  const own = p.value.project.filament_map_mode ?? cfg.filament_map_mode;
  const m = (Array.isArray(own) ? own[0] : own) as string | undefined;
  mode.value = m === 'Manual' || m === 'Auto For Match' ? m : 'Auto For Flush';
  page.value = mode.value === 'Manual' ? 'manual' : 'auto';
  const cur = asArray(p.value.project.filament_map ?? cfg.filament_map).map((x) => parseInt(x, 10));
  map.value = Array.from({ length: count.value }, (_, i) => {
    const e = cur[i];
    return Number.isFinite(e) && e >= 1 && e <= nozzles.value ? e : (i % nozzles.value) + 1;
  });
  picked.value = null;
});

const pageItems = [{ value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Custom' }];
watch(page, (v) => { if (v === 'manual') mode.value = 'Manual'; else if (mode.value === 'Manual') mode.value = 'Auto For Flush'; });

function moveTo(i: number, ext: number): void {
  const next = map.value.slice();
  next[i] = ext;
  map.value = next;
}
function onDrop(ext: number): void { if (dragging.value !== null) moveTo(dragging.value, ext); dragging.value = null; }
/** Tap / keyboard: pick a filament, then tap a nozzle column (or tap it again to send it to the other nozzle). */
function onTap(i: number): void {
  if (nozzles.value === 2) { moveTo(i, map.value[i] === 1 ? 2 : 1); return; }
  picked.value = picked.value === i ? null : i;
}
function onColumn(ext: number): void { if (picked.value !== null) { moveTo(picked.value, ext); picked.value = null; } }

function apply(): void {
  const proj = p.value.project;
  proj.filament_map_mode = mode.value;
  if (mode.value === 'Manual') proj.filament_map = map.value.map(String);
  dialogs.filamentMap = false;
}
const textOn = (hex: string) => {
  const h = hex.replace('#', '');
  const v = parseInt(h.slice(0, 2), 16) * 0.299 + parseInt(h.slice(2, 4), 16) * 0.587 + parseInt(h.slice(4, 6), 16) * 0.114;
  return v > 150 ? '#111' : '#fff';
};
</script>

<template>
  <UModal v-model:open="dialogs.filamentMap" title="Filament grouping" :fullscreen="phone" :ui="{ content: 'sm:max-w-2xl', body: 'flex flex-col gap-4' }">
    <template #body>
      <UTabs v-model="page" :items="pageItems" :content="false" size="sm" class="w-60" />
      <template v-if="page === 'auto'">
        <div class="fm__modes">
          <button type="button" class="fm__mode" :class="{ on: mode === 'Auto For Flush' }" @click="mode = 'Auto For Flush'">
            <UIcon name="i-lucide-leaf" class="size-5 text-primary" />
            <strong>Filament-saving mode</strong>
            <span>Generates filament grouping for the left and right nozzles based on the most filament-saving principles to minimize waste.</span>
          </button>
          <button type="button" class="fm__mode" :class="{ on: mode === 'Auto For Match' }" @click="mode = 'Auto For Match'">
            <UIcon name="i-lucide-hand-helping" class="size-5 text-primary" />
            <strong>Convenience mode</strong>
            <span>Generates filament grouping based on the printer’s actual filament status, reducing the need for manual filament adjustment.</span>
          </button>
        </div>
        <p class="text-xs text-dimmed">The engine assigns the filaments to the nozzles when slicing.</p>
      </template>
      <template v-else>
        <p class="text-sm text-muted">We will slice according to this grouping method:</p>
        <div class="fm__cols" :style="{ gridTemplateColumns: `repeat(${Math.min(nozzles, phone ? 1 : 3)}, minmax(0, 1fr))` }">
          <section v-for="c in columns" :key="c.ext" class="fm__col" :class="{ 'fm__col--target': picked !== null }"
                   @dragover.prevent @drop.prevent="onDrop(c.ext)" @click="onColumn(c.ext)">
            <h4>{{ c.label }}</h4>
            <div class="fm__items">
              <button v-for="i in c.items" :key="i" type="button" class="fm__fil" :class="{ picked: picked === i }" draggable="true"
                      :style="{ background: colours[i], color: textOn(colours[i]) }" :title="`Filament ${i + 1}${types[i] ? ` (${types[i]})` : ''}`"
                      @dragstart="dragging = i" @dragend="dragging = null" @click.stop="onTap(i)">
                <span class="fm__no">{{ i + 1 }}</span><span class="fm__type">{{ types[i] }}</span>
              </button>
              <span v-if="!c.items.length" class="fm__empty">Drop filaments here</span>
            </div>
          </section>
        </div>
        <p class="text-xs text-dimmed">Tip: drag the filaments{{ nozzles === 2 ? ' (or tap them)' : '' }} to reassign them to a different nozzle.</p>
      </template>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" @click="dialogs.filamentMap = false" />
        <UButton color="primary" label="OK" @click="apply" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.fm__modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.fm__mode {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 12px; text-align: left; cursor: pointer;
  border: 1px solid var(--ui-border); border-radius: var(--ui-radius); background: var(--ui-bg-elevated); color: var(--ui-text-toned); font-size: 12px;
}
.fm__mode strong { color: var(--ui-text-highlighted); font-size: 13px; }
.fm__mode.on { border-color: var(--ui-primary); box-shadow: 0 0 0 1px var(--ui-primary) inset; }
.fm__cols { display: grid; gap: 10px; }
.fm__col { border: 1px dashed var(--ui-border-accented); border-radius: var(--ui-radius); padding: 8px; min-height: 120px; }
.fm__col--target { border-color: var(--ui-primary); }
.fm__col h4 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--ui-text-highlighted); }
.fm__items { display: flex; flex-wrap: wrap; gap: 6px; }
.fm__fil { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.25); cursor: grab; font-size: 12px; }
.fm__fil.picked { outline: 2px solid var(--ui-primary); outline-offset: 1px; }
.fm__no { font-weight: 700; }
.fm__type { opacity: 0.85; }
.fm__empty { color: var(--ui-text-dimmed); font-size: 12px; }
@media (max-width: 640px) { .fm__modes { grid-template-columns: 1fr; } }
</style>

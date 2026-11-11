<script setup lang="ts">
/**
 * Orca FilamentMapDialog ("Filament grouping") for multi-nozzle printers
 * (e.g. Bambu H2D): Auto (Filament-saving = "Auto For Flush", Convenience =
 * "Auto For Match") or Custom, where filaments are dragged (or tapped) between
 * the left and right nozzle. Writes filament_map_mode / filament_map (1-based
 * extruder per filament) as project values. On an extruder whose flow type is
 * Hybrid (H2C nozzle rack) each filament picks its own flow type
 * (`filament_volume_map`, NozzleVolumeType ids), which selects its profile values.
 */
import { computed, ref, watch } from 'vue';
import { mobileDialog } from '../ui/mobileDialog';
import AppDialog from '../ui/AppDialog.vue';
import { resolvedConfig } from '../app/state';
import { currentPresets } from '../presets/store';
import { contrastText } from '../lib/colour';
import { NOZZLE_VOLUME_TYPE_IDS, SCALAR, asList, nozzleVolumeTypeName, valueAt } from '../lib/configValue';
import { nozzleCount } from './gates';
import { dialogs } from './state';
import { manualMapProblem, nozzleCountDialog, setAllNozzleCounts, zoneTitle } from './nozzleCount';

type Mode = 'Auto For Flush' | 'Auto For Match' | 'Manual';
const mode = ref<Mode>('Auto For Flush');
const page = ref<'auto' | 'manual'>('auto');
const map = ref<number[]>([]);
/** Flow type per filament (names) for filaments on a Hybrid extruder. */
const volumes = ref<string[]>([]);
const dragging = ref<number | null>(null);
const picked = ref<number | null>(null);

const p = computed(() => currentPresets.value);
const count = computed(() => p.value.selection.filaments.length);
const nozzles = computed(() => nozzleCount());
const colours = computed(() => p.value.physicalColours());
const nozzleTypes = computed(() => p.value.nozzleVolumeTypes());
const extruderInfo = computed(() => p.value.extruders());
/** Flow types a filament on extruder `ext` (1-based) can pick, or [] when the extruder isn't Hybrid. */
const hybridChoices = (ext: number) => (nozzleTypes.value[ext - 1] === 'Hybrid' ? extruderInfo.value[ext - 1]?.volumeTypes ?? [] : []);
const types = computed(() => p.value.selection.filaments.map((_, i) => valueAt(p.value.value('filament', 'filament_type', i), SCALAR) ?? ''));
/** The project's nozzle racks (printers with extruder_max_nozzle_count > 1), else null. */
const stats = computed(() => p.value.nozzleStats());
const rackExtruders = computed(() => extruderInfo.value.map((e, i) => (e.multiNozzle ? i : -1)).filter((i) => i >= 0));
const columns = computed(() => Array.from({ length: nozzles.value }, (_, k) => ({
  ext: k + 1,
  label: zoneTitle(k, nozzles.value, stats.value, nozzleTypes.value[1] === 'Hybrid'),
  items: map.value.map((e, i) => ({ i, e })).filter((x) => x.e === k + 1).map((x) => x.i),
})));
/** FilamentMapManualPanel::check_sync: a used extruder without a nozzle of the filaments' flow type. */
const problem = computed(() => (page.value === 'manual' && stats.value
  ? manualMapProblem(map.value, map.value.map((e, i) => (hybridChoices(e).length ? volumes.value[i] : nozzleTypes.value[e - 1] ?? 'Standard')), nozzleTypes.value, stats.value)
  : null));
/** "Please adjust your grouping or click [edit] to set nozzle count": Orca closes the grouping and opens the count. */
async function fixCount(): Promise<void> {
  const e = problem.value?.extruder;
  dialogs.filamentMap = false;
  if (e !== undefined) await nozzleCountDialog.ask({ extruder: e });
}

watch(() => dialogs.filamentMap, (o) => {
  if (!o) return;
  const cfg = resolvedConfig.value;
  const own = p.value.project.filament_map_mode ?? cfg.filament_map_mode;
  const m = valueAt(own, SCALAR);
  // Nozzle Manual has no page of its own: desktop shows it as Custom (and OK there writes Manual).
  mode.value = m === 'Manual' || m === 'Nozzle Manual' ? 'Manual' : m === 'Auto For Match' ? m : 'Auto For Flush';
  page.value = mode.value === 'Manual' ? 'manual' : 'auto';
  const cur = asList(p.value.project.filament_map ?? cfg.filament_map).map((x) => parseInt(x, 10));
  map.value = Array.from({ length: count.value }, (_, i) => {
    const e = cur[i];
    return Number.isFinite(e) && e >= 1 && e <= nozzles.value ? e : (i % nozzles.value) + 1;
  });
  const vm = asList(p.value.project.filament_volume_map ?? cfg.filament_volume_map);
  volumes.value = Array.from({ length: count.value }, (_, i) => (vm[i] !== undefined ? nozzleVolumeTypeName(vm[i]) : 'Standard'));
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
  if (map.value.some((e) => hybridChoices(e).length)) {
    proj.filament_volume_map = volumes.value.map((v, i) => String(hybridChoices(map.value[i]).includes(v) ? NOZZLE_VOLUME_TYPE_IDS[v] : NOZZLE_VOLUME_TYPE_IDS.Standard));
  }
  dialogs.filamentMap = false;
}
</script>

<template>
  <AppDialog v-model:open="dialogs.filamentMap" title="Filament grouping" size="2xl" fullscreen body-class="flex flex-col gap-4"
             confirm-label="OK" :confirm-disabled="!!problem" test-id="filament-map" @confirm="apply">
      <UTabs v-model="page" :items="pageItems" :content="false" size="sm" class="w-60" />
      <template v-if="page === 'auto'">
        <div class="fm__modes">
          <button type="button" class="fm__mode" :class="{ on: mode === 'Auto For Flush' }" @click="mode = 'Auto For Flush'">
            <UIcon name="i-lucide-leaf" class="size-5 text-primary" />
            <strong>Filament-Saving Mode</strong>
            <span>Generates filament grouping for the left and right nozzles based on the most filament-saving principles to minimize waste.</span>
          </button>
          <button type="button" class="fm__mode" :class="{ on: mode === 'Auto For Match' }" @click="mode = 'Auto For Match'">
            <UIcon name="i-lucide-hand-helping" class="size-5 text-primary" />
            <strong>Convenience Mode</strong>
            <span>Generates filament grouping for the left and right nozzles based on the printer's actual filament status, reducing the need for manual filament adjustment.</span>
          </button>
        </div>
        <p class="text-xs text-dimmed">The engine assigns the filaments to the nozzles when slicing.</p>
      </template>
      <template v-else>
        <p class="text-sm text-muted">We will slice according to this grouping method:</p>
        <div class="fm__cols" :style="{ gridTemplateColumns: `repeat(${Math.min(nozzles, mobileDialog ? 1 : 3)}, minmax(0, 1fr))` }">
          <section v-for="c in columns" :key="c.ext" class="fm__col" :class="{ 'fm__col--target': picked !== null }"
                   @dragover.prevent @drop.prevent="onDrop(c.ext)" @click="onColumn(c.ext)">
            <h4>{{ c.label }}</h4>
            <div class="fm__items">
              <button v-for="i in c.items" :key="i" type="button" class="fm__fil" :class="{ picked: picked === i }" draggable="true"
                      :style="{ background: colours[i], color: contrastText(colours[i]) }" :title="`Filament ${i + 1}${types[i] ? ` (${types[i]})` : ''}`"
                      @dragstart="dragging = i" @dragend="dragging = null" @click.stop="onTap(i)">
                <span class="fm__no">{{ i + 1 }}</span><span class="fm__type">{{ types[i] }}</span>
              </button>
              <USelect v-for="i in c.items.filter(() => hybridChoices(c.ext).length)" :key="`v${i}`" v-model="volumes[i]" size="xs" class="w-full"
                       :items="hybridChoices(c.ext)" :aria-label="`Filament ${i + 1} nozzle flow`" @click.stop>
                <template #leading><span class="fm__no">{{ i + 1 }}</span></template>
              </USelect>
              <span v-if="!c.items.length" class="fm__empty">Drop filaments here</span>
            </div>
          </section>
        </div>
        <p class="text-xs text-dimmed">Tip: You can drag the filaments to reassign them to different nozzles.{{ nozzles === 2 ? ' Tapping one moves it to the other nozzle.' : '' }}</p>
        <template v-if="problem">
          <p class="fm__err" role="alert" data-testid="filament-map-error">{{ problem.message }}</p>
          <p class="fm__err">Please adjust your grouping or click
            <UButton size="xs" variant="ghost" color="error" icon="i-lucide-pencil" square aria-label="Set nozzle count" @click="fixCount" />
            to set nozzle count</p>
        </template>
        <button v-if="rackExtruders.length" type="button" class="fm__link" data-testid="set-nozzle-count" @click="setAllNozzleCounts(rackExtruders)">
          Set the physical nozzle count...
        </button>
      </template>
  </AppDialog>
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
.fm__err { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; font-size: 13px; color: var(--ui-error); }
.fm__link { align-self: flex-start; font-size: 14px; color: var(--ui-primary); cursor: pointer; }
.fm__link:hover { text-decoration: underline; }
@media (max-width: 640px) { .fm__modes { grid-template-columns: 1fr; } }
</style>

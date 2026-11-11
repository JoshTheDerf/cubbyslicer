<script setup lang="ts">
/**
 * Orca PreferencesDialog, the parts that make sense in a browser: units,
 * default engine and slicing threads, auto flush / auto arrange behaviour,
 * camera (zoom to mouse, reverse zoom, orbit speed / centre, swapped
 * buttons), keyboard hints and "Clear my choice on…" (remembered prompts and
 * layout). Everything is stored in this browser (localStorage) and applies at
 * once. A changed row gets a revert button, like a changed setting.
 */
import { computed, ref, watch } from 'vue';
import { mobileDialog } from '../ui/mobileDialog';
import { ENGINES } from '../engine/capabilities';
import { ENGINE_LABELS, engineThreadsAvailable, engineThreadsPref, setEngineThreadsPref } from '../engine/client';
import {
  DEFAULT_PREFERENCES, preferences, clearRememberedChoice, rememberedChoices, resetRememberedChoices, type Preferences,
} from '../app/preferences';
import { toast } from '../ui';
import { dialogs } from './state';

type Key = keyof Preferences;
interface Item { value: string | number; label: string }
type Row = { show?: () => boolean } & (
  | { key: Key; label: string; help: string; kind: 'select'; items: Item[] }
  | { key: Key; label: string; help: string; kind: 'switch' }
  | { key: Key; label: string; help: string; kind: 'slider'; min: number; max: number; step: number; fmt: (v: number) => string });

const engineItems: Item[] = [{ value: 'last', label: 'Last used' }, ...ENGINES.map((e) => ({ value: e, label: ENGINE_LABELS[e] }))];

const SECTIONS: Array<{ id: string; title: string; rows: Row[] }> = [
  { id: 'general', title: 'General', rows: [
    { key: 'units', label: 'Units', help: 'Lengths in the object manipulation panel.', kind: 'select',
      items: [{ value: 'metric', label: 'Metric (mm)' }, { value: 'imperial', label: 'Imperial (in)' }] },
    { key: 'keyboardHints', label: 'Show keyboard shortcuts', help: 'Shortcut hints in menus and tooltips.', kind: 'switch' },
  ] },
  { id: 'slicing', title: 'Slicing', rows: [
    { key: 'defaultEngine', label: 'Default engine', help: 'Slicing engine selected when the app starts.', kind: 'select', items: engineItems },
  ] },
  { id: 'behaviour', title: 'Behaviour', rows: [
    { key: 'autoArrangeImport', label: 'Auto arrange plate after import', help: 'Arrange the active plate whenever models are added.', kind: 'switch' },
    { key: 'autoFlush', label: 'Auto flush after changing…', help: 'Re-calculate flushing volumes when these change.', kind: 'select',
      items: [{ value: 'all', label: 'Filaments or colours' }, { value: 'color', label: 'Colours only' }, { value: 'off', label: 'Disabled' }] },
    { key: 'askPrimitiveSize', label: 'Show options when adding a primitive', help: 'Adding a box, cylinder, sphere or slab part asks for its size first.', kind: 'switch' },
    { key: 'designTab', label: 'CAD feature (experimental)', help: 'Show the Design tab, where models from OrcaSlicer 2.5’s Design tab can be edited parametrically. Still under development.', kind: 'switch' },
    // Orca shows it only while the CAD feature is on.
    { key: 'designConnectorFace', label: 'Draw mate connectors as a face', kind: 'switch', show: () => preferences.designTab,
      help: 'In the Design tab, draw a coordinate system (mate connector) as a small face instead of the conventional disc with a roll quadrant. A face shows its orientation at a glance. Turn this off for the conventional CAD representation.' },
  ] },
  { id: 'camera', title: 'Camera', rows: [
    { key: 'zoomToCursor', label: 'Zoom to mouse position', help: 'Zoom towards the pointer instead of the view centre.', kind: 'switch' },
    { key: 'reverseZoom', label: 'Reverse mouse zoom', help: 'Reverses the direction of zoom with the mouse wheel.', kind: 'switch' },
    { key: 'orbitAroundCursor', label: 'Orbit around the cursor', help: 'Rotate the view around the point under the mouse.', kind: 'switch' },
    { key: 'swapPanRotate', label: 'Swap pan and rotate buttons', help: 'Rotate with the middle button, pan with the right one (Prepare view).', kind: 'switch' },
    { key: 'orbitSpeed', label: 'Orbit speed multiplier', help: 'Finer or coarser camera rotation.', kind: 'slider', min: 0.1, max: 3, step: 0.1, fmt: (v) => `${v.toFixed(1)}×` },
  ] },
];

const fmtValue = (r: Row, v: unknown): string =>
  r.kind === 'switch' ? (v ? 'on' : 'off') : r.kind === 'slider' ? r.fmt(v as number) : r.items.find((i) => i.value === v)?.label ?? String(v);
const changed = (k: Key) => preferences[k] !== DEFAULT_PREFERENCES[k];
function set(k: Key, v: unknown): void { (preferences as Record<Key, unknown>)[k] = v; }
function revert(k: Key): void { set(k, DEFAULT_PREFERENCES[k]); }

// ---- slicing threads (its own localStorage key, read by the engine workers) -------------------
const mtAvailable = engineThreadsAvailable();
const cores = Math.max(1, navigator.hardwareConcurrency || 1);
const threads = ref(engineThreadsPref());
watch(threads, (n) => setEngineThreadsPref(n));
const threadItems = computed<Item[]>(() => {
  const out: Item[] = [{ value: 0, label: `Automatic (${Math.min(16, cores)})` }, { value: 1, label: 'Single-threaded' }];
  for (const n of [2, 4, 6, 8, 12, 16]) if (n < cores || n === threads.value) out.push({ value: n, label: `${n} threads` });
  return out;
});

const nChanged = computed(() => (Object.keys(DEFAULT_PREFERENCES) as Key[]).filter(changed).length + (threads.value ? 1 : 0));

// ---- remembered choices --------------------------------------------------------------------
const remembered = ref(rememberedChoices());
const nRemembered = computed(() => remembered.value.filter((r) => r.set).length);
watch(() => dialogs.preferences, (o) => { if (o) { remembered.value = rememberedChoices(); threads.value = engineThreadsPref(); } });
function clearOne(key: string): void { clearRememberedChoice(key); remembered.value = rememberedChoices(); }
function clearChoices(): void {
  const n = resetRememberedChoices();
  remembered.value = rememberedChoices();
  toast.info(n ? `Cleared ${n} remembered choice${n === 1 ? '' : 's'}.` : 'Nothing to clear.');
}

/** Reset everything to the defaults, with an Undo in the toast. */
function resetAll(): void {
  const before = { ...preferences }, beforeThreads = threads.value;
  Object.assign(preferences, DEFAULT_PREFERENCES);
  threads.value = 0;
  toast.info('Preferences reset to their defaults.', {
    action: { label: 'Undo', run: () => { Object.assign(preferences, before); threads.value = beforeThreads; } },
  });
}

/** Phones: one section at a time (tabs), so nothing scrolls. */
const tabs = [...SECTIONS.map((s) => ({ value: s.id, label: s.title })), { value: 'choices', label: 'Choices' }];
const section = ref('general');
const shown = (id: string) => !mobileDialog.value || section.value === id;
</script>

<template>
  <UModal v-model:open="dialogs.preferences" title="Preferences" :fullscreen="mobileDialog" :ui="{ content: 'sm:max-w-2xl', body: 'flex flex-col gap-5' }">
    <template #body>
      <UTabs v-if="mobileDialog" v-model="section" :items="tabs" :content="false" size="sm" class="w-full" />
      <section v-for="s in SECTIONS" v-show="shown(s.id)" :key="s.id" class="pf">
        <h4>{{ s.title }}</h4>
        <div v-for="r in s.rows.filter((x) => !x.show || x.show())" :key="r.key" class="pf__row">
          <div class="pf__lbl">
            <span>{{ r.label }}</span><small>{{ r.help }}</small>
          </div>
          <div class="pf__ctl">
            <UButton v-if="changed(r.key)" size="xs" variant="ghost" color="warning" icon="i-lucide-undo-2" square
                     :aria-label="`Revert ${r.label}`" :title="`Revert to the default (${fmtValue(r, DEFAULT_PREFERENCES[r.key])})`" @click="revert(r.key)" />
            <USelect v-if="r.kind === 'select'" :model-value="(preferences[r.key] as string)" @update:model-value="set(r.key, $event)" :items="r.items" value-key="value" size="sm"
                     class="w-44 phone:w-40" :aria-label="r.label" />
            <USwitch v-else-if="r.kind === 'switch'" :model-value="(preferences[r.key] as boolean)" @update:model-value="set(r.key, $event)" :aria-label="r.label" />
            <div v-else class="flex w-56 items-center gap-3 phone:w-40">
              <USlider :model-value="(preferences[r.key] as number)" @update:model-value="set(r.key, $event)" :min="r.min" :max="r.max" :step="r.step" class="flex-1" :aria-label="r.label" />
              <span class="w-9 text-right text-xs tabular-nums text-muted">{{ r.fmt(preferences[r.key] as number) }}</span>
            </div>
          </div>
        </div>
        <div v-if="s.id === 'slicing'" class="pf__row">
          <div class="pf__lbl">
            <span>Slicing threads</span>
            <small>{{ mtAvailable ? 'CPU threads the engine uses. Fewer keeps the page responsive while slicing.' : 'This page can’t run multi-threaded engines, so slicing uses one thread.' }}</small>
          </div>
          <div class="pf__ctl">
            <UButton v-if="threads" size="xs" variant="ghost" color="warning" icon="i-lucide-undo-2" square aria-label="Revert Slicing threads"
                     title="Revert to the default (Automatic)" @click="threads = 0" />
            <USelect v-model="threads" :items="threadItems" value-key="value" size="sm" class="w-44 phone:w-40" :disabled="!mtAvailable" aria-label="Slicing threads" />
          </div>
        </div>
      </section>

      <section v-show="shown('choices')" class="pf">
        <h4>Clear my choice on…</h4>
        <p class="pf__note">What the app remembers between visits. Clear one to get its prompt or its default layout back (layout after a reload).</p>
        <div v-for="r in remembered" :key="r.key" class="pf__row pf__row--tight" :class="{ off: !r.set }">
          <span class="pf__choice">{{ r.label }}</span>
          <UButton v-if="r.set" size="xs" variant="outline" color="neutral" label="Clear" :aria-label="`Clear: ${r.label}`" @click="clearOne(r.key)" />
          <span v-else class="pf__unset">not set</span>
        </div>
        <div>
          <UButton size="sm" variant="outline" icon="i-lucide-eraser" label="Clear all" :disabled="!nRemembered" @click="clearChoices" />
        </div>
      </section>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton size="sm" variant="ghost" color="neutral" icon="i-lucide-rotate-ccw" :label="mobileDialog ? 'Reset all' : 'Reset all to defaults'"
                 :disabled="!nChanged" :title="nChanged ? `${nChanged} preference${nChanged === 1 ? '' : 's'} changed` : 'Everything is at its default'" @click="resetAll" />
        <div class="flex items-center gap-3">
          <span class="text-xs text-dimmed phone:hidden">Saved in this browser.</span>
          <UButton color="primary" label="Done" @click="dialogs.preferences = false" />
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.pf { display: flex; flex-direction: column; gap: 10px; }
.pf h4 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ui-text-highlighted); border-bottom: 1px solid var(--ui-border); padding-bottom: 4px; }
.pf__row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.pf__row--tight { gap: 12px; min-height: 26px; }
.pf__lbl { display: flex; flex-direction: column; min-width: 0; font-size: 13px; color: var(--ui-text); }
.pf__lbl small { color: var(--ui-text-dimmed); font-size: 11px; }
/* The revert button sits left of the control without moving it. */
.pf__ctl { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.pf__note { margin: 0; font-size: 11px; color: var(--ui-text-dimmed); }
.pf__choice { min-width: 0; font-size: 12px; color: var(--ui-text-toned); }
.pf__row.off .pf__choice { color: var(--ui-text-dimmed); }
.pf__unset { flex-shrink: 0; font-size: 11px; color: var(--ui-text-dimmed); }
@media (max-width: 640px), (max-height: 500px) {
  .pf h4 { display: none; }
  .pf__row { gap: 12px; }
}
/* Landscape phones: rows side by side. */
@media (max-height: 500px) and (min-width: 560px) {
  .pf:not(:last-child) { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; }
}
</style>

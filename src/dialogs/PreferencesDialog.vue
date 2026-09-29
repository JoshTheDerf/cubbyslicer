<script setup lang="ts">
/**
 * Orca PreferencesDialog, the parts that make sense in a browser: units,
 * default engine, auto flush / auto arrange behaviour, camera (zoom to
 * mouse, reverse zoom, orbit speed / centre, swapped buttons), keyboard
 * hints and "Clear my choice on…" (remembered prompts and layout).
 * Everything is stored in this browser (localStorage) and applies at once.
 */
import { ref, watch } from 'vue';
import { phone } from '../app/shell/uiState';
import { ENGINE_LABELS } from '../engine/client';
import { preferences, rememberedChoices, resetPreferences, resetRememberedChoices } from '../app/preferences';
import { toast } from '../ui';
import { dialogs } from './state';

const remembered = ref(rememberedChoices());
watch(() => dialogs.preferences, (o) => { if (o) remembered.value = rememberedChoices(); });

const unitItems = [{ value: 'metric', label: 'Metric (mm)' }, { value: 'imperial', label: 'Imperial (in)' }];
const engineItems = [
  { value: 'last', label: 'Last used' },
  { value: 'orca', label: ENGINE_LABELS.orca },
  { value: 'preflight', label: ENGINE_LABELS.preflight },
  { value: 'fullspectrum', label: ENGINE_LABELS.fullspectrum },
];
const flushItems = [
  { value: 'all', label: 'Filaments or colours' },
  { value: 'color', label: 'Colours only' },
  { value: 'off', label: 'Disabled' },
];

function clearChoices(): void {
  const n = resetRememberedChoices();
  remembered.value = rememberedChoices();
  toast.info(n ? `Cleared ${n} remembered choice${n === 1 ? '' : 's'}. Layout changes apply after a reload.` : 'Nothing to clear.');
}
function resetAll(): void { resetPreferences(); toast.info('Preferences reset to their defaults.'); }
</script>

<template>
  <UModal v-model:open="dialogs.preferences" title="Preferences" :fullscreen="phone" :ui="{ content: 'sm:max-w-2xl', body: 'flex flex-col gap-5' }">
    <template #body>
      <section class="pf">
        <h4>General</h4>
        <div class="pf__row">
          <div class="pf__lbl"><span>Units</span><small>Lengths in the object manipulation panel.</small></div>
          <USelect v-model="preferences.units" :items="unitItems" value-key="value" size="sm" class="w-44" />
        </div>
        <div class="pf__row">
          <div class="pf__lbl"><span>Default engine</span><small>Slicing engine selected when the app starts.</small></div>
          <USelect v-model="preferences.defaultEngine" :items="engineItems" value-key="value" size="sm" class="w-44" />
        </div>
        <div class="pf__row">
          <div class="pf__lbl"><span>Show keyboard shortcuts</span><small>Shortcut hints in menus and tooltips.</small></div>
          <USwitch v-model="preferences.keyboardHints" />
        </div>
      </section>

      <section class="pf">
        <h4>Behaviour</h4>
        <div class="pf__row">
          <div class="pf__lbl"><span>Auto flush after changing…</span><small>Re-calculate flushing volumes when these change.</small></div>
          <USelect v-model="preferences.autoFlush" :items="flushItems" value-key="value" size="sm" class="w-44" />
        </div>
        <div class="pf__row">
          <div class="pf__lbl"><span>Auto arrange plate after import</span><small>Arrange the active plate whenever models are added.</small></div>
          <USwitch v-model="preferences.autoArrangeImport" />
        </div>
      </section>

      <section class="pf">
        <h4>Camera</h4>
        <div class="pf__row">
          <div class="pf__lbl"><span>Zoom to mouse position</span><small>Zoom towards the pointer instead of the view centre.</small></div>
          <USwitch v-model="preferences.zoomToCursor" />
        </div>
        <div class="pf__row">
          <div class="pf__lbl"><span>Reverse mouse zoom</span><small>Reverses the direction of zoom with the mouse wheel.</small></div>
          <USwitch v-model="preferences.reverseZoom" />
        </div>
        <div class="pf__row">
          <div class="pf__lbl"><span>Orbit around the cursor</span><small>Rotate the view around the point under the mouse.</small></div>
          <USwitch v-model="preferences.orbitAroundCursor" />
        </div>
        <div class="pf__row">
          <div class="pf__lbl"><span>Swap pan and rotate buttons</span><small>Rotate with the middle button, pan with the right one (Prepare view).</small></div>
          <USwitch v-model="preferences.swapPanRotate" />
        </div>
        <div class="pf__row">
          <div class="pf__lbl"><span>Orbit speed multiplier</span><small>Finer or coarser camera rotation.</small></div>
          <div class="flex w-56 items-center gap-3">
            <USlider v-model="preferences.orbitSpeed" :min="0.1" :max="3" :step="0.1" class="flex-1" />
            <span class="w-9 text-right text-xs tabular-nums text-muted">{{ preferences.orbitSpeed.toFixed(1) }}×</span>
          </div>
        </div>
      </section>

      <section class="pf">
        <h4>Clear my choice on…</h4>
        <ul class="pf__list">
          <li v-for="r in remembered" :key="r.key" :class="{ off: !r.set }">{{ r.label }}<small v-if="!r.set"> (not set)</small></li>
        </ul>
        <div class="flex gap-2">
          <UButton size="sm" variant="outline" icon="i-lucide-eraser" label="Clear remembered choices" @click="clearChoices" />
          <UButton size="sm" variant="ghost" color="neutral" icon="i-lucide-rotate-ccw" label="Reset preferences" @click="resetAll" />
        </div>
      </section>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <span class="text-xs text-dimmed">Saved in this browser.</span>
        <UButton color="primary" label="Done" @click="dialogs.preferences = false" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.pf { display: flex; flex-direction: column; gap: 10px; }
.pf h4 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ui-text-highlighted); border-bottom: 1px solid var(--ui-border); padding-bottom: 4px; }
.pf__row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.pf__lbl { display: flex; flex-direction: column; min-width: 0; font-size: 13px; color: var(--ui-text); }
.pf__lbl small { color: var(--ui-text-dimmed); font-size: 11px; }
.pf__list { margin: 0; padding-left: 18px; list-style: disc; font-size: 12px; color: var(--ui-text-toned); }
.pf__list li.off { color: var(--ui-text-dimmed); }
</style>

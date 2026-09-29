<script setup lang="ts">
/**
 * Mounts the Orca tool dialogs (calibration, flushing volumes, filament
 * grouping, object table, create printer / filament, export preset bundle,
 * bed shape, preferences) and applies the app-wide preferences. Mounted once
 * from App.vue.
 */
import { onBeforeUnmount, watch } from 'vue';
import { preferences } from '../app/preferences';
import { activeEngine } from '../app/state';
import { setActiveEngine } from '../presets/store';
import CalibrationDialogs from '../calibration/CalibrationDialogs.vue';
import FlushingVolumesDialog from './flush/FlushingVolumesDialog.vue';
import FilamentMapDialog from './FilamentMapDialog.vue';
import ObjectTableDialog from './ObjectTableDialog.vue';
import CreatePresetDialog from './presets/CreatePresetDialog.vue';
import ExportBundleDialog from './presets/ExportBundleDialog.vue';
import BedShapeDialog from './bed/BedShapeDialog.vue';
import PreferencesDialog from './PreferencesDialog.vue';
import { installAutoFlush } from './flush/flushStore';

// Preferences → Default engine (once per page load).
if (preferences.defaultEngine !== 'last' && activeEngine.value !== preferences.defaultEngine) setActiveEngine(preferences.defaultEngine);

// Preferences → Show keyboard shortcuts: hides every <kbd> chip (menus, tooltips, palette).
const stopKbd = watch(() => preferences.keyboardHints, (on) => {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('cubby-no-kbd', !on);
}, { immediate: true });

// Preferences → Auto flush after changing…
const stopFlush = installAutoFlush();
onBeforeUnmount(() => { stopKbd(); stopFlush(); });
</script>

<template>
  <CalibrationDialogs />
  <FlushingVolumesDialog />
  <FilamentMapDialog />
  <ObjectTableDialog />
  <CreatePresetDialog kind="printer" />
  <CreatePresetDialog kind="filament" />
  <ExportBundleDialog />
  <BedShapeDialog />
  <PreferencesDialog />
</template>

<style>
.cubby-no-kbd kbd, .cubby-no-kbd [data-slot='kbds'] { display: none !important; }
</style>

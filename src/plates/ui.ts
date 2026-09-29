/** Plate settings dialog state (not persisted). */
import { reactive } from 'vue';

export const plateUi = reactive({
  /** Plate whose settings dialog is open (Orca PlateSettingsDialog), or null. */
  settingsFor: null as number | null,
});

export function openPlateSettings(i: number): void { plateUi.settingsFor = i; }

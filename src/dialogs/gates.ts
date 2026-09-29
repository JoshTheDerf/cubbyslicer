/** Cheap availability checks for the tool dialogs (action `when`s, sidebar buttons). */
import { activeEngine } from '../app/state';
import { currentPresets } from '../presets/store';
import { asArray } from '../presets/values';
import { isOrcaFamily } from '../engine/types';

export function filamentCount(): number {
  return currentPresets.value.selection.filaments.length;
}

/** Physical nozzle / extruder count of the selected printer. */
export function nozzleCount(): number {
  return Math.max(1, asArray(currentPresets.value.value('printer', 'nozzle_diameter')).length);
}

/**
 * Orca shows filament grouping for printers with more than one extruder /
 * nozzle (e.g. Bambu H2D, where every nozzle is fed by its own AMS).
 * Orca engine only (filament_map is an Orca option).
 */
export function isMultiNozzle(): boolean {
  if (!isOrcaFamily(activeEngine.value)) return false;
  if (!currentPresets.value.schema.value?.options.filament_map) return false;
  return nozzleCount() > 1;
}

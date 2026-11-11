/**
 * Presets store — one independent state per engine (catalog, selection,
 * unsaved overrides, user presets, project values). The active engine's
 * resolved config is written to `resolvedConfig` (debounced, only when it
 * actually changed).
 *
 * This file is the public import path; the modules behind it:
 *   enginePresets   the per-engine state class and refresh pipeline
 *   registry        per-engine registry, active engine, resolvedConfig, project section
 *   persistence     localStorage, cross-tab sync, snapshots
 *   schemaLoad      schema loading, guarded condition evaluator
 *   filamentSlots   physical / mixed slots, colours, nozzle flow types, purge mode
 *   filamentRefs    renumbering filament references on slot removal / insertion
 *   variantEdit     per-variant editing (extruder / nozzle flow switch)
 *   userPresetOps   save / export / import of user presets
 */
export { ENGINES } from '../engine/capabilities';
export { EnginePresets, defaultInfo, type EnginePresetsOptions, type Overrides, type Selection, type TabBases, type TabInfos } from './enginePresets';
export {
  currentPresets, presetsFor, _setEnginePresets, setActiveEngine, startPresets, presetsSettled, presetsAutosaveData, presetsProjectSection,
  type PresetsProjectData,
} from './registry';
export { presetsRevision, type PersistedEngineState } from './persistence';
export { loadSchema, type SchemaSource } from './schemaLoad';
export { FILAMENT_PALETTE } from './filamentSlots';
export { variantEdit, type VariantTag } from './variantEdit';
export type { ImportReport } from './userPresetOps';

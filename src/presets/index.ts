/**
 * Presets public API (shell / slice orchestrator).
 *
 *   startPresets()           begin writing activeEngine/resolvedConfig (idempotent; SettingsPanel calls it too)
 *   setActiveEngine(e)       switch engine (each engine keeps its own selection / overrides)
 *   currentPresets           computed EnginePresets of the active engine
 *   presetsFor(e)            per-engine state
 *   presetsProjectSection    { save, load } for the project file section "presets"
 */
export {
  startPresets, setActiveEngine, currentPresets, presetsFor, presetsProjectSection, loadSchema,
  EnginePresets, ENGINES, defaultInfo,
  type Selection, type Overrides, type PersistedEngineState, type PresetsProjectData, type ImportReport, type SchemaSource,
} from './store';
export { resolveConfig, schemaDefaults, shapeValues, tabOfScope, type ResolveInput } from './resolve';
export { filterCompatible, type CompatContext, type ConditionEvaluator } from './compat';
export { OrcaCatalog, ORCA_FILAMENT_LIBRARY } from './orca/catalog';
export { PreflightCatalog } from './preflight/catalog';
export { UserPresetStore, toOrcaJson, PresetNameError, type UserPreset } from './userPresets';
export * from './types';

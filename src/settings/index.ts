/** Settings public API. */
export { default as SettingsPanel } from './SettingsPanel.vue';
export { default as ObjectSettingsPanel } from './ObjectSettingsPanel.vue';
export { getConfigProblems, configProblems, validateConfig, validateValue, type ConfigProblem } from './validate';
export { buildLayout, locateKeys, HIDDEN_KEYS } from './layout/build';
export { registerPresetsSection } from './projectAdapter';
export { settingsActions, registerSettingsActions, type SettingsAction } from './actions';
export { settingsUi, openSettingsTab, type SettingsRegion } from './uiState';
export { jumpToSetting } from './useLayout';

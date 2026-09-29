/** Settings layout tables (pages → option groups → option keys), mirroring each engine's GUI Tab.cpp. */
import type { PresetKind } from '../../presets/types';

export interface LayoutGroupSource { title: string; keys: string[] }
export interface LayoutPageSource {
  title: string;
  /** Page is repeated per extruder (vector options indexed by extruder). */
  extruder: boolean;
  groups: LayoutGroupSource[];
}
/** Engine layout keyed by Orca/Prusa preset scope. */
export interface EngineLayoutSource {
  print: LayoutPageSource[];
  filament: LayoutPageSource[];
  machine: LayoutPageSource[];
}

export type SettingsTabId = 'process' | 'filament' | 'printer';
export const TAB_KIND: Record<SettingsTabId, PresetKind> = { process: 'process', filament: 'filament', printer: 'printer' };

export interface BuiltGroup {
  id: string;
  title: string;
  keys: string[];
  /** Auto-generated group for keys missing from the hand layout. */
  auto?: boolean;
}

export interface BuiltPage {
  id: string;
  title: string;
  groups: BuiltGroup[];
  /** Extruder index for per-extruder pages. */
  extruder?: number;
}

export interface BuiltTab {
  id: SettingsTabId;
  kind: PresetKind;
  title: string;
  pages: BuiltPage[];
}

export type BuiltLayout = Record<SettingsTabId, BuiltTab>;

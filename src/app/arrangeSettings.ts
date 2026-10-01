/**
 * Orca's arrange options (GLCanvas3D::ArrangeSettings, the popup on the
 * Arrange toolbar button), persisted in this browser like Orca's app config
 * "arrange" section: spacing and auto rotation are kept separately for
 * by-layer and by-object printing (min_object_distance_fff /
 * _fff_seq_print, enable_rotation_fff / _seq_print), the other options are
 * shared. Spacing 0 means auto (each object keeps its brim / support margin).
 */
import { reactive, watch } from 'vue';

export interface ArrangeSetSettings { distance: number; enableRotation: boolean }

export interface ArrangeSettingsState {
  fff: ArrangeSetSettings;
  seqPrint: ArrangeSetSettings;
  allowMultiMaterials: boolean;
  avoidCaliRegion: boolean;
  alignToYAxis: boolean;
}

/** Orca's spacing slider range (mm); the number field allows more. */
export const ARRANGE_SPACING_MAX = 100;

export const DEFAULT_ARRANGE_SETTINGS: ArrangeSettingsState = {
  fff: { distance: 0, enableRotation: false },
  seqPrint: { distance: 0, enableRotation: false },
  allowMultiMaterials: true,
  avoidCaliRegion: true,
  alignToYAxis: false,
};

const LS_KEY = 'cubby-slicer:arrange';

function sanitizeSet(raw: unknown): ArrangeSetSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    distance: typeof r.distance === 'number' && Number.isFinite(r.distance) ? Math.max(0, r.distance) : 0,
    enableRotation: r.enableRotation === true,
  };
}

export function sanitizeArrangeSettings(raw: unknown): ArrangeSettingsState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    fff: sanitizeSet(r.fff),
    seqPrint: sanitizeSet(r.seqPrint),
    allowMultiMaterials: typeof r.allowMultiMaterials === 'boolean' ? r.allowMultiMaterials : true,
    avoidCaliRegion: typeof r.avoidCaliRegion === 'boolean' ? r.avoidCaliRegion : true,
    alignToYAxis: r.alignToYAxis === true,
  };
}

function load(): ArrangeSettingsState {
  try { return sanitizeArrangeSettings(JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')); } catch { return sanitizeArrangeSettings(null); }
}

export const arrangeSettings = reactive<ArrangeSettingsState>(load());
watch(arrangeSettings, (s) => { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* private mode */ } }, { deep: true });

/** The set in use: Orca picks the "seq print" one when the global print sequence is by object. */
export function activeArrangeSet(seqPrint: boolean): ArrangeSetSettings {
  return seqPrint ? arrangeSettings.seqPrint : arrangeSettings.fff;
}

/** Orca's Reset button: defaults for the active set; Align to Y axis on for i3 (bed-slinger) printers. */
export function resetArrangeSettings(seqPrint: boolean, i3: boolean): void {
  Object.assign(activeArrangeSet(seqPrint), { distance: 0, enableRotation: false });
  arrangeSettings.allowMultiMaterials = true;
  arrangeSettings.avoidCaliRegion = true;
  arrangeSettings.alignToYAxis = i3;
}

/**
 * One arrange run's overrides of the saved options (links, the MCP bridge).
 * `ids`: the selection for mode "selection". `imported`: objects just added;
 * any of them on no plate (imports that didn't fit are put beside it) count
 * as on the active plate, where Orca puts new objects.
 */
export interface ArrangeRunOptions { distance?: number; enableRotation?: boolean; ids?: readonly string[]; imported?: readonly string[] }

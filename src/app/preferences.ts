/**
 * App preferences (the browser-relevant parts of OrcaSlicer's Preferences
 * dialog, Preferences.cpp), persisted in localStorage. Each preference is
 * wired to real behaviour by its consumer; see PreferencesDialog.vue.
 */
import { reactive, watch } from 'vue';
import { hasKey, readJson, removeKey, writeJson } from '../lib/storage';
import { toEngineId } from '../engine/capabilities';
import type { EngineId } from '../engine/types';

export type Units = 'metric' | 'imperial';
export type AutoFlush = 'all' | 'color' | 'off';

export interface Preferences {
  /** Orca "Units" (use_inches): lengths in the object manipulation panel. */
  units: Units;
  /** Engine selected on startup ('last' = keep the last used one). */
  defaultEngine: EngineId | 'last';
  /** Orca "Zoom to mouse position". */
  zoomToCursor: boolean;
  /** Orca "Reverse mouse zoom". */
  reverseZoom: boolean;
  /** Orbit around the point under the cursor instead of the view centre. */
  orbitAroundCursor: boolean;
  /** Orca "Orbit speed multiplier". */
  orbitSpeed: number;
  /** Swap the pan and rotate mouse buttons (Orca's mouse drag actions). */
  swapPanRotate: boolean;
  /** Arrange the plate after importing models. */
  autoArrangeImport: boolean;
  /** Orca "Auto flush after changing…" (auto_calculate_flush). */
  autoFlush: AutoFlush;
  /** Show keyboard shortcut chips in menus and tooltips. */
  keyboardHints: boolean;
  /** Orca 2.5 "Show options when adding a primitive": adding a box / cylinder / sphere / slab part asks for its size. */
  askPrimitiveSize: boolean;
  /** Orca 2.5 "CAD feature (experimental)": show the Design tab (no restart needed here). */
  designTab: boolean;
  /** Orca 2.5 design_commit_mode: Commit to Plate makes one assembly object (a part per body) or one object per body. */
  designCommitMode: 'assembly' | 'bodies';
}

export const DEFAULT_PREFERENCES: Preferences = {
  units: 'metric',
  defaultEngine: 'last',
  zoomToCursor: true,
  reverseZoom: false,
  orbitAroundCursor: false,
  orbitSpeed: 1,
  swapPanRotate: false,
  autoArrangeImport: false,
  autoFlush: 'all',
  keyboardHints: true,
  askPrimitiveSize: true,
  designTab: true,
  designCommitMode: 'assembly',
};

const LS_KEY = 'cubby-slicer:preferences';

export function sanitizePreferences(raw: unknown): Preferences {
  const out: Preferences = { ...DEFAULT_PREFERENCES };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.units === 'metric' || r.units === 'imperial') out.units = r.units;
  // An engine this build doesn't have maps to the default engine.
  if (r.defaultEngine === 'last') out.defaultEngine = 'last';
  else { const e = toEngineId(r.defaultEngine); if (e) out.defaultEngine = e; }
  for (const k of ['zoomToCursor', 'reverseZoom', 'orbitAroundCursor', 'swapPanRotate', 'autoArrangeImport', 'keyboardHints', 'askPrimitiveSize', 'designTab'] as const) {
    if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  }
  if (typeof r.orbitSpeed === 'number' && Number.isFinite(r.orbitSpeed)) out.orbitSpeed = Math.min(5, Math.max(0.1, r.orbitSpeed));
  if (r.designCommitMode === 'assembly' || r.designCommitMode === 'bodies') out.designCommitMode = r.designCommitMode;
  if (r.autoFlush === 'all' || r.autoFlush === 'color' || r.autoFlush === 'off') out.autoFlush = r.autoFlush;
  return out;
}

/** Where the primitive size dialog kept its "don't ask" choice before it became a preference. */
const OLD_PRIMITIVE_KEY = 'cubby-slicer:primitive-options';

function load(): Preferences {
  const raw = readJson<Record<string, unknown>>(LS_KEY);
  const out = sanitizePreferences(raw);
  if (typeof raw?.askPrimitiveSize !== 'boolean' && readJson<{ ask?: unknown }>(OLD_PRIMITIVE_KEY)?.ask === false) out.askPrimitiveSize = false;
  return out;
}

export const preferences = reactive<Preferences>(load());
watch(preferences, (p) => { writeJson(LS_KEY, p); }, { deep: true });

export function resetPreferences(): void { Object.assign(preferences, DEFAULT_PREFERENCES); }

// ---- units ----------------------------------------------------------------------------

export const MM_PER_INCH = 25.4;
/** mm → display units. */
export function toDisplayLength(mm: number): number { return preferences.units === 'imperial' ? mm / MM_PER_INCH : mm; }
/** display units → mm. */
export function fromDisplayLength(v: number): number { return preferences.units === 'imperial' ? v * MM_PER_INCH : v; }
export function lengthUnit(): string { return preferences.units === 'imperial' ? 'in' : 'mm'; }

// ---- "Don't show again" choices (Orca "Clear my choice on…") ------------------------------------

/** localStorage keys holding remembered choices / dismissed prompts, reset by "Reset dialogs". */
const REMEMBERED_KEYS: Array<{ key: string; label: string }> = [
  { key: 'cubby.setup.done', label: 'First-run printer & filament setup (shows again on next start)' },
  { key: 'cubby-slicer:recent-actions', label: 'Recently used commands in the command palette' },
  { key: 'cubby-slicer:layout', label: 'Sidebar width and visibility' },
  { key: 'cubby-slicer:transform-collapsed', label: 'Object manipulation panel collapsed state' },
  { key: 'cubby.settings.collapsed', label: 'Folded sidebar sections and setting groups' },
  { key: 'cubby-slicer:legend-folds', label: 'Folded Preview legend sections' },
];
export function registerRememberedChoice(key: string, label: string): void {
  if (!REMEMBERED_KEYS.some((k) => k.key === key)) REMEMBERED_KEYS.push({ key, label });
}
export function rememberedChoices(): Array<{ key: string; label: string; set: boolean }> {
  return REMEMBERED_KEYS.map((k) => {
    return { ...k, set: hasKey(k.key) };
  });
}
export function clearRememberedChoice(key: string): void {
  removeKey(key);
}
export function resetRememberedChoices(): number {
  let n = 0;
  for (const k of REMEMBERED_KEYS) {
    if (removeKey(k.key)) n++;
  }
  return n;
}

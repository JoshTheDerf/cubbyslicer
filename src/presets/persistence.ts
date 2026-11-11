/**
 * Persisting an engine's preset state: localStorage (last-used state a new
 * tab starts from, shared installed-printer list, cross-tab sync) and the
 * snapshot that autosaves and project files carry.
 */
import { ref, toRaw, watch } from 'vue';
import type { EngineId } from '../engine/types';
import { readJson, writeJson } from '../lib/storage';
import { DEFAULT_PRESET_ID, type PresetValues } from './types';
import type { EnginePresets, Overrides, Selection } from './enginePresets';

/** Persisted per-engine UI state (localStorage + project section). */
export interface PersistedEngineState {
  selection: Selection;
  overrides: Overrides;
  installedPrinters: string[];
  /** Project-level values outside the presets (plate type, filament colours, nozzle flow types, Orca's mixed filament vectors). */
  project?: PresetValues;
}

export const LS_KEY = (e: EngineId) => `cubby.presets.v1.${e}`;
export const LS_ENGINE = 'cubby.presets.v1.activeEngine';

/**
 * Bumped (debounced) whenever any engine's selection / overrides / project
 * values change, so this tab's autosave slot picks them up. localStorage only
 * holds the last-used state, which a brand-new tab starts from.
 */
export const presetsRevision = ref(0);

export function readSaved(engine: EngineId): PersistedEngineState | null {
  return readJson<PersistedEngineState>(LS_KEY(engine));
}

export function snapshot(s: EnginePresets): PersistedEngineState {
  const sel = toRaw(s.selection), ov = toRaw(s.overrides);
  return JSON.parse(JSON.stringify({ selection: sel, overrides: ov, installedPrinters: s.installedPrinters.value, project: toRaw(s.project) }));
}

export function applyPersisted(s: EnginePresets, p: Partial<PersistedEngineState>): void {
  if (p.selection) {
    s.selection.printer = p.selection.printer || DEFAULT_PRESET_ID;
    s.selection.process = p.selection.process || DEFAULT_PRESET_ID;
    s.selection.filaments = Array.isArray(p.selection.filaments) && p.selection.filaments.length ? p.selection.filaments.slice() : [DEFAULT_PRESET_ID];
  }
  if (p.overrides) {
    s.overrides.printer = { ...(p.overrides.printer ?? {}) };
    s.overrides.process = { ...(p.overrides.process ?? {}) };
    s.overrides.filaments = (p.overrides.filaments ?? [{}]).map((f) => ({ ...(f ?? {}) }));
  }
  if (Array.isArray(p.installedPrinters)) s.installedPrinters.value = p.installedPrinters.filter((x) => typeof x === 'string');
  if (p.project && typeof p.project === 'object') {
    for (const k of Object.keys(s.project)) delete s.project[k];
    Object.assign(s.project, JSON.parse(JSON.stringify(p.project)));
  }
}

/** Write the state to localStorage (debounced) whenever it changes, and follow other tabs. */
export function persistChanges(s: EnginePresets): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(() => [s.selection, s.overrides, s.installedPrinters.value, s.project], () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; writeJson(LS_KEY(s.engine), snapshot(s)); presetsRevision.value++; }, 300);
  }, { deep: true });
  followOtherTabs(s);
}

/**
 * The printer list and user presets are shared by every tab; the selection
 * and unsaved edits are per tab. Another tab installing a printer (via the
 * localStorage `storage` event) or saving a user preset updates this tab.
 */
function followOtherTabs(s: EnginePresets): void {
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key !== LS_KEY(s.engine) || !e.newValue) return;
      let theirs: unknown;
      try { theirs = (JSON.parse(e.newValue) as Partial<PersistedEngineState>).installedPrinters; } catch { return; }
      if (!Array.isArray(theirs)) return;
      const next = theirs.filter((x): x is string => typeof x === 'string');
      // Keep this tab's selected system printer listed even if the other tab removed it.
      const sel = s.selection.printer;
      if (sel.startsWith('sys:') && !next.includes(sel)) next.push(sel);
      const cur = s.installedPrinters.value;
      if (next.length === cur.length && next.every((x, i) => x === cur[i])) return;
      s.installedPrinters.value = next;
      void s.refreshPrinterList();
    });
  }
  s.users.onExternalChange(async () => {
    await s.refreshPrinterList();
    await s.refresh({ keepSelection: true });
  });
}

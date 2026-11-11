/**
 * The per-engine preset states, the active engine, writing `resolvedConfig`
 * and the project / autosave section.
 *
 * Owns: `activeEngine`, `resolvedConfig` (src/app/state.ts).
 */
import { computed, watch } from 'vue';
import { activeEngine, markSliceInputsChanged, resolvedConfig } from '../app/state';
import { ENGINES, toEngineId } from '../engine/capabilities';
import type { EngineId, FlatConfig } from '../engine/types';
import { readJson, writeJson } from '../lib/storage';
import { EnginePresets } from './enginePresets';
import { LS_ENGINE, type PersistedEngineState } from './persistence';
import { configsEqual } from './values';

const engines = new Map<EngineId, EnginePresets>();

/** Per-engine preset state (created lazily). */
export function presetsFor(engine: EngineId): EnginePresets {
  let s = engines.get(engine);
  if (!s) { s = new EnginePresets(engine); engines.set(engine, s); }
  return s;
}

/** Test hook: install a pre-built engine state. */
export function _setEnginePresets(engine: EngineId, s: EnginePresets | null): void {
  if (s) engines.set(engine, s); else engines.delete(engine);
}

/** Currently active engine's preset state. */
export const currentPresets = computed(() => presetsFor(activeEngine.value));

export function setActiveEngine(engine: EngineId): void {
  if (activeEngine.value === engine) return;
  activeEngine.value = engine;
  writeJson(LS_ENGINE, engine);
}

let started = false;
let flushNow: (() => void) | null = null;

/**
 * Start writing `resolvedConfig` for the active engine. Idempotent; called by
 * the settings panel on mount and safe to call from the shell at startup.
 */
export function startPresets(): void {
  if (started) return;
  started = true;
  // An engine this build doesn't have falls back to the default one; its saved state is left alone.
  const saved = toEngineId(readJson<string>(LS_ENGINE));
  if (saved) activeEngine.value = saved;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const s = presetsFor(activeEngine.value);
    if (!s.schema.value && s.loading.value) return;
    const cfg: FlatConfig = s.resolve();
    if (!configsEqual(resolvedConfig.value, cfg)) {
      resolvedConfig.value = cfg;
      markSliceInputsChanged();
    }
  };
  flushNow = flush;
  watch(
    () => {
      const s = presetsFor(activeEngine.value);
      return [activeEngine.value, s.bases.value, s.infos.value, s.schema.value, s.overrides, s.project, s.modelBedType.value, s.orcaSchema.value];
    },
    () => { if (timer) clearTimeout(timer); timer = setTimeout(flush, 120); },
    { deep: true, immediate: true },
  );
}

/**
 * Wait until the active engine's presets have finished loading (first-run
 * printer install, catalog, schema) and `resolvedConfig` reflects them, so a
 * slice started straight after page load uses the selected printer.
 */
export async function presetsSettled(timeoutMs = 60_000): Promise<void> {
  startPresets();
  const s = presetsFor(activeEngine.value);
  const deadline = Date.now() + timeoutMs;
  await Promise.race([s.ready, new Promise((r) => setTimeout(r, timeoutMs))]);
  while (s.loading.value > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  flushNow?.();
}

// ---- project section -------------------------------------------------------------------

export interface PresetsProjectData {
  version: 1;
  activeEngine: EngineId;
  engines: Partial<Record<EngineId, PersistedEngineState>>;
}

/**
 * This tab's preset state for its autosave slot. Engines still loading keep
 * what `pending` (the slot being restored) had for them, so a save racing the
 * restore doesn't record the constructor defaults.
 */
export function presetsAutosaveData(pending?: unknown): PresetsProjectData {
  const base = (pending && typeof pending === 'object' ? pending : {}) as Partial<PresetsProjectData>;
  const out: PresetsProjectData = { version: 1, activeEngine: toEngineId(base.activeEngine) ?? activeEngine.value, engines: {} };
  for (const e of ENGINES) { const st = base.engines?.[e]; if (st) out.engines[e] = st; }
  for (const [id, s] of engines) if (s.isReady) out.engines[id] = s.snapshot();
  return out;
}

/** Project file section `presets` (selection + unsaved overrides per engine). */
export const presetsProjectSection = {
  save(): PresetsProjectData {
    const out: PresetsProjectData = { version: 1, activeEngine: activeEngine.value, engines: {} };
    for (const [id, s] of engines) out.engines[id] = s.snapshot();
    return out;
  },
  async load(data: unknown): Promise<void> {
    if (typeof data !== 'object' || data === null) return;
    const d = data as Partial<PresetsProjectData>;
    if (d.engines) {
      for (const e of ENGINES) {
        const st = d.engines[e];
        if (st) await presetsFor(e).load(st);
      }
    }
    // A project saved with an engine this build doesn't have opens on the default engine with that
    // engine's own state; the missing engine's presets (and anything only it understood) are dropped.
    const engine = toEngineId(d.activeEngine);
    if (engine) setActiveEngine(engine);
  },
};

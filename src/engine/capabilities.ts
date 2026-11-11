/**
 * What each slicing engine can do: the one place that knows engine ids.
 * Code asks for a capability (`engineCaps(e).tools`) instead of comparing ids.
 */
import type { EngineId } from './types';

export interface EngineCaps {
  label: string;
  /**
   * OrcaSlicer's config key space, profile library and project format
   * (project_settings.config, per-object Orca keys, flush_volumes_matrix).
   */
  orcaConfig: boolean;
  /** Profiles come from Orca's library converted on the fly (`orca:*` compat values, placeholder variables). */
  orcaCompat: boolean;
  /** Ships a pthreads build in `wasm/<engine>/mt/`. */
  multiThreaded: boolean;
  /** Orca Calibration menu prints (Calib_Params jobs). */
  calibration: boolean;
  /** Orca's native mixed filaments (needs a 2.5 schema with `filament_is_mixed` too). */
  mixedFilaments: boolean;
  /** Orca 2.5 precise seam volumes (`precise_seam_*` part types in the job). */
  preciseSeam: boolean;
  /** Whose G-code writer the engine uses (header layout, thumbnail blocks). */
  gcodeWriter: 'orca' | 'prusa';
  /** Per-object key that turns supports on. */
  supportKey: string;
  /** Flushing volumes: project keys (Orca has a multiplier; PrusaSlicer a "custom matrix" switch). */
  flush: { matrix: string; multiplier: string | null; custom: string | null };
  /** Printer selected on the engine's first run (no saved state). */
  firstRunPrinter: string;
}

// OrcaSlicer's own default printer (PresetBundle::ORCA_DEFAULT_PRINTER_MODEL):
// a generic Klipper printer with a full process ladder + library filaments.
const ORCA_FIRST_PRINTER = 'sys:Custom/MyKlipper 0.4 nozzle';

export const ENGINE_CAPS: Readonly<Record<EngineId, EngineCaps>> = {
  orca: {
    label: 'OrcaSlicer', orcaConfig: true, orcaCompat: false, multiThreaded: true, calibration: true, mixedFilaments: true, preciseSeam: true,
    gcodeWriter: 'orca', supportKey: 'enable_support',
    flush: { matrix: 'flush_volumes_matrix', multiplier: 'flush_multiplier', custom: null },
    firstRunPrinter: ORCA_FIRST_PRINTER,
  },
  preflight: {
    label: 'preFlight', orcaConfig: false, orcaCompat: true, multiThreaded: false, calibration: false, mixedFilaments: false, preciseSeam: false,
    gcodeWriter: 'prusa', supportKey: 'support_material',
    flush: { matrix: 'wiping_volumes_matrix', multiplier: null, custom: 'wiping_volumes_use_custom_matrix' },
    // preFlight reads Orca's printer library (converted), so it starts on the same printer.
    firstRunPrinter: ORCA_FIRST_PRINTER,
  },
};

/** Engines in menu order. */
export const ENGINES = Object.keys(ENGINE_CAPS) as EngineId[];

export function engineCaps(e: EngineId): EngineCaps { return ENGINE_CAPS[e]; }

export const ENGINE_LABELS: Readonly<Record<EngineId, string>> =
  Object.fromEntries(ENGINES.map((e) => [e, ENGINE_CAPS[e].label])) as Record<EngineId, string>;

/** The engine new users start on, and the one stored state naming an engine this build doesn't have falls back to. */
export const DEFAULT_ENGINE: EngineId = 'orca';

/**
 * A stored engine id (preferences, localStorage, project and autosave
 * sections) → an engine of this build. An id it doesn't have (a retired
 * engine) becomes DEFAULT_ENGINE; non-strings are null.
 */
export function toEngineId(v: unknown): EngineId | null {
  if (typeof v !== 'string' || !v) return null;
  return v in ENGINE_CAPS ? (v as EngineId) : DEFAULT_ENGINE;
}

/**
 * Bridge ABI versions this app speaks (docs/ENGINE-CONTRACT.md, `cs_version().bridge`).
 * An engine outside the range is refused with a "re-stage the engine" error.
 */
export const BRIDGE_ABI = { min: 1, max: 1 } as const;

export function bridgeAbiError(engine: EngineId, abi: unknown): string | null {
  if (typeof abi === 'number' && abi >= BRIDGE_ABI.min && abi <= BRIDGE_ABI.max) return null;
  const want = BRIDGE_ABI.min === BRIDGE_ABI.max ? `${BRIDGE_ABI.min}` : `${BRIDGE_ABI.min}–${BRIDGE_ABI.max}`;
  return `The ${ENGINE_CAPS[engine].label} engine speaks bridge ABI ${String(abi ?? '?')}, this app needs ${want}. Re-stage the engine (scripts/fetch-${engine}-wasm.sh) or update the app.`;
}

/** Orca's config key space, profiles and project format. */
export function isOrcaConfig(e: EngineId): boolean { return ENGINE_CAPS[e].orcaConfig; }

/** Why the Calibration menu's prints can't run on `e` (null = they can). */
export function calibrationUnavailable(e: EngineId): string | null {
  return ENGINE_CAPS[e].calibration ? null
    : `Calibration prints need the ${ENGINES.filter((x) => ENGINE_CAPS[x].calibration).map((x) => ENGINE_CAPS[x].label).join(' or ')} engine. Switch the engine in the Printer section.`;
}

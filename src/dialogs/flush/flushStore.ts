/**
 * Flushing volumes ↔ the presets store's project values (Orca keeps
 * flush_volumes_matrix / flush_multiplier in the project config, not in a
 * preset). preFlight (PrusaSlicer) uses wiping_volumes_matrix +
 * wiping_volumes_use_custom_matrix and has no multiplier.
 *
 * Only physical filaments flush: the matrix here is physical × physical;
 * mixed filament slots get zero rows / columns in the slice config
 * (mixed/model.ts withMixedSlots, Orca WipeTowerDialog).
 */
import { asList } from '../../lib/configValue';
import { watch } from 'vue';
import { activeEngine, resolvedConfig } from '../../app/state';
import { preferences } from '../../app/preferences';
import { currentPresets } from '../../presets/store';

import {
  autoFlushMatrix, autoFlushUpdate, flattenMatrices, flushDataset, matrixSize, minFlushVolumes, nozzleMatrix, physicalBlock, resizeFlat, supportFlags,
} from './flushCalc';
import { engineCaps, type EngineId } from '../../engine/types';

export interface FlushState {
  engine: EngineId;
  /** Filament count. */
  n: number;
  /** Nozzles with their own matrix (Orca multi-extruder printers). */
  nozzles: number;
  colours: string[];
  matrices: number[][][];
  multipliers: number[];
  /** Orca 2.5 purge mode (`prime_volume_mode`) and the choices the printer offers ([] = none). */
  purgeMode: 'Default' | 'Saving' | 'Fast';
  purgeModes: Array<'Default' | 'Saving' | 'Fast'>;
  /** `flush_multiplier_fast` per nozzle (used instead of the multiplier in Fast mode). */
  fastMultipliers: number[];
}

function keys() { return engineCaps(activeEngine.value).flush; }

const nums = (v: unknown): number[] => asList(v as string | string[]).map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));

/** Colours of the physical filaments (the ones that flush). */
function flushColours(): string[] {
  return currentPresets.value.physicalColours();
}

export function flushNozzles(): number {
  if (!engineCaps(activeEngine.value).orcaConfig) return 1;
  return Math.max(1, asList(currentPresets.value.value('printer', 'nozzle_diameter')).length);
}

/** Auto-calculated matrix for nozzle `z` from the current colours (WipingDialog::CalcFlushingVolumes). */
export function autoMatrixFor(z: number, colours = flushColours()): number[][] {
  const cfg = resolvedConfig.value;
  return autoFlushMatrix(colours, { minFlush: minFlushVolumes(cfg, z, colours.length), support: supportFlags(cfg, colours.length), dataset: flushDataset(cfg, z) });
}

export function readFlush(): FlushState {
  const p = currentPresets.value;
  const k = keys();
  const colours = flushColours();
  const n = colours.length, nozzles = flushNozzles();
  const cfg = resolvedConfig.value;
  // The project keeps the physical block; the resolved config may carry every slot (mixed filaments).
  const flat = p.project[k.matrix] !== undefined ? nums(p.project[k.matrix]) : physicalBlock(nums(cfg[k.matrix]), n, nozzles);
  const consistent = matrixSize(flat.length, nozzles) === n;
  const matrices = Array.from({ length: nozzles }, (_, z) => (consistent ? nozzleMatrix(flat, n, z, nozzles) : autoMatrixFor(z, colours)));
  const mult = k.multiplier ? nums(p.project[k.multiplier] ?? cfg[k.multiplier]) : [];
  const multipliers = Array.from({ length: nozzles }, (_, z) => mult[z] ?? mult[0] ?? 1);
  const fast = nums(p.project.flush_multiplier_fast ?? cfg.flush_multiplier_fast);
  const fastMultipliers = Array.from({ length: nozzles }, (_, z) => fast[z] ?? fast[0] ?? 1.2);
  return { engine: activeEngine.value, n, nozzles, colours, matrices, multipliers, purgeMode: p.purgeMode(), purgeModes: p.purgeModes(), fastMultipliers };
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

export function writeFlush(s: Pick<FlushState, 'matrices' | 'multipliers'> & Partial<Pick<FlushState, 'purgeMode' | 'purgeModes' | 'fastMultipliers'>>): void {
  const p = currentPresets.value;
  const k = keys();
  p.project[k.matrix] = flattenMatrices(s.matrices).map(fmt);
  if (k.multiplier) p.project[k.multiplier] = s.multipliers.map(fmt);
  if (k.custom) p.project[k.custom] = '1';
  if (s.purgeModes?.length && s.purgeMode) {
    if (s.purgeMode === 'Default') delete p.project.prime_volume_mode; else p.project.prime_volume_mode = s.purgeMode;
    if (s.purgeMode === 'Fast' && s.fastMultipliers) p.project.flush_multiplier_fast = s.fastMultipliers.map(fmt);
  }
}

/**
 * Orca "Auto flush after changing…": re-calculate the rows / columns of
 * filaments whose colour (or preset) changed, and the whole matrix when the
 * filament count changes.
 */
export function installAutoFlush(): () => void {
  let prev: { colours: string[]; presets: string[]; engine: string; matrix: string } | null = null;
  return watch(
    () => ({
      colours: flushColours(), presets: currentPresets.value.selection.filaments.slice(), engine: activeEngine.value,
      ready: !!currentPresets.value.schema.value && currentPresets.value.loading.value === 0,
      matrix: JSON.stringify(currentPresets.value.project[keys().matrix] ?? null),
    }),
    (cur) => {
      // Only compare stable states (presets resolved); a matrix that changed together
      // with the colours came from a loaded project / autosave and is kept as is.
      if (!cur.ready) return;
      const last = prev;
      prev = { colours: cur.colours, presets: cur.presets, engine: cur.engine, matrix: cur.matrix };
      if (!last || last.engine !== cur.engine || preferences.autoFlush === 'off' || cur.colours.length < 2) return;
      const n = cur.colours.length, nozzles = flushNozzles();
      // No matrix of the project's own (new project, cleared): calculate one for the current
      // filaments (the slice would otherwise carry the fitted default, resolve()).
      if (engineCaps(cur.engine as EngineId).orcaConfig && currentPresets.value.project[keys().matrix] === undefined) {
        writeFlush({ ...readFlush(), matrices: Array.from({ length: nozzles }, (_, z) => autoMatrixFor(z, cur.colours)) });
        return;
      }
      if (last.matrix !== cur.matrix) return;
      const changed = new Set<number>();
      for (let i = 0; i < n; i++) {
        if (cur.colours[i] !== last.colours[i]) changed.add(i);
        else if (preferences.autoFlush === 'all' && cur.presets[i] !== last.presets[i]) changed.add(i);
      }
      if (!changed.size && n === last.colours.length) return;
      const state = readFlush();
      if (n !== last.colours.length) {
        const k = keys();
        const flat = nums(currentPresets.value.project[k.matrix] ?? resolvedConfig.value[k.matrix]);
        const oldN = matrixSize(flat.length, nozzles);
        const resized = oldN ? resizeFlat(flat, oldN, n, nozzles) : [];
        state.matrices = Array.from({ length: nozzles }, (_, z) => (oldN ? nozzleMatrix(resized, n, z, nozzles) : autoMatrixFor(z, cur.colours)));
        for (let i = Math.min(oldN, n); i < n; i++) changed.add(i);
      }
      state.matrices = state.matrices.map((m, z) => {
        let out = m;
        for (const i of changed) {
          const cfg = resolvedConfig.value;
          out = autoFlushUpdate(out, cur.colours, i, { minFlush: minFlushVolumes(cfg, z, n), support: supportFlags(cfg, n), dataset: flushDataset(cfg, z) });
        }
        return out;
      });
      writeFlush(state);
    },
    { deep: true },
  );
}

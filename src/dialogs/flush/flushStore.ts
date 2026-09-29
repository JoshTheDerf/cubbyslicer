/**
 * Flushing volumes ↔ the presets store's project values (Orca keeps
 * flush_volumes_matrix / flush_multiplier in the project config, not in a
 * preset). preFlight (PrusaSlicer) uses wiping_volumes_matrix +
 * wiping_volumes_use_custom_matrix and has no multiplier.
 */
import { watch } from 'vue';
import { activeEngine, resolvedConfig } from '../../app/state';
import { preferences } from '../../app/preferences';
import { currentPresets } from '../../presets/store';
import { asArray } from '../../presets/values';
import {
  autoFlushMatrix, autoFlushUpdate, flattenMatrices, flushDataset, matrixSize, minFlushVolumes, nozzleMatrix, resizeFlat, supportFlags,
} from './flushCalc';
import { isOrcaFamily } from '../../engine/types';

export interface FlushState {
  engine: 'orca' | 'preflight' | 'fullspectrum';
  /** Filament count. */
  n: number;
  /** Nozzles with their own matrix (Orca multi-extruder printers). */
  nozzles: number;
  colours: string[];
  matrices: number[][][];
  multipliers: number[];
}

function keys() {
  return isOrcaFamily(activeEngine.value)
    ? { matrix: 'flush_volumes_matrix', multiplier: 'flush_multiplier' as string | null, custom: null as string | null }
    : { matrix: 'wiping_volumes_matrix', multiplier: null, custom: 'wiping_volumes_use_custom_matrix' };
}

const nums = (v: unknown): number[] => asArray(v as string | string[]).map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));

export function flushColours(): string[] {
  const p = currentPresets.value;
  return p.selection.filaments.map((_, i) => p.filamentColour(i));
}

export function flushNozzles(): number {
  if (!isOrcaFamily(activeEngine.value)) return 1;
  return Math.max(1, asArray(currentPresets.value.value('printer', 'nozzle_diameter')).length);
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
  const flat = nums(p.project[k.matrix] ?? cfg[k.matrix]);
  const consistent = matrixSize(flat.length, nozzles) === n;
  const matrices = Array.from({ length: nozzles }, (_, z) => (consistent ? nozzleMatrix(flat, n, z, nozzles) : autoMatrixFor(z, colours)));
  const mult = k.multiplier ? nums(p.project[k.multiplier] ?? cfg[k.multiplier]) : [];
  const multipliers = Array.from({ length: nozzles }, (_, z) => mult[z] ?? mult[0] ?? 1);
  return { engine: activeEngine.value, n, nozzles, colours, matrices, multipliers };
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

export function writeFlush(s: Pick<FlushState, 'matrices' | 'multipliers'>): void {
  const p = currentPresets.value;
  const k = keys();
  p.project[k.matrix] = flattenMatrices(s.matrices).map(fmt);
  if (k.multiplier) p.project[k.multiplier] = s.multipliers.map(fmt);
  if (k.custom) p.project[k.custom] = '1';
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
      if (!last || last.engine !== cur.engine || last.matrix !== cur.matrix || preferences.autoFlush === 'off' || cur.colours.length < 2) return;
      const n = cur.colours.length, nozzles = flushNozzles();
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

/**
 * Orca 2.5's nozzle rack bookkeeping in the GUI (Widgets/MultiNozzleSync.cpp ManualNozzleCountDialog /
 * manuallySetNozzleCount, FilamentMapPanel.cpp check_sync / UpdateNozzleCountDisplay): which counts the
 * "Set nozzle count" dialog offers, its errors, the manual grouping check and the zone titles.
 */
import { parseNozzleStats, type NozzleCounts } from '../presets/nozzleMaps';
import { dialogRequest } from '../ui/dialogRequest';

/** Types the dialog shows: the extruder's own, or for a Hybrid extruder every type it provides (Standard, High Flow, E3D High Flow). */
export function nozzleCountTypes(volumeType: string, supported: readonly string[]): string[] {
  const all = ['Standard', 'High Flow', 'E3D High Flow'];
  return all.filter((t) => volumeType === t || (volumeType === 'Hybrid' && (!supported.length || supported.includes(t))));
}

/** The dialog's error for a total (Hybrid: the sum of every row), or null. */
export function nozzleCountError(total: number, max: number, forceNoZero: boolean): string | null {
  if (total === 0 && forceNoZero) return 'Error: Can not set both nozzle count to zero.';
  if (total > max) return `Error: Nozzle count can not exceed ${max}.`;
  return null;
}

/**
 * manuallySetNozzleCount's force_no_zero: a Hybrid extruder needs a nozzle, and so does any extruder while
 * the other one has none (`otherTotal` null: a single extruder, which can't be emptied either).
 */
export function orcaForceNoZero(volumeType: string, otherTotal: number | null): boolean {
  return volumeType === 'Hybrid' || otherTotal === null || otherTotal === 0;
}

export interface ManualMapProblem { extruder: number; type: 'Standard' | 'High Flow'; message: string }

/**
 * FilamentMapManualPanel::check_sync: on a printer with a nozzle rack, every used extruder needs a nozzle
 * of the type its filaments print with (Hybrid: per filament `volumes`).
 * `map` is 1-based extruder per filament; `stats` the extruders' rack strings.
 */
export function manualMapProblem(map: readonly number[], volumes: readonly string[], extruderTypes: readonly string[], stats: readonly string[]): ManualMapProblem | null {
  for (let e = 0; e < extruderTypes.length; e++) {
    const used = map.map((x, i) => ({ x, i })).filter((f) => f.x - 1 === e);
    if (!used.length) continue;
    const c: NozzleCounts = parseNozzleStats(stats[e] ?? '');
    let missing: 'Standard' | 'High Flow' | null = null;
    if (extruderTypes[e] === 'Hybrid') {
      const has = (t: string) => used.some((f) => (volumes[f.i] ?? 'Standard') === t);
      if (has('Standard') && !(c.Standard ?? 0)) missing = 'Standard';
      else if (has('High Flow') && !(c['High Flow'] ?? 0)) missing = 'High Flow';
    } else if (!(c[extruderTypes[e]] ?? 0)) missing = extruderTypes[e] === 'High Flow' ? 'High Flow' : 'Standard';
    if (missing) {
      const side = e === 0 ? 'Left' : 'Right';
      return { extruder: e, type: missing, message: `Error: ${side} extruder has no available ${missing} nozzle, current group result is invalid.` };
    }
  }
  return null;
}

/** UpdateNozzleCountDisplay: "Left Nozzle(N)", a Hybrid right extruder "Right Nozzle(Std: a, HF: b)"; no counts without a rack. */
export function zoneTitle(extruder: number, extruders: number, stats: readonly string[] | null, rightHybrid: boolean): string {
  const base = extruders === 2 ? (extruder === 0 ? 'Left Nozzle' : 'Right Nozzle') : `Nozzle ${extruder + 1}`;
  if (!stats) return base;
  const c = parseNozzleStats(stats[extruder] ?? '');
  if (extruder === 1 && rightHybrid) return `${base}(Std: ${c.Standard ?? 0}, HF: ${c['High Flow'] ?? 0})`;
  return `${base}(${Object.values(c).reduce((a, b) => a + b, 0)})`;
}

/** "Set nozzle count" for one extruder (resolves true on Confirm). Mounted in ShellDialogs. */
export const nozzleCountDialog = dialogRequest<{ extruder: number }, boolean>(false);

/** manuallySetNozzleCount for every extruder with a rack, one after the other ("Set the physical nozzle count..."). */
export async function setAllNozzleCounts(rackExtruders: readonly number[]): Promise<void> {
  for (const e of rackExtruders) await nozzleCountDialog.ask({ extruder: e });
}

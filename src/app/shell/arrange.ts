/**
 * Auto arrange (OrcaSlicer's ArrangeJob, run on the Orca engine): Arrange all
 * (A), Arrange plate (Shift+A) and Arrange selection, with the Arrange options
 * (spacing, auto rotation, …) or one run's overrides (`?spacing=` /
 * `?rotate=` links). One run at a time, like Orca's m_arrange_running.
 */
import { activeEngine, resolvedConfig } from '../state';
import { toast } from '../../ui';
import { orcaArrange } from '../../engine/client';
import type { FlatConfig } from '../../engine/types';
import { activePlate, applyArrange, arrangeInputs, bed, objects, selectedIds, type ArrangeOutcome } from '../../project/store';
import { activeArrangeSet, arrangeSettings, type ArrangeRunOptions } from '../arrangeSettings';
import { currentPresets } from '../../presets/store';
import { ui } from './uiState';

export type ArrangeMode = 'all' | 'plate' | 'selection';

const scalar = (v: FlatConfig[string] | undefined): string => String(Array.isArray(v) ? v[0] ?? '' : v ?? '');

/** The global print sequence is by object (Orca picks the "seq print" arrange settings then). */
export function arrangeSeqPrint(cfg: FlatConfig = resolvedConfig.value): boolean {
  return scalar(cfg.print_sequence) === 'by object' || scalar(cfg.complete_objects) === '1';
}

/** Orca's BBL vendor check (the "Avoid extrusion calibration region" option). */
export function isBblPrinter(): boolean {
  return currentPresets.value.infos.value.printer.vendor === 'BBL';
}

/**
 * The config Orca arranges with. preFlight's keys differ, so its bed (and
 * by-object sequence) are given in Orca's terms; the rest falls back to
 * Orca's defaults there.
 */
function orcaConfig(): FlatConfig {
  const cfg = resolvedConfig.value;
  if (activeEngine.value !== 'preflight') return cfg;
  const b = bed.value;
  const pt = (p: [number, number]) => `${p[0]}x${p[1]}`;
  return {
    ...cfg,
    printable_area: b.polygon.map(pt),
    ...(b.excludeAreas[0] ? { bed_exclude_area: b.excludeAreas[0].map(pt) } : {}),
    print_sequence: arrangeSeqPrint(cfg) ? 'by object' : 'by layer',
    ...(b.maxHeight ? { printable_height: String(b.maxHeight) } : {}),
  };
}

let running: Promise<ArrangeOutcome | null> | null = null;

export function arrangeRunning(): boolean { return !!running; }

/** Arrange; resolves when the result is applied (null if nothing ran). Errors are reported, not thrown. */
export function runArrange(mode: ArrangeMode, opts: ArrangeRunOptions = {}): Promise<ArrangeOutcome | null> {
  if (running) return running;
  running = doArrange(mode, opts).finally(() => { running = null; });
  return running;
}

async function doArrange(mode: ArrangeMode, opts: ArrangeRunOptions): Promise<ArrangeOutcome | null> {
  if (!objects.value.length) return null;
  const sel = opts.ids ?? selectedIds.value;
  if (mode === 'selection' && !sel.length) mode = 'all';
  const config = orcaConfig();
  const set = activeArrangeSet(arrangeSeqPrint(config));
  const inputs = arrangeInputs(mode === 'selection' ? sel : [], opts.imported ?? []);
  if (!inputs.objects.length) return null;
  const prevBusy = ui.busy;
  ui.busy = 'Arranging…';
  try {
    const r = await orcaArrange(config, inputs.objects, {
      mode, currentPlate: activePlate.value, plates: inputs.plates, items: inputs.items, bbl: isBblPrinter(),
      settings: {
        distance: Math.max(0, opts.distance ?? set.distance),
        enableRotation: opts.enableRotation ?? set.enableRotation,
        alignToYAxis: arrangeSettings.alignToYAxis,
        allowMultiMaterials: arrangeSettings.allowMultiMaterials,
        avoidCaliRegion: arrangeSettings.avoidCaliRegion,
      },
    });
    const out = applyArrange(inputs.ids, r, mode);
    for (const w of r.warnings) toast.warn(w.split('\n')[0], { detail: w.split('\n').slice(1).join('\n') || undefined });
    if (out.unplaced) {
      toast.warn('Arranging is done but there are unpacked items. Reduce spacing and try again.', {
        detail: `Placed beside the plates: ${r.unplaced.join(', ')}`,
      });
    }
    return out;
  } catch (e) {
    toast.error("Couldn't arrange.", { detail: (e as Error)?.message ?? String(e) });
    return null;
  } finally {
    ui.busy = prevBusy;
  }
}

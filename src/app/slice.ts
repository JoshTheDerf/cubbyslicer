/**
 * Slice orchestration: project + resolved config → engine → preview.
 *
 * Single controller instance (module state) so the top bar, SliceBar and
 * keyboard shortcuts all see the same status.
 *
 * Multiple plates (Orca-style): each plate is sliced on its own and keeps its
 * result; `lastSlice` (what Preview / export / send show) follows the active
 * plate. A plate's result is stale once its objects or the config changed.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { getSchema, SliceCancelled, SliceError, sliceJob } from '../engine/client';
import type { FlatConfig, SliceJob, SliceReport, SliceResult } from '../engine/types';
import { splitOrcaCompat } from '../presets/preflight/convert';
import { activePlate, getSliceObjects, plates, plateSliceSignature, projectLoads, setActivePlate } from '../project/store';
import { activeEngine, activeView, lastSlice, resolvedConfig } from './state';
import { applyPlateConfig } from '../plates/store';
import { presetsSettled } from '../presets/store';
import { calibJobOptions, calibSignature } from '../calibration/state';
import { saveBytes } from './shell/download';
import { toast } from '../ui';
import { GCODE_TYPES, fileInFolder, folderAccessSupported, writeHandle } from '../localfs/store';
import { withGcodeThumbnails } from '../project/thumbnails';

export type SliceStatus = 'idle' | 'slicing' | 'done' | 'error';

interface PlateSlice { result: SliceResult; signature: string }

const status = ref<SliceStatus>('idle');
const progress = ref(0);
const message = ref('');
const error = ref<string | null>(null);
const errorReport = shallowRef<SliceReport | null>(null);
/** Per-plate results (index = plate). */
const plateSlices = shallowRef<Array<PlateSlice | null>>([]);
let abort: AbortController | null = null;

// Config identity → small counter, so signatures change whenever the resolved config does.
const configIds = new WeakMap<FlatConfig, number>();
let configSeq = 0;
function configId(c: FlatConfig): number {
  let id = configIds.get(c);
  if (id === undefined) { id = ++configSeq; configIds.set(c, id); }
  return id;
}

function signature(plate: number): string {
  return `${activeEngine.value}#${configId(resolvedConfig.value)}#${plateSliceSignature(plate)}#${calibSignature()}`;
}

function resultFor(plate: number): PlateSlice | null { return plateSlices.value[plate] ?? null; }

/** Whether plate `i` has a result that no longer matches its inputs. */
function plateStale(i: number): boolean {
  const r = resultFor(i);
  return !!r && r.signature !== signature(i);
}

const isStale = computed(() => plateStale(activePlate.value));

/** Per-plate state for plate tabs: 'none' | 'stale' | 'done'. */
const plateStates = computed(() => plates.value.map((_, i) => (!resultFor(i) ? 'none' : plateStale(i) ? 'stale' : 'done')));

// Preview / export follow the active plate.
watch(activePlate, (p) => { lastSlice.value = resultFor(p)?.result ?? null; });

// Results are keyed by plate index: deleting (or inserting before the end)
// shifts indices, so drop them rather than show another plate's G-code.
// Appending a plate — the common case — keeps them.
// A different project: nothing sliced yet (sync, so a project's own G-code can be loaded right after).
watch(projectLoads, () => { plateSlices.value = []; lastSlice.value = null; status.value = 'idle'; }, { flush: 'sync' });

watch(() => plates.value.map((p) => p), (next, prev) => {
  const appended = next.length > prev.length && prev.every((p, i) => p === next[i]);
  if (appended || next.length === prev.length) return;
  plateSlices.value = [];
  lastSlice.value = resultFor(activePlate.value)?.result ?? null;
});

/** preFlight running converted Orca presets gets their Orca-only values as placeholder variables. */
async function buildJob(objects: SliceJob['objects'], plate = activePlate.value): Promise<SliceJob> {
  const job = await buildBaseJob(objects);
  // Per-plate settings (Orca PlateSettingsDialog) override the config; slider custom G-codes ride along.
  const meta = plates.value[plate];
  if (meta?.config) {
    const schema = await getSchema(job.engine).catch(() => null);
    job.config = applyPlateConfig(job.config, meta.config, schema ? (k) => k in schema.options : null);
  }
  if (meta?.customGcodes?.length) job.options = { ...job.options, customGcodes: meta.customGcodes.map((g) => ({ ...g })) };
  // Calibration print (Calibration menu): Orca's Calib_Params.
  const calib = calibJobOptions();
  if (calib.calib) job.options = { ...job.options, ...calib };
  return job;
}

async function buildBaseJob(objects: SliceJob['objects']): Promise<SliceJob> {
  const engine = activeEngine.value;
  const config = resolvedConfig.value;
  if (engine !== 'preflight') return { engine, config, objects };
  const orcaSchema = Object.keys(config).some((k) => k.startsWith('orca:')) ? await getSchema('orca').catch(() => null) : null;
  const split = splitOrcaCompat(config, orcaSchema);
  return { engine, config: split.config, objects, options: Object.keys(split.vars).length ? { placeholderVars: split.vars } : undefined };
}

async function slicePlate(plate: number, label: string): Promise<boolean> {
  const objects = getSliceObjects(plate);
  if (objects.length === 0) {
    error.value = plates.value.length > 1 ? `${label} is empty.` : 'Add a model to the plate first.';
    status.value = 'error';
    return false;
  }
  const sig = signature(plate);
  progress.value = 0;
  message.value = 'Starting engine';
  const prefix = plates.value.length > 1 ? `${label}: ` : '';
  const job = await buildJob(objects, plate);
  const sliced = await sliceJob(
    job,
    (p) => {
      // OrcaSlicer reports each step per object (4% → 13% → 4% → 13% … on a
      // multi-object plate) and G-code export restarts its own scale. Only
      // move forward so the bar and label don't flicker between steps.
      if (p.percent < progress.value) return;
      progress.value = p.percent;
      message.value = prefix + p.message;
    },
    abort!.signal,
  );
  // The printer's G-code thumbnails, rendered once here from the objects that
  // were sliced: every export / upload of this result reuses them.
  message.value = prefix + 'Rendering thumbnails';
  const result = await withGcodeThumbnails(sliced, job.config, objects);
  const next = plateSlices.value.slice();
  next[plate] = { result, signature: sig };
  plateSlices.value = next;
  if (plate === activePlate.value) lastSlice.value = result;
  return true;
}

async function run(plateList: number[], opts: { showLast: boolean }): Promise<boolean> {
  if (status.value === 'slicing') return false;
  abort = new AbortController();
  status.value = 'slicing';
  error.value = null;
  errorReport.value = null;
  let last = -1;
  try {
    // On a phone the sidebar may never have been opened: make sure the selected
    // printer / presets are loaded before building the job.
    message.value = 'Loading printer profile';
    await presetsSettled();
    for (const p of plateList) {
      if (!(await slicePlate(p, `Plate ${p + 1}`))) return false;
      last = p;
    }
    status.value = 'done';
    progress.value = 100;
    message.value = 'Done';
    if (opts.showLast && last >= 0 && last !== activePlate.value) setActivePlate(last);
    activeView.value = 'preview';
    return true;
  } catch (e) {
    if (e instanceof SliceCancelled) {
      status.value = lastSlice.value ? 'done' : 'idle';
      message.value = 'Cancelled';
      return false;
    }
    status.value = 'error';
    error.value = e instanceof Error ? e.message : String(e);
    errorReport.value = e instanceof SliceError ? e.report : null;
    return false;
  } finally {
    abort = null;
  }
}

/** Slice the active plate (Orca "Slice plate", Ctrl+R). */
function slice(): Promise<boolean> {
  return run([activePlate.value], { showLast: false });
}

/** Slice every non-empty plate that has no up-to-date result (Orca "Slice all"). */
function sliceAll(): Promise<boolean> {
  const list = plates.value.map((_, i) => i).filter((i) => getSliceObjects(i).length > 0 && (!resultFor(i) || plateStale(i)));
  if (!list.length) {
    if (plates.value.some((_, i) => getSliceObjects(i).length > 0)) { activeView.value = 'preview'; return Promise.resolve(true); }
    error.value = 'Add a model to a plate first.';
    status.value = 'error';
    return Promise.resolve(false);
  }
  // Keep showing the active plate if it's among them.
  return run(list, { showLast: !list.includes(activePlate.value) });
}

function cancel(): void {
  abort?.abort();
}

function gcodeFilename(plate = activePlate.value): string {
  const objs = getSliceObjects(plate);
  const base = (objs[0]?.name ?? 'plate').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '_') || 'plate';
  const suffix = objs.length > 1 ? `_plus${objs.length - 1}` : '';
  const plateTag = plates.value.length > 1 ? `_plate${plate + 1}` : '';
  return `${base}${suffix}${plateTag}.gcode`;
}

function download(r: SliceResult, name: string): void {
  const blob = new Blob([r.gcode as BlobPart], { type: 'text/x-gcode' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * Show G-code that came with a project (Orca sliced 3MF) as plate `plate`'s
 * result. It's marked outdated right away (it wasn't sliced from this app's
 * config), so Slice plate re-slices it.
 */
export function loadPlateGcode(plate: number, gcode: Uint8Array): void {
  const next = plateSlices.value.slice();
  next[plate] = { result: { engine: activeEngine.value, gcode, report: { ok: true, error: null, warnings: [], stats: null } }, signature: 'loaded' };
  plateSlices.value = next;
  if (plate === activePlate.value) lastSlice.value = next[plate]!.result;
}

/** The active plate's sliced G-code and its export name (null = not sliced). */
export function activeGcode(): { bytes: Uint8Array; name: string } | null {
  const r = lastSlice.value;
  return r ? { bytes: r.gcode, name: gcodeFilename() } : null;
}

/** Export the active plate's G-code (Orca "Export plate sliced file", Ctrl+G). */
function exportGcode(): boolean {
  const r = lastSlice.value;
  if (!r) return false;
  // Native save dialog where the File System Access API exists (else a download).
  void saveBytes(r.gcode, gcodeFilename(), 'text/x-gcode', { types: GCODE_TYPES, id: 'cubby-gcode' })
    .catch((e) => { toast.error("Couldn't export G-code.", { detail: (e as Error)?.message }); });
  return true;
}

/** Export every sliced plate's G-code as separate files. Returns how many were exported. */
function exportAllGcode(): number {
  const all = plateSlices.value.map((s, i) => (s ? { r: s.result, name: gcodeFilename(i) } : null)).filter((x): x is { r: SliceResult; name: string } => !!x);
  if (folderAccessSupported && all.length > 1) {
    // One folder for every plate instead of a dialog per file.
    void (async () => {
      try {
        const dir = await window.showDirectoryPicker!({ id: 'cubby-gcode', mode: 'readwrite' });
        for (const { r, name } of all) await writeHandle(await fileInFolder(dir, name), r.gcode);
        toast.success(`Exported ${all.length} plates to ${dir.name}.`, { timeout: 2200 });
      } catch (e) { if ((e as Error)?.name !== 'AbortError') toast.error("Couldn't export G-code.", { detail: (e as Error)?.message }); }
    })();
    return all.length;
  }
  for (const { r, name } of all) download(r, name);
  return all.length;
}

export function useSliceController() {
  return {
    status, progress, message, error, errorReport, isStale, plateStates,
    slice, sliceAll, cancel, exportGcode, exportAllGcode, gcodeFilename,
  };
}

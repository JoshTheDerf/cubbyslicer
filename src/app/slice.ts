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
import { engineCaps, type FlatConfig, type SliceJob, type SliceReport, type SliceResult } from '../engine/types';
import { ORCA_COMPAT_PREFIX, splitOrcaCompat } from '../presets/preflight/convert';
import { activePlate, getSliceObjects, objectIssues, objectsOnPlate, plates, plateSliceSignature, projectLoads, projectName, serializePlates, setActivePlate } from '../project/store';
import { activeEngine, activeView, lastSlice, resolvedConfig } from './state';
import { applyPlateConfig } from '../plates/store';
import { currentPresets, presetsSettled } from '../presets/store';
import { asList, cfgString, SCALAR } from '../lib/configValue';
import { calibJobOptions, calibSignature } from '../calibration/state';
import { safeFileName, saveBytes } from './shell/download';
import { isBblPrinter } from './shell/arrange';
import { isOrcaConfig } from '../engine/capabilities';
import { renderPlateImages, type PlateImages } from '../project/thumbnails';
import { buildGcode3mf, GCODE_3MF_EXT, scanGcode, type Gcode3mfPlate } from '../project/export/gcode3mf';
import { customGcodeXml, identifyIds, modelMetadataXml, projectSettings } from '../project/persistence/orca3mfWriter';
import { passthroughFor } from '../project/persistence/passthrough';
import { toast } from '../ui';
import { GCODE_TYPES, fileInFolder, folderAccessSupported, writeHandle } from '../localfs/store';
import { withGcodeThumbnails } from '../project/thumbnails';
import { gcodeForOutput } from '../plugins/gcode';
import { fireEngineEvents } from '../plugins/host/lifecycle';
import { finishNozzleMaps } from '../presets/nozzleMaps';
import { anchorOf, placeTower, setAnchor, withTowerAnchor, type PlacedTower } from './wipeTower';
import { engineTool } from '../engine/client';

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
async function buildJob(objects: SliceJob['objects'], plate = activePlate.value, opts: { anchor?: boolean } = {}): Promise<SliceJob> {
  const job = await buildBaseJob(objects);
  // Per-plate settings (Orca PlateSettingsDialog) override the config; slider custom G-codes ride along.
  const meta = plates.value[plate];
  if (meta?.config) {
    const schema = await getSchema(job.engine).catch(() => null);
    job.config = applyPlateConfig(job.config, meta.config, schema ? (k) => k in schema.options : null);
    // The plate's own filament_map / volume map: re-size the nozzle maps over them.
    if (engineCaps(job.engine).orcaConfig && schema) job.config = finishNozzleMaps(job.config, schema);
  }
  if (meta?.customGcodes?.length) job.options = { ...job.options, customGcodes: meta.customGcodes.map((g) => ({ ...g })) };
  // The plate's prime tower anchor (placed by placePlateTower) where the engine reads it.
  if (engineCaps(job.engine).orcaConfig && opts.anchor !== false) {
    const a = anchorOf(job.config, plate);
    if (a) job.config = withTowerAnchor(job.config, a[0], a[1]);
  }
  // Calibration print (Calibration menu): Orca's Calib_Params.
  const calib = calibJobOptions();
  if (calib.calib) job.options = { ...job.options, ...calib };
  return job;
}

async function buildBaseJob(objects: SliceJob['objects']): Promise<SliceJob> {
  const engine = activeEngine.value;
  const config = resolvedConfig.value;
  if (!engineCaps(engine).orcaCompat) return { engine, config, objects };
  const orcaSchema = Object.keys(config).some((k) => k.startsWith(ORCA_COMPAT_PREFIX)) ? await getSchema('orca').catch(() => null) : null;
  const split = splitOrcaCompat(config, orcaSchema);
  return { engine, config: split.config, objects, options: Object.keys(split.vars).length ? { placeholderVars: split.vars } : undefined };
}

/**
 * Desktop's prime tower placement for the plate (app/wipeTower.ts): a new plate gets desktop's
 * default spot, a saved anchor the footprint doesn't fit at is clamped / moved inside the
 * printable area, and one far off the plate goes to the clear spot nearest it (GLCanvas3D::reload_scene).
 * Written back to the project's wipe_tower_x / wipe_tower_y; the Prepare view's tower
 * (towerPreview.ts) and the slice (before its signature is taken) both go through here.
 */
export async function placePlateTower(plate: number, objects: SliceJob['objects'] = getSliceObjects(plate)): Promise<{ result: PlacedTower; job: SliceJob } | null> {
  if (!engineCaps(activeEngine.value).orcaConfig || !objects.length) return null;
  const p = currentPresets.value;
  try {
    const base = await buildJob(objects, plate, { anchor: false });
    const own = anchorOf(resolvedConfig.value, plate);
    const r = await placeTower(base, own, async (args) => (await engineTool('wipe_tower_footprint', args)).result, await p.printerModelId());
    if (!r) return null;
    const { x, y } = r.placement;
    if (own && Math.abs(own[0] - x) < 1e-3 && Math.abs(own[1] - y) < 1e-3) return { result: r, job: base };
    p.project.wipe_tower_x = setAnchor(asList(resolvedConfig.value.wipe_tower_x), plate, x);
    p.project.wipe_tower_y = setAnchor(asList(resolvedConfig.value.wipe_tower_y), plate, y);
    // The stored position changes once, so this is shown once per move.
    if (r.relocation?.overlapsObjects) {
      toast.warn(`The prime tower on plate ${plate + 1} no longer fits where it was placed. There is no free space left on the plate for it, so it was moved onto an object.`);
    } else if (r.relocation) {
      toast.info(`The prime tower on plate ${plate + 1} no longer fits where it was placed, so it was moved to free space on the plate.`);
    }
    await presetsSettled(); // resolvedConfig (and with it the slice signature) carries the new anchor
    return { result: r, job: base };
  } catch (e) {
    // The slice's own validation reports a tower that doesn't fit.
    console.warn('prime tower placement:', e);
    return null;
  }
}

const prefix0 = (label: string) => (plates.value.length > 1 ? `${label}: ` : '');

async function slicePlate(plate: number, label: string): Promise<boolean> {
  const objects = getSliceObjects(plate);
  if (objects.length === 0) {
    error.value = plates.value.length > 1 ? `${label} is empty.` : 'Add a model to the plate first.';
    status.value = 'error';
    return false;
  }
  // IDEX/IQEX parallel mode: Orca won't slice a plate with a part outside T0's zone.
  const misplaced = objectsOnPlate(plate).filter((o) => objectIssues.value.get(o.id)?.includes('zone'));
  if (misplaced.length) {
    error.value = `${prefix0(label)}${misplaced.length === 1 ? `“${misplaced[0].name}” is` : `${misplaced.length} objects are`} outside T0’s zone. Move ${misplaced.length === 1 ? 'it' : 'them'} into the clear area of the bed, or set the plate back to Primary mode.`;
    status.value = 'error';
    return false;
  }
  progress.value = 0;
  message.value = 'Placing the prime tower';
  await placePlateTower(plate, objects);
  const sig = signature(plate);
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
  fireEngineEvents(sliced.report.events);
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

/** Plate `i`'s sliced result, whether it is out of date, and its G-code file name (null = not sliced). */
export function plateSliceResult(i: number): { result: SliceResult; stale: boolean; name: string } | null {
  const r = resultFor(i);
  return r ? { result: r.result, stale: plateStale(i), name: gcodeFilename(i) } : null;
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
  const name = gcodeFilename();
  // Native save dialog where the File System Access API exists (else a download).
  // Post-processing plugins run on a copy once the file is picked (Orca: every export).
  void saveBytes(() => gcodeForOutput(r.gcode, 'File', name), name, 'text/x-gcode', { types: GCODE_TYPES, id: 'cubby-gcode' })
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
        for (const { r, name } of all) {
          const out = await gcodeForOutput(r.gcode, 'File', name);
          if (!out) return;
          await writeHandle(await fileInFolder(dir, name), out);
        }
        toast.success(`Exported ${all.length} plates to ${dir.name}.`, { timeout: 2200 });
      } catch (e) { if ((e as Error)?.name !== 'AbortError') toast.error("Couldn't export G-code.", { detail: (e as Error)?.message }); }
    })();
    return all.length;
  }
  void (async () => {
    for (const { r, name } of all) {
      const out = await gcodeForOutput(r.gcode, 'File', name);
      if (!out) return;
      download({ ...r, gcode: out }, name);
    }
  })();
  return all.length;
}

/** The sliced file (.gcode.3mf) can be written: an OrcaSlicer slice (desktop's File ▸ Export has it for every printer). */
const slicedFileAvailable = computed(() => isOrcaConfig(activeEngine.value));
/**
 * The print button's menu offers it for Bambu Lab printers and printers with
 * "Support 3MF as gcode" (use_3mf) — MainFrame::available_print_actions.
 */
const slicedFileOffered = computed(() => slicedFileAvailable.value && (isBblPrinter() || cfgString(resolvedConfig.value, 'use_3mf', SCALAR) === '1'));

const SLICED_FILE_TYPES: FilePickerAcceptType[] = [{ description: 'Sliced file (.gcode.3mf)', accept: { 'model/3mf': ['.3mf'] } }];

/** The plates' results that are current (desktop only packs valid slice results). */
function currentPlates(list: number[]): number[] {
  return list.filter((i) => resultFor(i) && !plateStale(i));
}

/**
 * The .gcode.3mf of `list` (Plater::export_gcode_3mf). Post-processing plugins
 * run on each plate's G-code first (null: one failed, nothing is written).
 */
async function slicedFileBytes(list: number[], exportPlate: number | null, name: string): Promise<Uint8Array | null> {
  const meta = serializePlates();
  const fallbackIds = identifyIds();
  const sliced = new Map<number, NonNullable<Gcode3mfPlate['sliced']>>();
  const labelIdOf = new Map<string, number>();
  for (const i of list) {
    const r = resultFor(i)!.result;
    const gcode = await gcodeForOutput(r.gcode, 'File', name);
    if (!gcode) return null;
    const scan = scanGcode(gcode);
    const objs = getSliceObjects(i);
    // Bambu G-code lists its label ids sorted; the engine numbers the instances in slice order.
    if (scan.labelIds?.length === objs.length) objs.forEach((o, k) => labelIdOf.set(o.id, scan.labelIds![k]));
    sliced.set(i, {
      gcode, scan, stats: r.report.stats,
      config: { ...resolvedConfig.value, ...(meta[i]?.config ?? {}) },
      objects: objs.map((o) => ({ name: o.name, fallbackId: fallbackIds.get(o.id) ?? 0 })),
    });
  }
  let images: PlateImages[] = [];
  try {
    images = await renderPlateImages((id) => labelIdOf.get(id) ?? fallbackIds.get(id) ?? 0);
  } catch (e) {
    console.warn('Sliced file thumbnails failed', e);
  }
  return buildGcode3mf({
    plates: meta.map((p, i) => ({ name: p.name, locked: p.locked, config: p.config, images: images[i], sliced: sliced.get(i) })),
    exportPlate,
    currentPlate: activePlate.value,
    config: resolvedConfig.value,
    printerModelId: (await currentPresets.value.printerModelId()) ?? '',
    bbl: isBblPrinter(),
    modelMetadataXml: modelMetadataXml(passthroughFor(new Set()).modelMetadata),
    projectSettings: projectSettings(),
    customGcodeXml: customGcodeXml(meta),
  });
}

/**
 * Export the active plate ("Export plate sliced file") or every plate with a
 * current result ("Export all sliced file") as a .gcode.3mf. Returns the number
 * of plates in the file (0: nothing current to export).
 */
function exportSlicedFile(all: boolean): number {
  const list = currentPlates(all ? plates.value.map((_, i) => i) : [activePlate.value]);
  if (!list.length) return 0;
  const stem = all ? safeFileName(projectName.value, 'plates') : gcodeFilename().replace(/\.gcode$/i, '');
  const name = `${stem}${GCODE_3MF_EXT}`;
  void saveBytes(() => slicedFileBytes(list, all ? null : activePlate.value, name), name, 'model/3mf', { types: SLICED_FILE_TYPES, id: 'cubby-gcode' })
    .catch((e) => { toast.error("Couldn't export the sliced file.", { detail: (e as Error)?.message }); });
  return list.length;
}

export function useSliceController() {
  return {
    status, progress, message, error, errorReport, isStale, plateStates,
    slice, sliceAll, cancel, exportGcode, exportAllGcode, gcodeFilename,
    slicedFileAvailable, slicedFileOffered, exportSlicedFile,
  };
}

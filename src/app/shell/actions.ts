/**
 * User-level commands shared by menus, toolbar, context menus and keyboard
 * shortcuts. Everything reports progress/errors through toasts.
 */
import { activeView } from '../state';
import { toast } from '../../ui';
import { ImportError, LIMITS } from '../../project/mesh';
import { MODEL_ACCEPT, isModelFileName, parseModelFile } from '../../project/import';
import { addCompanionMtl, offerObjColors } from '../../tools/objcolor/request';
import { openTool } from '../../tools/state';
import { build3mf } from '../../project/export/threemf';
import { buildStl } from '../../project/export/stl';
import { SAVE_EXT, buildOrca3mfWithThumbnails } from '../../project/persistence/orca3mfWriter';
import { resetSections } from '../../project/persistence/sections';
import {
  activePlate, addParsedObjects, addPlate, arrangeObjects, centerObjects, clearAll, clearPlate, clearSelection, copyObjects,
  deletePlate, dropToBed, duplicateObjects, getMesh, mirrorObjects, objectIssues, objects, objectsOnPlate, pasteObjects, plates,
  projectName, redo, removeInstance, removeObjects, resetProject, rotateObjects, scaleToFit, select, selectAll, selectedIds,
  setActivePlate, setPlateLocked, setPrintable, setTransforms, setVisible, splitToObjects, splitToParts, translateObjects, undo,
  addPart, endGesture,
  type ObjectClipboard,
} from '../../project/store';
import { NudgeBurst } from '@cubby/shared/nudge';
import { plateLabel } from '../../project/plates';
import { PRIMITIVE_LABELS, primitiveFor, primitiveOfSize, type PrimitiveKind } from '../../project/primitives';
import { PART_TYPE_LABELS, type PartType } from '../../project/types';
import { orientObjects } from '../../project/orient';
import { autoOrient as engineAutoOrient } from '../../engine/client';
import { settingsUi } from '../../settings/uiState';
import { fitBed, fitSelection, setGizmo, toggleLayOnFace, viewportState } from '../../viewport/controller';
import { nextTick } from 'vue';
import { dismissToast } from '../../ui';
import { downloadBytes, pickFiles, safeFileName, saveBytes } from './download';
import type { SliceControllerLike } from './external';
import { chooseAction, confirmAction, setClipboard, ui } from './uiState';
import { preferences } from '../preferences';
import { setCloudLocation } from '../../cloud/store';
import { folderAccessSupported, setLocalLocation, STL_TYPES, THREEMF_TYPES } from '../../localfs/store';

let slicer: SliceControllerLike | null = null;
export function bindSliceController(c: SliceControllerLike | null): void { slicer = c; }
export function hasSliceController(): boolean { return !!slicer; }

// ---- import ------------------------------------------------------------------

async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
  ui.busy = label;
  try { return await fn(); } finally { ui.busy = null; }
}

/** Import model buffers (from the file picker, drop, ?model= or postMessage). */
export async function importBuffer(name: string, buffer: ArrayBuffer): Promise<string[]> {
  if (buffer.byteLength > LIMITS.maxFileBytes) {
    toast.error(`${name} is too large to import.`, { detail: `The limit is ${LIMITS.maxFileBytes / 1048576} MB.` });
    return [];
  }
  if (/\.3mf$/i.test(name)) {
    const { sniffOrcaProject } = await import('../../project/import/orca3mf');
    if (sniffOrcaProject(buffer)) {
      const r = await openOrca3mf(name, buffer);
      if (r !== 'models') return r;
    }
  }
  try {
    const res = await withBusy(`Importing ${name}…`, () => parseModelFile(name, buffer));
    const ids = addParsedObjects(res.objects, { label: `Import ${name}` });
    activeView.value = 'prepare';
    // Preferences → Auto arrange plate after import.
    if (preferences.autoArrangeImport && ids.length) { const n = arrangeObjects(undefined, 6, 'plate'); if (n) reportUnplaced(n); }
    // OBJ face colours → filaments (Orca ObjColorDialog).
    if (res.objects.some((o) => o.faceGroups)) void offerObjColors(res.objects, ids);
    if (res.warnings.length) {
      toast.warn(`Imported ${name} with ${res.warnings.length === 1 ? 'a warning' : `${res.warnings.length} warnings`}.`, {
        detail: res.warnings.slice(0, 6).join('\n'),
      });
    }
    return ids;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return []; // e.g. STEP options dialog cancelled
    const msg = e instanceof ImportError ? e.message : `${(e as Error)?.message ?? e}`;
    toast.error(`Couldn't import ${name}.`, { detail: msg });
    return [];
  }
}

/**
 * An OrcaSlicer / Bambu Studio project 3MF: open it as a project (plates,
 * parts, settings, sliced G-code; replaces the current plate) or, on request,
 * import just its models. Returns the new object ids, or 'models' to fall
 * back to a plain mesh import.
 */
async function openOrca3mf(name: string, buffer: ArrayBuffer): Promise<string[] | 'models'> {
  if (objects.value.length) {
    const choice = await chooseAction({
      title: `Open ${name}?`,
      message: 'This is an OrcaSlicer project. Open it as a project (plates, parts and settings) to replace the current plate, or import just its models.',
      confirmLabel: 'Open project',
      altLabel: 'Import models',
    });
    if (choice === null) return [];
    if (choice === 'alt') return 'models';
  }
  try {
    const { openOrcaProject } = await import('../../project/orcaOpen');
    const r = await withBusy(`Opening ${name}…`, () => openOrcaProject(name, buffer));
    setCloudLocation(null);
    setLocalLocation(null); // no file handle: Ctrl+S asks where to save
    activeView.value = r.sliced && !r.objects ? 'preview' : 'prepare';
    const what = [`${r.objects} object${r.objects === 1 ? '' : 's'}`, `${r.plates} plate${r.plates === 1 ? '' : 's'}`, r.sliced ? `G-code for ${r.sliced} plate${r.sliced === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    if (r.warnings.length) toast.warn(`Opened ${name} (${what}).`, { detail: r.warnings.slice(0, 8).join('\n') });
    else toast.success(`Opened ${name} (${what}).`);
    return objects.value.map((o) => o.id);
  } catch (e) {
    const msg = e instanceof ImportError ? e.message : `${(e as Error)?.message ?? e}`;
    toast.error(`Couldn't open ${name}.`, { detail: msg });
    return [];
  }
}

/** Import dropped / picked files. Project 3MFs open as projects; models are added to the plate. */
export async function importFiles(files: Iterable<File>): Promise<void> {
  const list = [...files];
  const models = list.filter((f) => isModelFileName(f.name));
  // Companions: .mtl colours for OBJs, .svg opens the SVG emboss tool.
  const mtls = list.filter((f) => /\.mtl$/i.test(f.name));
  const svgs = list.filter((f) => /\.svg$/i.test(f.name));
  for (const f of mtls) { try { addCompanionMtl(await f.text()); } catch { /* unreadable */ } }
  if (svgs.length) { try { openTool('svg', { svgFile: { name: svgs[0].name, text: await svgs[0].text() } }); } catch { /* unreadable */ } }
  const other = list.filter((f) => !models.includes(f) && !mtls.includes(f) && !svgs.includes(f));
  if (other.length) toast.warn(`Skipped ${other.map((f) => f.name).join(', ')}.`, { detail: 'Supported files: STL, OBJ (+MTL), 3MF (including OrcaSlicer projects), STEP and SVG.' });
  let added = 0;
  for (const f of models) {
    if (f.size > LIMITS.maxFileBytes) {
      toast.error(`${f.name} is too large to import.`, { detail: `The limit is ${LIMITS.maxFileBytes / 1048576} MB.` });
      continue;
    }
    let buf: ArrayBuffer;
    try { buf = await f.arrayBuffer(); } catch { toast.error(`Couldn't read ${f.name}.`); continue; }
    added += (await importBuffer(f.name, buf)).length;
  }
  if (added > 1) toast.success(`Added ${added} objects.`);
}

export async function importDialog(): Promise<void> {
  const files = await pickFiles(MODEL_ACCEPT, true);
  if (files.length) await importFiles(files);
}

// ---- project ------------------------------------------------------------------

export async function newProject(): Promise<void> {
  if (objects.value.length) {
    const ok = await confirmAction({
      title: 'Start a new project?',
      message: 'The current plate will be cleared. Save it first if you want to keep it.',
      confirmLabel: 'Clear plate',
      danger: true,
    });
    if (!ok) return;
  }
  resetProject();
  resetSections();
  setCloudLocation(null);
  setLocalLocation(null);
  activeView.value = 'prepare';
}

export function saveProject(): void {
  void (async () => {
    try {
      const bytes = await buildOrca3mfWithThumbnails();
      downloadBytes(bytes, `${safeFileName(projectName.value, 'project')}${SAVE_EXT}`, 'model/3mf');
      toast.success('Project saved.');
    } catch (e) {
      toast.error("Couldn't save the project.", { detail: (e as Error)?.message });
    }
  })();
}

export async function openProjectDialog(): Promise<void> {
  const [f] = await pickFiles('.3mf', false);
  if (f) await importFiles([f]);
}

// ---- export ------------------------------------------------------------------

export function exportPlate3mf(): void {
  const list = objectsOnPlate(activePlate.value);
  if (!list.length) { toast.info('The plate is empty. Import a model first.'); return; }
  const suffix = plates.value.length > 1 ? `_plate${activePlate.value + 1}` : '';
  void (async () => {
    try { await saveBytes(build3mf(list, getMesh), `${safeFileName(projectName.value)}${suffix}.3mf`, 'model/3mf', { types: THREEMF_TYPES, id: 'cubby-3mf' }); }
    catch (e) { toast.error("Couldn't export 3MF.", { detail: (e as Error)?.message }); }
  })();
}

export function exportStl(selectionOnly: boolean): void {
  const list = selectionOnly ? objects.value.filter((o) => selectedIds.value.includes(o.id)) : objectsOnPlate(activePlate.value).filter((o) => o.printable);
  if (!list.length) { toast.info(selectionOnly ? 'Select objects to export.' : 'The plate is empty. Import a model first.'); return; }
  const name = selectionOnly && list.length === 1 ? list[0].name : projectName.value;
  void (async () => {
    try { await saveBytes(buildStl(list, getMesh), `${safeFileName(name)}.stl`, 'model/stl', { types: STL_TYPES, id: 'cubby-stl' }); }
    catch (e) { toast.error("Couldn't export STL.", { detail: (e as Error)?.message }); }
  })();
}

export async function exportGcode(): Promise<void> {
  if (!slicer) { toast.info('Slicing is not available yet.'); return; }
  try {
    const ok = await slicer.exportGcode();
    if (ok === false) toast.info('Slice the plate before exporting G-code.');
  } catch (e) { toast.error("Couldn't export G-code.", { detail: (e as Error)?.message }); }
}

export async function sliceNow(): Promise<void> {
  if (!slicer) { toast.info('Slicing is not available yet.'); return; }
  try { await slicer.slice(); } catch (e) { toast.error('Slicing failed.', { detail: (e as Error)?.message }); }
}

export async function sliceAllNow(): Promise<void> {
  if (!slicer) { toast.info('Slicing is not available yet.'); return; }
  try { await slicer.sliceAll(); } catch (e) { toast.error('Slicing failed.', { detail: (e as Error)?.message }); }
}

export function exportAllGcode(): void {
  if (!slicer) return;
  const n = slicer.exportAllGcode();
  if (!n) toast.info('Slice the plates before exporting G-code.');
  // With folder access the folder dialog reports the result itself.
  else if (!(folderAccessSupported && n > 1)) toast.success(`Exported G-code for ${n} plate${n === 1 ? '' : 's'}.`, { timeout: 2200 });
}

// ---- plates -------------------------------------------------------------------

export function addPlateCmd(): void {
  const i = addPlate();
  if (i < 0) toast.info('That’s the maximum number of plates.');
  else void nextTick(() => fitBed());
}

export async function deletePlateCmd(i = activePlate.value): Promise<void> {
  if (plates.value.length <= 1) return;
  const n = objectsOnPlate(i).length;
  if (n) {
    const ok = await confirmAction({
      title: `Delete ${plateLabel(plates.value[i], i)}?`,
      message: `This also deletes the ${n === 1 ? 'object' : `${n} objects`} on it. You can undo this.`,
      confirmLabel: 'Delete plate', danger: true,
    });
    if (!ok) return;
  }
  deletePlate(i);
}

export async function clearPlateCmd(i = activePlate.value): Promise<void> {
  const n = objectsOnPlate(i).length;
  if (!n) return;
  clearPlate(i);
  toast.info(`Deleted ${n === 1 ? '1 object' : `${n} objects`} from ${plateLabel(plates.value[i], i)}.`, { timeout: 2200 });
}

/** Make plate `i` active and bring it into view. */
export function selectPlate(i: number): void {
  setActivePlate(i);
  void nextTick(() => fitBed());
}

export function togglePlateLock(i = activePlate.value): void {
  const p = plates.value[i];
  if (p) setPlateLocked(i, !p.locked);
}

export function arrangePlate(): void {
  const n = arrangeObjects(undefined, 6, 'plate');
  if (n) reportUnplaced(n);
}

// ---- instances / split -------------------------------------------------------------

export function removeInstanceSel(): void { if (selectedIds.value.length) removeInstance(); }

export function splitSelectionToParts(): void {
  if (!selectedIds.value.length) return;
  const n = splitToParts();
  if (!n) toast.info('Nothing to split: the selection is a single connected piece.');
  else toast.success(`Split into ${n + 1} parts.`, { timeout: 2200 });
}

/**
 * Orca "Add part / negative part / modifier / support blocker / enforcer":
 * a generic shape sized from the object, or a model file, placed at the
 * object's centre (in its local frame).
 */
export async function addSubObject(type: PartType, source: PrimitiveKind | 'file'): Promise<void> {
  const id = selectedIds.value.length === 1 ? selectedIds.value[0] : null;
  if (!id || !objects.value.some((x) => x.id === id)) { toast.info('Select one object first.'); return; }
  if (source !== 'file') {
    addPrimitivePart(id, type, source);
    if (type === 'modifier') revealObjectSettings();
    return;
  }
  const [f] = await pickFiles(MODEL_ACCEPT, false);
  if (!f) return;
  try {
    const pid = await withBusy(`Loading ${f.name}…`, async () => addModelPart(id, type, f.name, await f.arrayBuffer()));
    if (!pid) { toast.error(`No geometry in ${f.name}.`); return; }
    if (type === 'modifier') revealObjectSettings();
  } catch (e) {
    toast.error(`Couldn’t load ${f.name}.`, { detail: (e as Error)?.message });
  }
}

/** Centre of an object's own mesh bbox (object-local frame). */
function meshCentre(objectId: string): { center: [number, number, number]; size: [number, number, number]; min: [number, number, number] } | null {
  const o = objects.value.find((x) => x.id === objectId);
  const mesh = o ? getMesh(o.meshId) : undefined;
  if (!mesh) return null;
  const b = mesh.bbox;
  return {
    center: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
    size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
    min: [b.min[0], b.min[1], b.min[2]],
  };
}

/**
 * Add a generic shape to an object (Orca load_generic_subobject). Without
 * `size` it is sized from the object like the menu does; without `at` it sits
 * in the object's middle (a slab on its bottom). `at` / `size` are mm in the
 * object's local frame. Returns the part id.
 */
export function addPrimitivePart(objectId: string, type: PartType, source: PrimitiveKind,
  opts: { size?: [number, number, number]; at?: [number, number, number]; name?: string } = {}): string | null {
  const c = meshCentre(objectId);
  if (!c) return null;
  const shape = opts.size ? primitiveOfSize(source, opts.size) : primitiveFor(source, c.size);
  // A slab sits on the bottom of the object (a layer-range modifier); the rest in its middle.
  const slabH = opts.size ? opts.size[2] : Math.max(0.5, Math.min(5, c.size[2] * 0.1));
  const at = opts.at ?? (source === 'slab' ? [c.center[0], c.center[1], c.min[2] + slabH / 2] as [number, number, number] : c.center);
  return addPart(objectId, type, opts.name ?? `${PART_TYPE_LABELS[type]} ${PRIMITIVE_LABELS[source].toLowerCase()}`, shape.positions, shape.indices, at);
}

/** Add a model file's geometry (every mesh in it merged, centred on its own bbox) as a part. Returns the part id, null when the file has no geometry. */
export async function addModelPart(objectId: string, type: PartType, fileName: string, buffer: ArrayBuffer,
  opts: { at?: [number, number, number]; name?: string } = {}): Promise<string | null> {
  const c = meshCentre(objectId);
  if (!c) return null;
  const res = await parseModelFile(fileName, buffer);
  if (!res.objects.length) return null;
  let nv = 0, nt = 0;
  for (const p of res.objects) { nv += p.positions.length; nt += p.indices.length; }
  const pos = new Float32Array(nv), idx = new Uint32Array(nt);
  let vo = 0, io = 0;
  for (const p of res.objects) {
    pos.set(p.positions, vo);
    for (let i = 0; i < p.indices.length; i++) idx[io + i] = p.indices[i] + vo / 3;
    vo += p.positions.length; io += p.indices.length;
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i + k]); mx[k] = Math.max(mx[k], pos[i + k]); }
  const m = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2);
  for (let i = 0; i < pos.length; i += 3) { pos[i] -= m[0]; pos[i + 1] -= m[1]; pos[i + 2] -= m[2]; }
  return addPart(objectId, type, opts.name ?? fileName.replace(/\.[a-z0-9]+$/i, ''), pos, idx, opts.at ?? c.center);
}

export function splitSelectionToObjects(): void {
  if (!selectedIds.value.length) return;
  const n = splitToObjects();
  if (!n) toast.info('Nothing to split: the selection is a single connected piece.');
  else toast.success(`Split into ${n} objects.`, { timeout: 2200 });
}

// ---- edit ------------------------------------------------------------------

export function doUndo(): void { const l = undo(); if (l) toast.info(`Undid ${l.toLowerCase()}.`, { timeout: 1600 }); }
export function doRedo(): void { const l = redo(); if (l) toast.info(`Redid ${l.toLowerCase()}.`, { timeout: 1600 }); }

export function deleteSelection(): void { if (selectedIds.value.length) removeObjects(); }

export function reportUnplaced(n: number): void {
  toast.warn(`${n === 1 ? '1 object doesn’t' : `${n} objects don’t`} fit on the plate.`, { detail: 'They were placed beside the plate. Scale them down or remove some objects.' });
}

export function doDuplicate(count = 1): void {
  if (!selectedIds.value.length) return;
  duplicateObjects(selectedIds.value.slice(), count);
}

export function toggleLayFlat(): void {
  if (!objects.value.length) return;
  toggleLayOnFace();
  if (viewportState.layOnFace) toast.info('Click a face to place it on the bed. Press Esc to cancel.', { timeout: 2500 });
}

export function escape(): void {
  if (viewportState.layOnFace) { toggleLayOnFace(false); return; }
  clearSelection();
}

// ---- object helpers used by the action dispatch ----

export function toggleHiddenSelection(): void {
  const objs = objects.value.filter((o) => selectedIds.value.includes(o.id));
  if (!objs.length) return;
  setVisible(objs.map((o) => o.id), objs.every((o) => !o.visible));
}

export function togglePrintableSelection(): void {
  const objs = objects.value.filter((o) => selectedIds.value.includes(o.id));
  if (!objs.length) return;
  setPrintable(objs.map((o) => o.id), objs.every((o) => !o.printable));
}

export function rotate90(axis: 0 | 1 | 2): void {
  const v: [number, number, number] = [0, 0, 0];
  v[axis] = 1;
  rotateObjects(v, 90);
}

export function cancelSlice(): void { slicer?.cancel(); }

export function startRename(): void {
  if (selectedIds.value.length === 1) ui.renamingId = selectedIds.value[0];
}

/** Select the object and switch the sidebar's Process section to Orca's "Objects" mode. */
export function revealObjectSettings(): void {
  if (!selectedIds.value.length) return;
  select([selectedIds.value.at(-1)!]);
  settingsUi.region = 'objects';
  settingsUi.collapsedSections = settingsUi.collapsedSections.filter((x) => x !== 'process');
  ui.revealObjectSettings++;
}

// ---- clipboard (Orca Ctrl+C / Ctrl+X / Ctrl+V) -------------------------------------

export function copySelection(): void {
  const c = copyObjects();
  if (!c) return;
  setClipboard(c);
  toast.info(`Copied ${c.objects.length === 1 ? c.objects[0].name : `${c.objects.length} objects`}.`, { timeout: 1600 });
}
export function cutSelection(): void {
  const c = copyObjects();
  if (!c) return;
  setClipboard(c);
  removeObjects(c.objects.map((o) => o.id));
}
export function pasteClipboard(): void {
  const c: ObjectClipboard | null = ui.clipboard;
  if (c) pasteObjects(c);
}

export function deleteAll(): void { if (objects.value.length) clearAll(); }

/** Seals a burst of arrow nudges as one undo step once the keys go idle (@cubby/shared/nudge). */
const nudgeBurst = new NudgeBurst(endGesture);

export function nudge(dx: number, dy: number): void {
  if (!selectedIds.value.length) return;
  translateObjects([dx, dy, 0]);
  nudgeBurst.bump();
}

// ---- Auto Orient (OrcaSlicer AutoOrienter in the engine worker) ----------------------

let orientAbort: AbortController | null = null;

/**
 * Orca's "Orient" button / Q: orient the selection, or every object when
 * nothing is selected ('all' = Shift+Q). One undo step; objects are dropped to
 * the bed afterwards and placement problems are reported.
 */
export async function autoOrientObjects(scope: 'auto' | 'all'): Promise<void> {
  if (ui.orienting) return;
  // Orca: Q orients the selection (or the plate when nothing is selected), Shift+Q the active plate; locked plates are skipped.
  const plateIds = () => (plates.value[activePlate.value]?.locked ? [] : objectsOnPlate(activePlate.value).map((o) => o.id));
  const ids = scope === 'all' || !selectedIds.value.length ? plateIds() : selectedIds.value.slice();
  const targets = objects.value.filter((o) => ids.includes(o.id) && o.visible);
  if (!targets.length) { toast.info('Nothing to orient.'); return; }
  ui.orienting = true;
  orientAbort = new AbortController();
  const progressId = 'auto-orient';
  const many = targets.length > 1;
  if (!many) ui.busy = `Orienting ${targets[0].name}…`;
  try {
    const res = await orientObjects(targets, getMesh, engineAutoOrient, {
      signal: orientAbort.signal,
      onProgress: (p) => {
        if (!many || p.done >= p.total) return;
        toast.info(`Auto orienting ${p.done + 1} of ${p.total}…`, {
          id: progressId, timeout: 0, detail: p.name,
          action: { label: 'Stop', run: () => orientAbort?.abort() },
        });
      },
    });
    if (many) dismissToast(progressId);
    if (res.rotations.length) {
      setTransforms(res.rotations.map((r) => ({ id: r.id, rotation: r.rotation })), res.rotations.length === 1 ? 'Auto orient' : `Auto orient ${res.rotations.length} objects`, { drop: true });
    }
    const unsupported = res.failed.length > 0 && res.failed.every((f) => /not support|unsupported|unknown (message|request)|cs_orient/i.test(f.error));
    if (unsupported) {
      toast.error('Auto orient isn’t available.', { detail: 'This build of the Orca engine doesn’t include the orienter. Update the engine files and reload.' });
      return;
    }
    if (res.failed.length) {
      toast.error(`Couldn’t orient ${res.failed.length === 1 ? res.failed[0].name : `${res.failed.length} objects`}.`, {
        detail: res.failed.slice(0, 6).map((f) => `${f.name}: ${f.error}`).join('\n'),
      });
    }
    const outside = res.rotations.filter((r) => objectIssues.value.get(r.id)?.some((i) => i !== 'overlap')).length;
    if (outside) {
      toast.warn(`${outside === 1 ? '1 object no longer fits' : `${outside} objects no longer fit`} on the plate after orienting.`, {
        detail: 'Arrange the plate (A) or scale the object down.',
        action: { label: 'Arrange', run: () => { const n = arrangeObjects(); if (n) reportUnplaced(n); } },
      });
    } else if (res.cancelled) {
      toast.info(`Stopped. Oriented ${res.rotations.length} of ${targets.length} objects.`);
    } else if (!res.failed.length) {
      const n = res.rotations.length;
      toast.success(n ? `Oriented ${n === 1 ? targets.find((t) => t.id === res.rotations[0].id)?.name ?? 'object' : `${n} objects`}.`
        : `${targets.length === 1 ? 'Already' : 'All objects are already'} in the best orientation.`, { timeout: 2200 });
    }
  } finally {
    ui.orienting = false;
    ui.busy = null;
    orientAbort = null;
  }
}

export { setGizmo, fitSelection, centerObjects, dropToBed, mirrorObjects, scaleToFit, selectAll, clearSelection, arrangeObjects };

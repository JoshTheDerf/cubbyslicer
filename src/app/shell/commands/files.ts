/** Import, open, new, save and model export (3MF / STL). */
import { activeView } from '../../state';
import { toast } from '../../../ui';
import { ImportError, LIMITS } from '../../../project/mesh';
import { MODEL_ACCEPT, isModelFileName, parseModelFile } from '../../../project/import';
import { addCompanionMtl, offerObjColors } from '../../../tools/objcolor/request';
import { openTool } from '../../../tools/state';
import { build3mf } from '../../../project/export/threemf';
import { buildStl } from '../../../project/export/stl';
import { SAVE_EXT, buildOrca3mfWithThumbnails } from '../../../project/persistence/orca3mfWriter';
import { resetSections } from '../../../project/persistence/sections';
import { activePlate, addParsedObjects, getMesh, objects, objectsOnPlate, plates, projectName, resetProject, selectedIds } from '../../../project/store';
import { downloadBytes, pickFiles, safeFileName, saveBytes } from '../download';
import { chooseAction, confirmAction, withBusy } from '../uiState';
import { preferences } from '../../preferences';
import { runArrange } from '../arrange';
import { setCloudLocation } from '../../../cloud/store';
import { setLocalLocation, STL_TYPES, THREEMF_TYPES } from '../../../localfs/store';

/**
 * Import model buffers (from the file picker, drop, ?model= or postMessage).
 * `autoArrange` overrides Preferences → Auto arrange plate after import.
 */
export async function importBuffer(name: string, buffer: ArrayBuffer, opts: { autoArrange?: boolean } = {}): Promise<string[]> {
  if (buffer.byteLength > LIMITS.maxFileBytes) {
    toast.error(`${name} is too large to import.`, { detail: `The limit is ${LIMITS.maxFileBytes / 1048576} MB.` });
    return [];
  }
  if (/\.3mf$/i.test(name)) {
    const { sniffOrcaProject } = await import('../../../project/import/orca3mf');
    if (sniffOrcaProject(buffer)) {
      const r = await openOrca3mf(name, buffer);
      if (r !== 'models') return r;
    }
  }
  // CubbyCAD scene: editable CAD objects (one per top-level node).
  if (/\.cubby$/i.test(name)) {
    try {
      const { importCubbyBuffer } = await import('../../../cad/commands');
      const ids = await withBusy(`Importing ${name}…`, () => importCubbyBuffer(name, buffer));
      if (ids.length) activeView.value = 'prepare';
      return ids;
    } catch (e) {
      toast.error(`Couldn't import ${name}.`, { detail: e instanceof ImportError ? e.message : `${(e as Error)?.message ?? e}` });
      return [];
    }
  }
  try {
    const res = await withBusy(`Importing ${name}…`, () => parseModelFile(name, buffer));
    const ids = addParsedObjects(res.objects, { label: `Import ${name}` });
    activeView.value = 'prepare';
    // Preferences → Auto arrange plate after import.
    if ((opts.autoArrange ?? preferences.autoArrangeImport) && ids.length) await runArrange('plate', { imported: ids });
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
    const { openOrcaProject } = await import('../../../project/orcaOpen');
    const r = await withBusy(`Opening ${name}…`, () => openOrcaProject(name, buffer));
    setCloudLocation(null);
    setLocalLocation(null); // no file handle: Ctrl+S asks where to save
    activeView.value = r.sliced && !r.objects ? 'preview' : 'prepare';
    const what = [`${r.objects} object${r.objects === 1 ? '' : 's'}`, `${r.plates} plate${r.plates === 1 ? '' : 's'}`, r.sliced ? `G-code for ${r.sliced} plate${r.sliced === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    if (r.warnings.length) toast.warn(`Opened ${name} (${what}).`, { detail: r.warnings.slice(0, 8).join('\n') });
    else toast.success(`Opened ${name} (${what}).`);
    // Desktop reloads every settings tab after opening a project (load_current_presets → Tab::update),
    // which runs the automatic value changes and their questions.
    void import('../../../settings/applyAutoChanges').then((m) => m.afterProjectOpen());
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
  if (other.length) toast.warn(`Skipped ${other.map((f) => f.name).join(', ')}.`, { detail: 'Supported files: STL, OBJ (+MTL), 3MF (including OrcaSlicer projects), STEP, CubbyCAD (.cubby) and SVG.' });
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

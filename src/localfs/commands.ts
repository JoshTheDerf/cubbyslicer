/**
 * Local file commands (File System Access API): open / import with the
 * native picker, Save back to the opened file, Save as, open recent, and the
 * approved-folder browser's open / save / export.
 */
import { toast } from '../ui';
import { importBuffer, importFiles, openProjectBuffer } from '../app/shell/actions';
import { safeFileName } from '../app/shell/download';
import { projectName } from '../project/store';
import { PROJECT_EXT, buildProjectFile } from '../project/persistence/projectFile';
import { setCloudLocation } from '../cloud/store';
import {
  MODEL_TYPES, PROJECT_TYPES, fileInFolder, local, markLocalSaved, pickOpen, pickSave, readHandle, setLocalLocation, writeHandle,
  type SavedHandle,
} from './store';
import { ref } from 'vue';

/** Folder browser request (LocalFolderDialog). */
export const folderDialog = ref<null | { mode: 'open' | 'save' | 'export'; exportKind?: 'gcode' | '3mf'; suggestedName?: string }>(null);

function fail(what: string, e: unknown): void {
  toast.error(`${what}.`, { detail: (e as Error)?.message ?? String(e) });
}

/** Open a local file handle: a project replaces the plate (and becomes the save target), a model is imported. */
export async function openLocalHandle(handle: FileSystemFileHandle, folder?: string): Promise<boolean> {
  let file: File;
  try { file = await readHandle(handle); } catch (e) { fail(`Couldn't open ${handle.name}`, e); return false; }
  if (file.name.toLowerCase().endsWith(PROJECT_EXT)) {
    const ok = await openProjectBuffer(file.name, await file.arrayBuffer());
    if (ok) { setCloudLocation(null); setLocalLocation({ handle, name: file.name, folder }); projectName.value = file.name.replace(/\.cubbyslice$/i, '') || projectName.value; markLocalSaved(); }
    return ok;
  }
  await importFiles([file]);
  return true;
}

/** File ▸ Open project (native picker). */
export async function openLocalProject(): Promise<void> {
  try {
    const hs = await pickOpen(MODEL_TYPES, false, 'cubby-project');
    if (hs?.[0]) await openLocalHandle(hs[0]);
  } catch (e) { fail("Couldn't open the file", e); }
}

/** File ▸ Import (native picker, several files). */
export async function importLocal(): Promise<void> {
  try {
    const hs = await pickOpen(MODEL_TYPES, true, 'cubby-import');
    if (!hs?.length) return;
    const files = await Promise.all(hs.map((h) => h.getFile()));
    await importFiles(files);
  } catch (e) { fail("Couldn't import", e); }
}

async function writeProject(handle: FileSystemFileHandle): Promise<void> {
  await writeHandle(handle, buildProjectFile());
}

/** Ctrl+S with a local file: write it back. Returns false when there's no local location. */
export async function saveLocal(): Promise<boolean> {
  const loc = local.location;
  if (!loc) return false;
  try {
    await writeProject(loc.handle);
    markLocalSaved();
    toast.success(`Saved ${loc.name}.`, { timeout: 1600 });
  } catch (e) { fail(`Couldn't save ${loc.name}`, e); }
  return true;
}

/** Save as: native save dialog; the chosen file becomes the save target. */
export async function saveLocalAs(): Promise<void> {
  try {
    const h = await pickSave(`${safeFileName(projectName.value, 'project')}${PROJECT_EXT}`, PROJECT_TYPES, 'cubby-project');
    if (!h) return;
    await writeProject(h);
    setCloudLocation(null);
    setLocalLocation({ handle: h, name: h.name });
    projectName.value = h.name.replace(/\.cubbyslice$/i, '') || projectName.value;
    markLocalSaved();
    toast.success(`Saved ${h.name}.`, { timeout: 1600 });
  } catch (e) { fail("Couldn't save the project", e); }
}

export async function openRecent(entry: SavedHandle<FileSystemFileHandle>): Promise<void> {
  await openLocalHandle(entry.handle);
}

/** Save the project into an approved folder under `name`. */
export async function saveProjectInFolder(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    const h = await fileInFolder(dir, name);
    await writeProject(h);
    setCloudLocation(null);
    setLocalLocation({ handle: h, name, folder: dir.name });
    projectName.value = name.replace(/\.cubbyslice$/i, '') || projectName.value;
    markLocalSaved();
    toast.success(`Saved to ${dir.name}.`, { detail: name, timeout: 2000 });
    return true;
  } catch (e) { fail(`Couldn't save ${name}`, e); return false; }
}

/** Write an export (G-code / 3MF) into an approved folder. */
export async function exportInFolder(dir: FileSystemDirectoryHandle, name: string, blob: Blob): Promise<boolean> {
  try {
    await writeHandle(await fileInFolder(dir, name), blob);
    toast.success(`Exported to ${dir.name}.`, { detail: name, timeout: 2000 });
    return true;
  } catch (e) { fail(`Couldn't export ${name}`, e); return false; }
}

export { importBuffer };

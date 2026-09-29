/**
 * Local files through the File System Access API (Chromium browsers): files
 * opened with the native picker keep their handle, so Save writes back in
 * place; Save as / exports use the native save dialog; approved folders (and
 * recent files) are remembered in IndexedDB and re-authorised on use. Without
 * the API everything falls back to <input type=file> + downloads.
 */
import { reactive } from 'vue';
import { projectRevision } from '../project/store';

export const fsAccessSupported = typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'
  && typeof window.showSaveFilePicker === 'function';
export const folderAccessSupported = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

export interface LocalLocation { handle: FileSystemFileHandle; name: string; folder?: string }
export interface SavedHandle<T extends FileSystemHandle = FileSystemHandle> { key: string; name: string; handle: T; addedAt: number }

export const local = reactive({
  /** The local file the project was opened from / last saved to. */
  location: null as LocalLocation | null,
  savedRevision: -1,
  folders: [] as SavedHandle<FileSystemDirectoryHandle>[],
  recent: [] as SavedHandle<FileSystemFileHandle>[],
});

export function isLocalDirty(): boolean {
  return !!local.location && projectRevision.value !== local.savedRevision;
}
export function setLocalLocation(loc: LocalLocation | null): void {
  local.location = loc;
  local.savedRevision = projectRevision.value;
  if (loc) void remember('recent', loc.handle);
}
export function markLocalSaved(): void { local.savedRevision = projectRevision.value; }

// ---- IndexedDB (handles are structured-cloneable) ----

const DB = 'cubby-slicer-fs';
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { for (const s of ['folders', 'recent']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'key' }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx<T>(store: 'folders' | 'recent', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const RECENT_MAX = 12;

async function remember(store: 'folders' | 'recent', handle: FileSystemHandle): Promise<void> {
  try {
    const all = (await tx<SavedHandle[]>(store, 'readonly', (s) => s.getAll())) ?? [];
    // Same entry picked again: keep one record (isSameEntry compares the actual file / folder).
    for (const e of all) if (await e.handle.isSameEntry(handle).catch(() => false)) await tx(store, 'readwrite', (s) => s.delete(e.key));
    await tx(store, 'readwrite', (s) => s.put({ key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: handle.name, handle, addedAt: Date.now() }));
    if (store === 'recent') {
      const list = (await tx<SavedHandle[]>(store, 'readonly', (s) => s.getAll())).sort((a, b) => b.addedAt - a.addedAt);
      for (const e of list.slice(RECENT_MAX)) await tx(store, 'readwrite', (s) => s.delete(e.key));
    }
  } catch { /* private mode / no IDB: nothing remembered */ }
  await loadSaved();
}

export async function forget(store: 'folders' | 'recent', key: string): Promise<void> {
  try { await tx(store, 'readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
  await loadSaved();
}

export async function loadSaved(): Promise<void> {
  try {
    local.folders = ((await tx<SavedHandle<FileSystemDirectoryHandle>[]>('folders', 'readonly', (s) => s.getAll())) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    local.recent = ((await tx<SavedHandle<FileSystemFileHandle>[]>('recent', 'readonly', (s) => s.getAll())) ?? []).sort((a, b) => b.addedAt - a.addedAt);
  } catch { local.folders = []; local.recent = []; }
}

// ---- permissions ----

/** Ask (again) for access; must run from a user gesture the first time in a session. */
export async function ensurePermission(handle: FileSystemHandle, mode: 'read' | 'readwrite'): Promise<boolean> {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  return (await handle.requestPermission?.({ mode })) === 'granted';
}

// ---- pickers ----

export const PROJECT_TYPES: FilePickerAcceptType[] = [{ description: '3MF project (OrcaSlicer compatible)', accept: { 'model/3mf': ['.3mf'] } }];
export const MODEL_TYPES: FilePickerAcceptType[] = [{
  description: 'Models and projects',
  accept: { 'application/octet-stream': ['.stl', '.obj', '.mtl', '.3mf', '.step', '.stp', '.svg'] },
}];
export const GCODE_TYPES: FilePickerAcceptType[] = [{ description: 'G-code', accept: { 'text/x-gcode': ['.gcode'] } }];
export const THREEMF_TYPES: FilePickerAcceptType[] = [{ description: '3MF', accept: { 'model/3mf': ['.3mf'] } }];
export const STL_TYPES: FilePickerAcceptType[] = [{ description: 'STL', accept: { 'model/stl': ['.stl'] } }];

const aborted = (e: unknown) => (e as Error)?.name === 'AbortError';

/** Native open picker; null when cancelled. */
export async function pickOpen(types: FilePickerAcceptType[], multiple: boolean, id: string): Promise<FileSystemFileHandle[] | null> {
  try { return await window.showOpenFilePicker!({ types, multiple, id }); } catch (e) { if (aborted(e)) return null; throw e; }
}

/** Native save picker (starts next to the current local file when there is one); null when cancelled. */
export async function pickSave(suggestedName: string, types: FilePickerAcceptType[], id: string): Promise<FileSystemFileHandle | null> {
  try {
    return await window.showSaveFilePicker!({ suggestedName, types, id, ...(local.location ? { startIn: local.location.handle } : {}) });
  } catch (e) { if (aborted(e)) return null; throw e; }
}

export async function writeHandle(handle: FileSystemFileHandle, data: Blob | Uint8Array): Promise<void> {
  if (!(await ensurePermission(handle, 'readwrite'))) throw new Error('Permission to write the file was denied.');
  const w = await handle.createWritable();
  try { await w.write(data instanceof Blob ? data : new Blob([data as BlobPart])); } finally { await w.close(); }
}

export async function readHandle(handle: FileSystemFileHandle): Promise<File> {
  if (!(await ensurePermission(handle, 'read'))) throw new Error('Permission to read the file was denied.');
  return handle.getFile();
}

// ---- folders ----

export async function addFolder(): Promise<SavedHandle<FileSystemDirectoryHandle> | null> {
  let dir: FileSystemDirectoryHandle;
  try { dir = await window.showDirectoryPicker!({ id: 'cubby-folder', mode: 'readwrite' }); } catch (e) { if (aborted(e)) return null; throw e; }
  await remember('folders', dir);
  for (const f of local.folders) if (await f.handle.isSameEntry(dir).catch(() => false)) return f;
  return null;
}

export interface FolderEntry { kind: 'file' | 'directory'; name: string; handle: FileSystemFileHandle | FileSystemDirectoryHandle; size?: number; modified?: number }

export async function listFolder(dir: FileSystemDirectoryHandle): Promise<FolderEntry[]> {
  if (!(await ensurePermission(dir, 'readwrite')) && !(await ensurePermission(dir, 'read'))) throw new Error(`Permission to read “${dir.name}” was denied.`);
  const out: FolderEntry[] = [];
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') out.push({ kind: 'directory', name, handle: h });
    else {
      let size: number | undefined, modified: number | undefined;
      try { const f = await (h as FileSystemFileHandle).getFile(); size = f.size; modified = f.lastModified; } catch { /* unreadable */ }
      out.push({ kind: 'file', name, handle: h, size, modified });
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
}

/** Create (or open) `name` in `dir` for writing. */
export async function fileInFolder(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle> {
  if (!(await ensurePermission(dir, 'readwrite'))) throw new Error(`Permission to write in “${dir.name}” was denied.`);
  return dir.getFileHandle(name, { create: true });
}

export async function existsInFolder(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

export async function deleteInFolder(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  if (!(await ensurePermission(dir, 'readwrite'))) throw new Error(`Permission to change “${dir.name}” was denied.`);
  await dir.removeEntry(name);
}

if (typeof window !== 'undefined') {
  void loadSaved();
  window.addEventListener('beforeunload', (e) => { if (isLocalDirty()) { e.preventDefault(); e.returnValue = ''; } });
}

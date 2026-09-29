/**
 * IndexedDB autosave. Debounced; meshes are stored as binary typed arrays
 * (structured clone), written once per mesh id. Every operation is guarded —
 * the app works normally when IndexedDB is unavailable (private mode, quota).
 */
import { watch } from 'vue';
import { liveMeshes, loadProjectData, projectName, projectRevision, serializeObjects, serializePaint, serializePlates } from '../store';
import { meshFromArrays, sanitizeObjects, sanitizePaint, sanitizePlates, type MeshRef } from './format';

const DB_NAME = 'cubby-slicer';
const DB_VERSION = 1;
const DEBOUNCE_MS = 1500;

interface StoredProject { name: string; objects: unknown; plates?: unknown; paint?: unknown; meshes: MeshRef[]; savedAt: number }
interface StoredMesh { id: string; positions: Float32Array; indices: Uint32Array }

let dbPromise: Promise<IDBDatabase | null> | null = null;
const storedMeshIds = new Set<string>();

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('project')) db.createObjectStore('project');
        if (!db.objectStoreNames.contains('meshes')) db.createObjectStore('meshes', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

let saving: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | null = null;
let enabled = false;
export let lastAutosaveError: string | null = null;

async function saveNow(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const ms = liveMeshes();
  const data: StoredProject = {
    name: projectName.value,
    objects: serializeObjects(),
    plates: serializePlates(),
    paint: serializePaint(),
    meshes: ms.map((m) => ({ id: m.id, vertexCount: m.vertexCount, triangleCount: m.triangleCount })),
    savedAt: Date.now(),
  };
  const live = new Set(ms.map((m) => m.id));
  try {
    await tx(db, ['project', 'meshes'], 'readwrite', (t) => {
      const mstore = t.objectStore('meshes');
      for (const m of ms) {
        if (storedMeshIds.has(m.id)) continue;
        const rec: StoredMesh = { id: m.id, positions: m.positions, indices: m.indices };
        mstore.put(rec);
      }
      for (const id of storedMeshIds) if (!live.has(id)) mstore.delete(id);
      t.objectStore('project').put(data, 'current');
    });
    for (const id of [...storedMeshIds]) if (!live.has(id)) storedMeshIds.delete(id);
    for (const id of live) storedMeshIds.add(id);
    lastAutosaveError = null;
  } catch (e) {
    lastAutosaveError = (e as Error)?.message ?? 'Autosave failed';
    console.warn('[autosave]', e);
  }
}

export function scheduleAutosave(): void {
  if (!enabled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    saving = saving.then(saveNow, saveNow);
  }, DEBOUNCE_MS);
}

/** Restore the last autosaved plate. Returns the number of objects restored. */
export async function restoreAutosave(): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  try {
    const t = db.transaction(['project', 'meshes'], 'readonly');
    const proj = (await reqP(t.objectStore('project').get('current'))) as StoredProject | undefined;
    const allKeys = (await reqP(t.objectStore('meshes').getAllKeys())) as string[];
    for (const k of allKeys) storedMeshIds.add(String(k));
    if (!proj || !Array.isArray(proj.meshes)) return 0;
    const meshes = [];
    for (const ref of proj.meshes) {
      const rec = (await reqP(db.transaction('meshes').objectStore('meshes').get(ref.id))) as StoredMesh | undefined;
      if (!rec || !(rec.positions instanceof Float32Array) || !(rec.indices instanceof Uint32Array)) continue;
      const vc = rec.positions.length / 3;
      let ok = rec.indices.length % 3 === 0;
      for (let i = 0; ok && i < rec.indices.length; i++) if (rec.indices[i] >= vc) ok = false;
      if (ok) meshes.push(meshFromArrays(rec.id, rec.positions, rec.indices));
    }
    const objects = sanitizeObjects(proj.objects, new Set(meshes.map((m) => m.id)));
    if (!objects.length) return 0;
    loadProjectData({ name: proj.name, objects, meshes, plates: sanitizePlates(proj.plates),
      paint: sanitizePaint(proj.paint, new Set(meshes.map((m) => m.id))) });
    return objects.length;
  } catch (e) {
    console.warn('[autosave] restore failed', e);
    return 0;
  }
}

/** Start watching the project for changes. Call once after restore. */
export function enableAutosave(): void {
  if (enabled) return;
  enabled = true;
  watch([projectRevision, projectName], scheduleAutosave);
  window.addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); timer = null; void saveNow(); } });
}

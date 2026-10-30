/**
 * IndexedDB autosave. Debounced; meshes are stored as binary typed arrays
 * (structured clone), written once per mesh id and shared by the slots that
 * use them. Every operation is guarded — the app works normally when
 * IndexedDB is unavailable (private mode, quota).
 *
 * Each tab saves its plate and preset selection to its own slot (slots.ts),
 * so tabs with different plates don't overwrite each other.
 */
import { watch } from 'vue';
import { exclusive, liveTabIds, tabSession } from '../../app/tabSession';
import { presetsAutosaveData, presetsProjectSection, presetsRevision } from '../../presets/store';
import { liveMeshes, loadProjectData, projectName, projectRevision, serializeObjects, serializePaint, serializePlates } from '../store';
import { meshFromArrays, sanitizeObjects, sanitizePaint, sanitizePlates, type MeshRef } from './format';
import { LEGACY_SLOT, planSlots, slotKey, type SlotMeta } from './slots';

const DB_NAME = 'cubby-slicer';
const DB_VERSION = 1;
const DEBOUNCE_MS = 1500;

interface StoredProject { name: string; objects: unknown; plates?: unknown; paint?: unknown; presets?: unknown; meshes: MeshRef[]; savedAt: number; editedAt?: number }
interface StoredMesh { id: string; positions: Float32Array; indices: Uint32Array }

let dbPromise: Promise<IDBDatabase | null> | null = null;
const storedMeshIds = new Set<string>();
/** This tab's slot (set before the first save). */
let ownSlot: string | null = null;
/** An adopted orphan slot, deleted once this tab has saved its own copy. */
let adoptedSlot: string | null = null;
/** Preset state of the restored slot, saved as-is until the engines have loaded it. */
let pendingPresets: unknown;
/**
 * Last change made in this slot (a new tab adopts the most recently edited
 * closed tab, so a tab that was only looked at doesn't win over real work).
 */
let editedAt = 0;
let projectEdited = false;
let lastPresetsJson = '';

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
  ownSlot ??= slotKey((await tabSession()).id);
  const ms = liveMeshes();
  const presets = presetsAutosaveData(pendingPresets);
  const presetsJson = JSON.stringify(presets);
  if (projectEdited || presetsJson !== lastPresetsJson || !editedAt) editedAt = Date.now();
  projectEdited = false;
  lastPresetsJson = presetsJson;
  const data: StoredProject = {
    name: projectName.value,
    objects: serializeObjects(),
    plates: serializePlates(),
    paint: serializePaint(),
    presets,
    meshes: ms.map((m) => ({ id: m.id, vertexCount: m.vertexCount, triangleCount: m.triangleCount })),
    savedAt: Date.now(),
    editedAt,
  };
  const live = new Set(ms.map((m) => m.id));
  const dropped = [...storedMeshIds].filter((id) => !live.has(id));
  const forget = adoptedSlot;
  try {
    await tx(db, ['project', 'meshes'], 'readwrite', (t) => {
      const mstore = t.objectStore('meshes');
      const pstore = t.objectStore('project');
      for (const m of ms) {
        if (storedMeshIds.has(m.id)) continue;
        const rec: StoredMesh = { id: m.id, positions: m.positions, indices: m.indices };
        mstore.put(rec);
      }
      pstore.put(data, ownSlot!);
      if (forget) pstore.delete(forget);
      // A mesh this tab dropped may still be on another tab's slot.
      if (dropped.length) {
        const all = pstore.getAll();
        all.onsuccess = () => {
          const used = meshIdsOf(all.result as StoredProject[]);
          for (const id of dropped) if (!used.has(id)) mstore.delete(id);
        };
      }
    });
    for (const id of dropped) storedMeshIds.delete(id);
    for (const id of live) storedMeshIds.add(id);
    if (forget === adoptedSlot) adoptedSlot = null;
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

function meshIdsOf(projects: Array<StoredProject | undefined>): Set<string> {
  const out = new Set<string>();
  for (const p of projects) if (Array.isArray(p?.meshes)) for (const m of p.meshes) if (typeof m?.id === 'string') out.add(m.id);
  return out;
}

/**
 * Pick this tab's slot (own → duplicated-from → newest closed tab's), forget
 * old closed-tab slots and meshes nobody uses. Runs under a cross-tab lock so
 * two new tabs don't adopt the same plate.
 */
async function claimSlot(db: IDBDatabase): Promise<StoredProject | undefined> {
  const tab = await tabSession();
  ownSlot = slotKey(tab.id);
  return exclusive('autosave-claim', async () => {
    const t = db.transaction('project', 'readonly');
    const store = t.objectStore('project');
    const [keys, rows] = await Promise.all([reqP(store.getAllKeys()), reqP(store.getAll())]) as [IDBValidKey[], StoredProject[]];
    const slots: SlotMeta[] = keys.map((k, i) => ({
      key: String(k), editedAt: Number(rows[i]?.editedAt ?? rows[i]?.savedAt) || 0, objects: Array.isArray(rows[i]?.objects) ? (rows[i].objects as unknown[]).length : 0,
    }));
    const plan = planSlots(slots, tab, await liveTabIds());
    const proj = plan.restore ? rows[keys.findIndex((k) => String(k) === plan.restore)] : undefined;
    try {
      await tx(db, ['project', 'meshes'], 'readwrite', (w) => {
        const ps = w.objectStore('project');
        for (const k of plan.prune) ps.delete(k);
        // Claim the adopted plate right away (the old slot goes on the first save).
        if (plan.adopt && proj && plan.restore !== ownSlot) ps.put({ ...proj, savedAt: Date.now() }, ownSlot!);
        // Re-read inside this transaction: another tab may have saved since.
        const ms = w.objectStore('meshes');
        const slotsNow = ps.getAll();
        slotsNow.onsuccess = () => {
          const used = meshIdsOf(slotsNow.result as StoredProject[]);
          const all = ms.getAllKeys();
          all.onsuccess = () => { for (const k of all.result) if (!used.has(String(k))) ms.delete(k); };
        };
      });
    } catch (e) { console.warn('[autosave] cleanup failed', e); }
    // The pre-tabs slot is moved even without Web Locks: no tab writes it any more.
    if (plan.restore && plan.restore !== ownSlot && (plan.adopt || plan.restore === LEGACY_SLOT)) adoptedSlot = plan.restore;
    return proj;
  });
}

/** Restore this tab's autosaved plate and presets. Returns the number of objects restored. */
export async function restoreAutosave(): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  try {
    const proj = await claimSlot(db);
    // Meshes this tab can skip writing (other slots' meshes are theirs to clean up).
    const allKeys = new Set(((await reqP(db.transaction('meshes').objectStore('meshes').getAllKeys())) as IDBValidKey[]).map(String));
    for (const id of meshIdsOf([proj])) if (allKeys.has(id)) storedMeshIds.add(id);
    if (proj) editedAt = Number(proj.editedAt ?? proj.savedAt) || 0;
    if (proj?.presets) {
      lastPresetsJson = JSON.stringify(proj.presets);
      pendingPresets = proj.presets;
      void presetsProjectSection.load(proj.presets).finally(() => { pendingPresets = undefined; scheduleAutosave(); });
    }
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
  watch([projectRevision, projectName], () => { projectEdited = true; scheduleAutosave(); });
  watch(presetsRevision, scheduleAutosave);
  window.addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); timer = null; void saveNow(); } });
}

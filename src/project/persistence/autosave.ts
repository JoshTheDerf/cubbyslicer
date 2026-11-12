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
import { liveMeshes, loadProjectData, projectName, projectRevision, serializeObjects, serializePaint, serializePlates, serializeTexture } from '../store';
import { sanitizeTexture } from '../../texture/persist';
import { meshFromArrays, sanitizeObjects, sanitizePaint, sanitizePlates, type MeshRef } from './format';
import { isEmptyPassthrough, passthroughFor, passthroughRevision, sanitizeProjectPassthrough, setProjectPassthrough } from './passthrough';
import { LEGACY_SLOT, planSlots, slotKey, type SlotMeta } from './slots';

const DB_NAME = 'cubby-slicer';
/** 2: + the `passthrough` store (project-level 3MF passthrough per slot, written only when it changes). */
const DB_VERSION = 2;
const DEBOUNCE_MS = 1500;

interface StoredProject { name: string; objects: unknown; plates?: unknown; paint?: unknown; texture?: unknown; presets?: unknown; meshes: MeshRef[]; savedAt: number; editedAt?: number }
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
/** passthroughRevision when this slot's passthrough was last written (-1: write on the next save). */
let savedPassthroughRev = -1;

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
        if (!db.objectStoreNames.contains('passthrough')) db.createObjectStore('passthrough');
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
    texture: serializeTexture(),
    presets,
    meshes: ms.map((m) => ({ id: m.id, vertexCount: m.vertexCount, triangleCount: m.triangleCount })),
    savedAt: Date.now(),
    editedAt,
  };
  const live = new Set(ms.map((m) => m.id));
  const dropped = [...storedMeshIds].filter((id) => !live.has(id));
  const forget = adoptedSlot;
  const rev = passthroughRevision.value;
  const pass = rev !== savedPassthroughRev ? passthroughFor(live) : null;
  try {
    await tx(db, ['project', 'meshes', 'passthrough'], 'readwrite', (t) => {
      const mstore = t.objectStore('meshes');
      const pstore = t.objectStore('project');
      const xstore = t.objectStore('passthrough');
      if (pass) { if (isEmptyPassthrough(pass)) xstore.delete(ownSlot!); else xstore.put(pass, ownSlot!); }
      if (forget) xstore.delete(forget);
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
    if (pass) savedPassthroughRev = rev;
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
async function claimSlot(db: IDBDatabase): Promise<{ proj: StoredProject | undefined; key: string | null }> {
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
      await tx(db, ['project', 'meshes', 'passthrough'], 'readwrite', (w) => {
        const ps = w.objectStore('project');
        const xs = w.objectStore('passthrough');
        for (const k of plan.prune) { ps.delete(k); xs.delete(k); }
        // Passthrough records whose slot is gone.
        const live = new Set(keys.map(String).filter((k) => !plan.prune.includes(k)));
        if (plan.adopt) live.add(ownSlot!);
        const xkeys = xs.getAllKeys();
        xkeys.onsuccess = () => { for (const k of xkeys.result) if (!live.has(String(k))) xs.delete(k); };
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
    return { proj, key: plan.restore };
  });
}

/** Restore this tab's autosaved plate and presets. Returns the number of objects restored. */
export async function restoreAutosave(): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  try {
    const { proj, key } = await claimSlot(db);
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
    const meshIds = new Set(meshes.map((m) => m.id));
    const objects = sanitizeObjects(proj.objects, meshIds);
    if (!objects.length) return 0;
    loadProjectData({ name: proj.name, objects, meshes, plates: sanitizePlates(proj.plates), paint: sanitizePaint(proj.paint, meshIds), texture: sanitizeTexture(proj.texture, meshIds) });
    const stored = key ? await reqP(db.transaction('passthrough').objectStore('passthrough').get(key)).catch(() => undefined) : undefined;
    const pass = sanitizeProjectPassthrough(stored, meshIds);
    if (pass) setProjectPassthrough(pass);
    // Restored from another slot (adopted / duplicated tab): write it under this tab's slot.
    savedPassthroughRev = pass && key !== ownSlot ? -1 : passthroughRevision.value;
    return objects.length;
  } catch (e) {
    console.warn('[autosave] restore failed', e);
    return 0;
  }
}

/** Start watching the project for changes. Call once after restore. */
/** Startup restore is over and edits are being saved (tests wait for this before starting clean). */
export function autosaveEnabled(): boolean { return enabled; }

export function enableAutosave(): void {
  if (enabled) return;
  enabled = true;
  watch([projectRevision, projectName], () => { projectEdited = true; scheduleAutosave(); });
  watch(presetsRevision, scheduleAutosave);
  watch(passthroughRevision, scheduleAutosave);
  window.addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); timer = null; void saveNow(); } });
}

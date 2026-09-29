/**
 * Tiny key/value persistence with graceful degradation:
 * IndexedDB → localStorage → in-memory. Every access is wrapped in try/catch
 * (private mode, blocked storage, quota) so callers never see storage errors.
 */

export interface KvBackend {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory';
  getAll(prefix: string): Promise<Array<[string, unknown]>>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryKv(): KvBackend {
  const m = new Map<string, string>();
  return {
    kind: 'memory',
    async getAll(prefix) { return [...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, JSON.parse(v)]); },
    async set(key, value) { m.set(key, JSON.stringify(value)); },
    async delete(key) { m.delete(key); },
  };
}

export function localStorageKv(storage: Storage): KvBackend {
  return {
    kind: 'localstorage',
    async getAll(prefix) {
      const out: Array<[string, unknown]> = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        try { out.push([k, JSON.parse(storage.getItem(k) ?? 'null')]); } catch { /* skip corrupt */ }
      }
      return out;
    },
    async set(key, value) { storage.setItem(key, JSON.stringify(value)); },
    async delete(key) { storage.removeItem(key); },
  };
}

const DB_NAME = 'cubby-slicer';
const STORE = 'kv';

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function indexedDbKv(factory: IDBFactory): Promise<KvBackend> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  const tx = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
  return {
    kind: 'indexeddb',
    async getAll(prefix) {
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      const store = tx('readonly');
      const [keys, values] = await Promise.all([idbRequest(store.getAllKeys(range)), idbRequest(store.getAll(range))]);
      return keys.map((k, i) => [String(k), values[i]]);
    },
    async set(key, value) { await idbRequest(tx('readwrite').put(JSON.parse(JSON.stringify(value)), key)); },
    async delete(key) { await idbRequest(tx('readwrite').delete(key)); },
  };
}

/** Wraps a backend so failures fall back to memory for the rest of the session. */
export function resilient(primary: KvBackend): KvBackend {
  let active = primary;
  const mem = memoryKv();
  const guard = async <T>(fn: (b: KvBackend) => Promise<T>): Promise<T> => {
    try { return await fn(active); } catch {
      if (active !== mem) { active = mem; }
      return fn(mem);
    }
  };
  return {
    get kind() { return active.kind; },
    getAll: (p) => guard((b) => b.getAll(p)),
    set: (k, v) => guard((b) => b.set(k, v)),
    delete: (k) => guard((b) => b.delete(k)),
  };
}

let defaultKv: Promise<KvBackend> | null = null;

/** Best available backend in this environment. */
export function openKv(): Promise<KvBackend> {
  defaultKv ??= (async () => {
    try {
      const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (f) return resilient(await indexedDbKv(f));
    } catch { /* fall through */ }
    try {
      const ls = (globalThis as { localStorage?: Storage }).localStorage;
      if (ls) { const probe = '__cubby_probe__'; ls.setItem(probe, '1'); ls.removeItem(probe); return resilient(localStorageKv(ls)); }
    } catch { /* fall through */ }
    return memoryKv();
  })();
  return defaultKv;
}

/** Synchronous localStorage helpers for small UI state (selection, overrides). */
export function lsGet<T>(key: string): T | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    const raw = ls?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

export function lsSet(key: string, value: unknown): void {
  try { (globalThis as { localStorage?: Storage }).localStorage?.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

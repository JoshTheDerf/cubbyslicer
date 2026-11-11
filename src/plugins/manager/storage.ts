/**
 * Persistent plugin storage: the OPFS directory `cubby-plugins/`, laid out like
 * Orca's data_dir():
 *
 *   orca_plugins/<escaped file name>/<entry .py|.whl> + .install_state.json
 *   orca_plugins/config.json                     global capability configs
 *   orca_plugins/plugin_data/<plugin_key>/…      plugin storage() (the runtime worker mounts it)
 *
 * Browsers without OPFS writes on the main thread fall back to an IndexedDB
 * file table (`cubby-plugins-fs`) with the same paths; plugin_data is then
 * memory-only in the runtime (said in the Diagnostics log). Tests use the
 * in-memory implementation.
 */

export interface PluginFs {
  readonly kind: 'opfs' | 'idb' | 'memory';
  readBytes(path: string): Promise<Uint8Array | null>;
  readText(path: string): Promise<string | null>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  /** Direct children of a directory ([] when missing). */
  list(dir: string): Promise<Array<{ name: string; kind: 'file' | 'directory' }>>;
  /** Remove a file or a directory tree (no-op when missing). */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export const ROOT_DIR = 'cubby-plugins';
const split = (p: string) => p.split('/').filter(Boolean);
const enc = new TextEncoder(), dec = new TextDecoder();
const toBytes = (d: string | Uint8Array) => (typeof d === 'string' ? enc.encode(d) : d);

// ---- memory ---------------------------------------------------------------------

export function memoryFs(): PluginFs {
  const files = new Map<string, Uint8Array>();
  const norm = (p: string) => split(p).join('/');
  return {
    kind: 'memory',
    async readBytes(p) { return files.get(norm(p))?.slice() ?? null; },
    async readText(p) { const b = files.get(norm(p)); return b ? dec.decode(b) : null; },
    async write(p, d) { files.set(norm(p), toBytes(d).slice()); },
    async list(dir) {
      const pre = norm(dir) ? norm(dir) + '/' : '';
      const out = new Map<string, 'file' | 'directory'>();
      for (const k of files.keys()) {
        if (!k.startsWith(pre)) continue;
        const rest = k.slice(pre.length).split('/');
        out.set(rest[0], rest.length > 1 ? 'directory' : 'file');
      }
      return [...out].map(([name, kind]) => ({ name, kind }));
    },
    async remove(p) { const n = norm(p); for (const k of [...files.keys()]) if (k === n || k.startsWith(n + '/')) files.delete(k); },
    async rename(a, b) {
      const na = norm(a), nb = norm(b);
      for (const [k, v] of [...files]) if (k === na || k.startsWith(na + '/')) { files.delete(k); files.set(nb + k.slice(na.length), v); }
    },
  };
}

// ---- OPFS -----------------------------------------------------------------------

export async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    return root ? await root.getDirectoryHandle(ROOT_DIR, { create: true }) : null;
  } catch { return null; }
}

function opfsFs(root: FileSystemDirectoryHandle): PluginFs {
  const dirOf = async (parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> => {
    let d = root;
    for (const p of parts) {
      try { d = await d.getDirectoryHandle(p, { create }); } catch { return null; }
    }
    return d;
  };
  const fileOf = async (p: string, create: boolean) => {
    const parts = split(p);
    const d = await dirOf(parts.slice(0, -1), create);
    if (!d) return null;
    try { return await d.getFileHandle(parts[parts.length - 1], { create }); } catch { return null; }
  };
  const self: PluginFs = {
    kind: 'opfs',
    async readBytes(p) {
      const h = await fileOf(p, false);
      return h ? new Uint8Array(await (await h.getFile()).arrayBuffer()) : null;
    },
    async readText(p) { const b = await self.readBytes(p); return b ? dec.decode(b) : null; },
    async write(p, data) {
      const h = await fileOf(p, true);
      if (!h) throw new Error(`Couldn't create ${p}`);
      const w = await h.createWritable();
      await w.write(toBytes(data) as BlobPart);
      await w.close();
    },
    async list(dir) {
      const d = await dirOf(split(dir), false);
      const out: Array<{ name: string; kind: 'file' | 'directory' }> = [];
      if (!d) return out;
      for await (const [name, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) out.push({ name, kind: h.kind });
      return out;
    },
    async remove(p) {
      const parts = split(p);
      const d = await dirOf(parts.slice(0, -1), false);
      try { await d?.removeEntry(parts[parts.length - 1], { recursive: true }); } catch { /* missing */ }
    },
    async rename(a, b) {
      // OPFS has no portable directory move: copy then delete.
      const copy = async (from: string, to: string) => {
        const bytes = await self.readBytes(from);
        if (bytes) { await self.write(to, bytes); return; }
        for (const e of await self.list(from)) await copy(`${from}/${e.name}`, `${to}/${e.name}`);
      };
      await copy(a, b);
      await self.remove(a);
    },
  };
  return self;
}

// ---- IndexedDB fallback ---------------------------------------------------------------

function idbFs(): PluginFs {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('cubby-plugins-fs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const s = (await db()).transaction('files', mode).objectStore('files');
    return new Promise((res, rej) => { const r = fn(s); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  };
  const keys = () => tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((k) => k.map(String));
  const norm = (p: string) => split(p).join('/');
  const self: PluginFs = {
    kind: 'idb',
    async readBytes(p) { const v = await tx<Uint8Array | undefined>('readonly', (s) => s.get(norm(p))); return v ? new Uint8Array(v) : null; },
    async readText(p) { const b = await self.readBytes(p); return b ? dec.decode(b) : null; },
    async write(p, d) { await tx('readwrite', (s) => s.put(toBytes(d).slice(), norm(p))); },
    async list(dir) {
      const pre = norm(dir) ? norm(dir) + '/' : '';
      const out = new Map<string, 'file' | 'directory'>();
      for (const k of await keys()) if (k.startsWith(pre)) { const r = k.slice(pre.length).split('/'); out.set(r[0], r.length > 1 ? 'directory' : 'file'); }
      return [...out].map(([name, kind]) => ({ name, kind }));
    },
    async remove(p) { const n = norm(p); for (const k of await keys()) if (k === n || k.startsWith(n + '/')) await tx('readwrite', (s) => s.delete(k)); },
    async rename(a, b) {
      const na = norm(a), nb = norm(b);
      for (const k of await keys()) if (k === na || k.startsWith(na + '/')) {
        const v = await self.readBytes(k);
        if (v) await self.write(nb + k.slice(na.length), v);
        await tx('readwrite', (s) => s.delete(k));
      }
    },
  };
  return self;
}

let fsPromise: Promise<PluginFs> | null = null;

/** The app's plugin storage (OPFS, else IndexedDB, else memory). */
export function pluginFs(): Promise<PluginFs> {
  return (fsPromise ??= (async () => {
    const root = typeof navigator !== 'undefined' ? await opfsRoot() : null;
    const canWrite = typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
    if (root && canWrite) return opfsFs(root);
    if (typeof indexedDB !== 'undefined') return idbFs();
    return memoryFs();
  })());
}

/** Test hook. */
export function _setPluginFs(fs: PluginFs | null): void { fsPromise = fs ? Promise.resolve(fs) : null; }

/** Ask the browser not to evict plugin storage (once, on first install). */
export async function requestPersistence(): Promise<void> {
  try { if (!(await navigator.storage?.persisted?.())) await navigator.storage?.persist?.(); } catch { /* not offered */ }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

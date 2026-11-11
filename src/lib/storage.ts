/**
 * Safe Web Storage access. Every call swallows the errors browsers throw when
 * storage is blocked, full or missing (private mode, sandboxed iframes, node
 * tests) and reports failure through its return value instead.
 */

export type StorageKind = 'local' | 'session';

/** The Storage object, or null when unavailable / access throws. */
export function webStorage(kind: StorageKind = 'local'): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage; sessionStorage?: Storage })[kind === 'local' ? 'localStorage' : 'sessionStorage'] ?? null;
  } catch { return null; }
}

/** The raw string, or null when missing / unavailable. */
export function readString(key: string, kind: StorageKind = 'local'): string | null {
  try { return webStorage(kind)?.getItem(key) ?? null; } catch { return null; }
}

/** Store a raw string; false when it couldn't be stored. */
export function writeString(key: string, value: string, kind: StorageKind = 'local'): boolean {
  try {
    const st = webStorage(kind);
    if (!st) return false;
    st.setItem(key, value);
    return true;
  } catch { return false; }
}

/** Parsed JSON, or null when missing, empty, unparseable or unavailable. Validate the shape yourself. */
export function readJson<T = unknown>(key: string, kind: StorageKind = 'local'): T | null {
  const raw = readString(key, kind);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/** Store a value as JSON; false when it couldn't be stored. */
export function writeJson(key: string, value: unknown, kind: StorageKind = 'local'): boolean {
  let raw: string;
  try { raw = JSON.stringify(value); } catch { return false; }
  return writeString(key, raw, kind);
}

/** Whether the key is set (false when unavailable). */
export function hasKey(key: string, kind: StorageKind = 'local'): boolean {
  return readString(key, kind) !== null;
}

/** Remove a key; true when it was set and is now gone. */
export function removeKey(key: string, kind: StorageKind = 'local'): boolean {
  try {
    const st = webStorage(kind);
    if (!st || st.getItem(key) === null) return false;
    st.removeItem(key);
    return true;
  } catch { return false; }
}

/** All keys (optionally only those starting with `prefix`). */
export function storageKeys(prefix = '', kind: StorageKind = 'local'): string[] {
  const out: string[] = [];
  try {
    const st = webStorage(kind);
    for (let i = 0; st && i < st.length; i++) {
      const k = st.key(i);
      if (k !== null && k.startsWith(prefix)) out.push(k);
    }
  } catch { /* storage blocked */ }
  return out;
}

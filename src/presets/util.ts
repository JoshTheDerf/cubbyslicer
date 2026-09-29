/** Small async / fetch helpers shared by the catalogs. */

export type JsonFetcher = (url: string) => Promise<unknown | null>;

/** Default fetcher: JSON or null on any failure (404, parse error, offline). */
export const fetchJson: JsonFetcher = async (url) => {
  try {
    const rsp = await fetch(url);
    if (!rsp.ok) return null;
    return await rsp.json();
  } catch {
    return null;
  }
};

/** Map with bounded concurrency; preserves order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Profile asset base for an engine (`/slicer/wasm/<engine>/profiles`). */
export function profileBase(engine: string): string {
  const env = (import.meta as { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL ?? '/';
  return `${base}wasm/${engine}/profiles`;
}

/**
 * Encode each path segment (vendor dirs and preset files contain spaces, '@', '+', '#').
 * Keeps RFC 3986 sub-delims / '@' literal — some static servers (Vite dev) don't decode %40.
 */
export function encodePath(path: string): string {
  return path.split('/').map((s) => encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F')).join('/');
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '');
  if (typeof v === 'string' && v !== '') return v.split(';').map((s) => s.trim()).filter(Boolean);
  return [];
}

export function str(v: unknown): string {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : v[0] === undefined ? '' : String(v[0]);
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Orca alias: preset name up to '@', trimmed ("Generic PLA @BBL X1C" → "Generic PLA"). */
export function aliasOf(name: string, explicit?: string): string {
  if (explicit) return explicit;
  const at = name.indexOf('@');
  return (at >= 0 ? name.slice(0, at) : name).trim();
}

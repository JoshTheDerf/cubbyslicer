/**
 * The user's own textures (desktop TextureLibrary.cpp "My textures": imports
 * and image-adjustment copies written to <data_dir>/textures/displacement).
 * Kept in the browser's IndexedDB (presets/kv: localStorage / memory when it
 * is blocked) as PNG bytes, one record per texture. Names are made unique the
 * way desktop names files ("Stone", "Stone (2)", ...); the list is most
 * recently used first (desktop's recent_textures, kept here in localStorage).
 * Removing one doesn't touch layers already using it: they hold the image.
 */
import { shallowRef } from 'vue';
import { openKv, type KvBackend } from '../presets/kv';
import { readJson, writeJson } from '../lib/storage';

export interface UserTexture { id: string; name: string; image: Uint8Array }

const PREFIX = 'cubby-slicer:texture:';
const RECENT_KEY = 'cubby-slicer:texture-recent';
/** RECENT_MAX. */
const RECENT_MAX = 200;

let kvOverride: KvBackend | null = null;
/** Tests: a backend of their own. */
export function setUserTextureKv(kv: KvBackend | null): void { kvOverride = kv; loaded = null; memRecent = null; userTextures.value = []; }
const kv = () => (kvOverride ? Promise.resolve(kvOverride) : openKv());

/** The list, most recently used first (empty until loaded). */
export const userTextures = shallowRef<UserTexture[]>([]);
let loaded: Promise<UserTexture[]> | null = null;

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The session's copy (what is used when storage is blocked). */
let memRecent: string[] | null = null;
function recent(): string[] {
  if (memRecent) return memRecent;
  const r = readJson<unknown>(RECENT_KEY);
  memRecent = Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
  return memRecent;
}
function setRecent(ids: string[]): void {
  memRecent = ids.slice(0, RECENT_MAX);
  writeJson(RECENT_KEY, memRecent);
}

/** sort_user_textures: recently used first, the rest by name. */
export function sortByRecent(list: UserTexture[], order: string[]): UserTexture[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...list].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.name.localeCompare(b.name));
}

/** Load (once) and return the user's textures. */
export function loadUserTextures(): Promise<UserTexture[]> {
  loaded ??= (async () => {
    const out: UserTexture[] = [];
    try {
      for (const [key, v] of await (await kv()).getAll(PREFIX)) {
        const r = v as { name?: unknown; png?: unknown };
        if (typeof r?.name !== 'string' || typeof r.png !== 'string') continue;
        try { out.push({ id: key.slice(PREFIX.length), name: r.name, image: unb64(r.png) }); } catch { /* corrupt */ }
      }
    } catch { /* storage unavailable: an empty library */ }
    userTextures.value = sortByRecent(out, recent());
    return userTextures.value;
  })();
  return loaded;
}

/** write_user_texture's naming: `stem`, else "stem (2)", "stem (3)", ... */
export function uniqueName(stem: string, taken: Iterable<string>): string {
  const base = stem.trim() || 'texture';
  const set = new Set([...taken].map((n) => n.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!set.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
}

/** Save a PNG as a new user texture (import / "Save as copy"); it becomes the most recently used. */
export async function saveUserTexture(stem: string, image: Uint8Array): Promise<UserTexture> {
  await loadUserTextures();
  const name = uniqueName(stem, userTextures.value.map((t) => t.name));
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await (await kv()).set(PREFIX + id, { name, png: b64(image) });
  const t: UserTexture = { id, name, image };
  userTextures.value = [t, ...userTextures.value];
  touchUserTexture(id);
  return t;
}

/** touch_user_texture: move it to the front of the recently used. */
export function touchUserTexture(id: string): void {
  setRecent([id, ...recent().filter((x) => x !== id)]);
  userTextures.value = sortByRecent(userTextures.value, recent());
}

/** remove_user_texture. */
export async function removeUserTexture(id: string): Promise<void> {
  await (await kv()).delete(PREFIX + id);
  setRecent(recent().filter((x) => x !== id));
  userTextures.value = userTextures.value.filter((t) => t.id !== id);
}

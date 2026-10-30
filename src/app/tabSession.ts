/**
 * Per-tab identity, so several CubbySlicer tabs can each keep their own plate
 * and printer selection.
 *
 * The id lives in sessionStorage (it survives a reload, and the browser's
 * "reopen closed tab"), and the tab holds a Web Lock named after it for its
 * whole lifetime. A duplicated tab copies sessionStorage, so it finds the lock
 * already held and takes a fresh id, remembering the original in `clonedFrom`.
 * Other tabs ask `liveTabIds()` which ids belong to an open tab.
 */

const SS_KEY = 'cubby.tab.id';
const LOCK_PREFIX = 'cubby-slicer.tab.';

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function ss(): Storage | null {
  try { return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null; } catch { return null; }
}

function locks(): LockManager | null {
  try { return (globalThis as { navigator?: Navigator }).navigator?.locks ?? null; } catch { return null; }
}

export interface TabSession {
  id: string;
  /** Set when this tab was duplicated from another open tab (same sessionStorage). */
  clonedFrom: string | null;
}

let session: Promise<TabSession> | null = null;

/** Hold `name` until the page goes away. Resolves false when another tab holds it. */
function holdForever(lm: LockManager, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    lm.request(name, { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      return lock ? new Promise<void>(() => { /* released when the tab closes */ }) : undefined;
    }).catch(() => resolve(true));
  });
}

/** This tab's id (claimed once per page load). */
export function tabSession(): Promise<TabSession> {
  session ??= (async () => {
    const store = ss();
    let id = store?.getItem(SS_KEY) ?? null;
    let clonedFrom: string | null = null;
    const lm = locks();
    if (id && lm && !(await holdForever(lm, LOCK_PREFIX + id))) {
      clonedFrom = id;
      id = null;
    }
    if (!id) {
      id = newId();
      if (lm) await holdForever(lm, LOCK_PREFIX + id);
    }
    try { store?.setItem(SS_KEY, id); } catch { /* storage blocked: id lasts for this page */ }
    return { id, clonedFrom };
  })();
  return session;
}

/**
 * Ids of the tabs open right now (this one included). Null when the browser
 * has no Web Locks, so callers can't tell open tabs from closed ones.
 */
export async function liveTabIds(): Promise<Set<string> | null> {
  const lm = locks();
  if (!lm) return null;
  try {
    const q = await lm.query();
    const ids = new Set<string>();
    for (const l of q.held ?? []) if (l.name?.startsWith(LOCK_PREFIX)) ids.add(l.name.slice(LOCK_PREFIX.length));
    return ids;
  } catch { return null; }
}

/** Run `fn` while no other tab runs a section with the same name (no-op lock without Web Locks). */
export async function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const lm = locks();
  if (!lm) return fn();
  return lm.request(`cubby-slicer.${name}`, fn);
}

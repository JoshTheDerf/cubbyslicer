/**
 * Which autosave slot a tab restores, and which slots to forget (pure; the
 * IndexedDB side is autosave.ts).
 *
 * Every tab autosaves to its own slot `tab:<id>`. On load a tab restores, in
 * order: its own slot (reload), the slot of the tab it was duplicated from
 * (copied), or the most recently edited slot no open tab owns (a closed or crashed
 * tab, or the single pre-tabs `current` slot), which it adopts so a second
 * new tab doesn't open the same plate.
 */

export const LEGACY_SLOT = 'current';
export const MAX_ORPHANS = 8;
export const ORPHAN_MAX_AGE_MS = 30 * 24 * 3600_000;

export const slotKey = (tabId: string) => `tab:${tabId}`;
const tabOf = (key: string) => (key.startsWith('tab:') ? key.slice(4) : null);

/** `editedAt`: the slot's last change (older slots: last save). */
export interface SlotMeta { key: string; editedAt: number; objects: number }

export interface SlotPlan {
  /** Slot to restore (null: start empty). */
  restore: string | null;
  /** Delete `restore` once this tab saved its own copy (an adopted orphan). */
  adopt: boolean;
  /** Slots to delete now. */
  prune: string[];
}

/**
 * @param live ids of the open tabs, or null when unknown (no Web Locks): then
 *   nothing is adopted or pruned by count, since the slot may belong to an open tab.
 */
export function planSlots(slots: SlotMeta[], tab: { id: string; clonedFrom: string | null }, live: Set<string> | null, now = Date.now()): SlotPlan {
  const own = slotKey(tab.id);
  const isLive = (s: SlotMeta) => { const t = tabOf(s.key); return t !== null && (t === tab.id || !!live?.has(t)); };
  const orphans = slots.filter((s) => !isLive(s)).sort((a, b) => b.editedAt - a.editedAt);

  let restore: string | null = null;
  let adopt = false;
  if (slots.some((s) => s.key === own)) restore = own;
  else if (tab.clonedFrom && slots.some((s) => s.key === slotKey(tab.clonedFrom!))) restore = slotKey(tab.clonedFrom);
  else {
    const pick = orphans.find((s) => s.objects > 0);
    if (pick) { restore = pick.key; adopt = live !== null; }
  }

  const prune: string[] = [];
  let kept = 0;
  for (const s of orphans) {
    if (s.key === restore) continue;
    const stale = now - s.editedAt > ORPHAN_MAX_AGE_MS;
    if (live === null) { if (stale) prune.push(s.key); continue; }
    if (stale || s.objects === 0 || kept >= MAX_ORPHANS) prune.push(s.key);
    else kept++;
  }
  return { restore, adopt, prune };
}

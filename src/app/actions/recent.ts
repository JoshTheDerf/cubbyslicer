/**
 * Speed Dial (command palette) history, per browser (best effort). Mirrors Orca 2.5's
 * ActionRegistry user state (ActionRegistry.cpp):
 *
 *  - run stats per action id ({count, last}): `run()` bumps them; the palette sorts by
 *    frecency (count halved every 30 idle days, `frecency_score`) and lists the last-N
 *    launched as "Recent" (`snapshot()`; N = the "Recent actions" preference, 0–10, default 5);
 *  - favourites: the ordered pin list, capped at 10 (`kFavLimit`, the Alt/Option+1–9, 0 slots);
 *    pinning an 11th is refused (`set_favourite` returns false);
 *  - the footer's expand / collapse state (`tooltip_expanded`, global, default expanded);
 *  - the plugin run-confirm's "Don't ask again" ids (`should_ask` / `suppress_ask`).
 */
import { computed, ref, watch } from 'vue';
import { readJson, writeJson } from '../../lib/storage';

/** Run stats ({id: {count, last}}). Older builds stored a plain id list here (migrated on read). */
const STATS_KEY = 'cubby-slicer:recent-actions';
const PINNED_KEY = 'cubby-slicer:pinned-actions';
const DETAILS_KEY = 'cubby-slicer:palette-details';
const RECENT_COUNT_KEY = 'cubby-slicer:palette-recent-count';
const NO_ASK_KEY = 'cubby-slicer:palette-no-ask';

/** Orca ActionRegistry::kFavLimit: the numbered quick-launch slots. */
export const MAX_PINNED = 10;
/** Orca AppConfig SPEED_DIAL_RECENT_COUNT_{MIN,DEFAULT,MAX}. */
export const RECENT_COUNT_MIN = 0;
export const RECENT_COUNT_DEFAULT = 5;
export const RECENT_COUNT_MAX = 10;
/** Orca frecency_score: the score halves every 30 idle days. */
const HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

export interface ActionStat { count: number; last: number }
export type ActionStats = Record<string, ActionStat>;

/** Parse the stored stats; a legacy id list (most recent first) becomes count 1, newest last. */
export function parseStats(v: unknown, now = Date.now()): ActionStats {
  const out: ActionStats = {};
  if (Array.isArray(v)) {
    const ids = [...new Set(v.filter((x): x is string => typeof x === 'string'))];
    ids.forEach((id, i) => { out[id] = { count: 1, last: now - (i + 1) * 1000 }; });
    return out;
  }
  if (v && typeof v === 'object') {
    for (const [id, s] of Object.entries(v as Record<string, unknown>)) {
      const o = s as { count?: unknown; last?: unknown } | null;
      const count = typeof o?.count === 'number' && o.count > 0 ? Math.floor(o.count) : 0;
      const last = typeof o?.last === 'number' && o.last > 0 ? o.last : 0;
      if (count || last) out[id] = { count, last };
    }
  }
  return out;
}

/** Cap + dedupe a pin list, first occurrence wins (Orca cap_favourites). */
export function capFavourites(ids: unknown, limit = MAX_PINNED): string[] {
  return Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === 'string'))].slice(0, limit) : [];
}

const clampCount = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(RECENT_COUNT_MAX, Math.max(RECENT_COUNT_MIN, Math.round(n))) : RECENT_COUNT_DEFAULT;

export const actionStats = ref<ActionStats>(parseStats(readJson(STATS_KEY)));
export const pinnedActionIds = ref<string[]>(capFavourites(readJson(PINNED_KEY)));
/** How many recently launched actions the Speed Dial lists first (Orca Preferences "Recent actions"). */
export const paletteRecentCount = ref<number>(clampCount(readJson(RECENT_COUNT_KEY)));
/** Footer description + wiki shown (Orca `tooltip_expanded`; absent = expanded). */
export const paletteDetailsExpanded = ref<boolean>(readJson(DETAILS_KEY) !== false);
const noAsk = ref<string[]>(capFavourites(readJson(NO_ASK_KEY), Infinity));

watch(pinnedActionIds, (ids) => { writeJson(PINNED_KEY, ids); });
watch(paletteRecentCount, (n) => { writeJson(RECENT_COUNT_KEY, clampCount(n)); });
watch(paletteDetailsExpanded, (v) => { writeJson(DETAILS_KEY, v); });

/** Orca frecency_score: count × 2^(−idle days / 30); 0 for an action never run. */
export function frecencyScore(stat: ActionStat | undefined, now = Date.now()): number {
  if (!stat || stat.count <= 0) return 0;
  const age = Math.max(0, (now - stat.last) / DAY_MS);
  return stat.count * 2 ** (-age / HALF_LIFE_DAYS);
}

/** Ids with a run history, most recent first (ties by id), at most `limit` (Orca snapshot() "recent"). */
export function recentIds(stats: ActionStats, limit: number, live?: (id: string) => boolean): string[] {
  return Object.entries(stats)
    .filter(([id, s]) => s.last > 0 && (!live || live(id)))
    .sort(([a, x], [b, y]) => y.last - x.last || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
}

/** Recently run ids, most recent first (the configured count). */
export const recentActionIds = computed(() => recentIds(actionStats.value, paletteRecentCount.value));

/** Bump an action's run stats (Orca ActionRegistry::run). */
export function recordRecent(id: string, now = Date.now()): void {
  const prev = actionStats.value[id];
  actionStats.value = { ...actionStats.value, [id]: { count: (prev?.count ?? 0) + 1, last: now } };
  writeJson(STATS_KEY, actionStats.value);
}

/** Pin or unpin. Returns false when pinning would exceed MAX_PINNED (Orca set_favourite). */
export function togglePinned(id: string): boolean {
  const cur = pinnedActionIds.value;
  if (cur.includes(id)) { pinnedActionIds.value = cur.filter((x) => x !== id); return true; }
  if (cur.length >= MAX_PINNED) return false;
  pinnedActionIds.value = [...cur, id];
  return true;
}

/**
 * Swap a pin with its neighbour among the `visible` pins (dir −1 / +1), keeping hidden pins
 * where they are (Orca speeddial.js moveFav + reorder_favourites). Returns the new visible index, or −1.
 */
export function movePinned(id: string, dir: -1 | 1, visible: readonly string[]): number {
  const vi = visible.indexOf(id);
  const ni = vi + dir;
  if (vi < 0 || ni < 0 || ni >= visible.length) return -1;
  const next = pinnedActionIds.value.slice();
  const a = next.indexOf(id), b = next.indexOf(visible[ni]);
  if (a < 0 || b < 0) return -1;
  next[a] = visible[ni];
  next[b] = id;
  pinnedActionIds.value = next;
  return ni;
}

/** Drop pins with no live action (Orca snapshot(): invisible pins must not fill the cap). */
export function prunePinned(live: (id: string) => boolean): void {
  const kept = pinnedActionIds.value.filter(live);
  if (kept.length !== pinnedActionIds.value.length) pinnedActionIds.value = kept;
}

/** Plugin run-confirm gate (Orca should_ask / suppress_ask). */
export function shouldAsk(id: string): boolean { return !noAsk.value.includes(id); }
export function suppressAsk(id: string): void {
  if (noAsk.value.includes(id)) return;
  noAsk.value = [...noAsk.value, id];
  writeJson(NO_ASK_KEY, noAsk.value);
}

/** Quick-launch slot label of the pinned position `i` ('1'…'9', '0' for the tenth), or '' past the tenth. */
export function pinnedSlot(i: number): string { return i < 0 || i >= MAX_PINNED ? '' : i === 9 ? '0' : String(i + 1); }
/** Pinned position for a digit key ('1' → 0, '0' → 9), or -1. */
export function pinnedIndexForDigit(d: string): number { return /^[0-9]$/.test(d) ? (d === '0' ? 9 : Number(d) - 1) : -1; }
/** The physical digit of a keydown: e.code first (macOS Option+digit types a symbol into e.key). */
export function digitFromEvent(e: { code?: string; key?: string }): string {
  return /^(?:Digit|Numpad)([0-9])$/.exec(e.code ?? '')?.[1] ?? e.key ?? '';
}

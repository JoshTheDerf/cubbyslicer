/**
 * Speed Dial (command palette) model: a port of Orca 2.5.0's
 * resources/web/dialog/SpeedDial/speeddial.js (+ ActionRegistry::snapshot / action_json and
 * resources/web/js/fuzzy-search.js). Pure: CommandPalette.vue renders it.
 *
 *  - Every entry is an action: commands (the registry), plugin commands, every setting
 *    (SettingsIndex → SettingAction: "Process : Quality : Layers" breadcrumb), one
 *    "Go to Plate N" per plate and the two-phase "Go to layer (percent)" / "Go to tab...".
 *  - The pool is frecency-sorted (ActionRegistry::snapshot()).
 *  - Empty query: the last-N launched ("Recent"), then everything else bucketed by category,
 *    categories alphabetical, frecency order inside (commandList / groupActions).
 *  - Query: one ranked list over every action (searchActions): a whole-query match in one field
 *    beats every word-by-word match spread over fields; contiguous beats fuzzy; title beats
 *    group beats breadcrumb; "advanced" / "expert" / "developer" also list every setting of
 *    that mode.
 *
 * App extras kept: unavailable commands (`when` false) are left out, toggles say what choosing
 * them does, the selected choice of a set is marked `current`, aliases are searchable, and a
 * command shows its own shortcut.
 */
import type { AppContext } from '../context';
import { formatBindingTokens, type Platform } from '../formatBinding';
import { frecencyScore, type ActionStats } from '../recent';
import type { Action } from '../types';

export type PaletteKind = 'command' | 'plugin' | 'setting';
/** Settings mode an entry needs (Orca ConfigOptionMode, `mode_key`). */
export type PaletteMode = 'simple' | 'advanced' | 'expert' | 'develop';

export interface PaletteItem {
  id: string;
  /** Title. */
  label: string;
  /** The registry category ('' for settings). */
  category: string;
  /** Eyebrow / section (Orca `group`): a command's category, '' for settings and plugin commands. */
  group: string;
  /** Plugin name, or a setting's breadcrumb "Process : Quality : Layers" (Orca `source`). */
  source?: string;
  kind: PaletteKind;
  /** Search-only alias when the title differs from the descriptive name (Orca `full_label`). */
  fullLabel?: string;
  icon?: string;
  /** An image shown instead of `icon` (Action.iconSrc). */
  iconSrc?: string;
  kbds?: string[];
  /** Search-only aliases (app extra). */
  keywords: string;
  /** The registry action (commands); dynamic entries carry `run` instead. */
  action?: Action;
  /** Runs a dynamic entry (settings, plates, the two-phase commands); `param` = the phase's input. */
  run?: (param: string) => unknown;
  /** Two-phase command (Orca `input`): activating it asks for a layer % or a tab first. */
  input?: 'percent' | 'tab';
  /** Settings mode it needs (settings only; commands are 'simple'). */
  mode?: PaletteMode;
  /** The selected choice of a set (shown as "current"). */
  current?: boolean;
  /** Footer description (Orca `desc`) and wiki page. */
  description?: string;
  helpUrl?: string;
}

// ---- projection (registry → entries) --------------------------------------------------------------

/** Category order of the keyboard shortcuts dialog (ShellDialogs.vue); the Speed Dial sorts A→Z. */
export const CATEGORY_ORDER = ['File', 'Edit', 'Object', 'Arrange', 'Plate', 'View', 'Slice', 'Export', 'Preview', 'Settings', 'Help'];

const VIEW_IDS = new Set(['view.prepare', 'view.preview', 'view.assembly']);
const isToggle = (a: Action) => a.id.startsWith('view.panel.') || a.id.includes('.toggle.');
const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function paletteLabel(a: Action, ctx: AppContext): string {
  const st = a.state?.(ctx);
  if (st === 'on' || st === 'off') {
    const on = st === 'on';
    // Toggles say what choosing them does.
    if (a.id.startsWith('view.panel.')) return `${on ? 'Hide' : 'Show'} ${a.title.toLowerCase()}`;
    if (isToggle(a)) {
      if (a.title.startsWith('Show ')) return on ? `Hide ${a.title.slice(5)}` : a.title;
      return `Turn ${on ? 'off' : 'on'} ${lcFirst(a.title)}`;
    }
    // Views are places to go; other on/off actions are choices of a set (marked `current`).
    if (VIEW_IDS.has(a.id)) return `Go to ${a.title}`;
  }
  return a.dynamicTitle?.(ctx) ?? a.title;
}

/** Selected choice of a set (not toggles: their label already says the state). */
function isCurrent(a: Action, ctx: AppContext): boolean {
  const st = a.state?.(ctx);
  return st === 'active' || (st === 'on' && !isToggle(a));
}

/**
 * Registry actions as entries. `pluginName(id)` names the plugin that contributed an action
 * (undefined for the app's own): those are Orca's plugin actions (eyebrow = plugin name,
 * grouped under "Plugins", run-confirm).
 */
export function projectPalette(actions: Action[], ctx: AppContext, platform?: Platform, pluginName?: (id: string) => string | undefined): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const a of actions) {
    if (a.paletteHidden) continue;
    if (a.when && a.when(ctx) === false) continue;
    const kbds = formatBindingTokens(a.binding, platform);
    const plugin = pluginName?.(a.id);
    out.push({
      id: a.id,
      label: paletteLabel(a, ctx),
      category: a.category,
      group: plugin !== undefined ? '' : a.category,
      source: plugin,
      kind: plugin !== undefined ? 'plugin' : 'command',
      icon: a.dynamicIcon?.(ctx) ?? a.icon,
      iconSrc: a.iconSrc,
      kbds: kbds.length ? kbds : undefined,
      keywords: (a.aliases ?? []).join(' '),
      action: a,
      current: isCurrent(a, ctx) || undefined,
      description: a.description,
      helpUrl: a.helpUrl,
    });
  }
  return out;
}

/** Orca setting_type_context: the breadcrumb's first segment. */
export const SETTING_TYPE_LABEL = { process: 'Process', filament: 'Filament', printer: 'Printer' } as const;

export interface SettingEntry {
  key: string;
  /** The label the settings row draws. */
  label: string;
  /** The option's own name when it differs (search-only). */
  fullLabel?: string;
  tab: keyof typeof SETTING_TYPE_LABEL;
  pageTitle: string;
  groupTitle: string;
  tooltip?: string;
  mode?: PaletteMode;
  icon?: string;
  /** Hidden by a rule: why (Orca keeps a hidden setting only when it has a recorded reason). */
  hidden?: string;
  /** Disabled by a rule: why. */
  disabled?: string;
}

/** Orca materialize_setting_actions: one entry per setting, id `setting:<key>`. */
export function settingItems(entries: readonly SettingEntry[], run: (e: SettingEntry) => unknown): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const e of entries) {
    if (e.hidden !== undefined && !e.hidden) continue;
    const source = [SETTING_TYPE_LABEL[e.tab], e.pageTitle, e.groupTitle].filter(Boolean).join(' : ');
    // The row's availability goes before its tooltip (Orca: availability + "\n\n" + tooltip).
    const reason = e.hidden ?? e.disabled ?? '';
    const description = [reason, e.tooltip ?? ''].filter(Boolean).join('\n\n') || undefined;
    out.push({
      id: `setting:${e.key}`, label: e.label, category: '', group: '', source, kind: 'setting',
      fullLabel: e.fullLabel && e.fullLabel !== e.label ? e.fullLabel : undefined,
      // App extra: the option key is searchable too.
      icon: e.icon, keywords: e.key, mode: e.mode ?? 'simple', description, run: () => run(e),
    });
  }
  return out;
}

/** Orca materialize_plate_actions: "Go to Plate N", one per plate, group "Plate". */
export function plateItems(count: number, select: (index: number) => unknown): PaletteItem[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => ({
    id: `plate.goto.${i}`, label: `Go to Plate ${i + 1}`, category: 'Plate', group: 'Plate', kind: 'command' as const,
    icon: 'i-lucide-square-arrow-right', keywords: '', run: () => select(i),
  }));
}

/** Orca NativeCommands "go_to_layer" (input "percent") and "go_to_tab" (input "tab"), group "Commands". */
export function phaseItems(goToLayer: (pct: number) => unknown, goToTab: (id: string) => unknown): PaletteItem[] {
  return [
    { id: 'palette.go-to-layer', label: 'Go to layer (percent)', category: 'Commands', group: 'Commands', kind: 'command', input: 'percent',
      icon: 'i-lucide-layers-2', keywords: '', run: (p) => goToLayer(Number(p)) },
    { id: 'palette.go-to-tab', label: 'Go to tab...', category: 'Commands', group: 'Commands', kind: 'command', input: 'tab',
      icon: 'i-lucide-app-window', keywords: '', run: (id) => goToTab(id) },
  ];
}

/** Orca snapshot(): frecency, then title, source, id. */
export function frecencySort(items: readonly PaletteItem[], stats: ActionStats, now = Date.now()): PaletteItem[] {
  const score = new Map(items.map((i) => [i.id, frecencyScore(stats[i.id], now)]));
  return items.slice().sort((a, b) => score.get(b.id)! - score.get(a.id)! || cmp(a.label, b.label) || cmp(a.source ?? '', b.source ?? '') || cmp(a.id, b.id));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---- fuzzy core (fuzzy-search.js) -----------------------------------------------------------------

export type Range = [number, number];

function foldChar(ch: string): string {
  if (ch.length === 1 && ch.charCodeAt(0) < 0x80) return ch;
  return ch.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}
/** Length-preserving fold + lower case, so match offsets slice the original text. */
export function normText(text: string | undefined): string {
  const src = text ?? '';
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const folded = foldChar(src[i]);
    const stable = folded.length === 1 ? folded : src[i];
    const lower = stable.toLowerCase();
    out += lower.length === 1 ? lower : stable;
  }
  return out;
}

/** Ordered subsequence of a normalized needle in a normalized haystack, tightest span wins. */
export function fuzzyRangesNorm(t: string, needle: string): Range[] | null {
  if (!needle) return null;
  const n = t.length, nl = needle.length;
  let best: { ranges: Range[]; span: number; start: number } | null = null;
  for (let start = 0; start < n; start++) {
    if (t[start] !== needle[0]) continue;
    let qi = 0, lastEnd = start;
    const ranges: Range[] = [];
    for (let i = start; i < n && qi < nl; i++) {
      if (t[i] !== needle[qi]) continue;
      const last = ranges[ranges.length - 1];
      if (last && last[1] === i) last[1] = i + 1; else ranges.push([i, i + 1]);
      lastEnd = i + 1;
      qi++;
    }
    if (qi !== nl) continue;
    const span = lastEnd - start;
    if (!best || span < best.span || (span === best.span && start < best.start)) {
      best = { ranges, span, start };
      if (span === nl) return ranges;
    }
  }
  return best ? best.ranges : null;
}

/** Greedy ordered subsequence over raw text (fuzzy-search.js FuzzyRanges; the tab picker). */
export function fuzzyRanges(text: string, query: string): Range[] | null {
  const needle = normText(query);
  if (!needle) return null;
  const t = normText(text);
  const ranges: Range[] = [];
  let qi = 0;
  for (let i = 0; i < t.length && qi < needle.length; i++) {
    if (t[i] !== needle[qi]) continue;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === i) last[1] = i + 1; else ranges.push([i, i + 1]);
    qi++;
  }
  return qi === needle.length ? ranges : null;
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- search (searchActions) -----------------------------------------------------------------------

const SCORE_CONTIGUOUS = 100000;
const SCORE_TITLE = 2000;
const SCORE_GROUP = 1000;
const SCORE_PHRASE = 10000000;

export type RangeKey = 'title' | 'group' | 'source' | 'plugin';
/** Highlight ranges per drawn field; `useEyebrowGroup`: the eyebrow shows the group (else the source). */
export type MatchRanges = Partial<Record<RangeKey, Range[] | null>> & { useEyebrowGroup: boolean };

interface Field { text: (a: PaletteItem) => string | undefined; weight: number; range: RangeKey | null }
const FIELDS: Field[] = [
  { text: (a) => a.label, weight: SCORE_TITLE, range: 'title' },
  { text: (a) => a.group, weight: SCORE_GROUP, range: 'group' },
  { text: (a) => a.source, weight: 0, range: 'source' },
  { text: (a) => a.fullLabel, weight: 0, range: null },
  { text: (a) => (a.kind === 'plugin' ? 'Plugins' : ''), weight: SCORE_GROUP, range: 'plugin' },
  { text: (a) => (a.kind === 'plugin' ? 'plugin plugins' : ''), weight: SCORE_GROUP, range: null },
  // App extra: aliases, search-only (weighted like Orca's other search-only aliases).
  { text: (a) => a.keywords, weight: 0, range: null },
];
const RANGE_KEYS: RangeKey[] = ['title', 'group', 'source', 'plugin'];

interface NormField { norm: string; weight: number; range: RangeKey | null }
const fieldCache = new WeakMap<PaletteItem, NormField[]>();
function searchFields(a: PaletteItem): NormField[] {
  let f = fieldCache.get(a);
  if (!f) {
    f = [];
    for (const field of FIELDS) {
      const norm = normText(field.text(a) ?? '');
      if (norm) f.push({ norm, weight: field.weight, range: field.range });
    }
    fieldCache.set(a, f);
  }
  return f;
}

function fieldMatchScore(norm: string, needle: string, wwRe: RegExp | null): { score: number; ranges: Range[]; contiguous: boolean } | null {
  if (!needle) return null;
  if (wwRe) {
    const m = wwRe.exec(norm);
    if (m) return { score: 1000 - m.index * 10, ranges: [[m.index, m.index + m[0].length]], contiguous: true };
  }
  const r = fuzzyRangesNorm(norm, needle);
  if (!r) return null;
  let gaps = 0, len = 0;
  for (let i = 0; i < r.length; i++) {
    if (i > 0) gaps += r[i][0] - r[i - 1][1];
    len += r[i][1] - r[i][0];
  }
  return { score: 1000 - r[0][0] * 10 - gaps * 10, ranges: r, contiguous: r.length === 1 && len === needle.length };
}

function matchFields(a: PaletteItem, needle: string, wwRe: RegExp): { score: number; ranges: Partial<Record<RangeKey, Range[]>> } | null {
  let best: number | null = null;
  const ranges: Partial<Record<RangeKey, Range[]>> = {};
  for (const field of searchFields(a)) {
    const m = fieldMatchScore(field.norm, needle, wwRe);
    if (!m) continue;
    const v = (m.contiguous ? SCORE_CONTIGUOUS : 0) + field.weight + m.score;
    if (best === null || v > best) best = v;
    if (field.range) ranges[field.range] = m.ranges;
  }
  return best === null ? null : { score: best, ranges };
}

function mergeRanges(list: Range[][] | undefined): Range[] | null {
  const flat: Range[] = [];
  for (const rs of list ?? []) for (const r of rs) flat.push([r[0], r[1]]);
  if (!flat.length) return null;
  flat.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Range[] = [flat[0]];
  for (let i = 1; i < flat.length; i++) {
    const last = out[out.length - 1];
    if (flat[i][0] <= last[1]) last[1] = Math.max(last[1], flat[i][1]); else out.push(flat[i]);
  }
  return out;
}

const MODE_WORDS: Record<string, PaletteMode> = { advanced: 'advanced', expert: 'expert', developer: 'develop', develop: 'develop' };

/** Settings modes named as whole words in the query ("Simple" deliberately absent). */
export function modeFilterFromQuery(query: string): PaletteMode[] {
  const found: PaletteMode[] = [];
  for (const w of normText(query.trim()).split(/[^a-z0-9]+/)) {
    const m = MODE_WORDS[w];
    if (m && !found.includes(m)) found.push(m);
  }
  return found;
}

export interface SearchResult { list: PaletteItem[]; matches: Map<string, MatchRanges> }

/** Orca searchActions: every entry matching the query, ranked by relevance. */
export function searchActions(items: readonly PaletteItem[], query: string): SearchResult {
  const q = query.trim();
  const matches = new Map<string, MatchRanges>();
  if (!q) return { list: items.slice(), matches };
  const needle = normText(q);
  const tokens = needle.split(/\s+/).filter(Boolean);
  const tokenRes = tokens.map((t) => new RegExp(`\\b${escapeRe(t)}\\b`));
  const wwRe = new RegExp(`\\b${escapeRe(needle)}\\b`);
  const modes = modeFilterFromQuery(q);
  const tokenPass = tokens.length !== 1 || tokens[0] !== needle;
  const scored: Array<{ a: PaletteItem; s: number }> = [];
  for (const a of items) {
    const phrase = matchFields(a, needle, wwRe);
    let score: number;
    let perField: Partial<Record<RangeKey, Range[][]>> = {};
    if (phrase) score = phrase.score + SCORE_PHRASE;
    else {
      if (!tokenPass) continue;
      let sum = 0, all = true;
      perField = {};
      for (let t = 0; t < tokens.length; t++) {
        const m = matchFields(a, tokens[t], tokenRes[t]);
        if (!m) { all = false; break; }
        sum += m.score;
        for (const k of Object.keys(m.ranges) as RangeKey[]) (perField[k] ??= []).push(m.ranges[k]!);
      }
      if (!all) continue;
      score = sum;
    }
    const entry: MatchRanges = { useEyebrowGroup: !!a.group };
    for (const k of RANGE_KEYS) entry[k] = phrase ? phrase.ranges[k] ?? null : mergeRanges(perField[k]);
    matches.set(a.id, entry);
    scored.push({ a, s: score });
  }
  scored.sort((x, y) => y.s - x.s || cmp(x.a.label, y.a.label) || cmp(x.a.id, y.a.id));
  let list = scored.map((e) => e.a);
  if (modes.length) {
    const extras = items.filter((a) => !matches.has(a.id) && a.mode && modes.includes(a.mode))
      .sort((x, y) => cmp(x.label, y.label) || cmp(x.id, y.id));
    list = list.concat(extras);
  }
  return { list, matches };
}

// ---- empty-query list (commandList / groupActions / commandSections) -------------------------------

/** Section an entry is listed under: plugins share one, settings take their preset type. */
export function actionCategory(a: PaletteItem | undefined): string {
  if (!a) return 'Other';
  if (a.kind === 'plugin') return 'Plugins';
  if (a.group) return a.group;
  const src = a.source ?? '';
  const sep = src.indexOf(' : ');
  return (sep < 0 ? src : src.slice(0, sep)) || 'Other';
}

/** The small line above a row's title. */
export function actionEyebrow(a: PaletteItem, query: string, isRecent: boolean): string {
  if (a.kind === 'plugin' && (query.trim() || isRecent)) return 'Plugins';
  return a.group || a.source || '';
}

/** Bucket by category (stable: the incoming frecency order is kept), categories A→Z ignoring case. */
export function groupActions(list: readonly PaletteItem[]): PaletteItem[] {
  const buckets = new Map<string, PaletteItem[]>();
  for (const a of list) {
    const c = actionCategory(a);
    const b = buckets.get(c);
    if (b) b.push(a); else buckets.set(c, [a]);
  }
  const order = [...buckets.keys()].sort((x, y) => cmp(x.toLowerCase(), y.toLowerCase()));
  return order.flatMap((c) => buckets.get(c)!);
}

export interface CommandList extends SearchResult {
  /** Header label above a flat list index (empty query only). */
  sections: Map<number, string>;
  /** Leading entries that are the "Recent" section. */
  recentCount: number;
}

/** Orca commandList + commandSections: a ranked list for a query, else Recent + categories. */
export function commandList(items: readonly PaletteItem[], recent: readonly PaletteItem[], query: string): CommandList {
  if (query.trim()) return { ...searchActions(items, query), sections: new Map(), recentCount: 0 };
  const recentIds = new Set(recent.map((r) => r.id));
  const list = [...recent, ...groupActions(items.filter((a) => !recentIds.has(a.id)))];
  const sections = new Map<number, string>();
  if (recent.length) sections.set(0, 'Recent');
  let prev: string | null = null;
  for (let i = recent.length; i < list.length; i++) {
    const c = actionCategory(list[i]);
    if (i === recent.length || c !== prev) sections.set(i, c);
    prev = c;
  }
  return { list, matches: new Map(), sections, recentCount: recent.length };
}

// ---- inline completion (completionFor) --------------------------------------------------------------

export interface Completion { suffix: string; word: string; id: string }

/** Ghost completion of the query's last word from the top 10 results' title, group, breadcrumb. */
export function completionFor(query: string, list: readonly PaletteItem[]): Completion | null {
  const m = /(\S+)\s*$/.exec(query);
  if (!m) return null;
  const prefix = normText(m[1]);
  if (!prefix) return null;
  for (const a of list.slice(0, 10)) {
    for (const f of [a.label, a.group, a.source, a.fullLabel]) {
      for (const w of String(f ?? '').split(/[\s:]+/).filter(Boolean)) {
        const n = normText(w);
        if (n.length > prefix.length && n.startsWith(prefix)) return { suffix: w.slice(prefix.length), word: w, id: a.id };
      }
    }
  }
  return null;
}

// ---- selection / favourites -------------------------------------------------------------------------

export interface Sel { zone: 'list' | 'fav'; i: number }

/**
 * Arrow navigation (nextSel): Down from the bar → first row; Down wraps at the bottom; Up at the
 * top goes to the bar when there is one, else wraps to the last row; Left / Right move in the bar.
 */
export function nextSel(sel: Sel, key: string, listLen: number, favLen: number): Sel {
  const last = Math.max(0, listLen - 1);
  if (key === 'ArrowDown') {
    if (sel.zone === 'fav') return { zone: 'list', i: 0 };
    return { zone: 'list', i: sel.i >= last ? 0 : sel.i + 1 };
  }
  if (key === 'ArrowUp') {
    if (sel.zone === 'list') {
      if (sel.i <= 0) return favLen ? { zone: 'fav', i: 0 } : { zone: 'list', i: last };
      return { zone: 'list', i: sel.i - 1 };
    }
    return { ...sel };
  }
  if (key === 'ArrowLeft' && sel.zone === 'fav') return { zone: 'fav', i: Math.max(0, sel.i - 1) };
  if (key === 'ArrowRight' && sel.zone === 'fav') return { zone: 'fav', i: Math.min(favLen - 1, sel.i + 1) };
  return { ...sel };
}

/** Pins that resolve to a listed entry, deduped, in pin order (visibleFavourites). */
export function visibleFavourites(pins: readonly string[], live: (id: string) => boolean): string[] {
  return pins.filter((id, i) => live(id) && pins.indexOf(id) === i);
}

export function selectedActionId(sel: Sel, list: readonly { id: string }[], favIds: readonly string[]): string | null {
  if (sel.zone === 'fav') return favIds[sel.i] ?? null;
  return list[sel.i]?.id ?? null;
}

/** The footer describes the hovered entry, else the keyboard selection. */
export function detailActionId(hover: string | null, sel: Sel, list: readonly { id: string }[], favIds: readonly string[]): string | null {
  return hover || selectedActionId(sel, list, favIds);
}

// ---- modes ------------------------------------------------------------------------------------------

const MODE_RANK: Record<PaletteMode, number> = { simple: 0, advanced: 1, expert: 2, develop: 3 };
export const MODE_LABEL: Record<PaletteMode, string> = { simple: 'Simple', advanced: 'Advanced', expert: 'Expert', develop: 'Developer' };

/** The entry needs a settings mode above the current one (choosing it asks to switch). */
export function needsModeSwitch(a: Pick<PaletteItem, 'mode'> | undefined, userMode: PaletteMode): boolean {
  return MODE_RANK[a?.mode ?? 'simple'] > MODE_RANK[userMode];
}
/** Row tag for an entry above the current mode, else ''. */
export function modeBadge(a: Pick<PaletteItem, 'mode'> | undefined, userMode: PaletteMode): string {
  return a?.mode && needsModeSwitch(a, userMode) ? MODE_LABEL[a.mode] : '';
}

// ---- tabs phase / misc ------------------------------------------------------------------------------

export interface PaletteTab { id: string; title: string; icon?: string }

/** Tabs whose title or id fuzzy-match the query (filterTabs). */
export function filterTabs(tabs: readonly PaletteTab[], query: string): PaletteTab[] {
  const q = query.trim();
  if (!q) return tabs.slice();
  return tabs.filter((t) => fuzzyRanges(t.title, q) || fuzzyRanges(t.id, q));
}

/** A click this soon after a phase switch is the second half of a double-click (PHASE_CLICK_GRACE_MS). */
export const PHASE_CLICK_GRACE_MS = 500;
export function phaseClickIgnored(now: number, enteredAt: number): boolean {
  return enteredAt > 0 && now - enteredAt < PHASE_CLICK_GRACE_MS;
}

/** A layer percentage the percent phase accepts (runJumpToLayer), or null. */
export function parsePercent(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = parseFloat(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** "GCODE OPTIMIZER" → "Gcode Optimizer" (prettySource). */
export function prettySource(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Accessible names "Title from Source", with the id appended when another entry reads the same
 * (actionLabel), for a whole pool at once.
 */
export function actionLabels(all: readonly PaletteItem[]): Map<string, string> {
  const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const sig = new Map(all.map((o) => [o.id, `${fold(o.label)}|${fold(o.source || o.group || '')}`]));
  const count = new Map<string, number>();
  for (const s of sig.values()) count.set(s, (count.get(s) ?? 0) + 1);
  return new Map(all.map((a) => {
    const label = `${a.label} from ${prettySource(a.source || a.group || '')}`;
    return [a.id, count.get(sig.get(a.id)!)! > 1 ? `${label} (${a.id})` : label];
  }));
}

/** Text split at the match ranges, for <mark> highlighting. */
export function markSegments(text: string, ranges: readonly Range[] | null | undefined): Array<{ t: string; m: boolean }> {
  if (!ranges?.length) return [{ t: text, m: false }];
  const out: Array<{ t: string; m: boolean }> = [];
  let last = 0;
  for (const [a, b] of ranges) {
    if (a > last) out.push({ t: text.slice(last, a), m: false });
    out.push({ t: text.slice(a, b), m: true });
    last = b;
  }
  if (last < text.length) out.push({ t: text.slice(last), m: false });
  return out;
}

/** Windowed list: rows rendered per step, and the row / header heights the spacer reserves. */
export const K_ROWS = 50;
export const ROW_H = 44;
export const SECTION_H = 30;
export function spacerHeight(total: number, rendered: number, totalSections: number, renderedSections: number): number {
  return Math.max(0, total - rendered) * ROW_H + Math.max(0, totalSections - renderedSections) * SECTION_H;
}

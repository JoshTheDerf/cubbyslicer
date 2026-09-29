/**
 * Command palette projection + ranking (mirrors
 * cad-project/src/actions/project/palette.ts, with a built-in fuzzy scorer in
 * place of Fuse).
 *
 *  - Only available actions (`when` ≠ false) and not `paletteHidden`.
 *  - Label = dynamicTitle ?? title; toggles read "Turn on/off <title>".
 *  - Empty query: recent commands first, then everything by category order.
 *  - Query: fuzzy over label (strongest), aliases, then category; ties break
 *    on earliest match, shorter label, recency.
 */
import type { AppContext } from '../context';
import { formatBindingTokens, type Platform } from '../formatBinding';
import type { Action } from '../types';

export interface PaletteItem {
  id: string;
  label: string;
  category: string;
  icon?: string;
  kbds?: string[];
  keywords: string;
  action: Action;
}

export interface PaletteSection { id: string; label: string; items: PaletteItem[] }

export const CATEGORY_ORDER = ['File', 'Edit', 'Object', 'Arrange', 'Plate', 'View', 'Slice', 'Export', 'Preview', 'Settings', 'Help'];

export function paletteLabel(a: Action, ctx: AppContext): string {
  const st = a.state?.(ctx);
  if (st === 'on' || st === 'off') {
    // Pure toggles (panels) read as "Turn on/off"; exclusive views (Prepare/Preview) read as "Go to".
    if (a.id.startsWith('view.panel.')) return `${st === 'on' ? 'Hide' : 'Show'} ${a.title.toLowerCase()}`;
    return `Go to ${a.title}`;
  }
  return a.dynamicTitle?.(ctx) ?? a.title;
}

export function projectPalette(actions: Action[], ctx: AppContext, platform?: Platform): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const a of actions) {
    if (a.paletteHidden) continue;
    if (a.when && a.when(ctx) === false) continue;
    const kbds = formatBindingTokens(a.binding, platform);
    out.push({
      id: a.id,
      label: paletteLabel(a, ctx),
      category: a.category,
      icon: a.dynamicIcon?.(ctx) ?? a.icon,
      kbds: kbds.length ? kbds : undefined,
      keywords: (a.aliases ?? []).join(' '),
      action: a,
    });
  }
  return out;
}

const WORD_SPLIT = /[\s\-_/.()]+/;

/** "ep3" → "Export plate as 3MF": each query run must start a word, in order. */
function initialsMatch(q: string, text: string): boolean {
  const words = text.split(WORD_SPLIT).filter(Boolean);
  let qi = 0;
  for (const w of words) {
    if (qi >= q.length) break;
    let k = 0;
    while (k < w.length && qi + k < q.length && w[k] === q[qi + k]) k++;
    qi += k;
  }
  return qi >= q.length;
}

/**
 * Fuzzy score of `q` against `text` (both lower-cased). 0 = no match.
 * Contiguous substring (word-start best) > word initials > tight subsequence.
 */
export function fuzzyScore(q: string, text: string): { score: number; index: number } {
  if (!q) return { score: 1, index: 0 };
  const idx = text.indexOf(q);
  if (idx >= 0) {
    const atWord = idx === 0 || WORD_SPLIT.test(text[idx - 1]);
    return { score: 1000 - idx + (atWord ? 300 : 0) + (idx === 0 ? 200 : 0), index: idx };
  }
  const compact = q.replace(/\s+/g, '');
  if (compact.length >= 2 && initialsMatch(compact, text)) return { score: 700, index: 0 };
  // Tight subsequence: total gap budget scales with the query length.
  let ti = 0, first = -1, gaps = 0;
  for (const c of compact) {
    const found = text.indexOf(c, ti);
    if (found < 0) return { score: 0, index: -1 };
    if (first < 0) first = found;
    else gaps += found - ti;
    ti = found + 1;
  }
  if (gaps > Math.max(2, compact.length)) return { score: 0, index: -1 };
  return { score: Math.max(1, 400 - gaps * 20 - first), index: first };
}

export function rankPalette(items: PaletteItem[], query: string, recent: string[] = []): PaletteItem[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const recency = (id: string) => { const i = recent.indexOf(id); return i < 0 ? 0 : recent.length - i; };
  if (!q) {
    const cat = (c: string) => { const i = CATEGORY_ORDER.indexOf(c); return i < 0 ? CATEGORY_ORDER.length : i; };
    return items.slice().sort((a, b) => recency(b.id) - recency(a.id) || cat(a.category) - cat(b.category) || a.label.localeCompare(b.label));
  }
  const scored: Array<{ it: PaletteItem; s: number; idx: number }> = [];
  for (const it of items) {
    const label = it.label.toLowerCase();
    const l = fuzzyScore(q, label);
    // Tiers: any label match > alias match > category match.
    let s = l.score ? 20000 + l.score : 0;
    let idx = l.index >= 0 ? l.index : 999;
    if (!l.score) {
      const k = q.length >= 2 ? fuzzyScore(q, it.keywords.toLowerCase()).score : 0;
      const c = fuzzyScore(q, it.category.toLowerCase()).score;
      s = k ? 10000 + k : c;
      idx = 999;
    }
    if (s <= 0) continue;
    scored.push({ it, s: s + recency(it.id) * 60, idx });
  }
  scored.sort((a, b) => b.s - a.s || a.idx - b.idx || a.it.label.length - b.it.label.length);
  return scored.map((x) => x.it);
}

/** Empty-query sections: "Recent" then categories. */
export function sectionPalette(items: PaletteItem[], recent: string[]): PaletteSection[] {
  const rec = recent.map((id) => items.find((i) => i.id === id)).filter((x): x is PaletteItem => !!x);
  const recSet = new Set(rec.map((r) => r.id));
  const byCat = new Map<string, PaletteItem[]>();
  for (const it of items) {
    if (recSet.has(it.id)) continue;
    const l = byCat.get(it.category);
    if (l) l.push(it); else byCat.set(it.category, [it]);
  }
  const cats = [...byCat.keys()].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const out: PaletteSection[] = [];
  if (rec.length) out.push({ id: 'recent', label: 'Recent', items: rec });
  for (const c of cats) out.push({ id: c.toLowerCase(), label: c, items: byCat.get(c)!.sort((a, b) => a.label.localeCompare(b.label)) });
  return out;
}

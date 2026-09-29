/** Global settings search over label / key / tooltip, returning jump targets. */
import type { ConfigSchema } from '../engine/types';
import { locateKeys, type KeyLocation } from './layout/build';
import type { BuiltLayout } from './layout/types';

export interface SearchHit extends KeyLocation {
  key: string;
  label: string;
  pageTitle: string;
  groupTitle: string;
  score: number;
}

interface Entry extends KeyLocation { key: string; label: string; l: string; k: string; t: string; pageTitle: string; groupTitle: string }

export function buildSearchIndex(schema: ConfigSchema, layout: BuiltLayout): Entry[] {
  const loc = locateKeys(layout);
  const titles = new Map<string, { page: string; group: string }>();
  for (const tab of Object.values(layout)) for (const p of tab.pages) for (const g of p.groups) titles.set(g.id, { page: p.title, group: g.title });
  const out: Entry[] = [];
  for (const [key, where] of loc) {
    const def = schema.options[key];
    if (!def) continue;
    const label = def.fullLabel || def.label || key;
    const t = titles.get(where.groupId);
    out.push({
      ...where, key, label,
      l: `${label} ${def.label}`.toLowerCase(), k: key.toLowerCase(), t: (def.tooltip || '').toLowerCase(),
      pageTitle: t?.page ?? '', groupTitle: t?.group ?? '',
    });
  }
  return out;
}

export function searchSettings(index: Entry[], query: string, limit = 50): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const hits: SearchHit[] = [];
  for (const e of index) {
    let score = 0;
    let all = true;
    for (const w of words) {
      let s = 0;
      if (e.k === w || e.l === w) s = 100;
      else if (e.l.startsWith(w)) s = 60;
      else if (e.l.includes(w)) s = 40;
      else if (e.k.includes(w.replace(/\s+/g, '_'))) s = 30;
      else if (e.t.includes(w)) s = 10;
      if (!s) { all = false; break; }
      score += s;
    }
    if (all) hits.push({ tab: e.tab, pageId: e.pageId, groupId: e.groupId, key: e.key, label: e.label, pageTitle: e.pageTitle, groupTitle: e.groupTitle, score });
  }
  hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return hits.slice(0, limit);
}

/** Declarative fixes applied on top of a generated layout table. */
import type { EngineLayoutSource, LayoutGroupSource } from './types';

export interface LayoutPatch {
  tab: keyof EngineLayoutSource;
  page: string;
  group: string;
  /** Keys to move into the group (removed from wherever they are in the tab). */
  keys?: string[];
  /** Create the group before this group when missing. */
  before?: string;
  /** Insert keys after this key within the group. */
  after?: string;
  atStart?: boolean;
  rename?: string;
}

export function patchLayout(src: EngineLayoutSource, patches: LayoutPatch[]): EngineLayoutSource {
  const out: EngineLayoutSource = JSON.parse(JSON.stringify(src));
  for (const p of patches) {
    const pages = out[p.tab];
    const page = pages.find((x) => x.title === p.page);
    if (!page) continue;
    let group = page.groups.find((g) => g.title === p.group);
    if (p.rename && group) { group.title = p.rename; continue; }
    if (!p.keys?.length) continue;
    for (const pg of pages) for (const g of pg.groups) g.keys = g.keys.filter((k) => !p.keys!.includes(k));
    if (!group) {
      group = { title: p.group, keys: [] } as LayoutGroupSource;
      const at = p.before ? page.groups.findIndex((g) => g.title === p.before) : -1;
      if (at >= 0) page.groups.splice(at, 0, group); else page.groups.push(group);
    }
    const idx = p.after ? group.keys.indexOf(p.after) : -1;
    if (idx >= 0) group.keys.splice(idx + 1, 0, ...p.keys);
    else if (p.atStart) group.keys.unshift(...p.keys);
    else group.keys.push(...p.keys);
  }
  for (const pages of Object.values(out)) for (const pg of pages) pg.groups = pg.groups.filter((g: LayoutGroupSource) => g.keys.length);
  return out;
}

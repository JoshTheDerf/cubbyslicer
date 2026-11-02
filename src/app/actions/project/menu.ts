/**
 * Menu projection: layout of action ids → ui MenuItem[] (mirrors
 * cad-project/src/actions/project/menu.ts).
 *  - label   = state ? title (+✓) : dynamicTitle ?? title
 *  - disabled= when(ctx) === false
 *  - kbds    = formatBindingTokens(binding)
 * Group boundaries become separators; empty groups are dropped.
 */
import type { AppContext } from '../context';
import { formatBindingTokens, type Platform } from '../formatBinding';
import { runAction } from '../run';
import type { Action } from '../types';

/** Surface-agnostic menu item (the shell adapts it to Nuxt UI's DropdownMenu / ContextMenu items). */
export interface MenuItem {
  label?: string;
  icon?: string;
  /** Shortcut chips, e.g. ['Ctrl', 'S']. */
  kbds?: string[];
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  /** Renders a divider. */
  separator?: boolean;
  /** Submenu. */
  children?: MenuItem[];
  action?: () => void;
}

export interface MenuSubmenu { label: string; icon?: string; children: MenuEntry[] }
export type MenuEntry = string | MenuSubmenu;
export interface MenuLayout {
  groups: MenuEntry[][];
  /** Context menus: leave out what doesn't apply (disabled items, empty submenus) instead of greying it. */
  contextual?: boolean;
}

export function menuLayoutIds(layout: MenuLayout): string[] {
  const ids = (e: MenuEntry): string[] => (typeof e === 'string' ? [e] : e.children.flatMap(ids));
  return layout.groups.flatMap((g) => g.flatMap(ids));
}

export interface ProjectMenuOptions {
  platform?: Platform;
  /** Hook for surfaces that record usage (e.g. recent commands). */
  onRun?: (a: Action) => void;
}

function resolve(byId: Map<string, Action>, id: string, ctx: AppContext, o: ProjectMenuOptions): MenuItem {
  const a = byId.get(id);
  if (!a) return { label: id, disabled: true };
  const st = a.state?.(ctx);
  const item: MenuItem = {
    label: a.state && st !== 'active' ? a.title : (a.dynamicTitle?.(ctx) ?? a.title),
    icon: a.dynamicIcon?.(ctx) ?? a.icon,
    action: () => { o.onRun?.(a); void runAction(a, ctx); },
  };
  if (st === 'on' || st === 'active') item.checked = true;
  if (a.when && a.when(ctx) === false) item.disabled = true;
  if (a.tone === 'danger') item.danger = true;
  const kbds = formatBindingTokens(a.binding, o.platform);
  if (kbds.length) item.kbds = kbds;
  return item;
}

export function projectMenu(actions: Action[], ctx: AppContext, layout: MenuLayout, o: ProjectMenuOptions = {}): MenuItem[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const out: MenuItem[] = [];
  for (const group of layout.groups) {
    const entry = (e: MenuEntry): MenuItem => {
      if (typeof e === 'string') return resolve(byId, e, ctx, o);
      // "Add part ▸ Add part: Box" reads "Add part ▸ Box" (the palette keeps the full title).
      const prefix = `${e.label}: `;
      const children = e.children.map((c) => {
        const it = entry(c);
        return it.label?.startsWith(prefix) ? { ...it, label: it.label.slice(prefix.length) } : it;
      }).filter((it) => !(layout.contextual && it.disabled));
      return { label: e.label, icon: e.icon, children, disabled: children.every((c) => c.disabled) };
    };
    const items = group.map(entry).filter((it) => !(layout.contextual && it.disabled));
    if (!items.length) continue;
    if (out.length) out.push({ separator: true });
    out.push(...items);
  }
  return out;
}

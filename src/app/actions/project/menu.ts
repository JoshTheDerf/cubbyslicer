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

export interface MenuSubmenu { label: string; icon?: string; children: string[] }
export type MenuEntry = string | MenuSubmenu;
export interface MenuLayout { groups: MenuEntry[][] }

export function menuLayoutIds(layout: MenuLayout): string[] {
  return layout.groups.flatMap((g) => g.flatMap((e) => (typeof e === 'string' ? [e] : e.children)));
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
    const items = group.map((e): MenuItem => {
      if (typeof e === 'string') return resolve(byId, e, ctx, o);
      const children = e.children.map((id) => resolve(byId, id, ctx, o));
      return { label: e.label, icon: e.icon, children, disabled: children.every((c) => c.disabled) };
    });
    if (!items.length) continue;
    if (out.length) out.push({ separator: true });
    out.push(...items);
  }
  return out;
}

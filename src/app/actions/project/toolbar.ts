/** Toolbar projection: layout of action ids → button descriptors. */
import type { AppContext } from '../context';
import { formatBinding, formatBindingTokens, type Platform } from '../formatBinding';
import { runAction } from '../run';
import type { Action } from '../types';

/** One button that opens a menu of actions (shows the active one's icon). */
export interface ToolMenuRef { menu: string; label: string; icon: string; items: string[] }
export interface ToolGroup {
  label: string;
  items: Array<string | ToolMenuRef>;
  /** Mutually exclusive modes, drawn as one segmented control. */
  segmented?: boolean;
}
export interface ToolbarLayout { groups: ToolGroup[] }

export interface ToolEntry {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  /** Shortcut chips (tooltip kbds). */
  kbds: string[];
  active: boolean;
  disabled: boolean;
  tone: 'default' | 'danger';
  run: () => void;
  /** Menu entries (a ToolMenuRef). */
  children?: ToolEntry[];
}
export interface ToolGroupEntry { label: string; segmented: boolean; items: ToolEntry[] }

export function toolbarLayoutIds(l: ToolbarLayout): string[] {
  return l.groups.flatMap((g) => g.items.flatMap((it) => (typeof it === 'string' ? [it] : it.items)));
}

export function projectToolbar(actions: Action[], ctx: AppContext, layout: ToolbarLayout, platform?: Platform): ToolGroupEntry[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const entry = (id: string): ToolEntry => {
    const a = byId.get(id);
    if (!a) return { id, label: id, icon: 'i-lucide-box', kbds: [], active: false, disabled: true, tone: 'default', run: () => {} };
    const st = a.state?.(ctx);
    return {
      id,
      label: a.dynamicTitle?.(ctx) ?? a.title,
      icon: a.dynamicIcon?.(ctx) ?? a.icon ?? 'i-lucide-box',
      shortcut: formatBinding(a.binding, platform) || undefined,
      kbds: formatBindingTokens(a.binding, platform),
      active: st === 'active' || st === 'on',
      disabled: !!a.when && a.when(ctx) === false,
      tone: a.tone ?? 'default',
      run: () => { void runAction(a, ctx); },
    };
  };
  const menu = (m: ToolMenuRef): ToolEntry => {
    const children = m.items.map(entry);
    const on = children.find((c) => c.active);
    return {
      id: m.menu, label: on ? `${m.label} · ${on.label}` : m.label, icon: on?.icon ?? m.icon, kbds: [],
      active: !!on, disabled: children.every((c) => c.disabled), tone: 'default', run: () => {}, children,
    };
  };
  return layout.groups.map((g) => ({
    label: g.label,
    segmented: !!g.segmented,
    items: g.items.map((it) => (typeof it === 'string' ? entry(it) : menu(it))),
  }));
}

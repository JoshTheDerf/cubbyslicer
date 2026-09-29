/** Toolbar projection: layout of action ids → button descriptors. */
import type { AppContext } from '../context';
import { formatBinding, formatBindingTokens, type Platform } from '../formatBinding';
import { runAction } from '../run';
import type { Action } from '../types';

export interface ToolbarLayout { groups: string[][] }

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
}

export function toolbarLayoutIds(l: ToolbarLayout): string[] { return l.groups.flat(); }

export function projectToolbar(actions: Action[], ctx: AppContext, layout: ToolbarLayout, platform?: Platform): ToolEntry[][] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  return layout.groups.map((g) => g.map((id): ToolEntry => {
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
  }));
}

/** Reactive projections of the action registry for shell components (Nuxt UI surfaces). */
import { computed } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import { getActionContext } from '../actions/context';
import { detectPlatform, formatBinding, formatBindingTokens } from '../actions/formatBinding';
import { recordRecent } from '../actions/recent';
import { actionsRevision, getAction, getAllActions } from '../actions/registry';
import { runAction } from '../actions/run';
import { projectMenu, type MenuItem, type MenuLayout } from '../actions/project/menu';
import { projectToolbar, type ToolbarLayout } from '../actions/project/toolbar';

export const platform = detectPlatform();

/** Build menu items for a layout now (call when opening a menu). */
export function menuItems(layout: MenuLayout): MenuItem[] {
  void actionsRevision.value;
  const ctx = getActionContext();
  return ctx ? projectMenu(getAllActions(), ctx, layout, { platform }) : [];
}

/**
 * Projected MenuItem[] (flat, separators) → Nuxt UI DropdownMenu / ContextMenu
 * items (groups as nested arrays; toggles as checkbox items).
 */
export function toNuxtItems(items: MenuItem[]): DropdownMenuItem[][] {
  const groups: DropdownMenuItem[][] = [[]];
  for (const it of items) {
    if (it.separator) { if (groups.at(-1)!.length) groups.push([]); continue; }
    const n: DropdownMenuItem = {
      label: it.label,
      icon: it.icon,
      disabled: it.disabled,
      kbds: it.kbds,
      color: it.danger ? 'error' : undefined,
    };
    if (it.children) n.children = toNuxtItems(it.children);
    else if (it.checked !== undefined) {
      n.type = 'checkbox';
      n.checked = it.checked;
      n.onSelect = () => it.action?.();
    } else n.onSelect = () => it.action?.();
    groups.at(-1)!.push(n);
  }
  return groups.filter((g) => g.length);
}

/** Menu layout → reactive Nuxt UI items. */
export function useMenu(layout: MenuLayout | (() => MenuLayout)) {
  return computed(() => toNuxtItems(menuItems(typeof layout === 'function' ? layout() : layout)));
}

export function useToolbar(layout: ToolbarLayout) {
  return computed(() => {
    void actionsRevision.value;
    const ctx = getActionContext();
    return ctx ? projectToolbar(getAllActions(), ctx, layout, platform) : [];
  });
}

/** Display string for an action's binding (tooltips, hints). */
export function bindingOf(id: string): string {
  void actionsRevision.value;
  return formatBinding(getAction(id)?.binding, platform);
}
export function bindingTokensOf(id: string): string[] {
  void actionsRevision.value;
  return formatBindingTokens(getAction(id)?.binding, platform);
}

/** Run an action by id (e.g. from a button). */
export function run(id: string, opts: { recent?: boolean } = {}): void {
  const a = getAction(id);
  const ctx = getActionContext();
  if (!a || !ctx) return;
  if (opts.recent) recordRecent(id);
  void runAction(a, ctx);
}

/** Whether an action is currently available. */
export function available(id: string): boolean {
  void actionsRevision.value;
  const a = getAction(id);
  const ctx = getActionContext();
  return !!a && !!ctx && !(a.when && a.when(ctx) === false);
}

/**
 * Pages capabilities (orca.pages): one main-window tab each, beside Prepare /
 * Preview (TopBar), the page HTML from get_ui() built the first time the tab is
 * shown (PluginPages.cpp), messages both ways (window.orca.postMessage →
 * on_message; post_message → window.orca.onMessage handlers), and a palette entry
 * per page (Orca's PluginPageAction). Tabs go away with the capability.
 */
import { reactive, watch } from 'vue';
import { activeView } from '../../app/state';
import { registerActions, type Action } from '../../app/actions';
import { activePluginPage, pluginPages, type PluginPageTab } from '../state';
import { onPluginsChange, pluginState } from '../manager/store';
import type { CapabilityId } from '../types';

export const pageKey = (pluginKey: string, name: string): string => `${pluginKey}\u0000${name}`;

/** Messages posted by plugins to pages, per page (delivered by PluginPageHost.vue). */
export const pageInbox = reactive(new Map<string, unknown[]>());

export function postToPage(pluginKey: string, name: string, data: unknown): void {
  const k = pageKey(pluginKey, name);
  const q = pageInbox.get(k) ?? [];
  q.push(data);
  pageInbox.set(k, q);
}

export const pageId = (t: PluginPageTab): CapabilityId => ({ pluginKey: t.pluginKey, type: 'pages', name: t.name });

let disposers: Array<() => void> = [];

function sync(): void {
  const tabs: PluginPageTab[] = [];
  for (const r of pluginState.rows) {
    if (r.status !== 'loaded') continue;
    for (const c of r.caps) if (c.type === 'pages' && c.enabled) tabs.push({ key: pageKey(c.pluginKey, c.name), pluginKey: c.pluginKey, name: c.name, pluginName: r.desc.name });
  }
  pluginPages.value = tabs;
  if (activePluginPage.value && !tabs.some((t) => t.key === activePluginPage.value)) activePluginPage.value = null;
  for (const d of disposers) d();
  disposers = [];
  // Owned by the plugin (source `plugin:<key>`), like its Script entries.
  const byPlugin = new Map<string, PluginPageTab[]>();
  for (const t of tabs) byPlugin.set(t.pluginKey, [...(byPlugin.get(t.pluginKey) ?? []), t]);
  for (const [key, list] of byPlugin) {
    const actions: Action[] = list.map((t) => ({
      id: `plugin.page.${t.pluginKey}.${t.name}`, title: t.name, icon: 'i-lucide-panels-top-left', category: 'Plugins',
      aliases: [t.pluginName, 'plugin', 'page'], description: `Shows the ${t.name} page of the ${t.pluginName} plugin.`,
      run: () => { activePluginPage.value = t.key; },
    }));
    disposers.push(registerActions(actions, { id: `plugin:${key}`, name: list[0].pluginName }));
  }
}

let installed = false;
export function installPluginPages(): void {
  if (installed) return;
  installed = true;
  onPluginsChange(sync);
  sync();
  // Prepare / Preview chosen any other way (keys, palette, a tool): the page tab gives way.
  watch(activeView, () => { activePluginPage.value = null; });
}

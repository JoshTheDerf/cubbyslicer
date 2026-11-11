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

// Orca's BitmapCache::load_svg colour replacements (theme colours of Orca's own icons).
const SVG_LIGHT: [string, string][] = [['"#0x00AE42"', '"#009688"'], ['"#00FF00"', '"#52c7b8"'], ['#949494', '#7C8282']];
const SVG_DARK: [string, string][] = [
  ['"#0x00AE42"', '"#009688"'], ['"#262E30"', '"#EFEFF0"'], ['"#323A3D"', '"#B3B3B5"'], ['"#808080"', '"#818183"'],
  ['"#CECECE"', '"#54545B"'], ['"#6B6B6B"', '"#818182"'], ['"#909090"', '"#FFFFFF"'], ['"#00FF00"', '"#FF0000"'],
  ['"#009688"', '"#00675b"'], ['"#F1F1F1"', '"#36363B"'], ['#DBDBDB', '#4A4A51'], ['#F0F0F1', '#333337'], ['#262E30', '#EFEFF0'],
];

/** A page icon as a data URL; an SVG gets Orca's theme colour replacements (PluginPages: create_scaled_bitmap, 20 px). */
export function pageIconSrc(icon: { mime: string; data: string } | undefined): string | undefined {
  if (!icon?.data) return undefined;
  if (icon.mime !== 'image/svg+xml') return `data:${icon.mime};base64,${icon.data}`;
  const bytes = Uint8Array.from(atob(icon.data), (c) => c.charCodeAt(0));
  let svg = new TextDecoder().decode(bytes);
  const dark = typeof document === 'undefined' || document.documentElement.classList.contains('dark');
  // One pass per pair, in Orca's map order (std::map: sorted by key).
  for (const [from, to] of [...(dark ? SVG_DARK : SVG_LIGHT)].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) svg = svg.split(from).join(to);
  let bin = '';
  for (const b of new TextEncoder().encode(svg)) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

function sync(): void {
  const tabs: PluginPageTab[] = [];
  for (const r of pluginState.rows) {
    if (r.status !== 'loaded') continue;
    for (const c of r.caps) if (c.type === 'pages' && c.enabled) tabs.push({ key: pageKey(c.pluginKey, c.name), pluginKey: c.pluginKey, name: c.name, pluginName: r.desc.name, iconSrc: pageIconSrc(c.icon) });
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
      id: `plugin.page.${t.pluginKey}.${t.name}`, title: t.name, icon: 'i-lucide-panels-top-left', iconSrc: t.iconSrc, category: 'Plugins',
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

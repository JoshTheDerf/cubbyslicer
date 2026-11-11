/**
 * The few plugin flags the rest of the app reads. Importing this costs
 * nothing: no plugin code, no Python.
 */
import { computed, ref, shallowRef } from 'vue';
import { dialogs, openDialog } from '../dialogs/state';

/** The Plugins dialog (File ▸ Plugins, as in OrcaSlicer): `dialogs.plugins`. */
export const pluginsDialogOpen = computed({ get: () => dialogs.plugins, set: (v: boolean) => { dialogs.plugins = v; } });
export function openPluginsDialog(): void { openDialog('plugins'); }

/** At least one plugin is loaded (export / send then ask the plugin system about post-processing). */
export const pluginsActive = ref(false);

/** A Pages capability shown as a main-window tab beside Prepare / Preview (Orca: beside Prepare / Preview / Device). */
export interface PluginPageTab {
  key: string; pluginKey: string; name: string; pluginName: string;
  /** The page's get_icon() as a data URL (tab and palette entry; none: the generic page icon). */
  iconSrc?: string;
}
/** Tabs of the loaded, enabled Pages capabilities (kept by src/plugins/host/pages.ts). */
export const pluginPages = shallowRef<PluginPageTab[]>([]);
/** The page shown in the centre area instead of Prepare / Preview (null = none). */
export const activePluginPage = ref<string | null>(null);

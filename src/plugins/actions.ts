/**
 * The built-in plugin command: File ▸ Plugins (OrcaSlicer MainFrame puts
 * "Plugins" in the File menu). Plugin Script capabilities register their own
 * palette entries at runtime (host/actions.ts).
 */
import type { Action } from '../app/actions/types';
import { openPluginsDialog } from './state';

export const pluginsActions: Action[] = [
  {
    id: 'plugins.open', title: 'Plugins…', icon: 'i-lucide-puzzle', category: 'Plugins',
    aliases: ['python', 'orca plugins', 'install plugin', 'scripts', 'extensions', 'post-processing'],
    description: 'Install, enable and configure OrcaSlicer Python plugins.',
    run: () => openPluginsDialog(),
  },
];

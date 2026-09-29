/**
 * Local files (File System Access API): Save as, and the approved-folder
 * browser (open / save into / export into). Ctrl+S / Ctrl+O / Ctrl+I use the
 * native pickers directly (actionContext) when the browser supports them.
 */
import type { Action } from '../types';
import { lastSlice } from '../../state';
import { folderAccessSupported, fsAccessSupported } from '../../../localfs/store';
import { folderDialog, saveLocalAs } from '../../../localfs/commands';

export function localFileActions(): Action[] {
  return [
    { id: 'file.save-as', title: 'Save project as…', icon: 'i-lucide-save-all', category: 'File', aliases: ['save copy', 'cubbyslice'],
      binding: { key: 's', ctrlOrMeta: true, alt: true }, run: (c) => (fsAccessSupported ? saveLocalAs() : c.dispatch.saveProject()) },
    { id: 'local.folders', title: 'Open from local folder…', icon: 'i-lucide-folder-tree', category: 'File', aliases: ['folder', 'directory', 'workspace', 'recent', 'file system'],
      when: () => folderAccessSupported, run: () => { folderDialog.value = { mode: 'open' }; } },
    { id: 'local.save-folder', title: 'Save project to local folder…', icon: 'i-lucide-folder-down', category: 'File', aliases: ['folder', 'directory'],
      when: () => folderAccessSupported, run: () => { folderDialog.value = { mode: 'save' }; } },
    { id: 'local.export-gcode', title: 'Export G-code to local folder…', icon: 'i-lucide-folder-output', category: 'Export', aliases: ['folder', 'directory', 'sd card'],
      when: () => folderAccessSupported && !!lastSlice.value, run: () => { folderDialog.value = { mode: 'export', exportKind: 'gcode' }; } },
    { id: 'local.export-3mf', title: 'Export plate 3MF to local folder…', icon: 'i-lucide-folder-output', category: 'Export', aliases: ['folder', 'directory'],
      when: (c) => folderAccessSupported && c.objectCount > 0, run: () => { folderDialog.value = { mode: 'export', exportKind: '3mf' }; } },
  ];
}

import type { Action } from '../types';

// Orca: Ctrl+N new (browser-reserved, so unbound here), Ctrl+O open, Ctrl+S save, Ctrl+I import.
export function fileActions(): Action[] {
  return [
    { id: 'file.new', title: 'New project', icon: 'i-lucide-file-plus', category: 'File', aliases: ['clear plate', 'reset'],
      run: (c) => c.dispatch.newProject() },
    { id: 'file.open', title: 'Open project…', icon: 'i-lucide-folder-open', category: 'File', aliases: ['load', '3mf'],
      binding: { key: 'o', ctrlOrMeta: true }, run: (c) => c.dispatch.openProject() },
    { id: 'file.save', title: 'Save project', icon: 'i-lucide-save', category: 'File', aliases: ['download project', '3mf'],
      binding: { key: 's', ctrlOrMeta: true }, run: (c) => c.dispatch.saveProject() },
    { id: 'file.import', title: 'Import model…', icon: 'i-lucide-file-input', category: 'File', aliases: ['add', 'open stl', 'obj', '3mf', 'upload'],
      binding: { key: 'i', ctrlOrMeta: true }, run: (c) => c.dispatch.importModels() },
    { id: 'export.plate-3mf', title: 'Export plate as 3MF', icon: 'i-lucide-file-output', category: 'Export', aliases: ['save 3mf', 'download'],
      when: (c) => c.objectCount > 0, run: (c) => c.dispatch.exportPlate3mf() },
    { id: 'export.plate-stl', title: 'Export plate as STL', icon: 'i-lucide-file-output', category: 'Export', aliases: ['save stl', 'download'],
      when: (c) => c.objectCount > 0, run: (c) => c.dispatch.exportPlateStl() },
    { id: 'export.selection-stl', title: 'Export selection as STL', icon: 'i-lucide-file-output', category: 'Export', aliases: ['save stl'],
      when: (c) => c.selection.count > 0, run: (c) => c.dispatch.exportSelectionStl() },
  ];
}

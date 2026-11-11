import type { Action } from '../types';

// Orca: Ctrl+R slice plate, Ctrl+G export plate sliced file.
export function sliceActions(): Action[] {
  const canExport = (c: Parameters<NonNullable<Action['when']>>[0]) => c.slice.available && c.slice.hasResult && !c.slice.busy;
  return [
    { id: 'slice.run', title: 'Slice plate', icon: 'i-lucide-layers', category: 'Slice', aliases: ['generate gcode', 'start'],
      binding: { key: 'r', ctrlOrMeta: true },
      dynamicTitle: (c) => (c.slice.hasResult && c.slice.stale ? 'Re-slice plate' : 'Slice plate'),
      when: (c) => c.slice.available && !c.slice.busy && c.objectCount > 0, run: (c) => c.dispatch.slice() },
    { id: 'slice.all', title: 'Slice all plates', icon: 'i-lucide-layers-3', category: 'Slice', aliases: ['slice everything'],
      when: (c) => c.slice.available && !c.slice.busy && c.objectCount > 0 && c.plates.count > 1, run: (c) => c.dispatch.sliceAll() },
    // Registered before edit.select-none so Esc cancels a running slice first.
    { id: 'slice.cancel', title: 'Cancel slicing', icon: 'i-lucide-circle-stop', category: 'Slice', aliases: ['stop', 'abort'],
      binding: { key: 'escape', passThroughWhenUnavailable: true },
      when: (c) => c.slice.busy && !c.modalOpen, run: (c) => c.dispatch.cancelSlice() },
    { id: 'slice.export-gcode', title: 'Export G-code', icon: 'i-lucide-download', category: 'Export', aliases: ['download gcode', 'save gcode', 'export sliced file'],
      binding: { key: 'g', ctrlOrMeta: true }, when: canExport, run: (c) => c.dispatch.exportGcode() },
    { id: 'slice.export-all-gcode', title: 'Export G-code of all sliced plates', icon: 'i-lucide-download', category: 'Export', aliases: ['export all plates'],
      when: (c) => c.slice.available && !c.slice.busy && c.plates.count > 1 && (c.slice.slicedPlates ?? 0) > 0, run: (c) => c.dispatch.exportAllGcode() },
    // Orca's .gcode.3mf (File ▸ Export in desktop, for every printer; the slice bar's menu offers it for Bambu Lab / "Support 3MF as gcode").
    { id: 'slice.export-sliced-file', title: 'Export plate sliced file', icon: 'i-lucide-package', category: 'Export', aliases: ['gcode.3mf', 'export current sliced file'],
      when: (c) => !!c.slice.slicedFile && canExport(c) && !c.slice.stale, run: (c) => c.dispatch.exportSlicedFile(false) },
    { id: 'slice.export-all-sliced-file', title: 'Export all sliced file', icon: 'i-lucide-package', category: 'Export', aliases: ['gcode.3mf all plates', 'export all plate sliced file'],
      when: (c) => !!c.slice.slicedFile && c.slice.available && !c.slice.busy && (c.slice.currentPlates ?? 0) > 0,
      run: (c) => c.dispatch.exportSlicedFile(true) },
    // Earlier builds used Ctrl+E; keep it working.
    { id: 'slice.export-gcode-e', title: 'Export G-code', icon: 'i-lucide-download', category: 'Export', hidden: true, paletteHidden: true,
      binding: { key: 'e', ctrlOrMeta: true }, when: canExport, run: (c) => c.dispatch.exportGcode() },
  ];
}

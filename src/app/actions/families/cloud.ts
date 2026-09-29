/**
 * CubbyCAD workspace files (the editor's file storage): open, save back,
 * save as, and export G-code / 3MF into a workspace. File ▸ CubbyCAD.
 */
import type { Action } from '../types';
import { lastSlice } from '../../state';
import { cloud } from '../../../cloud/store';
import { cloudExportDialog, cloudOpenDialog, cloudSave, cloudSaveAsDialog } from '../../../cloud/commands';

export function cloudActions(): Action[] {
  return [
    { id: 'cloud.open', title: 'Open from CubbyCAD…', icon: 'i-lucide-cloud-download', category: 'File', aliases: ['workspace', 'cloud', 'open project', 'files'],
      run: () => cloudOpenDialog() },
    { id: 'cloud.save', title: 'Save to CubbyCAD', icon: 'i-lucide-cloud-upload', category: 'File', aliases: ['workspace', 'cloud', 'upload project'],
      run: () => cloudSave() },
    { id: 'cloud.save-as', title: 'Save to CubbyCAD as…', icon: 'i-lucide-cloud-upload', category: 'File', aliases: ['workspace', 'cloud', 'save as'],
      binding: { key: 's', ctrlOrMeta: true, shift: true }, run: () => cloudSaveAsDialog() },
    { id: 'cloud.export-gcode', title: 'Export G-code to CubbyCAD…', icon: 'i-lucide-cloud-upload', category: 'Export', aliases: ['workspace', 'cloud', 'upload gcode'],
      when: () => !!lastSlice.value, run: () => cloudExportDialog('gcode') },
    { id: 'cloud.export-3mf', title: 'Export plate 3MF to CubbyCAD…', icon: 'i-lucide-cloud-upload', category: 'Export', aliases: ['workspace', 'cloud', 'upload 3mf'],
      when: (c) => c.objectCount > 0, run: () => cloudExportDialog('3mf') },
    { id: 'cloud.copy-link', title: 'Copy CubbyCAD link', icon: 'i-lucide-link', category: 'File', aliases: ['share', 'url'],
      when: () => !!cloud.location,
      run: async () => {
        const { cloudLink } = await import('../../../cloud/commands');
        const { toast } = await import('../../../ui');
        const l = cloudLink();
        if (!l) return;
        try { await navigator.clipboard.writeText(l); toast.success('Link copied.', { timeout: 1600 }); } catch { toast.info(l); }
      } },
  ];
}

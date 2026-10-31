/**
 * Orca's plater toolbar, centred over the 3D view (GLCanvas3D main toolbar +
 * gizmo bar), grouped by task: add, edit, place on the bed, transform, modify
 * the mesh, per-region print adjustments, measure. The four paint gizmos share
 * one menu button (their L / P / N / H keys still toggle them directly).
 * Groups become separators; trailing groups fold into a "More tools" menu when
 * the view is narrow. Camera presets live on the view cube.
 */
import type { ToolbarLayout } from '../project/toolbar';

export const PLATE_TOOLBAR: ToolbarLayout = {
  groups: [
    { label: 'Add', items: ['file.import', 'cad.palette'] },
    { label: 'Edit', items: ['edit.duplicate', 'edit.delete'] },
    { label: 'Place', items: ['arrange.all', 'object.auto-orient', 'object.lay-on-face'] },
    { label: 'Transform', segmented: true, items: ['object.gizmo.all', 'object.gizmo.move', 'object.gizmo.rotate', 'object.gizmo.scale'] },
    { label: 'Modify', items: ['tool.cut', 'tool.boolean', 'tool.text'] },
    {
      label: 'Print adjustments',
      items: [
        { menu: 'paint', label: 'Paint', icon: 'i-lucide-paintbrush', items: ['paint.support', 'paint.seam', 'paint.color', 'paint.fuzzy'] },
        'layers.edit', 'tool.brim-ears',
      ],
    },
    { label: 'Inspect', items: ['tool.measure'] },
  ],
};

/**
 * Orca's plater toolbar, centred over the 3D view (GLCanvas3D main toolbar +
 * gizmo bar): add / orient / arrange / instances, then the gizmo tools.
 * Groups become separators. Camera presets live on the view cube.
 */
import type { ToolbarLayout } from '../project/toolbar';

export const PLATE_TOOLBAR: ToolbarLayout = {
  groups: [
    ['file.import', 'object.auto-orient', 'arrange.all'],
    ['edit.duplicate', 'edit.delete'],
    ['layers.edit'],
    ['object.gizmo.all', 'object.gizmo.move', 'object.gizmo.rotate', 'object.gizmo.scale', 'object.lay-on-face'],
    ['tool.cut', 'paint.support', 'paint.seam', 'paint.color', 'paint.fuzzy'],
    ['tool.boolean', 'tool.text', 'tool.measure', 'tool.brim-ears'],
  ],
};

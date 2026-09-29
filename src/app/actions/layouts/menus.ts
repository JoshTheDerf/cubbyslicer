/**
 * Top menu bar layouts: id arrays only (order + grouping). Labels, gates,
 * ✓ states and kbd chips come from the action records.
 */
import type { MenuLayout } from '../project/menu';
import { SUB_SOURCES, SUB_TYPES } from '../families/object';
import { HANDY_MODEL_IDS } from '../families/calibration';
import { SNAP_OPTIONS } from '@cubby/shared/snap';

/** "Add part ▸ Load… / Box / …" submenus for each volume type. */
const ADD_SUBMENUS = SUB_TYPES.map(([type, label, icon]) => ({ label, icon, children: SUB_SOURCES.map(([src]) => `object.add.${type}.${src}`) }));

export const FILE_MENU: MenuLayout = {
  groups: [
    ['file.new', 'file.open', 'file.save', 'file.save-as'],
    [{ label: 'Local folders', icon: 'i-lucide-folder-tree', children: ['local.folders', 'local.save-folder', 'local.export-gcode', 'local.export-3mf'] },
      { label: 'CubbyCAD', icon: 'i-lucide-cloud', children: ['cloud.open', 'cloud.save', 'cloud.save-as', 'cloud.export-gcode', 'cloud.export-3mf', 'cloud.copy-link'] }],
    ['file.import'],
    ['export.plate-3mf', 'export.plate-stl', 'export.selection-stl', 'slice.export-gcode', 'slice.export-all-gcode'],
    ['presets.export-bundle'],
    ['app.preferences'],
  ],
};

export const EDIT_MENU: MenuLayout = {
  groups: [
    ['edit.undo', 'edit.redo'],
    ['edit.cut', 'edit.copy', 'edit.paste'],
    ['edit.select-all', 'edit.select-none'],
    ['edit.duplicate', 'edit.instance-remove', 'edit.instances', 'edit.rename', 'edit.delete', 'edit.delete-all'],
  ],
};

export const VIEW_MENU: MenuLayout = {
  groups: [
    ['view.prepare', 'view.preview', 'view.assembly'],
    [
      'view.camera.iso', 'view.camera.top', 'view.camera.bottom', 'view.camera.front', 'view.camera.back', 'view.camera.left', 'view.camera.right',
    ],
    ['view.fit-selection', 'view.fit-plate', 'view.zoom-in', 'view.zoom-out'],
    ['view.camera.perspective', 'view.camera.orthographic',
      { label: 'Grid snap', icon: 'i-lucide-magnet', children: SNAP_OPTIONS.map((o) => `view.snap.${o.value}`) }],
    ['view.panel.sidebar'],
  ],
};

export const OBJECT_MENU: MenuLayout = {
  groups: [
    ['object.gizmo.all', 'object.gizmo.move', 'object.gizmo.rotate', 'object.gizmo.scale', 'object.lay-on-face'],
    ['object.auto-orient', 'object.drop', 'object.center', 'object.scale-to-fit'],
    [
      { label: 'Mirror', icon: 'i-lucide-flip-horizontal-2', children: ['object.mirror.x', 'object.mirror.y', 'object.mirror.z'] },
      { label: 'Rotate 90°', icon: 'i-lucide-rotate-cw', children: ['object.rotate90.x', 'object.rotate90.y', 'object.rotate90.z'] },
    ],
    ['tool.cut', 'object.split-objects', 'object.split-parts'],
    ADD_SUBMENUS,
    ['arrange.all', 'arrange.plate', 'arrange.selection', 'plate.auto-orient-all'],
    ['object.toggle-hidden', 'object.toggle-printable', 'object.settings', 'object.table'],
    ['layers.edit', 'object.height-range', 'layers.reset'],
    ['tool.measure', 'tool.text', 'tool.svg', 'tool.simplify', 'tool.boolean', 'tool.brim-ears'],
  ],
};

export const PLATE_MENU: MenuLayout = {
  groups: [
    ['plate.add', 'plate.delete'],
    ['plate.prev', 'plate.next'],
    ['arrange.plate', 'plate.auto-orient-all', 'plate.lock'],
    ['plate.clear'],
    ['plate.settings'],
  ],
};

export const SLICE_MENU: MenuLayout = {
  groups: [
    ['slice.run', 'slice.cancel'],
    ['slice.export-gcode', 'printer.print', 'printer.send'],
    ['printer.setup', 'printer.webui'],
    ['printer.bed-shape', 'filament.flushing', 'filament.grouping'],
    ['presets.create-printer', 'presets.create-filament'],
  ],
};

/** Orca's "Calibration" top menu (MainFrame.cpp) + the tolerance test from its handy models. */
export const CALIBRATION_MENU: MenuLayout = {
  groups: [
    ['calib.temp', 'calib.volumetric', 'calib.pa', 'calib.flow', 'calib.retraction', 'calib.cornering',
      { label: 'Input shaping', icon: 'i-lucide-activity', children: ['calib.is-freq', 'calib.is-damp'] }, 'calib.vfa'],
    ['calib.tolerance', { label: 'Handy models', icon: 'i-lucide-box', children: HANDY_MODEL_IDS.map(([id]) => `handy.${id}`) }],
    ['calib.guide'],
  ],
};

export const HELP_MENU: MenuLayout = {
  groups: [
    ['settings.setup'],
    ['help.palette', 'help.shortcuts'],
    ['claude.connect', 'claude.disconnect'],
    ['help.about'],
  ],
};

export const MENU_BAR: Array<{ id: string; label: string; layout: MenuLayout }> = [
  { id: 'file', label: 'File', layout: FILE_MENU },
  { id: 'edit', label: 'Edit', layout: EDIT_MENU },
  { id: 'view', label: 'View', layout: VIEW_MENU },
  { id: 'object', label: 'Object', layout: OBJECT_MENU },
  { id: 'plate', label: 'Plate', layout: PLATE_MENU },
  { id: 'slice', label: 'Slice', layout: SLICE_MENU },
  { id: 'calibration', label: 'Calibration', layout: CALIBRATION_MENU },
  { id: 'help', label: 'Help', layout: HELP_MENU },
];

/** Right-click on one or more objects. */
export const OBJECT_CONTEXT_MENU: MenuLayout = {
  groups: [
    ['edit.rename', 'object.settings'],
    ['edit.cut', 'edit.copy', 'edit.paste'],
    ['edit.duplicate', 'edit.instance-remove', 'edit.instances'],
    ['tool.cut', { label: 'Split', icon: 'i-lucide-split', children: ['object.split-objects', 'object.split-parts'] }, ...ADD_SUBMENUS, 'object.height-range'],
    ['object.auto-orient', 'object.center', 'object.drop', 'object.lay-on-face', 'object.scale-to-fit'],
    [{ label: 'Mirror', icon: 'i-lucide-flip-horizontal-2', children: ['object.mirror.x', 'object.mirror.y', 'object.mirror.z'] },
      { label: 'Rotate 90°', icon: 'i-lucide-rotate-cw', children: ['object.rotate90.x', 'object.rotate90.y', 'object.rotate90.z'] }],
    ['arrange.all', 'arrange.plate', 'arrange.selection'],
    ['object.toggle-hidden', 'object.toggle-printable', 'export.selection-stl'],
    ['tool.text', 'tool.svg', 'tool.simplify', 'tool.boolean', 'tool.brim-ears'],
    ['edit.delete'],
  ],
};

/** Right-click on empty plate. */
export const PLATE_CONTEXT_MENU: MenuLayout = {
  groups: [
    ['file.import', 'edit.paste'],
    ['tool.text.object', 'tool.svg', { label: 'Add handy model', icon: 'i-lucide-box', children: HANDY_MODEL_IDS.map(([id]) => `handy.${id}`) }],
    ['arrange.all', 'arrange.plate', 'plate.auto-orient-all', 'edit.select-all'],
    ['plate.add', 'plate.lock', 'plate.clear', 'plate.delete'],
    ['plate.settings'],
    ['view.fit-plate'],
  ],
};

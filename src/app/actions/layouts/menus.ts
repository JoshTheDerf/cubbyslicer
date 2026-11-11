/**
 * Top menu bar layouts: id arrays only (order + grouping). Labels, gates,
 * ✓ states and kbd chips come from the action records.
 */
import type { MenuLayout } from '../project/menu';
import { ALIGN_ITEMS, DISTRIBUTE_ITEMS, SUB_SOURCES, SUB_TYPES } from '../families/object';
import { ORDER_ITEMS } from '../families/plate';
import { HANDY_MODEL_IDS } from '../families/calibration';
import { SNAP_OPTIONS } from '@cubby/shared/snap';
import { paletteShapes } from '../../../cad/shapes';

/** CubbyCAD's built-in shapes, added as new objects. */
const ADD_SHAPE_MENU = { label: 'Add shape', icon: 'i-lucide-shapes', children: paletteShapes().map((s) => `cad.add.${s.id}`) };
/** CubbyCAD modelling: group / ungroup / hole. */
const CAD_GROUP = ['object.group', 'object.ungroup', 'object.make-hole', 'object.make-solid'];

/** "Add part ▸ Load… / Box / …" submenus for each volume type. */
const ADD_SUBMENUS = SUB_TYPES.map(([type, label, icon]) => ({ label, icon, children: SUB_SOURCES.map(([src]) => `object.add.${type}.${src}`) }));

export const FILE_MENU: MenuLayout = {
  groups: [
    ['file.new', 'file.open', 'file.save', 'file.save-as'],
    [{ label: 'Local folders', icon: 'i-lucide-folder-tree', children: ['local.folders', 'local.save-folder', 'local.export-gcode', 'local.export-3mf'] },
      { label: 'CubbyCAD', icon: 'i-lucide-cloud', children: ['cloud.open', 'cloud.save', 'cloud.save-as', 'cloud.export-gcode', 'cloud.export-3mf', 'cloud.copy-link'] }],
    ['file.import'],
    ['export.plate-3mf', 'export.plate-stl', 'export.selection-stl', 'export.cubby', 'slice.export-gcode', 'slice.export-all-gcode'],
    ['presets.export-bundle'],
    ['plugins.open'],
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
    ['view.design', 'view.prepare', 'view.preview', 'view.assembly'],
    [
      'view.camera.iso', 'view.camera.top', 'view.camera.bottom', 'view.camera.front', 'view.camera.back', 'view.camera.left', 'view.camera.right',
    ],
    ['view.fit-selection', 'view.fit-plate', 'view.zoom-in', 'view.zoom-out'],
    ['view.camera.perspective', 'view.camera.orthographic',
      { label: 'Grid snap', icon: 'i-lucide-magnet', children: SNAP_OPTIONS.map((o) => `view.snap.${o.value}`) }],
    ['view.xray', 'view.section', 'view.section.align', 'view.focus-mode', 'view.center-of-mass'],
    ['view.panel.sidebar'],
  ],
};

/**
 * Object menu: what to do with the selection, by task (place, transform,
 * modify, add to it, CubbyCAD modelling, print settings, view). Plate-wide
 * arrange / orient live in the Plate menu; the gizmo modes, which have
 * toolbar buttons and keys, share one submenu.
 */
const MIRROR_MENU = { label: 'Mirror', icon: 'i-lucide-flip-horizontal-2', children: ['object.mirror.x', 'object.mirror.y', 'object.mirror.z'] };
const ROTATE90_MENU = { label: 'Rotate 90°', icon: 'i-lucide-rotate-cw', children: ['object.rotate90.x', 'object.rotate90.y', 'object.rotate90.z'] };
/** Orca 2.5 "Align/Distribute" (several objects). */
const ALIGN_MENU = {
  label: 'Align / distribute', icon: 'i-lucide-align-horizontal-justify-center',
  children: [...DISTRIBUTE_ITEMS.map(([k]) => `object.distribute.${k}`), ...ALIGN_ITEMS.map(([k]) => `object.align.${k}`)],
};
/** Orca 2.5 "Order By" (plate menu): the active plate, and every plate in a submenu. */
const ORDER_MENU = {
  label: 'Order by', icon: 'i-lucide-arrow-down-wide-narrow',
  children: [...ORDER_ITEMS.map(([o]) => `plate.order.${o}`), { label: 'All plates', children: ORDER_ITEMS.map(([o]) => `plate.order-all.${o}`) }],
};
const SPLIT_MENU = { label: 'Split', icon: 'i-lucide-split', children: ['object.split-objects', 'object.split-parts'] };

export const OBJECT_MENU: MenuLayout = {
  groups: [
    ['object.auto-orient', 'object.lay-on-face', 'object.drop', 'object.center', 'object.scale-to-fit', 'arrange.selection', ALIGN_MENU],
    [{ label: 'Transform gizmo', icon: 'i-lucide-move-3d', children: ['object.gizmo.all', 'object.gizmo.move', 'object.gizmo.rotate', 'object.gizmo.scale'] },
      MIRROR_MENU, ROTATE90_MENU],
    ['tool.cut', SPLIT_MENU, 'tool.boolean', 'tool.simplify', 'object.fix-model'],
    [{ label: 'Add part or modifier', icon: 'i-lucide-box', children: ADD_SUBMENUS }, 'tool.text', 'tool.svg'],
    [{ ...ADD_SHAPE_MENU, children: ['cad.palette', ...ADD_SHAPE_MENU.children] },
      { label: 'Shape modelling', icon: 'i-lucide-boxes', children: [...CAD_GROUP, 'cad.edit-tree'] }, 'object.to-design', 'object.mesh-to-design', 'object.edit-design', 'object.unlink-design'],
    ['object.settings', 'object.height-range', 'layers.edit', 'layers.reset', 'tool.brim-ears', 'object.toggle-printable'],
    ['object.toggle-hidden', 'tool.measure', 'object.table'],
  ],
};

export const PLATE_MENU: MenuLayout = {
  groups: [
    ['plate.add', 'plate.delete'],
    ['plate.prev', 'plate.next'],
    ['arrange.all', 'arrange.plate', 'arrange.options'],
    ['plate.auto-orient-all', ORDER_MENU, 'plate.lock'],
    ['plate.fix-all', 'plate.fix-all-plates'],
    ['plate.clear'],
    ['plate.settings'],
  ],
};

export const SLICE_MENU: MenuLayout = {
  groups: [
    ['slice.run', 'slice.cancel'],
    ['slice.export-gcode', 'printer.print', 'printer.send'],
    ['printer.setup', 'printer.webui', 'printer.sync-filaments'],
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

/**
 * Right-click on one or more objects (the viewport and the object list).
 * Contextual: only what applies to the clicked selection is listed, so one
 * object, several objects and a CubbyCAD shape each get their own menu.
 * Clipboard cut stays in Edit (Ctrl+X): here "Cut" is the cut tool.
 */
export const OBJECT_CONTEXT_MENU: MenuLayout = {
  contextual: true,
  groups: [
    ['edit.rename', 'object.settings'],
    [{ label: 'Add part or modifier', icon: 'i-lucide-box', children: ADD_SUBMENUS }, 'object.height-range', 'tool.text', 'tool.svg'],
    ['edit.copy', 'edit.paste', 'edit.duplicate', 'edit.instance-remove', 'edit.instances'],
    ['object.auto-orient', 'object.drop', 'object.center', 'object.scale-to-fit', 'arrange.selection', ALIGN_MENU, MIRROR_MENU, ROTATE90_MENU],
    ['tool.cut', SPLIT_MENU, 'tool.boolean', 'tool.simplify', 'object.fix-model', 'tool.brim-ears'],
    [...CAD_GROUP, 'cad.edit-tree', 'object.to-design', 'object.mesh-to-design', 'object.edit-design', 'object.unlink-design'],
    ['object.toggle-hidden', 'object.toggle-printable', 'export.selection-stl'],
    ['edit.delete'],
  ],
};

/** Right-click on empty plate (contextual, like the object menu). */
export const PLATE_CONTEXT_MENU: MenuLayout = {
  contextual: true,
  groups: [
    ['file.import', 'edit.paste'],
    [{ ...ADD_SHAPE_MENU, children: ['cad.palette', ...ADD_SHAPE_MENU.children] }, 'tool.text.object', 'tool.svg',
      { label: 'Add handy model', icon: 'i-lucide-box', children: HANDY_MODEL_IDS.map(([id]) => `handy.${id}`) }],
    ['arrange.plate', 'arrange.options', 'plate.auto-orient-all', ORDER_MENU, 'edit.select-all'],
    ['plate.fix-all', 'plate.fix-all-plates'],
    ['plate.add', 'plate.lock', 'plate.settings'],
    ['plate.clear', 'plate.delete'],
    ['view.fit-plate'],
  ],
};

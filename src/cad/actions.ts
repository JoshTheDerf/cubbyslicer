/**
 * CubbyCAD modelling commands in the action registry (menus, palette, keys,
 * run_action). Ids follow CubbyCAD's (object.group / object.ungroup /
 * object.make-hole / object.make-solid). CubbyCAD's Ctrl+G / Ctrl+Shift+G
 * would clash with Orca's Export G-code / Print plate here, so group and
 * ungroup are keyless; CubbyCAD's make-hole / make-solid are keyless there too,
 * and its H (hide) / L (lock) are Orca's fuzzy-skin / support painting, so
 * hide and lock are keyless too (menus, palette, the shape tree).
 * State is module-level (./commands), like the tools' actions.
 */
import type { Action } from '../app/actions/types';
import type { AppContext } from '../app/actions/context';
import { activeView } from '../app/state';
import { objects, selectedIds } from '../project/store';
import { isCadGroup } from './api';
import { paletteShapes } from './shapes';
import {
  addShapeCmd, cadChild, cadObject, cadUi, groupSelectionCmd, lockTarget, selectionHoleState, setHoleCmd, toggleLockCmd, ungroupSelectionCmd,
} from './commands';
import { exportCubbyCmd } from './files';

const prepare = () => activeView.value === 'prepare';
const selectedCad = () => objects.value.some((o) => o.cad && selectedIds.value.includes(o.id));

export function cadActions(): Action[] {
  return [
    { id: 'cad.palette', title: 'Add shape…', icon: 'i-lucide-shapes', category: 'Object',
      aliases: ['primitive', 'add primitive', 'cubbycad', 'box', 'cylinder', 'sphere', 'modelling', 'shape palette'],
      when: () => prepare(), state: () => (cadUi.paletteOpen ? 'active' : undefined),
      run: () => { cadUi.paletteOpen = !cadUi.paletteOpen; } },
    ...paletteShapes().map((s): Action => ({
      id: `cad.add.${s.id}`, title: `Add ${s.label.toLowerCase()}`, icon: s.icon, category: 'Object',
      aliases: ['primitive', 'shape', s.label.toLowerCase(), 'cubbycad'],
      when: () => prepare(), run: () => addShapeCmd(s.id),
    })),
    { id: 'object.group', title: 'Group', icon: 'i-lucide-folder-plus', category: 'Object',
      aliases: ['combine', 'union', 'boolean group', 'manifold group', 'csg'],
      when: (c: AppContext) => prepare() && c.selection.count >= 2, run: () => groupSelectionCmd() },
    { id: 'object.ungroup', title: 'Ungroup', icon: 'i-lucide-folder-minus', category: 'Object', aliases: ['split group', 'dissolve'],
      when: () => prepare() && objects.value.some((o) => selectedIds.value.includes(o.id) && o.cad && isCadGroup(o.cad.node)),
      run: () => ungroupSelectionCmd() },
    { id: 'object.make-solid', title: 'Make solid', icon: 'i-lucide-box', category: 'Object',
      aliases: ['add', 'union', 'positive', 'set add', 'contribution', 'not a hole'],
      when: () => prepare() && (!!cadChild.value || selectedCad()), state: () => (selectionHoleState() === 'solid' ? 'on' : undefined),
      run: () => setHoleCmd(false) },
    { id: 'object.make-hole', title: 'Make hole', icon: 'i-lucide-circle-dashed', category: 'Object',
      aliases: ['subtract', 'negative', 'cut', 'remove', 'difference', 'set subtract', 'contribution'],
      when: () => prepare() && (!!cadChild.value || selectedCad()), state: () => (selectionHoleState() === 'hole' ? 'on' : undefined),
      run: () => setHoleCmd(true) },
    { id: 'object.toggle-locked', title: 'Lock shape', icon: 'i-lucide-lock', category: 'Object', aliases: ['freeze', 'protect', 'unlock'],
      dynamicTitle: () => (lockTarget()?.locked ? 'Unlock shape' : 'Lock shape'),
      dynamicIcon: () => (lockTarget()?.locked ? 'i-lucide-unlock' : 'i-lucide-lock'),
      when: () => prepare() && !!lockTarget(), run: () => toggleLockCmd() },
    { id: 'cad.edit-tree', title: 'Edit shape tree', icon: 'i-lucide-list-tree', category: 'Object', aliases: ['node tree', 'outliner', 'shape parameters'],
      when: () => prepare() && !!cadObject.value, state: () => (cadUi.panelOpen ? 'active' : undefined),
      run: () => { cadUi.panelOpen = !cadUi.panelOpen; } },
    { id: 'export.cubby', title: 'Export as .cubby (CubbyCAD)…', icon: 'i-lucide-file-box', category: 'Export',
      aliases: ['cubbycad', 'cad scene', 'export cad', 'cubby'],
      when: () => objects.value.some((o) => o.cad), run: () => exportCubbyCmd() },
  ];
}

import { nudgeDelta, nudgeStep } from '@cubby/shared/nudge';
import type { Action } from '../types';
import type { AppContext } from '../context';
import type { GizmoMode } from '../../../viewport/controller';
import { openDialog } from '../../../dialogs/state';

// Orca plater keys: M move, R rotate, S scale, F lay on face, A arrange all, Shift+A arrange the active plate,
// Q auto-orient (selection, or everything when nothing is selected), Shift+Q orient the active plate,
// V toggle printable, arrows nudge the selection by the grid snap, 10 mm when snap is off (Shift = a tenth).
// Arrow → bed axis and the step come from @cubby/shared/nudge (Orca's fixed X / Y, not camera-relative).
const gizmo = (id: string, mode: GizmoMode, title: string, icon: string, key: string, aliases: string[]): Action => ({
  id, title, icon, category: 'Object', aliases, binding: { key, scope: 'prepare' },
  state: (c) => (c.gizmo === mode && !c.layOnFace ? 'active' : undefined),
  run: (c) => c.dispatch.setGizmo(mode),
});

const AXES = ['X', 'Y', 'Z'] as const;
const NUDGES: Array<{ key: string; arrow: string; name: string }> = [
  { key: 'arrowup', arrow: 'ArrowUp', name: 'up' },
  { key: 'arrowdown', arrow: 'ArrowDown', name: 'down' },
  { key: 'arrowleft', arrow: 'ArrowLeft', name: 'left' },
  { key: 'arrowright', arrow: 'ArrowRight', name: 'right' },
];

function nudgeBy(c: AppContext, arrow: string, fine: boolean): void {
  const d = nudgeDelta(arrow, { step: nudgeStep(c.snapIncrement, { fallback: 10, fine }), up: 'z' });
  if (d) c.dispatch.nudge(d.x, d.y);
}

type SubType = 'part' | 'negative' | 'modifier' | 'support_blocker' | 'support_enforcer';
type SubSource = 'box' | 'cylinder' | 'sphere' | 'slab' | 'file';
/** Orca's right-click "Add part / negative part / modifier / support blocker / support enforcer" menus. */
export const SUB_TYPES: Array<[SubType, string, string]> = [
  ['part', 'Add part', 'i-lucide-box'],
  ['negative', 'Add negative part', 'i-lucide-box-select'],
  ['modifier', 'Add modifier', 'i-lucide-sliders-horizontal'],
  ['support_blocker', 'Add support blocker', 'i-lucide-shield-off'],
  ['support_enforcer', 'Add support enforcer', 'i-lucide-shield-plus'],
];
export const SUB_SOURCES: Array<[SubSource, string]> = [
  ['file', 'Load…'], ['box', 'Box'], ['cylinder', 'Cylinder'], ['sphere', 'Sphere'], ['slab', 'Slab'],
];

export function objectActions(): Action[] {
  const sel = (c: AppContext) => c.selection.count > 0;
  return [
    gizmo('object.gizmo.all', 'all', 'Transform', 'i-lucide-move-3d', 'g', ['full gizmo', 'edit gizmo', 'move rotate scale']),
    gizmo('object.gizmo.move', 'translate', 'Move', 'i-lucide-move', 'm', ['translate', 'gizmo']),
    gizmo('object.gizmo.rotate', 'rotate', 'Rotate', 'i-lucide-rotate-3d', 'r', ['gizmo', 'turn']),
    gizmo('object.gizmo.scale', 'scale', 'Scale', 'i-lucide-scaling', 's', ['gizmo', 'resize']),
    { id: 'object.lay-on-face', title: 'Lay on face', icon: 'i-lucide-panel-bottom', category: 'Object', aliases: ['place on face', 'flatten', 'place face on bed'],
      binding: { key: 'f', scope: 'prepare' }, when: (c) => c.objectCount > 0,
      state: (c) => (c.layOnFace ? 'active' : undefined), run: (c) => c.dispatch.toggleLayOnFace() },
    { id: 'object.lay-on-face.cancel', title: 'Cancel lay on face', icon: 'i-lucide-x', category: 'Object', hidden: true, paletteHidden: true,
      binding: { key: 'escape', scope: 'prepare', passThroughWhenUnavailable: true },
      when: (c) => c.layOnFace && !c.modalOpen, run: (c) => c.dispatch.toggleLayOnFace() },
    { id: 'object.auto-orient', title: 'Auto orient', icon: 'i-lucide-compass', category: 'Object',
      aliases: ['orient', 'optimal orientation', 'best face down'],
      dynamicTitle: (c) => (c.selection.count ? (c.selection.count > 1 ? `Auto orient ${c.selection.count} objects` : 'Auto orient selected') : 'Auto orient all'),
      binding: { key: 'q', scope: 'prepare' }, when: (c) => c.objectCount > 0 && !c.orienting,
      run: (c) => c.dispatch.autoOrient('auto') },
    { id: 'plate.auto-orient-all', title: 'Auto orient plate', icon: 'i-lucide-compass', category: 'Arrange', aliases: ['orient plate', 'orient everything', 'orient all objects on plate'],
      binding: { key: 'q', shift: true, scope: 'prepare' }, when: (c) => c.objectCount > 0 && !c.orienting,
      run: (c) => c.dispatch.autoOrient('all') },
    // No key: Orca's B is the mesh boolean gizmo (src/tools/actions.ts).
    { id: 'object.drop', title: 'Drop to bed', icon: 'i-lucide-arrow-down-to-line', category: 'Object', aliases: ['floor', 'z zero'],
      when: sel, run: (c) => c.dispatch.dropToBed() },
    { id: 'object.center', title: 'Center on plate', icon: 'i-lucide-crosshair', category: 'Object', aliases: ['middle'],
      when: sel, run: (c) => c.dispatch.center() },
    { id: 'object.scale-to-fit', title: 'Scale to fit', icon: 'i-lucide-maximize', category: 'Object', aliases: ['maximize', 'fill bed'],
      when: sel, run: (c) => c.dispatch.scaleToFit() },
    ...AXES.map((ax, i): Action => ({
      id: `object.mirror.${ax.toLowerCase()}`, title: `Mirror along ${ax}`, icon: 'i-lucide-flip-horizontal-2', category: 'Object', aliases: ['flip'],
      when: sel, run: (c) => c.dispatch.mirror(i as 0 | 1 | 2),
    })),
    ...AXES.map((ax, i): Action => ({
      id: `object.rotate90.${ax.toLowerCase()}`, title: `Rotate 90° about ${ax}`, icon: 'i-lucide-rotate-cw', category: 'Object', aliases: ['turn'],
      when: sel, run: (c) => c.dispatch.rotate90(i as 0 | 1 | 2),
    })),
    { id: 'object.toggle-hidden', title: 'Hide', icon: 'i-lucide-eye-off', category: 'Object', aliases: ['show', 'visibility'],
      dynamicTitle: (c) => (c.selection.allHidden ? 'Show' : 'Hide'),
      dynamicIcon: (c) => (c.selection.allHidden ? 'i-lucide-eye' : 'i-lucide-eye-off'),
      // Hides the picked shape of a CAD object, else the objects. (CubbyCAD's H is Orca's fuzzy-skin paint here.)
      when: sel, run: (c) => c.dispatch.toggleHidden() },
    { id: 'object.toggle-printable', title: 'Don’t print', icon: 'i-lucide-printer', category: 'Object', aliases: ['printable', 'skip', 'exclude'],
      dynamicTitle: (c) => (c.selection.allNotPrintable ? 'Print' : 'Don’t print'),
      dynamicIcon: (c) => (c.selection.allNotPrintable ? 'i-lucide-printer' : 'i-lucide-ban'),
      binding: { key: 'v', scope: 'prepare' }, when: sel, run: (c) => c.dispatch.togglePrintable() },
    { id: 'object.settings', title: 'Per-object settings', icon: 'i-lucide-sliders-horizontal', category: 'Settings', aliases: ['overrides', 'modifier'],
      when: (c) => !!c.selection.single, run: (c) => c.dispatch.perObjectSettings() },
    { id: 'arrange.all', title: 'Arrange all objects', icon: 'i-lucide-layout-grid', category: 'Arrange', aliases: ['auto arrange', 'pack', 'layout', 'arrange all plates'],
      dynamicTitle: (c) => (c.plates.count > 1 ? 'Arrange all plates' : 'Arrange plate'),
      binding: { key: 'a', scope: 'prepare' }, when: (c) => c.objectCount > 0, run: (c) => c.dispatch.arrangeAll() },
    { id: 'arrange.plate', title: 'Arrange objects on plate', icon: 'i-lucide-layout-dashboard', category: 'Arrange', aliases: ['arrange selected plate', 'pack plate'],
      binding: { key: 'a', shift: true, scope: 'prepare' }, when: (c) => c.plates.activeObjects > 0, run: (c) => c.dispatch.arrangePlate() },
    { id: 'arrange.selection', title: 'Arrange selection', icon: 'i-lucide-layout-grid', category: 'Arrange', aliases: ['pack'],
      when: (c) => c.selection.count > 0, run: (c) => c.dispatch.arrangeSelection() },
    { id: 'arrange.options', title: 'Arrange options…', icon: 'i-lucide-settings-2', category: 'Arrange', aliases: ['arrange settings', 'spacing', 'auto rotate', 'arrange spacing'],
      run: () => openDialog('arrange') },
    { id: 'object.split-objects', title: 'Split to objects', icon: 'i-lucide-split', category: 'Object', aliases: ['separate', 'break apart', 'explode'],
      when: sel, run: (c) => c.dispatch.splitToObjects() },
    { id: 'object.split-parts', title: 'Split to parts', icon: 'i-lucide-component', category: 'Object', aliases: ['separate parts', 'volumes'],
      when: sel, run: (c) => c.dispatch.splitToParts() },
    ...SUB_TYPES.flatMap(([type, label, icon]) => SUB_SOURCES.map(([source, sLabel]): Action => ({
      id: `object.add.${type}.${source}`, title: `${label}: ${sLabel}`, icon, category: 'Object',
      aliases: [`add ${label.toLowerCase()}`, sLabel.toLowerCase()],
      when: (c) => !!c.selection.single, run: (c) => c.dispatch.addSubObject(type, source),
    }))),
    // Arrow nudges: one visible help entry + the dispatching (hidden) bindings.
    { id: 'object.nudge', title: 'Move selection by the grid snap, 10 mm when off (Shift: a tenth)', icon: 'i-lucide-move', category: 'Object', paletteHidden: true,
      binding: { displayOnly: true, displayTokens: ['←', '↑', '→', '↓'], scope: 'prepare' }, when: sel, run: () => {} },
    ...NUDGES.flatMap(({ key, arrow, name }): Action[] => [false, true].map((fine): Action => ({
      id: `object.nudge.${name}${fine ? '.fine' : ''}`, title: `Move selection ${name}${fine ? ' (fine)' : ''}`, category: 'Object',
      hidden: true, paletteHidden: true,
      binding: { key, shift: fine, scope: 'prepare', whenFocusIdle: true, passThroughWhenUnavailable: true },
      when: sel, run: (c) => nudgeBy(c, arrow, fine),
    }))),
  ];
}

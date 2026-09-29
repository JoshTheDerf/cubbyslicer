/**
 * Tool commands (Orca gizmos + import helpers), keyed like Orca's
 * KBShortcutsDialog: C cut, U measure, T text, B mesh boolean, E brim ears.
 * State is module-level (./state), so actions don't need the context dispatch.
 */
import type { Action } from '../app/actions/types';
import type { AppContext } from '../app/actions/context';
import { activeView } from '../app/state';
import { selectedPart } from '../project/store';
import { toolState, toggleTool, openTool, type ToolId } from './state';

const prepare = () => activeView.value === 'prepare';
const active = (id: ToolId) => (): 'active' | undefined => (toolState.active === id ? 'active' : undefined);

export function toolActions(): Action[] {
  const single = (c: AppContext) => !!c.selection.single || !!selectedPart.value;
  return [
    { id: 'tool.cut', title: 'Cut', icon: 'i-lucide-scissors', category: 'Object', aliases: ['cut plane', 'split', 'connectors', 'dowel', 'dovetail', 'tongue and groove', 'gizmo cut'],
      binding: { key: 'c', scope: 'prepare' }, when: (c) => prepare() && !!c.selection.single, state: active('cut'), run: () => toggleTool('cut') },
    { id: 'view.assembly', title: 'Assembly view', icon: 'i-lucide-boxes', category: 'View', aliases: ['assembled', 'explode', 'exploded view', 'cut pieces'],
      when: (c) => prepare() && c.objectCount > 0, state: active('assembly'), run: () => toggleTool('assembly') },
    { id: 'tool.measure', title: 'Measure', icon: 'i-lucide-ruler', category: 'Object', aliases: ['distance', 'angle', 'dimension', 'gizmo measure'],
      binding: { key: 'u', scope: 'prepare' }, when: (c) => prepare() && c.objectCount > 0, state: active('measure'), run: () => toggleTool('measure') },
    { id: 'tool.text', title: 'Text', icon: 'i-lucide-type', category: 'Object', aliases: ['emboss', 'engrave', 'add text', 'label', 'gizmo text'],
      binding: { key: 't', scope: 'prepare' }, when: () => prepare(), state: active('text'), run: () => toggleTool('text') },
    { id: 'tool.text.object', title: 'Add text object', icon: 'i-lucide-type', category: 'Object', aliases: ['text on plate', 'emboss'],
      when: () => prepare(), run: () => openTool('text', { newObject: true }) },
    { id: 'tool.svg', title: 'Add SVG', icon: 'i-lucide-shapes', category: 'Object', aliases: ['svg', 'emboss svg', 'logo', 'vector'],
      when: () => prepare(), state: active('svg'), run: () => toggleTool('svg') },
    { id: 'tool.simplify', title: 'Simplify model', icon: 'i-lucide-triangle', category: 'Object', aliases: ['decimate', 'reduce triangles', 'polygon count'],
      when: (c) => prepare() && single(c), state: active('simplify'), run: () => toggleTool('simplify') },
    { id: 'tool.boolean', title: 'Mesh boolean', icon: 'i-lucide-squares-subtract', category: 'Object', aliases: ['union', 'difference', 'subtract', 'intersection', 'csg', 'gizmo mesh boolean'],
      binding: { key: 'b', scope: 'prepare' }, when: (c) => prepare() && c.selection.count > 0, state: active('boolean'), run: () => toggleTool('boolean') },
    { id: 'tool.brim-ears', title: 'Brim ears', icon: 'i-lucide-circle-dot', category: 'Object', aliases: ['mouse ears', 'brim', 'gizmo brim ears'],
      binding: { key: 'e', scope: 'prepare' }, when: (c) => prepare() && !!c.selection.single, state: active('brim'), run: () => toggleTool('brim') },
  ];
}

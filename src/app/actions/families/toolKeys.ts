import type { Action } from '../types';
import { cadUi } from '../../../cad/commands';
import { closeTool, TOOL_TITLES, toolKeys, toolState } from '../../../tools/state';
import { activeView } from '../../state';
import { designUi } from '../../../design/state';

// Keys of the open tool panel (src/tools) and the shape palette: Esc closes them, Delete / Backspace
// delete the tool's own selection, Enter runs its main action. Registered before slice / edit, so they
// win over Esc = cancel slice / clear selection and Delete = delete objects while a tool is open.
// The Design view's right-click offer menu closes on Esc the same way (before Esc clears the design selection).
export function toolKeyActions(): Action[] {
  const del = () => !!toolKeys.value?.deleteSelected?.available();
  return [
    { id: 'tool.palette.close', title: 'Close the shape palette', icon: 'i-lucide-x', category: 'Object', hidden: true, paletteHidden: true,
      binding: { key: 'escape', scope: 'prepare', passThroughWhenUnavailable: true },
      when: (c) => cadUi.paletteOpen && !c.modalOpen, run: () => { cadUi.paletteOpen = false; } },
    { id: 'tool.close', title: 'Close tool', icon: 'i-lucide-x', category: 'Object',
      dynamicTitle: () => (toolState.active ? `Close ${TOOL_TITLES[toolState.active].toLowerCase()}` : 'Close tool'),
      binding: { key: 'escape', scope: 'prepare', passThroughWhenUnavailable: true },
      when: (c) => !!toolState.active && !c.modalOpen, run: () => closeTool() },
    { id: 'design.offer.close', title: 'Close menu', icon: 'i-lucide-x', category: 'Design', hidden: true, paletteHidden: true,
      binding: { key: 'escape', scope: 'design', passThroughWhenUnavailable: true },
      when: () => activeView.value === 'design' && !!designUi.offerClose, run: () => designUi.offerClose?.() },
    { id: 'tool.delete-selected', title: 'Delete selected (tool)', icon: 'i-lucide-trash-2', category: 'Object', tone: 'danger',
      dynamicTitle: () => toolKeys.value?.deleteSelected?.title ?? 'Delete selected',
      binding: { key: 'delete', scope: 'prepare' }, when: del, run: () => toolKeys.value?.deleteSelected?.run() },
    { id: 'tool.delete-selected-backspace', title: 'Delete selected (tool)', icon: 'i-lucide-trash-2', category: 'Object', hidden: true, paletteHidden: true,
      binding: { key: 'backspace', scope: 'prepare' }, when: del, run: () => toolKeys.value?.deleteSelected?.run() },
    { id: 'tool.confirm', title: 'Apply tool', icon: 'i-lucide-check', category: 'Object',
      dynamicTitle: () => toolKeys.value?.confirm?.title ?? 'Apply tool',
      binding: { key: 'enter', scope: 'prepare', passThroughWhenUnavailable: true },
      when: () => !!toolKeys.value?.confirm?.available(), run: () => toolKeys.value?.confirm?.run() },
  ];
}

/** Edit and object commands used by the action dispatch: undo, delete, clipboard, toggles, nudge, rename. */
import { shallowRef } from 'vue';
import { NudgeBurst } from '@cubby/shared/nudge';
import { toast } from '../../../ui';
import {
  clearAll, copyObjects, duplicateObjects, endGesture, objects, pasteObjects, redo, removeObjects, rotateObjects, select, selectedIds,
  setPrintable, setVisible, translateObjects, undo, type ObjectClipboard,
} from '../../../project/store';
import { cadChild, cadNode, deleteNode, editNode } from '../../../cad/commands';
import { settingsUi } from '../../../settings/uiState';
import { toggleLayOnFace, viewportState } from '../../../viewport/controller';
import { setClipboard, ui } from '../uiState';

/**
 * A modal editing session with its own undo list (the Design tab's sketch: its whole session
 * becomes one app undo step when it is finished) takes Ctrl+Z / Ctrl+Y and Edit ▸ Undo / Redo
 * while it is open, so they never walk the app history underneath it.
 */
export interface UndoOverride {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undoLabel(): string | null;
  redoLabel(): string | null;
}
export const undoOverride = shallowRef<UndoOverride | null>(null);

export function doUndo(): void {
  if (undoOverride.value) { undoOverride.value.undo(); return; }
  const l = undo(); if (l) toast.info(`Undid ${l.toLowerCase()}.`, { timeout: 1600 });
}
export function doRedo(): void {
  if (undoOverride.value) { undoOverride.value.redo(); return; }
  const l = redo(); if (l) toast.info(`Redid ${l.toLowerCase()}.`, { timeout: 1600 });
}

export function deleteSelection(): void {
  // A shape picked in a CAD object's tree: delete just that node (CubbyCAD's Delete).
  const child = cadChild.value;
  if (child) { void deleteNode(child.objectId, child.nodeId); return; }
  if (selectedIds.value.length) removeObjects();
}

export function doDuplicate(count = 1): void {
  if (!selectedIds.value.length) return;
  duplicateObjects(selectedIds.value.slice(), count);
}

export function toggleLayFlat(): void {
  if (!objects.value.length) return;
  toggleLayOnFace();
  if (viewportState.layOnFace) toast.info('Click a face to place it on the bed. Press Esc to cancel.', { timeout: 2500 });
}

export function toggleHiddenSelection(): void {
  const child = cadChild.value;
  if (child) { void editNode(child.objectId, { id: child.nodeId, hidden: !cadNode.value?.hidden }, cadNode.value?.hidden ? 'Show shape' : 'Hide shape'); return; }
  const objs = objects.value.filter((o) => selectedIds.value.includes(o.id));
  if (!objs.length) return;
  setVisible(objs.map((o) => o.id), objs.every((o) => !o.visible));
}

export function togglePrintableSelection(): void {
  const objs = objects.value.filter((o) => selectedIds.value.includes(o.id));
  if (!objs.length) return;
  setPrintable(objs.map((o) => o.id), objs.every((o) => !o.printable));
}

export function rotate90(axis: 0 | 1 | 2): void {
  const v: [number, number, number] = [0, 0, 0];
  v[axis] = 1;
  rotateObjects(v, 90);
}

export function startRename(): void {
  if (selectedIds.value.length === 1) ui.renamingId = selectedIds.value[0];
}

/** Select the object and switch the sidebar's Process section to Orca's "Objects" mode. */
export function revealObjectSettings(): void {
  if (!selectedIds.value.length) return;
  select([selectedIds.value.at(-1)!]);
  settingsUi.region = 'objects';
  settingsUi.collapsedSections = settingsUi.collapsedSections.filter((x) => x !== 'process');
  ui.revealObjectSettings++;
}

// ---- clipboard (Orca Ctrl+C / Ctrl+X / Ctrl+V) -------------------------------------

export function copySelection(): void {
  const c = copyObjects();
  if (!c) return;
  setClipboard(c);
  toast.info(`Copied ${c.objects.length === 1 ? c.objects[0].name : `${c.objects.length} objects`}.`, { timeout: 1600 });
}
export function cutSelection(): void {
  const c = copyObjects();
  if (!c) return;
  setClipboard(c);
  removeObjects(c.objects.map((o) => o.id));
}
export function pasteClipboard(): void {
  const c: ObjectClipboard | null = ui.clipboard;
  if (c) pasteObjects(c);
}

export function deleteAll(): void { if (objects.value.length) clearAll(); }

/** Seals a burst of arrow nudges as one undo step once the keys go idle (@cubby/shared/nudge). */
const nudgeBurst = new NudgeBurst(endGesture);

export function nudge(dx: number, dy: number): void {
  if (!selectedIds.value.length) return;
  translateObjects([dx, dy, 0]);
  nudgeBurst.bump();
}

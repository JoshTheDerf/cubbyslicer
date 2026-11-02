/**
 * A plate's menu (the plate bar's tabs and the object list's plate rows).
 * Like the other right-click menus it lists only what applies to that plate.
 */
import type { DropdownMenuItem } from '@nuxt/ui';
import { moveObjectsToPlate, objectPlate, objectsOnPlate, plates, select, selectedIds, setActivePlate } from '../../project/store';
import { useSliceController } from '../slice';
import { openPlateSettings } from '../../plates/ui';
import { arrangePlate, autoOrientObjects, clearPlateCmd, deletePlateCmd, exportGcode, togglePlateLock } from './actions';

export function plateMenu(i: number, rename: (i: number) => void): DropdownMenuItem[][] {
  const slicer = useSliceController();
  const p = plates.value[i];
  if (!p) return [];
  const n = objectsOnPlate(i).length;
  const run = (fn: () => unknown) => () => { setActivePlate(i); void fn(); };
  const moving = selectedIds.value.filter((id) => objectPlate.value.get(id) !== i);
  const groups: Array<Array<DropdownMenuItem | false>> = [
    [
      n > 0 && slicer.status.value !== 'slicing' && { label: 'Slice this plate', icon: 'i-lucide-layers', onSelect: run(() => slicer.slice()) },
      slicer.plateStates.value[i] === 'done' && { label: 'Export G-code', icon: 'i-lucide-download', onSelect: run(exportGcode) },
    ],
    [
      n > 0 && !p.locked && { label: 'Arrange objects on plate', icon: 'i-lucide-layout-dashboard', kbds: ['shift', 'A'], onSelect: run(arrangePlate) },
      n > 0 && !p.locked && { label: 'Auto orient plate', icon: 'i-lucide-compass', kbds: ['shift', 'Q'], onSelect: run(() => autoOrientObjects('all')) },
      n > 0 && { label: 'Select objects on plate', icon: 'i-lucide-box-select', onSelect: run(() => select(objectsOnPlate(i).map((o) => o.id))) },
      moving.length > 0 && {
        label: moving.length > 1 ? `Move ${moving.length} selected objects here` : 'Move selected object here', icon: 'i-lucide-move-right',
        onSelect: () => moveObjectsToPlate(moving, i),
      },
    ],
    [
      { label: 'Rename…', icon: 'i-lucide-text-cursor-input', onSelect: () => rename(i) },
      { label: p.locked ? 'Unlock plate' : 'Lock plate', icon: p.locked ? 'i-lucide-lock-open' : 'i-lucide-lock', onSelect: () => togglePlateLock(i) },
      { label: 'Plate settings…', icon: 'i-lucide-settings-2', onSelect: run(() => openPlateSettings(i)) },
    ],
    [
      n > 0 && { label: 'Delete all objects on plate', icon: 'i-lucide-eraser', color: 'error', onSelect: () => clearPlateCmd(i) },
      plates.value.length > 1 && { label: 'Delete plate', icon: 'i-lucide-square-x', color: 'error', onSelect: () => deletePlateCmd(i) },
    ],
  ];
  return groups.map((g) => g.filter((it): it is DropdownMenuItem => !!it)).filter((g) => g.length);
}

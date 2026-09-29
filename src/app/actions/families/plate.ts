import type { Action } from '../types';

// Multiple plates (Orca PartPlateList). Orca: A arranges all plates, Shift+A
// the selected plate, Shift+Q auto-orients the active plate.
export function plateActions(): Action[] {
  const multi = (c: Parameters<NonNullable<Action['when']>>[0]) => c.plates.count > 1;
  return [
    { id: 'plate.add', title: 'Add plate', icon: 'i-lucide-square-plus', category: 'Plate', aliases: ['new plate', 'more plates'],
      when: (c) => c.plates.count < 36, run: (c) => c.dispatch.addPlate() },
    { id: 'plate.delete', title: 'Delete plate', icon: 'i-lucide-square-x', category: 'Plate', tone: 'danger', aliases: ['remove plate'],
      when: multi, run: (c) => c.dispatch.deletePlate() },
    { id: 'plate.next', title: 'Next plate', icon: 'i-lucide-chevron-right', category: 'Plate',
      when: multi, run: (c) => c.dispatch.selectPlate((c.plates.active + 1) % c.plates.count) },
    { id: 'plate.prev', title: 'Previous plate', icon: 'i-lucide-chevron-left', category: 'Plate',
      when: multi, run: (c) => c.dispatch.selectPlate((c.plates.active - 1 + c.plates.count) % c.plates.count) },
    { id: 'plate.lock', title: 'Lock plate', icon: 'i-lucide-lock', category: 'Plate', aliases: ['unlock plate', 'freeze'],
      dynamicTitle: (c) => (c.plates.locked ? 'Unlock plate' : 'Lock plate'),
      dynamicIcon: (c) => (c.plates.locked ? 'i-lucide-lock-open' : 'i-lucide-lock'),
      state: (c) => (c.plates.locked ? 'active' : undefined),
      run: (c) => c.dispatch.togglePlateLock() },
    { id: 'plate.clear', title: 'Delete all objects on plate', icon: 'i-lucide-eraser', category: 'Plate', tone: 'danger', aliases: ['clear plate', 'empty plate'],
      when: (c) => c.plates.activeObjects > 0, run: (c) => c.dispatch.clearPlate() },
  ];
}

import type { Action } from '../types';

/** Orca 2.5 "Order By" (plate right-click). */
export const ORDER_ITEMS: Array<['name' | 'filament' | 'height' | 'size', string]> = [['name', 'Name'], ['filament', 'Filament'], ['height', 'Height'], ['size', 'Size']];
const ORDER_HELP = 'Sorts the objects in the object list; choosing the same order again reverses it. Printing by object follows this order.';

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
    ...ORDER_ITEMS.map(([o, label]): Action => ({
      id: `plate.order.${o}`, title: `Order objects on plate by ${label.toLowerCase()}`, icon: 'i-lucide-arrow-down-wide-narrow', category: 'Plate',
      aliases: ['order by', 'sort objects', 'object order', label.toLowerCase()], description: ORDER_HELP,
      when: (c) => c.plates.activeObjects > 1, run: (c) => c.dispatch.orderObjects(o, false),
    })),
    ...ORDER_ITEMS.map(([o, label]): Action => ({
      id: `plate.order-all.${o}`, title: `Order objects on all plates by ${label.toLowerCase()}`, icon: 'i-lucide-arrow-down-wide-narrow', category: 'Plate',
      aliases: ['order by', 'sort objects', 'all plates', label.toLowerCase()], description: ORDER_HELP,
      when: (c) => c.plates.count > 1 && c.objectCount > 1, run: (c) => c.dispatch.orderObjects(o, true),
    })),
    { id: 'plate.fix-all', title: 'Fix all', icon: 'i-lucide-wrench', category: 'Plate', aliases: ['repair all', 'fix models', 'repair meshes', 'fix plate'],
      description: 'Repairs the mesh of every object on the plate. Paint is kept.',
      when: (c) => c.plates.activeObjects > 0, run: (c) => c.dispatch.repairMeshes('plate') },
    { id: 'plate.fix-all-plates', title: 'Fix all plates', icon: 'i-lucide-wrench', category: 'Plate', aliases: ['repair all plates', 'fix every model'],
      description: 'Repairs the mesh of every object on every plate. Paint is kept.',
      when: (c) => c.plates.count > 1 && c.objectCount > 0, run: (c) => c.dispatch.repairMeshes('all') },
    { id: 'plate.clear', title: 'Delete all objects on plate', icon: 'i-lucide-eraser', category: 'Plate', tone: 'danger', aliases: ['clear plate', 'empty plate'],
      when: (c) => c.plates.activeObjects > 0, run: (c) => c.dispatch.clearPlate() },
  ];
}

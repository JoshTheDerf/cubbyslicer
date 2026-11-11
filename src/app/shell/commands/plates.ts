/** Plate commands: add / delete / clear / select / lock / arrange / order objects. */
import { nextTick } from 'vue';
import { toast } from '../../../ui';
import {
  activePlate, addPlate, clearPlate, deletePlate, mutate, objectInfo, objects, objectsOnPlate, plateOf, plates, setActivePlate, setPlateLocked,
} from '../../../project/store';
import type { ProjectObject } from '../../../project/types';
import { plateLabel } from '../../../project/plates';
import { fitBed } from '../../../viewport/controller';
import { confirmAction } from '../uiState';
import { runArrange } from '../arrange';

export function addPlateCmd(): void {
  const i = addPlate();
  if (i < 0) toast.info('That’s the maximum number of plates.');
  else void nextTick(() => fitBed());
}

export async function deletePlateCmd(i = activePlate.value): Promise<void> {
  if (plates.value.length <= 1) return;
  const n = objectsOnPlate(i).length;
  if (n) {
    const ok = await confirmAction({
      title: `Delete ${plateLabel(plates.value[i], i)}?`,
      message: `This also deletes the ${n === 1 ? 'object' : `${n} objects`} on it. You can undo this.`,
      confirmLabel: 'Delete plate', danger: true,
    });
    if (!ok) return;
  }
  deletePlate(i);
}

export async function clearPlateCmd(i = activePlate.value): Promise<void> {
  const n = objectsOnPlate(i).length;
  if (!n) return;
  clearPlate(i);
  toast.info(`Deleted ${n === 1 ? '1 object' : `${n} objects`} from ${plateLabel(plates.value[i], i)}.`, { timeout: 2200 });
}

/** Make plate `i` active and bring it into view. */
export function selectPlate(i: number): void {
  setActivePlate(i);
  void nextTick(() => fitBed());
}

export function togglePlateLock(i = activePlate.value): void {
  const p = plates.value[i];
  if (p) setPlateLocked(i, !p.locked);
}

export function arrangePlate(): void { void runArrange('plate'); }

// ---- Order By (Orca 2.5 ObjectList::order_objects) -------------------------------------

export type ObjectOrder = 'name' | 'filament' | 'height' | 'size';
export const OBJECT_ORDER_LABELS: Record<ObjectOrder, string> = { name: 'Name', filament: 'Filament', height: 'Height', size: 'Size' };

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortKey(o: ProjectObject, order: ObjectOrder): number {
  if (order === 'filament') { const e = Number(o.overrides.extruder); return Number.isFinite(e) && e > 0 ? e : 1; }
  const info = objectInfo.value.get(o.id);
  if (!info) return 0;
  return order === 'height' ? info.max[2] : (info.max[0] - info.min[0]) * (info.max[1] - info.min[1]) * (info.max[2] - info.min[2]);
}

/** Stable sort of the objects on each plate within the list slots that plate already holds. */
function sorted(list: ProjectObject[], order: ObjectOrder, descending: boolean, plate: number | 'all'): ProjectObject[] {
  const out = list.slice();
  const plateIds = plate === 'all' ? [...new Set(list.map((o) => plateOf(o.id)))] : [plate];
  for (const p of plateIds) {
    const slots: number[] = [];
    list.forEach((o, i) => { if (plateOf(o.id) === p) slots.push(i); });
    const items = slots.map((i) => list[i]);
    const cmp = (a: ProjectObject, b: ProjectObject) => (order === 'name' ? natural.compare(a.name, b.name) : sortKey(a, order) - sortKey(b, order));
    items.sort((a, b) => (descending ? cmp(b, a) : cmp(a, b)));
    slots.forEach((slot, k) => { out[slot] = items[k]; });
  }
  return out;
}

/**
 * Orca "Order By": sort the objects of a plate (or every plate) in the object
 * list by name (natural), filament, height or size. Choosing the order the
 * objects already have reverses it. By-object printing follows this order.
 * One undo step.
 */
export function orderPlateObjects(order: ObjectOrder, plate: number | 'all' = activePlate.value): void {
  const cur = objects.value;
  let next = sorted(cur, order, false, plate);
  if (next.every((o, i) => o === cur[i])) next = sorted(cur, order, true, plate);
  if (next.every((o, i) => o === cur[i])) return;
  const ids = next.map((o) => o.id);
  mutate(`Order by ${order}`, () => {
    const byId = new Map(objects.value.map((o) => [o.id, o]));
    objects.value = ids.map((id) => byId.get(id)!);
  });
}

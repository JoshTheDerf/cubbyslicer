/** Plate commands: switch, add, delete, rename, lock, move objects between plates, reset bed types. */
import { MAX_PLATES, plateShift, resetPlateBedTypes } from '../plates';
import { plateOfLive } from './derived';
import { mutate } from './history';
import { fitsWhereItIs, insertPlate, placeOnPlates, removePlateAt, shiftToPlate } from './placement';
import { activePlate, bed, clampActivePlate, objects, plates, targets } from './state';

export function setActivePlate(i: number): void {
  if (i >= 0 && i < plates.value.length) activePlate.value = i;
}

/** Add an empty plate at the end (or after `after`); it becomes active. */
export function addPlate(after = plates.value.length - 1): number {
  if (plates.value.length >= MAX_PLATES) return -1;
  const at = Math.min(plates.value.length, after + 1);
  mutate('Add plate', () => insertPlate(at), { slice: false });
  activePlate.value = at;
  return at;
}

/** Delete plate `i` and the objects on it (Orca's plate delete). Keeps at least one plate. */
export function deletePlate(i = activePlate.value): void {
  const n = plates.value.length;
  if (n <= 1 || i < 0 || i >= n) return;
  mutate(`Delete ${plates.value[i].name || `plate ${i + 1}`}`, () => removePlateAt(i));
  if (activePlate.value > i) activePlate.value--;
  clampActivePlate();
}

export function renamePlate(i: number, name: string): void {
  mutate('Rename plate', () => { const p = plates.value[i]; if (p) p.name = name.trim().slice(0, 80); }, { slice: false });
}

export function setPlateLocked(i: number, locked: boolean): void {
  mutate(locked ? 'Lock plate' : 'Unlock plate', () => { const p = plates.value[i]; if (p) p.locked = locked; }, { slice: false });
}

/** Move objects to plate `i`, keeping their place on the plate when it's free, else arranging them there. */
export function moveObjectsToPlate(ids: string[], i: number): void {
  const ts = targets(ids);
  if (!ts.length || i < 0 || i >= plates.value.length) return;
  mutate(`Move to plate ${i + 1}`, () => {
    const b = bed.value, n = plates.value.length;
    for (const o of ts) {
      const from = plateOfLive(o);
      if (from === i) continue;
      if (from >= 0) {
        const [dx, dy] = plateShift(b, from, n, i, n);
        o.position = [o.position[0] + dx, o.position[1] + dy, o.position[2]];
      } else shiftToPlate([o], i);
    }
    const others = objects.value.filter((o) => !ts.includes(o) && plateOfLive(o) === i);
    const clash = ts.filter((o, k) => !fitsWhereItIs(o, [...others, ...ts.filter((_, j) => j !== k)], i));
    if (clash.length) placeOnPlates(clash, [...others, ...ts.filter((o) => !clash.includes(o))], i);
  });
  activePlate.value = i;
}

/** Drop every plate's bed type override (a printer with a single bed type); true when one was set. */
export function clearPlateBedTypes(): boolean {
  const r = resetPlateBedTypes(plates.value);
  if (r.reset) mutate('Reset plate bed types', () => { plates.value = r.plates; });
  return r.reset;
}

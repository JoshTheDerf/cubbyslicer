/**
 * Orca auto arrange I/O: what the engine's ArrangeJob reads
 * (`arrangeInputs`) and applying its result as one undo step
 * (`applyArrange`). app/shell/arrange.ts runs the job in between.
 */
import type { ArrangeArgs, ArrangeResult, SliceObjectInput } from '../../engine/types';
import { isHoleObject } from '../../cad/build';
import { quatFromAxisAngle, quatMultiply, quatNormalize, type Quat } from '../math';
import { MAX_PLATES, plateOffset, type PlateMeta } from '../plates';
import { objectWorldInfo, plateOfInfo, plateOfLive } from './derived';
import { mutate } from './history';
import { insertPlate, removePlateAt } from './placement';
import { engineObject } from './sliceInput';
import { activePlate, bed, clampActivePlate, meshes, objects, plates } from './state';

/** Per-object facts ArrangeJob reads alongside `ArrangeInputs.objects`. */
export type ArrangeInputItem = ArrangeArgs['items'][number];
/** Per-plate facts ArrangeJob reads. */
export type ArrangeInputPlate = ArrangeArgs['plates'][number];
export interface ArrangeInputs { ids: string[]; objects: SliceObjectInput[]; items: ArrangeInputItem[]; plates: ArrangeInputPlate[] }

/** A plate's own print sequence setting ('' = the global one). */
function plateSeq(p: PlateMeta): ArrangeInputPlate['seq'] {
  const v = p.config?.print_sequence ?? (p.config?.complete_objects !== undefined ? (String(p.config.complete_objects) === '1' ? 'by object' : 'by layer') : '');
  const sv = Array.isArray(v) ? String(v[0] ?? '') : String(v);
  return sv === 'by object' || sv === 'by layer' ? sv : '';
}

/** A plate's own IDEX/IQEX parallel mode ('' = none: the process preset's applies). */
function plateOwnImexMode(p: PlateMeta): string {
  const v = p.config?.imex_parallel_mode;
  return String((Array.isArray(v) ? v[0] : v) ?? '');
}

/**
 * Inputs for the engine's Orca arrange (src/engine/client.ts orcaArrange):
 * every object except CubbyCAD holes, as slice-job objects whose transforms
 * are plate-local for objects on a plate, plus the per-object and per-plate
 * facts ArrangeJob reads. `ids[i]` is the object of `objects[i]`. `imported`
 * objects on no plate count as on the active plate.
 */
export function arrangeInputs(selection: readonly string[] = [], imported: readonly string[] = []): ArrangeInputs {
  const sel = new Set(selection), fresh = new Set(imported);
  const n = plates.value.length;
  const ids: string[] = [], out: SliceObjectInput[] = [], items: ArrangeInputItem[] = [];
  for (const o of objects.value) {
    if (isHoleObject(o.cad?.node)) continue;
    const mesh = meshes.get(o.meshId);
    const info = objectWorldInfo(o);
    if (!mesh || !info) continue;
    let plate = plateOfInfo(info);
    if (plate < 0 && fresh.has(o.id)) plate = activePlate.value;
    const offset: [number, number] = plate >= 0 ? plateOffset(plate, n, bed.value) : [0, 0];
    out.push(engineObject(o, mesh, info, offset, false));
    ids.push(o.id);
    items.push({ plate, printable: o.printable, selected: sel.has(o.id) });
  }
  const platesOut = plates.value.map((p) => ({
    locked: !!p.locked, seq: plateSeq(p),
    toolChanges: (p.customGcodes ?? []).filter((g) => g.type === 'tool_change' && (g.extruder ?? 0) > 0).map((g) => g.extruder!),
    imexMode: plateOwnImexMode(p),
  }));
  return { ids, objects: out, items, plates: platesOut };
}

export interface ArrangeOutcome { moved: number; unplaced: number; imex: boolean }

/**
 * Apply an Orca arrange result (one undo step): new plates are appended,
 * objects placed (plate-local XY + rotation about Z, height kept), and after
 * "Arrange all" trailing plates left empty or without printable objects are
 * removed (PartPlateList::rebuild_plates_after_arrangement). By-object
 * printing also takes the arrange order as the object order.
 */
export function applyArrange(ids: readonly string[], r: ArrangeResult, mode: 'all' | 'plate' | 'selection'): ArrangeOutcome {
  let moved = 0;
  mutate('Arrange', () => {
    while (plates.value.length < Math.min(r.plates, MAX_PLATES)) insertPlate(plates.value.length);
    const n = plates.value.length;
    const byId = new Map(objects.value.map((o) => [o.id, o]));
    r.items.forEach((it, k) => {
      const o = byId.get(ids[k]);
      if (!o || !it.moved) return;
      const [ox, oy] = plateOffset(it.plate, n, bed.value);
      const q = it.dRot ? quatNormalize(quatMultiply(quatFromAxisAngle([0, 0, 1], it.dRot), [...o.rotation] as Quat)) : o.rotation;
      o.rotation = q;
      o.position = [it.x + ox, it.y + oy, o.position[2]];
      moved++;
    });
    if (mode === 'all') {
      // Recycle: from the last plate down, drop plates that are empty or hold nothing printable; stop at the first other unlocked one.
      for (let i = plates.value.length - 1; i > 0; i--) {
        const on = objects.value.filter((o) => plateOfLive(o) === i);
        if (!on.length || !on.some((o) => o.printable)) removePlateAt(i, true);
        else if (plates.value[i].locked) continue;
        else break;
      }
    }
    if (r.seqPrint && r.order.length > 1) {
      // Orca sorts objects by arrange order: refill the arranged objects' slots in that order.
      const ordered = r.order.map((k) => ids[k]).filter((id) => byId.has(id));
      const set = new Set(ordered);
      let next = 0;
      objects.value = objects.value.map((o) => (set.has(o.id) ? byId.get(ordered[next++])! : o));
    }
  });
  clampActivePlate();
  return { moved, unplaced: r.unplaced.length, imex: !!r.imex };
}

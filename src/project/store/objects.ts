/**
 * Object lifecycle: add (imports), remove, duplicate and instance counts,
 * copy / paste, clear.
 */
import { decomposeTRS, type Quat, type Vec3 } from '../math';
import { computeBBox } from '../mesh';
import { plateOffset } from '../plates';
import type { MeshData, ParsedObject, ProjectObject } from '../types';
import { cloneObj } from './clone';
import { objectsOnPlate, plateOf, plateOfLive } from './derived';
import { mutate } from './history';
import { anyClash, arrangeInternal, dropObj, placeOnPlates, shiftToPlate } from './placement';
import {
  activePlate, addMesh, bed, getObject, meshIdsOf, meshRevision, meshes, objects, plateBedOf, plates, selectedIds, targets, uid, uniqueName,
} from './state';

export interface AddOptions { select?: boolean; label?: string }

/** Add parsed objects (from import). Returns new object ids. */
export function addParsedObjects(parsed: ParsedObject[], opts: AddOptions = {}): string[] {
  const ids: string[] = [];
  mutate(opts.label ?? (parsed.length === 1 ? `Add ${parsed[0].name}` : `Add ${parsed.length} objects`), () => {
    const plate = activePlate.value;
    const existing = objectsOnPlate(plate);
    const fresh: ProjectObject[] = [];
    const b = plateBedOf(plate);
    const [ox, oy] = plateOffset(plate, plates.value.length, bed.value);
    for (const p of parsed) {
      const mesh = addMesh(p.positions, p.indices);
      let position: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0];
      let rotation: Quat = [0, 0, 0, 1];
      let scale: Vec3 = [1, 1, 1];
      if (p.transform) {
        const d = decomposeTRS(p.transform);
        if (d.exact) {
          position = [d.position[0] + ox, d.position[1] + oy, d.position[2]]; rotation = d.rotation; scale = d.scale;
        } else {
          // Sheared placement: bake the linear part into the mesh.
          const m = p.transform, pos = mesh.positions;
          for (let i = 0; i < pos.length; i += 3) {
            const x = pos[i], y = pos[i + 1], z = pos[i + 2];
            pos[i] = m[0] * x + m[4] * y + m[8] * z;
            pos[i + 1] = m[1] * x + m[5] * y + m[9] * z;
            pos[i + 2] = m[2] * x + m[6] * y + m[10] * z;
          }
          mesh.bbox = computeBBox(pos);
          position = [m[12] + ox, m[13] + oy, m[14]];
        }
      }
      const o: ProjectObject = {
        id: uid(), name: uniqueName(p.name), meshId: mesh.id,
        position, rotation, scale, visible: true, printable: p.printable ?? true, overrides: {}, color: '',
      };
      objects.value.push(o);
      const live = objects.value[objects.value.length - 1];
      dropObj(live);
      fresh.push(live);
      ids.push(o.id);
    }
    // Keep file placements when they fit; otherwise find room for the new objects.
    if (anyClash(fresh, existing)) {
      if (existing.length === 0) arrangeInternal(fresh, existing, 6, true, 'bottom-left', plate);
      else arrangeInternal(fresh, existing, 6, false, 'nearest-center', plate);
    }
  });
  if (opts.select ?? true) selectedIds.value = ids;
  return ids;
}

export function removeObjects(ids = selectedIds.value.slice()): void {
  if (!ids.length) return;
  const set = new Set(ids);
  mutate(ids.length === 1 ? `Delete ${getObject(ids[0])?.name ?? 'object'}` : `Delete ${ids.length} objects`, () => {
    objects.value = objects.value.filter((o) => !set.has(o.id));
  });
}

/** Push copies of `src` (fresh ids, unique names) into the project; returns the live (reactive) copies. */
function pushCopies(src: ProjectObject, count: number, created: string[]): ProjectObject[] {
  const fresh: ProjectObject[] = [];
  for (let i = 0; i < count; i++) {
    const c = cloneObj(src);
    c.id = uid();
    c.name = uniqueName(src.name);
    objects.value.push(c);
    fresh.push(objects.value[objects.value.length - 1]);
    created.push(c.id);
  }
  return fresh;
}

/** Duplicate each target `count` times as instances (shared mesh). */
export function duplicateObjects(ids = selectedIds.value.slice(), count = 1): string[] {
  const src = targets(ids);
  if (!src.length || count < 1) return [];
  const created: string[] = [];
  mutate(count > 1 ? `Add ${count} instances` : 'Duplicate', () => {
    const p0 = plateOf(src[0].id);
    const plate = p0 >= 0 ? p0 : activePlate.value;
    const existing = objectsOnPlate(plate);
    const fresh = src.flatMap((s) => pushCopies(s, count, created));
    placeOnPlates(fresh, existing, plate);
  });
  selectedIds.value = created;
  return created;
}

/** Instances of an object: every object sharing its mesh (Orca's instances of one ModelObject). */
export function instancesOf(id: string): ProjectObject[] {
  const o = getObject(id);
  return o ? objects.value.filter((x) => x.meshId === o.meshId) : [];
}

/**
 * Orca "Set number of instances": make each target's instance group exactly
 * `count` strong — new instances are placed next to the others on the same
 * plate (spilling to the next plates when full); surplus ones are removed
 * newest-first, never the object itself.
 */
export function setInstanceCount(ids: string[], count: number | ((current: number) => number)): void {
  const clampN = (c: number) => Math.max(1, Math.min(500, Math.round(c)));
  const seen = new Set<string>();
  const groups: Array<{ src: ProjectObject; members: ProjectObject[] }> = [];
  for (const o of targets(ids)) {
    if (seen.has(o.meshId)) continue;
    seen.add(o.meshId);
    groups.push({ src: o, members: objects.value.filter((x) => x.meshId === o.meshId) });
  }
  const want = groups.map((g) => clampN(typeof count === 'function' ? count(g.members.length) : count));
  if (!groups.length || groups.every((g, i) => g.members.length === want[i])) return;
  const created: string[] = [];
  const label = typeof count === 'number' ? `Set ${want[0]} instance${want[0] === 1 ? '' : 's'}` : 'Change instances';
  mutate(label, () => {
    groups.forEach(({ src, members }, gi) => {
      const n = want[gi];
      if (members.length > n) {
        const drop = new Set(members.filter((m) => m.id !== src.id).slice(-(members.length - n)).map((m) => m.id));
        objects.value = objects.value.filter((o) => !drop.has(o.id));
      } else if (members.length < n) {
        const live = getObject(src.id)!;
        const p0 = plateOfLive(live);
        const plate = p0 >= 0 ? p0 : activePlate.value;
        const existing = objects.value.filter((o) => plateOfLive(o) === plate);
        placeOnPlates(pushCopies(live, n - members.length, created), existing, plate);
      }
    });
  });
  if (created.length) selectedIds.value = [...new Set([...selectedIds.value.filter((id) => getObject(id)), ...created])];
}

/** Orca "-": remove the newest other instance of each target's group. */
export function removeInstance(ids = selectedIds.value.slice()): void {
  setInstanceCount(ids, (c) => c - 1);
}

/** In-app clipboard payload: object snapshots plus the meshes they use (kept alive while on the clipboard). */
export interface ObjectClipboard { objects: ProjectObject[]; meshes: MeshData[] }

export function copyObjects(ids = selectedIds.value.slice()): ObjectClipboard | null {
  const src = targets(ids);
  if (!src.length) return null;
  const ms = new Map<string, MeshData>();
  for (const o of src) for (const id of meshIdsOf(o)) { const m = meshes.get(id); if (m) ms.set(m.id, m); }
  return { objects: src.filter((o) => ms.has(o.meshId)).map(cloneObj), meshes: [...ms.values()] };
}

/** Paste clipboard objects as new instances placed near the plate centre. Returns the new ids. */
export function pasteObjects(clip: ObjectClipboard): string[] {
  if (!clip.objects.length) return [];
  const created: string[] = [];
  mutate(clip.objects.length === 1 ? `Paste ${clip.objects[0].name}` : `Paste ${clip.objects.length} objects`, () => {
    for (const m of clip.meshes) if (!meshes.has(m.id)) { meshes.set(m.id, m); meshRevision.value++; }
    const plate = activePlate.value;
    const existing = objectsOnPlate(plate);
    const fresh = clip.objects.flatMap((s) => pushCopies(s, 1, created));
    shiftToPlate(fresh.filter((o) => plateOfLive(o) !== plate), plate);
    placeOnPlates(fresh, existing, plate);
  });
  selectedIds.value = created;
  return created;
}

/** Remove every object on plate `i` (default: the active plate). */
export function clearPlate(i = activePlate.value): void {
  mutate('Clear plate', () => { objects.value = objects.value.filter((o) => plateOfLive(o) !== i); });
}

/** Remove every object on every plate (Orca "Delete all", Ctrl+D). Plates stay. */
export function clearAll(): void {
  mutate('Delete all', () => { objects.value = []; });
}

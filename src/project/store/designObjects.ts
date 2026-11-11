/**
 * Design tab objects: plate objects linked to a body of the project's design (src/design).
 * Committing adds them; every design edit replaces their meshes in the same undo step as
 * the new document bytes (src/design/commands.ts). A new mesh has a new id, so paint resets,
 * as with every mesh-replacing edit; tools that replace a mesh some other way (cut, split,
 * simplify, mesh boolean, repairs) drop the link, as they drop a CubbyCAD tree.
 */
import { plateOffset } from '../plates';
import type { Vec3 } from '../math';
import type { DesignLink, MeshData, ProjectObject } from '../types';
import { objectsOnPlate } from './derived';
import { mutate } from './history';
import { anyClash, arrangeInternal, dropObj } from './placement';
import { activePlate, addMesh, bed, meshes, objects, plates, selectedIds, uid, uniqueName } from './state';

/** A body's plate mesh in design (bed) coordinates. */
export interface DesignBodyMesh { positions: Float32Array; indices: Uint32Array }

function bboxOf(p: Float32Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { const v = p[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max };
}

/** The mesh relative to `origin` (a copy). */
function localMesh(m: DesignBodyMesh, origin: Vec3) {
  const pos = new Float32Array(m.positions.length);
  for (let i = 0; i < pos.length; i += 3) { pos[i] = m.positions[i] - origin[0]; pos[i + 1] = m.positions[i + 1] - origin[1]; pos[i + 2] = m.positions[i + 2] - origin[2]; }
  return addMesh(pos, m.indices.slice());
}

/**
 * Commit to Plate: one object per body, where the body sits in the design (the design frame is
 * the bed's), on the active plate; arranged like an import when they clash. One undo step.
 */
export function addDesignObjects(items: ReadonlyArray<{ name: string; mesh: DesignBodyMesh; link: Omit<DesignLink, 'origin'> }>, label: string): string[] {
  const ids: string[] = [];
  if (!items.length) return ids;
  mutate(label, () => {
    const plate = activePlate.value;
    const existing = objectsOnPlate(plate);
    const [ox, oy] = plateOffset(plate, plates.value.length, bed.value);
    const fresh: ProjectObject[] = [];
    for (const it of items) {
      const b = bboxOf(it.mesh.positions);
      const origin: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]];
      const mesh = localMesh(it.mesh, origin);
      const o: ProjectObject = {
        id: uid(), name: uniqueName(it.name), meshId: mesh.id,
        position: [origin[0] + ox, origin[1] + oy, origin[2]], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        visible: true, printable: true, overrides: {}, color: '',
        design: Object.freeze({ ...it.link, origin }),
      };
      objects.value.push(o);
      const live = objects.value[objects.value.length - 1];
      dropObj(live);
      fresh.push(live);
      ids.push(o.id);
    }
    if (anyClash(fresh, existing)) {
      if (existing.length === 0) arrangeInternal(fresh, existing, 6, true, 'bottom-left', plate);
      else arrangeInternal(fresh, existing, 6, false, 'nearest-center', plate);
    }
  }, { slice: true });
  selectedIds.value = ids;
  return ids;
}

/**
 * Commit to Plate as one assembly (Orca's default commit mode): one object ("Design Assembly")
 * with one part per body, keeping their relative positions; every part follows its body.
 * The object's own mesh is the first body (Orca: a ModelObject with a ModelVolume per body).
 */
export function addDesignAssembly(items: ReadonlyArray<{ name: string; mesh: DesignBodyMesh; link: Omit<DesignLink, 'origin'> }>, name: string, label: string): string[] {
  if (!items.length) return [];
  if (items.length === 1) return addDesignObjects(items, label);
  let id = '';
  mutate(label, () => {
    const plate = activePlate.value;
    const existing = objectsOnPlate(plate);
    const [ox, oy] = plateOffset(plate, plates.value.length, bed.value);
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const it of items) { const b = bboxOf(it.mesh.positions); for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); } }
    const origin: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]];
    const [first, ...rest] = items;
    const o: ProjectObject = {
      id: uid(), name: uniqueName(name), meshId: localMesh(first.mesh, origin).id,
      position: [origin[0] + ox, origin[1] + oy, origin[2]], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      visible: true, printable: true, overrides: {}, color: '',
      design: Object.freeze({ ...first.link, origin }),
      parts: rest.map((it) => ({
        id: uid('p'), name: it.name, meshId: localMesh(it.mesh, origin).id, type: 'part' as const,
        position: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as Vec3, overrides: {},
        design: Object.freeze({ ...it.link, origin }),
      })),
    };
    objects.value.push(o);
    const live = objects.value[objects.value.length - 1];
    dropObj(live);
    id = o.id;
    if (anyClash([live], existing)) arrangeInternal([live], existing, 6, false, 'nearest-center', plate);
  }, { slice: true });
  selectedIds.value = [id];
  return [id];
}

/** Every live link: objects' and assembly parts' (owner = the plate object). */
export function designLinks(): Array<{ owner: ProjectObject; partId?: string; link: DesignLink }> {
  const out: Array<{ owner: ProjectObject; partId?: string; link: DesignLink }> = [];
  for (const o of objects.value) {
    if (o.design) out.push({ owner: o, link: o.design });
    for (const p of o.parts ?? []) if (p.design) out.push({ owner: o, partId: p.id, link: p.design });
  }
  return out;
}

/** What happens to one linked object after a design edit. */
export type DesignRelink = { link: DesignLink | null; mesh?: DesignBodyMesh } | undefined;

/**
 * Update every design-linked object. `update(link)` returns undefined (unchanged), `{ link: null }`
 * (drop the link: its body's feature was deleted), or a new link with an optional new body mesh.
 * Instances sharing a mesh keep sharing it. Call it inside the `mutate()` that also stores the
 * new design bytes. Returns how many meshes were replaced.
 */
export function relinkDesignObjects(update: (link: DesignLink) => DesignRelink): number {
  const swapped = new Map<string, string>();
  let n = 0;
  for (const x of objects.value) {
    for (const p of x.parts ?? []) {
      if (!p.design) continue;
      const r = update(p.design);
      if (!r) continue;
      if (!r.link) { delete p.design; continue; }
      if (p.design !== r.link) p.design = r.link;
      if (!r.mesh || sameLocalMesh(meshes.get(p.meshId), r.mesh, r.link.origin)) continue;
      let id = swapped.get(p.meshId);
      if (!id) { id = localMesh(r.mesh, r.link.origin).id; swapped.set(p.meshId, id); }
      p.meshId = id;
      dropObj(x);
      n++;
    }
    if (!x.design) continue;
    const r = update(x.design);
    if (!r) continue;
    if (!r.link) { delete x.design; continue; }
    if (x.design !== r.link) x.design = r.link;
    if (!r.mesh) continue;
    // Unchanged geometry keeps its mesh (and so its paint).
    if (sameLocalMesh(meshes.get(x.meshId), r.mesh, r.link.origin)) continue;
    let id = swapped.get(x.meshId);
    if (!id) { id = localMesh(r.mesh, r.link.origin).id; swapped.set(x.meshId, id); }
    x.meshId = id;
    dropObj(x);
    n++;
  }
  return n;
}

/** Is `m` exactly `body` − `origin` (as localMesh stores it)? */
function sameLocalMesh(m: MeshData | undefined, body: DesignBodyMesh, origin: Vec3): boolean {
  if (!m || m.positions.length !== body.positions.length || m.indices.length !== body.indices.length) return false;
  const p = m.positions, q = body.positions;
  for (let i = 0; i < p.length; i++) if (p[i] !== Math.fround(q[i] - origin[i % 3])) return false;
  const a = m.indices, b = body.indices;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Objects linked to the design. */
export function designObjects(): ProjectObject[] { return objects.value.filter((o) => !!o.design || !!o.parts?.some((p) => p.design)); }

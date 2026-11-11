/** Commits from the tools (src/tools): text / SVG emboss, simplify, mesh boolean, brim ears. */
import { quatNormalize, type Quat, type Vec3 } from '../math';
import type { PaintLayer, PaintLayers, PaintMap } from '../../engine/types';
import type { BrimPoint, EmbossMeta, MeshData, PartType, ProjectObject } from '../types';
import { PART_TYPE_LABELS } from '../types';
import { objectsOnPlate } from './derived';
import { changed, mutate } from './history';
import { writeMeshPaint } from './paint';
import { dropPart, pushPart } from './parts';
import { dropObj, fitsWhereItIs, placeOnPlates } from './placement';
import { activePlate, addMesh, getObject, objects, plateBedOf, selectedIds, uid, uniqueName } from './state';

type ToolMeshPatch = { positions: Float32Array; indices: Uint32Array };

/** Point every volume using `from` (the object's own mesh or a part's, on all instances) at mesh `to`. */
function swapVolumeMesh(objId: string, partId: string | null, to: MeshData, emboss: EmbossMeta | null | undefined): void {
  const o = getObject(objId);
  if (!o) return;
  if (partId === null) {
    const from = o.meshId;
    for (const x of objects.value) {
      if (x.meshId !== from) continue;
      x.meshId = to.id;
      delete x.cad; // simplify / boolean results are plain meshes
      delete x.design;
      if (emboss === null) delete x.emboss; else if (emboss) x.emboss = { ...emboss };
      dropObj(x);
    }
  } else {
    const p = o.parts?.find((q) => q.id === partId);
    if (!p) return;
    p.meshId = to.id;
    delete p.design;
    if (emboss === null) delete p.emboss; else if (emboss) p.emboss = { ...emboss };
    if (p.type === 'part') dropObj(o);
  }
}

/**
 * Add a tool-made mesh (text / SVG) as a new object. Without `position` it is
 * placed next to what is on the active plate. Returns the new object id.
 */
export function addToolObject(name: string, mesh: ToolMeshPatch, opts: { emboss?: EmbossMeta; position?: Vec3; rotation?: Quat; label?: string } = {}): string {
  const id = uid();
  mutate(opts.label ?? `Add ${name}`, () => {
    const m = addMesh(mesh.positions, mesh.indices);
    const plate = activePlate.value;
    const existing = objectsOnPlate(plate);
    const b = plateBedOf(plate);
    const o: ProjectObject = {
      id, name: uniqueName(name), meshId: m.id,
      position: opts.position ? [...opts.position] as Vec3 : [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0],
      rotation: opts.rotation ? [...opts.rotation] as Quat : [0, 0, 0, 1], scale: [1, 1, 1],
      visible: true, printable: true, overrides: {}, color: '',
      ...(opts.emboss ? { emboss: { ...opts.emboss } } : {}),
    };
    objects.value.push(o);
    const live = objects.value[objects.value.length - 1];
    dropObj(live);
    if (!opts.position && !fitsWhereItIs(live, existing, plate)) placeOnPlates([live], existing, plate);
  });
  selectedIds.value = [id];
  return id;
}

/** Add a part with a full placement in the object's frame (text / SVG on a surface). Returns the part id. */
export function addToolPart(objId: string, type: PartType, name: string, mesh: ToolMeshPatch,
  t: { position: Vec3; rotation: Quat; scale?: Vec3 }, emboss?: EmbossMeta): string | null {
  if (!getObject(objId)) return null;
  const id = uid('p');
  mutate(`Add ${PART_TYPE_LABELS[type].toLowerCase()} ${name}`, () => {
    const m = addMesh(mesh.positions, mesh.indices);
    pushPart(getObject(objId)!, {
      id, name, meshId: m.id, type, position: [...t.position] as Vec3, rotation: quatNormalize(t.rotation),
      scale: t.scale ? [...t.scale] as Vec3 : [1, 1, 1], overrides: {}, ...(emboss ? { emboss: { ...emboss } } : {}),
    });
  });
  return id;
}

/**
 * Replace a volume's geometry (partId null = the object's own mesh, on all
 * its instances): text / SVG re-edit, simplify. `emboss`: new source,
 * null = drop it (geometry no longer matches), undefined = keep.
 */
export function replaceVolumeMesh(objId: string, partId: string | null, mesh: ToolMeshPatch,
  opts: { label: string; emboss?: EmbossMeta | null; mergeKey?: string; name?: string }): void {
  mutate(opts.label, () => {
    const m = addMesh(mesh.positions, mesh.indices);
    swapVolumeMesh(objId, partId, m, opts.emboss);
    if (opts.name) {
      const o = getObject(objId);
      const n = opts.name.slice(0, 200);
      if (o && partId === null) o.name = n;
      else { const p = o?.parts?.find((q) => q.id === partId); if (p) p.name = n; }
    }
  }, { mergeKey: opts.mergeKey });
}

/**
 * Orca mesh boolean result: the target volume gets the result mesh (in its
 * own mesh frame); the tool volumes are removed when `deleteInput`.
 */
export function commitBoolean(p: {
  label: string; objectId: string; partId: string | null; mesh: ToolMeshPatch;
  removeObjects?: string[]; removeParts?: Array<{ objectId: string; partId: string }>;
}): void {
  mutate(p.label, () => {
    const m = addMesh(p.mesh.positions, p.mesh.indices);
    swapVolumeMesh(p.objectId, p.partId, m, null);
    for (const rp of p.removeParts ?? []) {
      const o = getObject(rp.objectId);
      if (o) dropPart(o, rp.partId);
    }
    if (p.removeObjects?.length) {
      const drop = new Set(p.removeObjects.filter((id) => id !== p.objectId));
      objects.value = objects.value.filter((o) => !drop.has(o.id));
    }
  });
  selectedIds.value = [p.objectId];
}

/** Orca brim ears: the points of an object (ModelObject::brim_points — shared by its instances). */
export function setBrimPoints(objId: string, pts: BrimPoint[], label = 'Brim ears edit'): void {
  const o = getObject(objId);
  if (!o) return;
  mutate(label, () => {
    const meshId = getObject(objId)!.meshId;
    for (const x of objects.value) {
      if (x.meshId !== meshId) continue;
      if (pts.length) x.brimPoints = pts.map((b) => ({ pos: [...b.pos] as Vec3, radius: b.radius }));
      else delete x.brimPoints;
    }
  });
}

/** A repaired mesh (desktop "Fix model"): replaces every volume that uses `from`, with its re-projected paint. */
export interface MeshRepair { from: string; mesh: ToolMeshPatch; paint?: PaintLayers }

/**
 * Commit mesh repairs as one undo step: each repaired mesh replaces the
 * object meshes (all instances) and part meshes that used the old one, keeps
 * its paint (re-projected by the engine), drops a CubbyCAD tree it no longer
 * matches, and puts the objects back on the bed (Fix All: "then drop the
 * object to the bed").
 */
export function commitMeshRepairs(label: string, repairs: readonly MeshRepair[]): void {
  if (!repairs.length) return;
  mutate(label, () => {
    for (const r of repairs) {
      const m = addMesh(r.mesh.positions, r.mesh.indices);
      for (const [layer, map] of Object.entries(r.paint ?? {}) as Array<[PaintLayer, PaintMap]>) writeMeshPaint(m.id, layer, map);
      for (const x of objects.value) {
        if (x.meshId === r.from) { x.meshId = m.id; delete x.cad; delete x.design; dropObj(x); }
        for (const p of x.parts ?? []) {
          if (p.meshId !== r.from) continue;
          p.meshId = m.id;
          delete p.design;
          if (p.type === 'part') dropObj(x);
        }
      }
    }
  });
}

/**
 * Objects the app keeps in sync with the project by itself (Orca 2.5's belt purge prism,
 * GUI/BeltPurgeTower.cpp ensure_belt_purge_tower): removed and added outside the undo
 * history, as desktop's Plater::priv::update does — undo restores whatever the project had
 * and the next sync puts the derived objects right again. Returns the new ids.
 */
export function syncDerivedObjects(remove: readonly string[], add: ReadonlyArray<{ name: string; positions: Float32Array; indices: Uint32Array; position: Vec3; overrides: ProjectObject['overrides'] }>): string[] {
  if (!remove.length && !add.length) return [];
  const gone = new Set(remove);
  const ids: string[] = [];
  const next = objects.value.filter((o) => !gone.has(o.id));
  for (const a of add) {
    const m = addMesh(a.positions, a.indices);
    const id = uid();
    next.push({ id, name: a.name, meshId: m.id, position: [...a.position] as Vec3, rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true, printable: true, overrides: { ...a.overrides }, color: '' });
    ids.push(id);
  }
  objects.value = next;
  if (gone.size) selectedIds.value = selectedIds.value.filter((id) => !gone.has(id));
  changed(true);
  return ids;
}

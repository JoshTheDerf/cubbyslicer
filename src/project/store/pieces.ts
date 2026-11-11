/**
 * Turning one object into several: split to objects, split to parts, and the
 * cut tool's result (Orca Plater::cut).
 */
import type { PaintLayer, PaintLayers, PaintMap } from '../../engine/types';
import {
  composeTRS, decomposeTRS, mat4Identity, mat4InvertAffine, mat4Multiply, transformPoint, type Quat, type Vec3,
} from '../math';
import { splitMesh, type MeshPiece } from '../split';
import type { MeshData, ObjectPart, PartType, ProjectObject } from '../types';
import { PART_TYPE_LABELS } from '../types';
import { cloneObj, clonePart } from './clone';
import { objectsOnPlate, plateOf } from './derived';
import { mutate } from './history';
import { writeMeshPaint } from './paint';
import { anyClash, arrangeInternal, dropObj } from './placement';
import { addMesh, getObject, meshes, objects, selectedIds, targets, uid } from './state';

/** Targets whose mesh has more than one connected piece, with the pieces. */
function splittable(ids: string[]): Array<{ o: ProjectObject; pieces: MeshPiece[] }> {
  const work: Array<{ o: ProjectObject; pieces: MeshPiece[] }> = [];
  for (const o of targets(ids)) {
    const mesh = meshes.get(o.meshId);
    if (!mesh) continue;
    const pieces = splitMesh(mesh.positions, mesh.indices);
    if (pieces.length > 1) work.push({ o, pieces });
  }
  return work;
}

/**
 * Orca "Split to objects": each connected piece of a target's mesh becomes an
 * object of its own, in place (same rotation / scale / settings). Returns the
 * number of objects created; 0 when nothing could be split.
 */
export function splitToObjects(ids = selectedIds.value.slice()): number {
  const work = splittable(ids);
  if (!work.length) return 0;
  const created: string[] = [];
  mutate('Split to objects', () => {
    for (const { o, pieces } of work) {
      const src = cloneObj(o);
      const m = composeTRS(src.position, src.rotation, src.scale);
      const at = objects.value.findIndex((x) => x.id === o.id);
      const fresh: ProjectObject[] = pieces.map((pc, k) => {
        const mesh = addMesh(pc.positions, pc.indices);
        const c = cloneObj(src);
        c.id = uid();
        c.meshId = mesh.id;
        delete c.cad; // a piece is plain mesh: the tree no longer describes it
        delete c.design; // nor does the design body
        c.name = `${src.name}_${k + 1}`;
        // The piece was re-centred on its bbox centre: move the origin there.
        c.position = transformPoint(m, pc.center);
        return c;
      });
      objects.value.splice(at, 1, ...fresh);
      for (const c of fresh) created.push(c.id);
    }
  });
  selectedIds.value = created;
  return created.length;
}

/**
 * Orca "Split to parts": the object keeps one piece as its own mesh and the
 * other connected pieces become parts of it (one object, several volumes).
 * Returns the number of parts created.
 */
export function splitToParts(ids = selectedIds.value.slice()): number {
  const work = splittable(ids);
  if (!work.length) return 0;
  let created = 0;
  mutate('Split to parts', () => {
    for (const { o, pieces } of work) {
      const live = getObject(o.id)!;
      const m = composeTRS([...live.position] as Vec3, [...live.rotation] as Quat, [...live.scale] as Vec3);
      const c0 = pieces[0].center;
      // Existing parts keep their world placement: shift them by the new origin.
      const oldParts = (live.parts ?? []).map((p) => ({ ...clonePart(p), position: [p.position[0] - c0[0], p.position[1] - c0[1], p.position[2] - c0[2]] as Vec3 }));
      const base = addMesh(pieces[0].positions, pieces[0].indices);
      live.meshId = base.id;
      delete live.cad;
      delete live.design;
      live.position = transformPoint(m, c0);
      const newParts: ObjectPart[] = pieces.slice(1).map((pc, k) => ({
        id: uid('p'), name: `${live.name}_${k + 2}`, meshId: addMesh(pc.positions, pc.indices).id, type: 'part' as PartType,
        position: [pc.center[0] - c0[0], pc.center[1] - c0[1], pc.center[2] - c0[2]] as Vec3, rotation: [0, 0, 0, 1] as Quat, scale: [1, 1, 1] as Vec3,
        overrides: {},
      }));
      live.parts = [...oldParts, ...newParts];
      created += newParts.length;
    }
  });
  return created;
}

/** One volume of a cut piece: world-space mesh (bed mm) + its paint. */
export interface PieceVolume { name: string; type: PartType; positions: Float32Array; indices: Uint32Array; paint?: PaintLayers }
/** One object produced by the cut tool; `assembled` maps its world placement to the assembled pose (column-major). */
export interface ObjectPiece { name: string; volumes: PieceVolume[]; assembled?: number[] }

/**
 * Replace an object with the pieces of an engine cut (Orca GLGizmoCut3D →
 * Plater::cut): each piece becomes an object whose first model part is its
 * mesh (origin at its bottom centre) and whose other volumes (connectors,
 * modifiers, …) are parts. Paint and part settings are kept; variable layer
 * height, height ranges and brim ears don't survive a cut (as in Orca).
 * Returns the new object ids.
 */
export function replaceWithPieces(objectId: string, pieces: ObjectPiece[], label = 'Cut'): string[] {
  const src = getObject(objectId);
  if (!src) return [];
  const plate = Math.max(0, plateOf(objectId));
  const created: string[] = [];
  mutate(label, () => {
    const base = cloneObj(src);
    const partOverrides = new Map((base.parts ?? []).map((p) => [p.name, p.overrides]));
    const fresh: ProjectObject[] = [];
    pieces.forEach((pc, k) => {
      const solids = pc.volumes.filter((v) => v.type === 'part' && v.indices.length);
      if (!solids.length) return;
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const v of solids) {
        const q = v.positions;
        for (let i = 0; i < q.length; i += 3) {
          if (q[i] < minX) minX = q[i]; if (q[i] > maxX) maxX = q[i];
          if (q[i + 1] < minY) minY = q[i + 1]; if (q[i + 1] > maxY) maxY = q[i + 1];
          if (q[i + 2] < minZ) minZ = q[i + 2];
        }
      }
      const origin: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, minZ];
      const local = (v: PieceVolume): MeshData => {
        const q = new Float32Array(v.positions.length);
        for (let i = 0; i < q.length; i += 3) { q[i] = v.positions[i] - origin[0]; q[i + 1] = v.positions[i + 1] - origin[1]; q[i + 2] = v.positions[i + 2] - origin[2]; }
        const m = addMesh(q, v.indices);
        for (const [layer, map] of Object.entries(v.paint ?? {}) as Array<[PaintLayer, PaintMap]>) writeMeshPaint(m.id, layer, map);
        return m;
      };
      const main = solids[0];
      const o: ProjectObject = {
        ...base,
        id: uid(), name: pieces.length > 1 ? (pc.name && pc.name !== src.name ? pc.name : `${src.name}_${k + 1}`) : src.name,
        meshId: local(main).id, position: origin, rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        parts: pc.volumes.filter((v) => v !== main && v.indices.length).map((v): ObjectPart => ({
          id: uid('p'), name: v.name || PART_TYPE_LABELS[v.type], meshId: local(v).id, type: v.type,
          position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], overrides: { ...(partOverrides.get(v.name) ?? {}) },
        })),
      };
      delete o.layerHeightProfile; delete o.layerRanges; delete o.brimPoints; delete o.emboss; delete o.assembly; delete o.assemble; delete o.cad; delete o.design;
      if (!o.parts?.length) delete o.parts;
      // Where the piece sits in the assembled model: (world → assembled) · translate(origin),
      // composed with the source's own assembly pose if it had one.
      {
        let a = mat4Multiply(pc.assembled ?? mat4Identity(), composeTRS(origin, [0, 0, 0, 1], [1, 1, 1]));
        if (src.assembly) {
          const toAsm = mat4Multiply(composeTRS(src.assembly.position, src.assembly.rotation, src.assembly.scale),
            mat4InvertAffine(composeTRS(src.position, src.rotation, src.scale)));
          a = mat4Multiply(toAsm, a);
        }
        const d = decomposeTRS(a);
        o.assembly = { position: d.position, rotation: d.rotation, scale: d.scale };
      }
      fresh.push(o);
    });
    if (!fresh.length) return;
    const at = objects.value.findIndex((x) => x.id === objectId);
    objects.value.splice(at, 1, ...fresh);
    const live = objects.value.filter((x) => fresh.some((f) => f.id === x.id));
    for (const o of live) dropObj(o);
    const others = objectsOnPlate(plate).filter((x) => !live.includes(x));
    if (anyClash(live, others, plate)) arrangeInternal(live, others, 6, false, 'nearest-center', plate);
    for (const o of live) created.push(o.id);
  });
  if (created.length) selectedIds.value = created;
  return created;
}

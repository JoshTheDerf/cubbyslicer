/**
 * Placing an emboss volume (text / SVG) on a picked surface, like Orca's
 * emboss "on surface" placement: the volume's local +Z follows the surface
 * normal, its +Y points "up" (world +Z projected onto the surface; world +Y
 * on horizontal faces), and it is expressed in the object's frame.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { composeTRS, decomposeTRS, type Quat, type Vec3 } from '../project/math';
import { getObject } from '../project/store';
import type { PartType } from '../project/types';

/** Parts sink slightly into the surface so they fuse; negative volumes / modifiers poke out a little for a clean cut. */
export function surfaceOffset(type: PartType, depth: number): number {
  if (type === 'part') return -Math.min(0.2, depth * 0.1);
  return -(depth - Math.min(0.05, depth * 0.1));
}

/** World frame at a surface point: rotation taking local +Z to the normal with a stable up direction. */
export function surfaceFrame(normal: Vector3): Quaternion {
  const z = normal.clone().normalize();
  const worldUp = Math.abs(z.z) > 0.95 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  const y = worldUp.clone().addScaledVector(z, -worldUp.dot(z)).normalize();
  const x = new Vector3().crossVectors(y, z).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/** Part transform (object frame) for an emboss volume placed at world `point` / `normal` on object `objectId`. */
export function partPlacement(objectId: string, point: Vector3, normal: Vector3, type: PartType, depth: number): { position: Vec3; rotation: Quat; scale: Vec3 } | null {
  const o = getObject(objectId);
  if (!o) return null;
  const q = surfaceFrame(normal);
  const origin = point.clone().addScaledVector(normal.clone().normalize(), surfaceOffset(type, depth));
  const w = new Matrix4().compose(origin, q, new Vector3(1, 1, 1));
  const objM = new Matrix4().fromArray(composeTRS([...o.position] as Vec3, [...o.rotation] as Quat, [...o.scale] as Vec3));
  const local = objM.invert().multiply(w);
  const d = decomposeTRS(local.toArray());
  return { position: d.position, rotation: d.rotation, scale: d.scale };
}

/** World-space corners of a w × h rectangle placed like partPlacement (for the hover preview). */
export function previewRect(point: Vector3, normal: Vector3, w: number, h: number): Vector3[] {
  const q = surfaceFrame(normal);
  const lift = normal.clone().normalize().multiplyScalar(0.05);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => new Vector3(x, y, 0).applyQuaternion(q).add(point).add(lift));
}

/** XY size of a mesh (for previews / labels). */
export function meshSizeXY(positions: Float32Array): [number, number] {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    x0 = Math.min(x0, positions[i]); x1 = Math.max(x1, positions[i]);
    y0 = Math.min(y0, positions[i + 1]); y1 = Math.max(y1, positions[i + 1]);
  }
  return Number.isFinite(x0) ? [x1 - x0, y1 - y0] : [0, 0];
}

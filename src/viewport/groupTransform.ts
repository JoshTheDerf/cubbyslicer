/**
 * The transform panel's multi-selection edits (Orca's world coordinates): the
 * selection moves, rotates and scales as one group about its centre.
 */
import { composeTRS, quatFromAxisAngle, quatMultiply, transformPoint, type Quat, type Vec3 } from '../project/math';

export interface GroupItem { id: string; position: Vec3; rotation: Quat; scale: Vec3 }
export interface GroupPatch { id: string; position: Vec3; rotation?: Quat; scale?: Vec3 }

const AXES: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export function groupMove(items: GroupItem[], delta: Vec3): GroupPatch[] {
  return items.map((o) => ({ id: o.id, position: o.position.map((p, i) => p + delta[i]) as Vec3 }));
}

/** Rotate every object by `angle` (radians) about a world axis through `centre`. */
export function groupRotate(items: GroupItem[], axis: number, angle: number, centre: Vec3): GroupPatch[] {
  const q = quatFromAxisAngle(AXES[axis], angle);
  const m = composeTRS([0, 0, 0], q, [1, 1, 1]);
  return items.map((o) => {
    const r = transformPoint(m, o.position.map((p, i) => p - centre[i]) as Vec3);
    return { id: o.id, position: r.map((v, i) => v + centre[i]) as Vec3, rotation: quatMultiply(q, o.rotation) };
  });
}

/** Scale every object by `f` about `centre` (uniform: per-axis would shear rotated objects). */
export function groupScale(items: GroupItem[], f: number, centre: Vec3): GroupPatch[] {
  return items.map((o) => ({
    id: o.id,
    position: o.position.map((p, i) => centre[i] + (p - centre[i]) * f) as Vec3,
    scale: o.scale.map((s) => s * f) as Vec3,
  }));
}

/**
 * Assembly View (Orca CanvasAssembleView): every object at its assembled
 * pose (ProjectObject.assembly, e.g. cut pieces before "place on cut"),
 * pushed apart from the common centre by the explosion ratio. Display only:
 * the project transforms don't change.
 */
import { reactive } from 'vue';
import { composeTRS, transformPoint, type Vec3 } from '../../project/math';
import type { MeshData, ProjectObject } from '../../project/types';

export const assemblyUi = reactive({ explosion: 1 });

/** Display copies of `objects` in assembly view. */
export function assembledObjects(objects: ProjectObject[], meshOf: (id: string) => MeshData | undefined, explosion: number): ProjectObject[] {
  const poses = objects.map((o) => {
    const a = o.assembly ?? { position: o.position, rotation: o.rotation, scale: o.scale };
    const m = meshOf(o.meshId);
    const bb = m?.bbox;
    const local: Vec3 = bb ? [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2] : [0, 0, 0];
    return { o, a, centre: transformPoint(composeTRS(a.position, a.rotation, a.scale), local) };
  });
  const n = poses.length || 1;
  const c = poses.reduce<Vec3>((s, p) => [s[0] + p.centre[0] / n, s[1] + p.centre[1] / n, s[2] + p.centre[2] / n], [0, 0, 0]);
  const k = Math.max(0, explosion - 1);
  return poses.map(({ o, a, centre }) => ({
    ...o,
    position: [a.position[0] + (centre[0] - c[0]) * k, a.position[1] + (centre[1] - c[1]) * k, a.position[2] + (centre[2] - c[2]) * k] as Vec3,
    rotation: [...a.rotation] as ProjectObject['rotation'],
    scale: [...a.scale] as Vec3,
  }));
}

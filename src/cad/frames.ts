/**
 * Frames between a slicer object and its CubbyCAD node tree.
 *
 * - CubbyCAD node transforms live in the Three render frame (Y-up).
 * - A CAD object's mesh is `evaluateCadNode(…, { frame: 'zup' })` of its root
 *   WITHOUT the root's own transform: mesh_zup = R · E, where R = RENDER_TO_ZUP
 *   and E is the subtree in the render frame.
 * - The object's TRS M (bed space, Z-up, mm) places that mesh: world = M · R · E.
 *
 * So the root's render-frame transform that reproduces the same world is
 * T = R⁻¹ · M · R (a conjugation: still a TRS), and back M = R · T · R⁻¹.
 * Child transforms inside the tree never change frame; they are composed
 * through ancestors in the render frame as CubbyCAD does.
 */
import { CAD_UNIT_TO_MM, RENDER_TO_ZUP, ZUP_TO_RENDER, matrixToTransform, transformToMatrix, type CadTransform } from './api';
import { composeTRS, decomposeTRS, mat4Multiply, type Mat4, type Quat, type Vec3 } from '../project/math';

export { ZUP_TO_RENDER };

export interface TRS { position: Vec3; rotation: Quat; scale: Vec3 }

/**
 * Units → mm, for callers that send CAD nodes in another unit (slicer_import_cad `unit`).
 * A `.cubby` file is always mm: CubbyCAD stores every transform and param in mm
 * whatever the scene's display `unit` says.
 */
export const UNIT_TO_MM: Record<string, number> = CAD_UNIT_TO_MM;

/** Z-up matrix (bed space) → the equivalent render-frame matrix. */
export function zupToRenderMatrix(m: Mat4): Mat4 { return mat4Multiply(ZUP_TO_RENDER, mat4Multiply(m, RENDER_TO_ZUP)); }
/** Render-frame matrix → the equivalent Z-up (bed space) matrix. */
export function renderToZupMatrix(m: Mat4): Mat4 { return mat4Multiply(RENDER_TO_ZUP, mat4Multiply(m, ZUP_TO_RENDER)); }

/** A slicer TRS (relative to `origin`, bed space) as a CubbyCAD node transform. */
export function trsToCadTransform(t: TRS, origin: Vec3 = [0, 0, 0]): CadTransform {
  const p: Vec3 = [t.position[0] - origin[0], t.position[1] - origin[1], t.position[2] - origin[2]];
  return cleanTransform(matrixToTransform(zupToRenderMatrix(composeTRS(p, t.rotation, t.scale))));
}

/**
 * A CubbyCAD root transform as a slicer TRS (bed space around `origin`),
 * scaled by `unit` (scene unit → mm). `exact` is false when the matrix has
 * shear and can't be a TRS.
 */
export function cadTransformToTrs(t: CadTransform | undefined, unit = 1, origin: Vec3 = [0, 0, 0]): TRS & { exact: boolean } {
  let m = renderToZupMatrix(transformToMatrix(t));
  if (unit !== 1) m = mat4Multiply(composeTRS([0, 0, 0], [0, 0, 0, 1], [unit, unit, unit]), m);
  const d = decomposeTRS(m);
  return { position: [d.position[0] + origin[0], d.position[1] + origin[1], d.position[2] + origin[2]], rotation: d.rotation, scale: d.scale, exact: d.exact };
}

/** The matrix a node's own transform contributes (render frame). */
export function nodeMatrix(t: CadTransform | undefined): Mat4 { return transformToMatrix(t); }

/** Round away float noise so saved trees stay readable (and hashes stable). */
export function cleanTransform(t: CadTransform): CadTransform {
  const r = (v: number) => { const x = Math.round(v * 1e9) / 1e9; return Object.is(x, -0) ? 0 : x; };
  const q = (t.rotation ?? [0, 0, 0, 1]).map(r) as [number, number, number, number];
  return {
    position: (t.position ?? [0, 0, 0]).map(r) as [number, number, number],
    rotation: q[3] < 0 ? q.map((v) => r(-v)) as [number, number, number, number] : q,
    scale: (t.scale ?? [1, 1, 1]).map(r) as [number, number, number],
  };
}

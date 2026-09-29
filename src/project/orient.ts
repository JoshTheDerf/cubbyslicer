/**
 * Auto Orient (OrcaSlicer's libslic3r AutoOrienter, run in the Orca engine
 * worker via `autoOrient()` in src/engine/client.ts).
 *
 * The engine receives the object's mesh with transform = current
 * rotation * scale (no translation) and returns a ROW-MAJOR 3x3 rotation R to
 * PRE-multiply onto the current rotation:  R_new = R * R_cur  (scale kept).
 * The caller then drops the object to the bed.
 *
 * Kept free of Vue / the store so the matrix composition is unit-testable
 * with a mocked orienter.
 */
import type { SliceObjectInput } from '../engine/types';
import { composeTRS, mat4Determinant3, quatMultiply, quatNormalize, type Quat, type Vec3 } from './math';
import type { MeshData, ProjectObject } from './types';

export type Orienter = (object: SliceObjectInput, signal?: AbortSignal) => Promise<number[]>;

/** Row-major 3x3 rotation → unit quaternion [x, y, z, w] (re-orthonormalised). */
export function rotationMatrixToQuat(r: number[]): Quat {
  if (r.length < 9 || r.some((v) => !Number.isFinite(v))) throw new Error('Invalid rotation from the orienter');
  // Gram–Schmidt on the columns so small numeric drift can't produce skew.
  const col = (j: number): Vec3 => [r[j], r[3 + j], r[6 + j]];
  const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const x = norm(col(0));
  const y0 = col(1), d = dot(x, y0);
  const y = norm([y0[0] - d * x[0], y0[1] - d * x[1], y0[2] - d * x[2]]);
  let z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  // A reflection would flip the mesh inside out; keep it a proper rotation.
  if (dot(z, col(2)) < 0) z = [-z[0], -z[1], -z[2]];
  const m00 = x[0], m01 = y[0], m02 = z[0];
  const m10 = x[1], m11 = y[1], m12 = z[1];
  const m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return quatNormalize(q);
}

/** New object rotation: the orienter's R pre-multiplied onto the current one. */
export function composeOrientation(current: Quat, r: number[]): Quat {
  return quatNormalize(quatMultiply(rotationMatrixToQuat(r), current));
}

/** True when R is (numerically) the identity — nothing to do. */
export function isIdentityRotation(r: number[], eps = 1e-6): boolean {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return r.length >= 9 && I.every((v, i) => Math.abs(r[i] - v) < eps);
}

/** Engine input for one object: mesh + transform = rotation * scale, no translation. */
export function orientInput(o: ProjectObject, mesh: MeshData): SliceObjectInput {
  const transform = composeTRS([0, 0, 0], [...o.rotation] as Quat, [...o.scale] as Vec3);
  let indices = mesh.indices;
  if (mat4Determinant3(transform) < 0) {
    // Mirrored: fix the winding so the orienter sees outward normals.
    indices = new Uint32Array(mesh.indices.length);
    const src = mesh.indices;
    for (let i = 0; i < src.length; i += 3) { indices[i] = src[i]; indices[i + 1] = src[i + 2]; indices[i + 2] = src[i + 1]; }
  }
  return { id: o.id, name: o.name, positions: mesh.positions, indices, transform };
}

export interface OrientProgress { done: number; total: number; name: string }
export interface OrientOutcome {
  /** New rotations for objects whose orientation changed. */
  rotations: Array<{ id: string; rotation: Quat }>;
  /** Objects already in their best orientation. */
  unchanged: string[];
  failed: Array<{ id: string; name: string; error: string }>;
  cancelled: boolean;
}

/**
 * Orient `objs` one at a time (the engine worker builds a fresh instance per
 * call, so running them concurrently would only queue). Never throws for a
 * single object's failure — it's reported in `failed`.
 */
export async function orientObjects(
  objs: ProjectObject[],
  meshOf: (meshId: string) => MeshData | undefined,
  orient: Orienter,
  opts: { signal?: AbortSignal; onProgress?: (p: OrientProgress) => void } = {},
): Promise<OrientOutcome> {
  const out: OrientOutcome = { rotations: [], unchanged: [], failed: [], cancelled: false };
  let done = 0;
  for (const o of objs) {
    if (opts.signal?.aborted) { out.cancelled = true; break; }
    opts.onProgress?.({ done, total: objs.length, name: o.name });
    const mesh = meshOf(o.meshId);
    if (!mesh) { out.failed.push({ id: o.id, name: o.name, error: 'mesh missing' }); done++; continue; }
    try {
      const r = await orient(orientInput(o, mesh), opts.signal);
      if (isIdentityRotation(r)) out.unchanged.push(o.id);
      else out.rotations.push({ id: o.id, rotation: composeOrientation(o.rotation, r) });
    } catch (e) {
      if (opts.signal?.aborted) { out.cancelled = true; break; }
      out.failed.push({ id: o.id, name: o.name, error: (e as Error)?.message ?? String(e) });
    }
    done++;
  }
  opts.onProgress?.({ done, total: objs.length, name: '' });
  return out;
}

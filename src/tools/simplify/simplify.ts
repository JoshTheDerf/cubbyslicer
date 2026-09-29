/**
 * Mesh simplification (Orca GLGizmoSimplify, which runs its quadric edge
 * collapse): here meshoptimizer's simplifier, lazily loaded (wasm).
 * The target is a triangle count; borders are kept (open meshes stay open
 * where they were), and the result is compacted.
 */
import type { MeshArrays } from '../geom/extrude';
import { compactMesh } from '../geom/meshUtil';

type Simplifier = typeof import('meshoptimizer')['MeshoptSimplifier'];
let simplifier: Promise<Simplifier> | null = null;

export function loadSimplifier(): Promise<Simplifier> {
  simplifier ??= import('meshoptimizer').then(async (m) => { await m.MeshoptSimplifier.ready; return m.MeshoptSimplifier; });
  simplifier.catch(() => { simplifier = null; });
  return simplifier;
}

/** Orca's detail levels → triangle ratio (very high … very low). */
export const DETAIL_LEVELS: Array<{ id: string; label: string; ratio: number }> = [
  { id: 'very-high', label: 'Very high', ratio: 0.8 },
  { id: 'high', label: 'High', ratio: 0.5 },
  { id: 'medium', label: 'Medium', ratio: 0.25 },
  { id: 'low', label: 'Low', ratio: 0.1 },
  { id: 'very-low', label: 'Very low', ratio: 0.03 },
];

export function targetFromRatio(triangles: number, ratio: number): number {
  return Math.max(4, Math.min(triangles, Math.round(triangles * Math.max(0, Math.min(1, ratio)))));
}

export interface SimplifyResult extends MeshArrays { error: number }

export async function simplifyMesh(positions: Float32Array, indices: Uint32Array, targetTriangles: number): Promise<SimplifyResult> {
  const s = await loadSimplifier();
  const target = Math.max(4, Math.floor(targetTriangles)) * 3;
  if (target >= indices.length) return { positions, indices, error: 0 };
  // target_error = 1 (relative): let the triangle count decide; LockBorder keeps open borders in place.
  const [idx, error] = s.simplify(indices, positions, 3, target, 1, ['LockBorder']);
  const c = compactMesh(positions, idx);
  return { ...c, error: error * s.getScale(positions, 3) };
}

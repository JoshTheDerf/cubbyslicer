/**
 * Brim ears of a project object (Orca GLGizmoBrimEars): its first layer
 * outline, bed ↔ mesh-local conversion and auto-generated ears. Shared by the
 * brim ears panel and the MCP bridge.
 */
import { Matrix4, Vector3 } from 'three';
import { getObject, objectInfo } from '../../project/store';
import { resolvedConfig } from '../../app/state';
import type { BrimPoint } from '../../project/types';
import type { Vec3 } from '../../project/math';
import { volumeMatrix, volumeMesh } from '../overlay';
import { mergeMeshes, transformed } from '../geom/meshUtil';
import { autoEarPoints, defaultHeadDiameter, sliceAtZ, type Loop } from './brimEars';

/** First layer of the object: its model parts sliced 0.1 mm above its bottom (world XY). */
export function firstLayer(objectId: string): { loops: Loop[]; bottom: number } | null {
  const o = getObject(objectId);
  const info = o ? objectInfo.value.get(o.id) : undefined;
  if (!o || !info) return null;
  const vols = [{ partId: null as string | null }, ...(o.parts ?? []).filter((p) => p.type === 'part').map((p) => ({ partId: p.id as string | null }))];
  const meshes = vols.flatMap((v) => {
    const m = volumeMesh(o.id, v.partId), w = volumeMatrix(o.id, v.partId);
    return m && w ? [{ positions: transformed(m.positions, w), indices: m.indices }] : [];
  });
  const all = mergeMeshes(meshes);
  return { loops: sliceAtZ(all.positions, all.indices, info.min[2] + 0.1), bottom: info.min[2] };
}

/** World bed point (x, y) at the object's bottom → the object's mesh-local frame. */
export function earToLocal(objectId: string, x: number, y: number, bottom: number): Vec3 | null {
  const w = volumeMatrix(objectId, null);
  if (!w) return null;
  const v = new Vector3(x, y, bottom - 0.0001).applyMatrix4(new Matrix4().fromArray(w).invert());
  return [v.x, v.y, v.z];
}

function cfgNum(k: string, d: number): number {
  const v = resolvedConfig.value[k];
  const s = Array.isArray(v) ? v[0] : v;
  const n = parseFloat(String(s ?? ''));
  return Number.isFinite(n) ? n : d;
}

/** Orca's default ear head diameter for the current printer (mm). */
export function defaultEarDiameter(): number {
  const nozzle = cfgNum('nozzle_diameter', 0.4);
  const v = resolvedConfig.value.initial_layer_line_width;
  const s = String((Array.isArray(v) ? v[0] : v) ?? '');
  const width = s.endsWith('%') ? (parseFloat(s) / 100) * nozzle : parseFloat(s) || nozzle * 1.25;
  return defaultHeadDiameter(width, nozzle);
}

/** Ears Orca's "Auto-generate points" would add at the sharp corners of the first layer. */
export function autoEars(objectId: string, opts: { detectionRadius: number; maxAngle: number; diameter: number }): BrimPoint[] {
  const l = firstLayer(objectId);
  if (!l) return [];
  return autoEarPoints(l.loops, opts.detectionRadius, opts.maxAngle)
    .map(([x, y]) => earToLocal(objectId, x, y, l.bottom))
    .filter((p): p is Vec3 => !!p)
    .map((pos) => ({ pos, radius: opts.diameter / 2 }));
}

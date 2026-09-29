/**
 * Cut tool logic (Orca GLGizmoCut3D, key C): the cut plane (a point + tilt),
 * its cross-section on the object, connector placement, and the engine call
 * (`cs_tool` op "cut", which runs Orca's own Cut / connector code) whose
 * pieces replace the object in the project.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { engineTool } from '../../engine/client';
import type { PaintLayers } from '../../engine/types';
import { getMesh, getMeshPaint, getObject, replaceWithPieces, type ObjectPiece, type PieceVolume } from '../../project/store';
import { composeTRS, pointInPolygon, type Pt, type Quat, type Vec3 } from '../../project/math';
import type { PartType } from '../../project/types';
import { sliceAtZ, type Loop } from '../brim/brimEars';

export type CutMode = 'plane' | 'groove';
export type ConnectorType = 'plug' | 'dowel' | 'snap';
export type ConnectorStyle = 'prism' | 'frustum';
export type ConnectorShape = 'triangle' | 'square' | 'hexagon' | 'circle';
export type PartAction = 'keep' | 'place' | 'flip';

/** A connector on the cut plane: plane-local 2D position (mm) + its own size. */
export interface CutConnector { u: number; v: number; radius: number; height: number }

export interface CutSettings {
  mode: CutMode;
  /** Plane point (world, mm). */
  center: Vec3;
  /** Tilt about world X then Y (degrees). */
  rotX: number;
  rotY: number;
  keepUpper: boolean;
  keepLower: boolean;
  upper: PartAction;
  lower: PartAction;
  /** Keep both halves as parts of one object (plane cuts without connectors). */
  keepAsParts: boolean;
  connectors: CutConnector[];
  connectorType: ConnectorType;
  connectorStyle: ConnectorStyle;
  connectorShape: ConnectorShape;
  /** Connector size (diameter, mm) and depth (mm) for new connectors. */
  connectorSize: number;
  connectorDepth: number;
  radiusTolerance: number;
  heightTolerance: number;
  groove: { depth: number; width: number; flapsAngle: number; angle: number };
}

export function defaultSettings(center: Vec3, height: number): CutSettings {
  const size = Math.max(2, Math.min(10, height / 6));
  return {
    mode: 'plane', center, rotX: 0, rotY: 0,
    keepUpper: true, keepLower: true, upper: 'place', lower: 'keep', keepAsParts: false,
    connectors: [], connectorType: 'plug', connectorStyle: 'prism', connectorShape: 'circle',
    connectorSize: +size.toFixed(1), connectorDepth: +size.toFixed(1), radiusTolerance: 0, heightTolerance: 0.1,
    groove: { depth: +Math.max(1, height / 8).toFixed(1), width: +Math.max(2, height / 5).toFixed(1), flapsAngle: 60, angle: 0 },
  };
}

/** Plane rotation (world). */
export function planeQuat(s: Pick<CutSettings, 'rotX' | 'rotY'>): Quaternion {
  const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (s.rotX * Math.PI) / 180);
  const qy = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (s.rotY * Math.PI) / 180);
  return qy.multiply(qx);
}

/** Plane frame → world (column-major). Plane-local z = the normal (towards the upper part). */
export function planeMatrix(s: Pick<CutSettings, 'center' | 'rotX' | 'rotY'>): Matrix4 {
  return new Matrix4().compose(new Vector3(...s.center), planeQuat(s), new Vector3(1, 1, 1));
}

export function planeNormal(s: Pick<CutSettings, 'rotX' | 'rotY'>): Vector3 {
  return new Vector3(0, 0, 1).applyQuaternion(planeQuat(s));
}

interface VolumeSrc { name: string; type: PartType; meshId: string; world: Matrix4; config: Record<string, unknown>; paint: PaintLayers }

function volumesOf(objectId: string): VolumeSrc[] {
  const o = getObject(objectId);
  if (!o) return [];
  const om = new Matrix4().fromArray(composeTRS([...o.position] as Vec3, [...o.rotation] as Quat, [...o.scale] as Vec3));
  const out: VolumeSrc[] = [{ name: o.name, type: 'part', meshId: o.meshId, world: om, config: {}, paint: getMeshPaint(o.meshId) }];
  for (const p of o.parts ?? []) {
    const pm = new Matrix4().fromArray(composeTRS([...p.position] as Vec3, [...p.rotation] as Quat, [...p.scale] as Vec3));
    out.push({ name: p.name, type: p.type, meshId: p.meshId, world: om.clone().multiply(pm), config: { ...p.overrides }, paint: getMeshPaint(p.meshId) });
  }
  return out;
}

/** Model parts of the object in the plane's frame (for the cross-section). */
function solidsInPlaneFrame(objectId: string, s: CutSettings): Array<{ positions: Float32Array; indices: Uint32Array }> {
  const inv = planeMatrix(s).invert();
  const out: Array<{ positions: Float32Array; indices: Uint32Array }> = [];
  for (const v of volumesOf(objectId)) {
    if (v.type !== 'part') continue;
    const m = getMesh(v.meshId);
    if (!m) continue;
    const t = inv.clone().multiply(v.world).elements;
    const src = m.positions, pos = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i], y = src[i + 1], z = src[i + 2];
      pos[i] = t[0] * x + t[4] * y + t[8] * z + t[12];
      pos[i + 1] = t[1] * x + t[5] * y + t[9] * z + t[13];
      pos[i + 2] = t[2] * x + t[6] * y + t[10] * z + t[14];
    }
    out.push({ positions: pos, indices: m.indices });
  }
  return out;
}

/** Cross-section loops of the object's model parts on the plane (plane-local XY). */
export function crossSection(objectId: string, s: CutSettings): Loop[] {
  return solidsInPlaneFrame(objectId, s).flatMap((m) => sliceAtZ(m.positions, m.indices, 0));
}

/** Inside the section (even-odd over all loops). */
export function insideSection(loops: Loop[], p: Pt): boolean {
  let n = 0;
  for (const l of loops) if (l.pts.length > 2 && pointInPolygon(p, l.pts, 0)) n++;
  return n % 2 === 1;
}

export interface CutValidation { ok: boolean; reason?: string }

export function validate(s: CutSettings, loops: Loop[]): CutValidation {
  if (!loops.length) return { ok: false, reason: 'The plane doesn’t cross the object.' };
  if (s.mode === 'plane' && !s.connectors.length && !s.keepUpper && !s.keepLower) return { ok: false, reason: 'Keep at least one part.' };
  if (s.mode === 'plane' && s.connectors.some((c) => !insideSection(loops, [c.u, c.v]))) return { ok: false, reason: 'Some connectors are outside the cut surface.' };
  return { ok: true };
}

/**
 * Run the cut in the engine and replace the object with the pieces.
 * Returns the new object ids.
 */
export async function performCut(objectId: string, s: CutSettings): Promise<string[]> {
  const o = getObject(objectId);
  if (!o) throw new Error('The object is gone.');
  const vols = volumesOf(objectId);
  const offset = new Vector3(...o.position);
  // "Object space" for the engine = world minus the instance offset.
  const shift = new Matrix4().makeTranslation(-offset.x, -offset.y, -offset.z);
  const meshes = vols.map((v) => {
    const m = getMesh(v.meshId);
    if (!m) throw new Error(`The mesh of ${v.name} is missing.`);
    return { positions: m.positions, indices: m.indices };
  });
  const pm = shift.clone().multiply(planeMatrix(s));
  const connectors = s.mode === 'plane' ? s.connectors.map((c) => {
    const w = new Vector3(c.u, c.v, 0).applyMatrix4(planeMatrix(s)).sub(offset);
    return {
      pos: [w.x, w.y, w.z], radius: c.radius, height: c.height, type: s.connectorType, style: s.connectorStyle, shape: s.connectorShape,
      radiusTolerance: s.radiusTolerance / 100, heightTolerance: s.heightTolerance / 100,
    };
  }) : [];
  const withConnectors = connectors.length > 0;
  const args = {
    name: o.name,
    offset: [offset.x, offset.y, offset.z],
    volumes: vols.map((v) => ({ name: v.name, type: v.type, transform: shift.clone().multiply(v.world).elements.slice(), config: v.config, paint: v.paint })),
    cut: {
      mode: s.mode,
      matrix: pm.elements.slice(),
      keepUpper: withConnectors || s.keepUpper,
      keepLower: withConnectors || s.keepLower,
      keepAsParts: !withConnectors && s.keepAsParts,
      placeOnCutUpper: s.upper === 'place', flipUpper: s.upper === 'flip',
      placeOnCutLower: s.lower === 'place', flipLower: s.lower === 'flip',
      keepPaint: true,
      connectors,
      groove: s.mode === 'groove' ? {
        depth: s.groove.depth, width: s.groove.width, flapsAngle: (s.groove.flapsAngle * Math.PI) / 180, angle: (s.groove.angle * Math.PI) / 180,
        depthTolerance: 0.1, widthTolerance: 0.1,
      } : undefined,
    },
  };
  type Res = { objects: Array<{ name: string; instance: number[]; volumes: Array<{ name: string; type: string; transform: number[]; connector?: boolean; paint?: PaintLayers; mesh: number }> }> };
  const { result, meshes: outMeshes } = await engineTool<Res>('cut', args, meshes);
  const pieces: ObjectPiece[] = result.objects.map((ro) => {
    const inst = new Matrix4().fromArray(ro.instance);
    // Before "place on cut" / flip the piece sat at the original instance (a pure offset).
    const assembled = new Matrix4().makeTranslation(offset.x, offset.y, offset.z).multiply(inst.clone().invert()).elements.slice();
    return {
      name: ro.name,
      assembled,
      volumes: ro.volumes.map((rv): PieceVolume => {
        const mesh = outMeshes[rv.mesh];
        const w = inst.clone().multiply(new Matrix4().fromArray(rv.transform)).elements;
        const src = mesh.positions, pos = new Float32Array(src.length);
        for (let i = 0; i < src.length; i += 3) {
          const x = src[i], y = src[i + 1], z = src[i + 2];
          pos[i] = w[0] * x + w[4] * y + w[8] * z + w[12];
          pos[i + 1] = w[1] * x + w[5] * y + w[9] * z + w[13];
          pos[i + 2] = w[2] * x + w[6] * y + w[10] * z + w[14];
        }
        // Mirrored placements (flip) turn triangles inside out: restore the winding.
        let idx = mesh.indices;
        if (new Matrix4().fromArray(w).determinant() < 0) {
          idx = new Uint32Array(mesh.indices);
          for (let t = 0; t < idx.length; t += 3) { const a = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = a; }
        }
        const type = (['part', 'negative', 'modifier', 'support_blocker', 'support_enforcer'].includes(rv.type) ? rv.type : 'part') as PartType;
        return { name: rv.name, type, positions: pos, indices: idx, paint: rv.paint };
      }),
    };
  });
  if (!pieces.length) throw new Error('The cut produced no parts.');
  return replaceWithPieces(objectId, pieces, s.mode === 'groove' ? 'Cut with groove' : 'Cut');
}

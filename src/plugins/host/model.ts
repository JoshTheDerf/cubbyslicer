/**
 * `orca.host.model()` from the project store.
 *
 * Mapping (Orca Model → CubbySlicer project):
 *  - ModelObject = one instance group (objects sharing a mesh, `instancesOf`),
 *    on every plate, in project order; ModelInstance = each of those objects.
 *  - ModelVolume = the object's mesh (ModelPart) followed by its parts
 *    (negative volumes, modifiers, support blockers / enforcers).
 *  - Transforms: offset (bed mm), rotation (XYZ Euler, radians), scale,
 *    mirror (±1 from a negative scale); matrices are row-major 4×4.
 *  - Meshes are copied to the runtime on `volume.mesh()` (float32 xyz, int32
 *    triples); stats (volume, manifold, bbox) are computed here and cached per mesh.
 */
import type { ConfigValue } from '../../engine/types';
import type { MeshData, ObjectPart, PartType, ProjectObject } from '../../project/types';
import {
  activePlate, getMesh, getMeshPaint, objectInfo, objectLocalBBox, objects,
} from '../../project/store';
import { composeTRS, mat4Determinant3, type Quat, type Vec3 } from '../../project/math';
import { currentPresets } from '../../presets/store';
import { serializeOrcaValue } from './configSerialize';
import type { ReplyPayload } from '../runtime/hostChannel';

type Mat4 = number[];
type BBox = { min: Vec3; max: Vec3 } | null;

const VOLUME_TYPE: Record<PartType, string> = {
  part: 'ModelPart', negative: 'NegativeVolume', modifier: 'ParameterModifier', support_blocker: 'SupportBlocker', support_enforcer: 'SupportEnforcer',
};

/** Stable small integer ids for string ids (Orca ObjectBase ids are integers). */
const numericIds = new Map<string, number>();
const numId = (s: string): number => {
  let n = numericIds.get(s);
  if (n === undefined) { n = numericIds.size + 1; numericIds.set(s, n); }
  return n;
};

/** Column-major (CubbySlicer) → row-major (numpy) */
const rowMajor = (m: Mat4): number[] => [0, 1, 2, 3].flatMap((r) => [m[r], m[4 + r], m[8 + r], m[12 + r]]);

/** Quaternion → Orca's XYZ Euler angles (Geometry::extract_rotation, radians). */
export function quatToEulerXYZ(q: Quat): Vec3 {
  const [x, y, z, w] = q;
  const sinp = 2 * (w * y - z * x);
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp),
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  ];
}

interface MeshStats { volume: number; manifold: boolean; bbox: BBox }
const statsCache = new WeakMap<MeshData, MeshStats>();

export function meshStats(m: MeshData): MeshStats {
  let s = statsCache.get(m);
  if (s) return s;
  const p = m.positions, idx = m.indices;
  let vol = 0;
  const edges = new Map<string, number>();
  let manifold = true;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    if (manifold && idx.length <= 3_000_000) {
      for (const [u, v] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
        const k = u < v ? `${u},${v}` : `${v},${u}`;
        const n = (edges.get(k) ?? 0) + 1;
        edges.set(k, n);
        if (n > 2) manifold = false;
      }
    }
  }
  if (manifold) for (const n of edges.values()) if (n !== 2) { manifold = false; break; }
  s = { volume: Math.abs(vol), manifold, bbox: m.triangleCount ? { min: [...m.bbox.min] as Vec3, max: [...m.bbox.max] as Vec3 } : null };
  statsCache.set(m, s);
  return s;
}

function serializeOverrides(over: Readonly<Record<string, ConfigValue>> | undefined): Record<string, string> {
  const schema = currentPresets.value.schema.value;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(over ?? {})) {
    const s = serializeOrcaValue(schema?.options[k]?.type, v);
    if (s !== null) out[k] = s;
  }
  return out;
}

function painted(meshId: string) {
  const p = getMeshPaint(meshId);
  return { support: !!p.support, seam: !!p.seam, mm: !!p.color, fuzzy: !!p.fuzzy };
}

const union = (a: BBox, b: BBox): BBox => !a ? b : !b ? a : {
  min: a.min.map((v, i) => Math.min(v, b.min[i])) as Vec3, max: a.max.map((v, i) => Math.max(v, b.max[i])) as Vec3,
};

function transformDecomp(position: Vec3, rotation: Quat, scale: Vec3) {
  return {
    offset: position, rotation: quatToEulerXYZ(rotation),
    scale: scale.map(Math.abs) as Vec3, mirror: scale.map((s) => (s < 0 ? -1 : 1)) as Vec3,
  };
}

function volumeEntry(id: string, name: string, type: string, meshId: string, part: ObjectPart | null, extruder: number) {
  const mesh = getMesh(meshId);
  const st = mesh ? meshStats(mesh) : { volume: 0, manifold: false, bbox: null };
  const pos: Vec3 = part ? part.position : [0, 0, 0];
  const rot: Quat = part ? part.rotation : [0, 0, 0, 1];
  const scl: Vec3 = part ? part.scale : [1, 1, 1];
  return {
    id: numId(id), name, type, extruder, mesh: meshId,
    ...transformDecomp(pos, rot, scl),
    matrix: rowMajor(composeTRS(pos, rot, scl)),
    facets: mesh?.triangleCount ?? 0, volume: st.volume, manifold: st.manifold, bbox: st.bbox,
    painted: painted(meshId), config: serializeOverrides(part?.overrides),
  };
}

const extruderOf = (over: Readonly<Record<string, ConfigValue>> | undefined): number => {
  const v = over?.extruder;
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) && n > 0 ? n : -1;
};

export function modelSnapshot(): unknown {
  const info = objectInfo.value;
  const groups = new Map<string, ProjectObject[]>();
  for (const o of objects.value) {
    const g = groups.get(o.meshId);
    if (g) g.push(o); else groups.set(o.meshId, [o]);
  }
  let modelBox: BBox = null;
  let maxZ = 0;
  const flags = { support: false, seam: false, mm: false, fuzzy: false };
  const outObjects = [...groups.values()].map((group) => {
    const o = group[0];
    const volumes = [volumeEntry(`${o.id}:main`, o.name, 'ModelPart', o.meshId, null, extruderOf(o.overrides)),
      ...(o.parts ?? []).map((p) => volumeEntry(`${o.id}:${p.id}`, p.name, VOLUME_TYPE[p.type], p.meshId, p, extruderOf(p.overrides)))];
    let objBox: BBox = null;
    const instances = group.map((inst) => {
      const wi = info.get(inst.id);
      const box: BBox = wi ? { min: [...wi.min] as Vec3, max: [...wi.max] as Vec3 } : null;
      objBox = union(objBox, box);
      const m = composeTRS(inst.position, inst.rotation, inst.scale);
      const asm = inst.assembly ?? null;
      const am = asm ? composeTRS(asm.position, asm.rotation, asm.scale) : m;
      return {
        id: numId(inst.id), printable: inst.printable, is_printable: inst.printable && inst.visible,
        ...transformDecomp(inst.position, inst.rotation, inst.scale),
        matrix: rowMajor(m), left_handed: mat4Determinant3(m) < 0, bbox: box,
        assemble: { initialized: !!asm, offset: asm ? asm.position : inst.position, rotation: quatToEulerXYZ(asm ? asm.rotation : inst.rotation), matrix: rowMajor(am) },
        offset_to_assembly: asm ? asm.position.map((v, i) => v - inst.position[i]) : [0, 0, 0],
      };
    });
    const pnt = volumes.reduce((a, v) => ({ support: a.support || v.painted.support, seam: a.seam || v.painted.seam, mm: a.mm || v.painted.mm, fuzzy: a.fuzzy || v.painted.fuzzy }), { support: false, seam: false, mm: false, fuzzy: false });
    for (const k of Object.keys(flags) as (keyof typeof flags)[]) flags[k] ||= pnt[k];
    modelBox = union(modelBox, objBox);
    const ob = objBox as BBox;
    if (ob) maxZ = Math.max(maxZ, ob.max[2]);
    const raw = objectLocalBBox(o);
    const extruders = new Set(volumes.map((v) => v.extruder).filter((e) => e > 0));
    return {
      id: numId(o.id), name: o.name, module_name: '', input_file: '', printable: o.printable,
      min_z: ob ? ob.min[2] : 0, max_z: ob ? ob.max[2] : 0, bbox: ob, raw_bbox: raw ? { min: raw.min, max: raw.max } : null,
      facets: volumes.reduce((n, v) => n + v.facets, 0), parts: volumes.filter((v) => v.type === 'ModelPart').length,
      materials: extruders.size, cut: false, custom_layering: !!(o.layerHeightProfile?.length || o.layerRanges?.length),
      painted: pnt, config: serializeOverrides(o.overrides), instances, volumes,
    };
  });
  return {
    id: 1, plate_index: activePlate.value, material_count: 0, painted: flags,
    bbox: modelBox, bbox_approx: modelBox, max_z: maxZ, objects: outObjects,
  };
}

export function meshReply(meshId: string): ReplyPayload {
  const m = getMesh(meshId);
  if (!m) throw Object.assign(new Error('mesh is no longer available'), { pyType: 'RuntimeError' });
  if (m.vertexCount > 0x7fffffff) throw Object.assign(new Error('mesh too large for int32 indices'), { pyType: 'OverflowError' });
  const st = meshStats(m);
  const pos = new Uint8Array(m.positions.buffer.slice(m.positions.byteOffset, m.positions.byteOffset + m.positions.byteLength));
  const idx = new Uint8Array(new Int32Array(m.indices).buffer);
  return { json: { vertex_count: m.vertexCount, triangle_count: m.triangleCount, volume: st.volume, manifold: st.manifold, bbox: st.bbox }, blobs: [pos, idx] };
}


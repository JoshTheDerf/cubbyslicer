/**
 * The project as engine input: slice-job objects for a plate (plate-local
 * transforms, shared mesh arrays, overrides, paint, layer fields, brim ears)
 * and the signature that tells when a plate's slice is stale.
 */
import { toRaw } from 'vue';
import { activeEngine, resolvedConfig } from '../../app/state';
import { engineCaps } from '../../engine/capabilities';
import type { ConfigValue, FlatConfig, SliceObjectInput } from '../../engine/types';
import { isHoleObject } from '../../cad/build';
import { layerSliceFields } from '../../layers/sliceFields';
import type { WorldInfo } from '../geometry';
import { composeTRS, mat4Determinant3, mat4Multiply, type Quat, type Vec3 } from '../math';
import { plateOffset } from '../plates';
import type { MeshData, ProjectObject } from '../types';
import { objectPlate, objectWorldInfo, plateOfInfo } from './derived';
import { paintFor, paintVersion } from './paint';
import { activePlate, bed, meshRevision, meshes, objects, plates } from './state';

/** Overrides as a plain engine config (undefined when there are none). */
function configOf(ov: Record<string, ConfigValue>): FlatConfig | undefined {
  const raw = toRaw(ov);
  return Object.keys(raw).length ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])) : undefined;
}

/** Indices as given, or a winding-flipped copy when the transform mirrors (facets stay outward-facing). */
function windingFor(src: Uint32Array, transform: number[]): Uint32Array {
  if (mat4Determinant3(transform) >= 0) return src;
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i += 3) { out[i] = src[i]; out[i + 1] = src[i + 2]; out[i + 2] = src[i + 1]; }
  return out;
}

/**
 * One object as a slice-job object, placed relative to `offset` (its plate's
 * grid offset) and dropped to z = 0. Mesh arrays are shared, not copied.
 * `slice`: for slicing (mirrored meshes get flipped winding, brim ears are
 * included) rather than for arrange.
 */
export function engineObject(o: ProjectObject, mesh: MeshData, info: WorldInfo, offset: readonly [number, number], slice: boolean): SliceObjectInput {
  const pos: Vec3 = [o.position[0] - offset[0], o.position[1] - offset[1], o.position[2] - info.min[2]];
  const transform = composeTRS(pos, [...o.rotation] as Quat, [...o.scale] as Vec3);
  const indicesFor = (src: Uint32Array, t: number[]) => (slice ? windingFor(src, t) : src);
  const parts = (o.parts ?? []).flatMap((p) => {
    const pm = meshes.get(p.meshId);
    if (!pm) return [];
    const pt = mat4Multiply(transform, composeTRS([...p.position] as Vec3, [...p.rotation] as Quat, [...p.scale] as Vec3));
    const pp = paintFor(p.meshId);
    // A precise seam goes as its seam type with the seam's own settings; an engine without seam volumes gets the inert modifier.
    const seam = slice && p.preciseSeam && engineCaps(activeEngine.value).preciseSeam ? p.preciseSeam : null;
    return [{ id: p.id, name: p.name, type: seam ? seam.type : p.type, positions: pm.positions, indices: indicesFor(pm.indices, pt), transform: pt,
      config: configOf(seam ? seam.config : p.overrides), ...(pp ? { paint: pp } : {}) }];
  });
  const paint = paintFor(o.meshId);
  return {
    id: o.id, name: o.name, positions: mesh.positions, indices: indicesFor(mesh.indices, transform), transform, config: configOf(o.overrides),
    ...(parts.length ? { parts } : {}),
    ...(paint ? { paint } : {}),
    ...layerSliceFields(toRaw(o), info.max[2] - info.min[2], resolvedConfig.value),
    ...(slice && o.brimPoints?.length ? { brimPoints: toRaw(o.brimPoints).map((b) => ({ pos: [...toRaw(b).pos] as [number, number, number], radius: b.radius })) } : {}),
  };
}

/**
 * Printable objects on a plate as engine inputs. Mesh arrays are shared (not
 * copied) unless the transform mirrors (det < 0), in which case a
 * winding-flipped index copy is produced so facets stay outward-facing.
 */
export function getSliceObjects(plate = activePlate.value): SliceObjectInput[] {
  const out: SliceObjectInput[] = [];
  // Engine coordinates are the printer's bed: remove the plate's grid offset.
  const offset = plateOffset(plate, plates.value.length, bed.value);
  for (const o of objects.value) {
    if (!o.printable || isHoleObject(o.cad?.node)) continue;
    const mesh = meshes.get(o.meshId);
    if (!mesh) continue;
    const info = objectWorldInfo(o)!;
    if (plateOfInfo(info) !== plate) continue;
    out.push(engineObject(o, mesh, info, offset, true));
  }
  return out;
}

/**
 * What a plate's slice depends on besides the config: its printable objects
 * (plate-relative placement, mesh, overrides). A plate's result is stale when
 * this or the config changed since it was sliced.
 */
export function plateSliceSignature(plate: number): string {
  void meshRevision.value;
  const [ox, oy] = plateOffset(plate, plates.value.length, bed.value);
  const parts: string[] = [];
  for (const o of objects.value) {
    if (!o.printable || isHoleObject(o.cad?.node) || objectPlate.value.get(o.id) !== plate) continue;
    const r = toRaw(o);
    parts.push(JSON.stringify([r.id, r.meshId, paintVersion(r), r.position[0] - ox, r.position[1] - oy, r.position[2], r.rotation, r.scale, toRaw(r.overrides), toRaw(r.parts ?? []),
      toRaw(o.layerHeightProfile ?? null), toRaw(o.layerRanges ?? null), toRaw(o.brimPoints ?? null)]));
  }
  // Plate settings + slider custom G-codes (Orca PartPlate config / CustomGCode::Info).
  const pm = plates.value[plate];
  if (pm?.config || pm?.customGcodes) parts.push(JSON.stringify([toRaw(pm.config ?? null), toRaw(pm.customGcodes ?? null)]));
  return parts.join('|');
}

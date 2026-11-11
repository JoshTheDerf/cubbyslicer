/**
 * Parts of an object (Orca volumes): model parts, modifiers, negative parts,
 * support blockers / enforcers. Add, remove, transform, retype, rename and
 * per-part setting overrides.
 */
import type { ConfigValue } from '../../engine/types';
import { quatNormalize, type Quat, type Vec3 } from '../math';
import type { ObjectPart, PartType, PreciseSeam, PreciseSeamType, ProjectObject } from '../types';
import { mutate } from './history';
import { dropObj } from './placement';
import { EMPTY_OVERRIDES, addMesh, getObject, uid } from './state';

export function findPart(objId: string, partId: string): { o: ProjectObject; p: ObjectPart } | null {
  const o = getObject(objId);
  const p = o?.parts?.find((x) => x.id === partId);
  return o && p ? { o, p } : null;
}

export function getPartOverrides(objId: string, partId: string): Readonly<Record<string, ConfigValue>> {
  return findPart(objId, partId)?.p.overrides ?? EMPTY_OVERRIDES;
}

/** Remove a part (inside a `mutate`); the object drops back onto the bed. */
export function dropPart(o: ProjectObject, partId: string): void {
  if (!o.parts) return;
  o.parts = o.parts.filter((p) => p.id !== partId);
  if (!o.parts.length) delete o.parts;
  dropObj(o);
}

export function removePart(objId: string, partId: string): void {
  mutate('Delete part', () => {
    const o = getObject(objId);
    if (o) dropPart(o, partId);
  });
}

/** Move / rotate / scale one part (object-local frame). The object stays on the bed. */
export function setPartTransform(objId: string, partId: string, t: { position?: Vec3; rotation?: Quat; scale?: Vec3 }, label = 'Move part'): void {
  mutate(label, () => {
    const f = findPart(objId, partId);
    if (!f) return;
    if (t.position) f.p.position = [...t.position] as Vec3;
    if (t.rotation) f.p.rotation = quatNormalize(t.rotation);
    if (t.scale) f.p.scale = t.scale.map((v) => (Math.abs(v) < 1e-4 ? Math.sign(v || 1) * 1e-4 : v)) as Vec3;
    if (f.p.type === 'part') dropObj(f.o);
  });
}

export function setPartType(objId: string, partId: string, type: PartType): void {
  mutate('Change part type', () => {
    const f = findPart(objId, partId);
    if (!f) return;
    f.p.type = type;
    delete f.p.preciseSeam; // any explicit type ends a precise seam
    dropObj(f.o);
  });
}

/**
 * Orca 2.5 "Change type > Precise Seam" / "Precise Seam Type": make the part a
 * precise seam of `seamType` (a modifier carrying `preciseSeam`, with no
 * settings of its own: Orca gives seam volumes none). An existing seam keeps
 * its stored config; `keepSubtype` keeps its subtype too (Orca's generic
 * "Precise Seam" entry).
 */
export function setPreciseSeamType(objId: string, partId: string, seamType: PreciseSeamType, keepSubtype = false): void {
  mutate('Change precise seam type', () => {
    const f = findPart(objId, partId);
    if (!f) return;
    const old = f.p.preciseSeam;
    f.p.type = 'modifier';
    f.p.overrides = {};
    f.p.preciseSeam = Object.freeze({ type: keepSubtype && old ? old.type : seamType, config: old?.config ?? Object.freeze({}) }) as PreciseSeam;
    dropObj(f.o);
  });
}

export function renamePart(objId: string, partId: string, name: string): void {
  const n = name.trim();
  if (!n) return;
  mutate('Rename part', () => { const f = findPart(objId, partId); if (f) f.p.name = n.slice(0, 200); }, { slice: false });
}

export function setPartOverride(objId: string, partId: string, key: string, value: ConfigValue | undefined): void {
  mutate(value === undefined ? 'Reset part setting' : 'Change part setting', () => {
    const f = findPart(objId, partId);
    if (!f) return;
    if (value === undefined) delete f.p.overrides[key];
    else f.p.overrides[key] = Array.isArray(value) ? [...value] : value;
  }, { mergeKey: `povr:${partId}:${key}` });
}

/** Append a part to a live object (inside a `mutate`); a model part drops the object back onto the bed. */
export function pushPart(o: ProjectObject, part: ObjectPart): void {
  o.parts = [...(o.parts ?? []), part];
  if (part.type === 'part') dropObj(o);
}

/**
 * Orca "Add part / modifier / negative part / support blocker / enforcer":
 * `positions`/`indices` are mesh-local (centred); the part is placed at
 * `localPos` in the object's frame (default: the object's origin).
 */
export function addPart(objId: string, type: PartType, name: string, positions: Float32Array, indices: Uint32Array, localPos: Vec3 = [0, 0, 0],
  seamType?: PreciseSeamType): string | null {
  const o = getObject(objId);
  if (!o) return null;
  const id = uid('p');
  const seam = seamType ? { type: 'modifier' as const, preciseSeam: Object.freeze({ type: seamType, config: Object.freeze({}) }) as PreciseSeam } : null;
  mutate(seam ? 'Add precise seam' : `Add ${type === 'part' ? 'part' : type.replace('_', ' ')}`, () => {
    const mesh = addMesh(positions, indices);
    pushPart(getObject(objId)!, {
      id, name, meshId: mesh.id, type: seam?.type ?? type, position: [...localPos] as Vec3, rotation: [0, 0, 0, 1], scale: [1, 1, 1], overrides: {},
      ...(seam ? { preciseSeam: seam.preciseSeam } : {}),
    });
  });
  return id;
}

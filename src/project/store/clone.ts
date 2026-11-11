/**
 * Deep copies of project objects for undo snapshots, the clipboard and
 * duplication. Meshes and CubbyCAD trees are shared by reference (both are
 * immutable once made).
 */
import { markRaw, toRaw } from 'vue';
import type { ConfigValue } from '../../engine/types';
import type { CadNode } from '../../cad/api';
import type { Quat, Vec3 } from '../math';
import type { ObjectPart, ProjectObject } from '../types';

export function cloneOverrides(o: Record<string, ConfigValue>): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const [k, v] of Object.entries(toRaw(o))) out[k] = Array.isArray(v) ? [...v] : v;
  return out;
}

export function clonePart(p: ObjectPart): ObjectPart {
  const r = toRaw(p);
  const out: ObjectPart = { ...r, position: [...r.position] as Vec3, rotation: [...r.rotation] as Quat, scale: [...r.scale] as Vec3, overrides: cloneOverrides(r.overrides) };
  if (r.emboss) out.emboss = { ...toRaw(r.emboss) }; // tools: text / SVG source
  return out;
}

export function cloneObj(o: ProjectObject): ProjectObject {
  const r = toRaw(o);
  const out: ProjectObject = {
    ...r,
    position: [...r.position] as Vec3,
    rotation: [...r.rotation] as Quat,
    scale: [...r.scale] as Vec3,
    overrides: cloneOverrides(r.overrides),
  };
  if (r.parts?.length) out.parts = toRaw(r.parts).map(clonePart);
  else delete out.parts;
  if (r.layerHeightProfile?.length) out.layerHeightProfile = [...toRaw(r.layerHeightProfile)];
  else delete out.layerHeightProfile;
  if (r.layerRanges?.length) out.layerRanges = toRaw(r.layerRanges).map((l) => ({ ...toRaw(l), overrides: cloneOverrides(l.overrides) }));
  else delete out.layerRanges;
  // tools: text / SVG emboss source + brim ears
  if (r.emboss) out.emboss = { ...toRaw(r.emboss) }; else delete out.emboss;
  if (r.brimPoints?.length) out.brimPoints = toRaw(r.brimPoints).map((b) => ({ pos: [...toRaw(b).pos] as Vec3, radius: b.radius }));
  else delete out.brimPoints;
  // CubbyCAD tree: immutable, shared by reference.
  if (r.cad) out.cad = cadData(toRaw(r.cad).node); else delete out.cad;
  // Design tab link: immutable (frozen), shared.
  if (r.design) out.design = toRaw(r.design); else delete out.design;
  return out;
}

/** A CAD tree wrapper Vue never proxies (trees are immutable; edits replace them). */
export function cadData(node: CadNode): { node: CadNode } {
  return markRaw({ node: markRaw(toRaw(node)) });
}

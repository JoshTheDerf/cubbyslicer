/**
 * Derived geometry: each object's world bbox + footprint, which plate it is
 * on, plate problems (off plate, too tall, overlapping) and plate stats.
 */
import { computed } from 'vue';
import { isHoleObject } from '../../cad/build';
import { mergeWorldInfo, partWorldInfo, worldInfo, type WorldInfo } from '../geometry';
import { composeTRS, transformPoint, type Vec3 } from '../math';
import { plateIndexAt } from '../plates';
import type { ObjectIssue, ProjectObject } from '../types';
import { validatePlate } from '../validate';
import { computeImexZoneLayout, effectiveImexMode, imexZoneViolation } from '../../plates/imex';
import { resolvedConfig } from '../../app/state';
import { beltOpenY } from '../../viewport/belt';
import { activePlate, bed, meshRevision, meshes, objects, plateBedOf, plates } from './state';

/**
 * Bounding box of an object in its own (unscaled, unrotated) frame: its mesh
 * plus its model parts (each part's mesh box corners through the part's TRS).
 * Multiply by |scale| for Orca's "Size" row.
 */
export function objectLocalBBox(o: ProjectObject): { min: Vec3; max: Vec3 } | null {
  const mesh = meshes.get(o.meshId);
  if (!mesh) return null;
  const min = [...mesh.bbox.min] as Vec3, max = [...mesh.bbox.max] as Vec3;
  for (const p of o.parts ?? []) {
    if (p.type !== 'part') continue;
    const pm = meshes.get(p.meshId);
    if (!pm) continue;
    const m = composeTRS(p.position, p.rotation, p.scale);
    for (let c = 0; c < 8; c++) {
      const q = transformPoint(m, [c & 1 ? pm.bbox.max[0] : pm.bbox.min[0], c & 2 ? pm.bbox.max[1] : pm.bbox.min[1], c & 4 ? pm.bbox.max[2] : pm.bbox.min[2]]);
      for (let k = 0; k < 3; k++) { if (q[k] < min[k]) min[k] = q[k]; if (q[k] > max[k]) max[k] = q[k]; }
    }
  }
  return { min, max };
}

/** World bbox + footprint of an object: its mesh plus its model parts (Orca's instance bbox excludes modifiers). Not cached: use for objects being edited. */
export function objectWorldInfo(o: ProjectObject): WorldInfo | null {
  const mesh = meshes.get(o.meshId);
  if (!mesh) return null;
  let info = worldInfo(o, mesh);
  for (const p of o.parts ?? []) {
    if (p.type !== 'part') continue;
    const pm = meshes.get(p.meshId);
    if (pm) info = mergeWorldInfo(info, partWorldInfo(o, p, pm));
  }
  return info;
}

/** World bbox + XY hull per object id. */
export const objectInfo = computed(() => {
  void meshRevision.value;
  const m = new Map<string, WorldInfo>();
  for (const o of objects.value) {
    const info = objectWorldInfo(o);
    if (info) m.set(o.id, info);
  }
  return m;
});

/** The plate under a world bbox's centre (-1 = none). */
export function plateOfInfo(i: WorldInfo): number {
  return plateIndexAt((i.min[0] + i.max[0]) / 2, (i.min[1] + i.max[1]) / 2, plates.value.length, bed.value);
}

/** The plate an object is on right now (uncached; for objects being edited). */
export function plateOfLive(o: ProjectObject): number { const i = objectWorldInfo(o); return i ? plateOfInfo(i) : -1; }

/** Plate index per object id (-1 = on no plate). */
export const objectPlate = computed(() => {
  const m = new Map<string, number>();
  for (const [id, info] of objectInfo.value) m.set(id, plateOfInfo(info));
  return m;
});

export function plateOf(id: string): number { return objectPlate.value.get(id) ?? -1; }
export function objectsOnPlate(i: number): ProjectObject[] { return objects.value.filter((o) => plateOf(o.id) === i); }

/** Plate problems per object id (only printable objects are checked, each against its own plate). */
export const objectIssues = computed(() => {
  const byPlate = new Map<number, Array<{ id: string; hull: WorldInfo['hull']; min: WorldInfo['min']; max: WorldInfo['max'] }>>();
  const out = new Map<string, ObjectIssue[]>();
  for (const o of objects.value) {
    // A CubbyCAD hole on its own isn't printed: no plate problems (it usually sits over the part it will cut).
    if (!o.printable || isHoleObject(o.cad?.node)) continue;
    const info = objectInfo.value.get(o.id);
    if (!info) continue;
    const p = objectPlate.value.get(o.id) ?? -1;
    if (p < 0) { out.set(o.id, ['outside']); continue; }
    let l = byPlate.get(p);
    if (!l) byPlate.set(p, (l = []));
    l.push({ id: o.id, hull: info.hull, min: info.min, max: info.max });
  }
  for (const [p, items] of byPlate) {
    const cfg = resolvedConfig.value;
    for (const [id, issues] of validatePlate(items, plateBedOf(p), { openY: beltOpenY(cfg) })) out.set(id, issues);
    // IDEX/IQEX parallel mode: parts go in T0's zone, clear of the carriage collision strips.
    const mode = effectiveImexMode(cfg, plates.value[p]?.config);
    const layout = mode ? computeImexZoneLayout(cfg, mode, plateBedOf(p)) : null;
    if (!layout?.primaryZone) continue;
    for (const it of items) {
      if (!imexZoneViolation(layout, it.hull)) continue;
      const l = out.get(it.id);
      if (!l) out.set(it.id, ['zone']); else if (!l.includes('zone')) l.push('zone');
    }
  }
  return out;
});

export const plateStats = computed(() => {
  void meshRevision.value;
  let tris = 0, n = 0;
  for (const o of objects.value) {
    if (objectPlate.value.get(o.id) !== activePlate.value) continue;
    n++;
    tris += meshes.get(o.meshId)?.triangleCount ?? 0;
  }
  return { objects: n, triangles: tris, total: objects.value.length };
});

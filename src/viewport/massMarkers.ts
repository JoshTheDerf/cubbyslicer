/**
 * The centre-of-mass markers of the Prepare view (desktop
 * GLCanvas3D::CenterOfMass::model_markers): one per object (its model parts,
 * each at its filament's density), one per plate (its objects), and for an
 * assembly (several model parts, or parts and negative volumes) one per
 * connected body when there are several: the parts united, negative volumes
 * cut away, the later part weighing where two overlap (massBodies.ts, desktop's
 * solid_bodies). Bodies are computed asynchronously (`prepareMassBodies`);
 * until they are, and for parts that aren't closed meshes, the parts are
 * summed as solids.
 */
import { asList, toNumber, valueAt } from '../lib/configValue';
import { composeTRS, mat4Multiply } from '../project/math';
import type { MeshData, ProjectObject } from '../project/types';
import type { FlatConfig } from '../engine/types';
import { addSum, DEFAULT_FILAMENT_DENSITY, emptySum, meshMass, type MassMarker, type MassSum } from './massProps';
import { solidBodies, type BodyInput, type SolidBodyMesh } from './massBodies';

type Box = NonNullable<MassMarker['box']>;
const mergeBox = (a: Box | null, b: Box | null): Box | null => {
  if (!a) return b && { min: [...b.min], max: [...b.max] };
  if (!b) return a;
  return { min: [0, 1, 2].map((i) => Math.min(a.min[i], b.min[i])) as Box['min'], max: [0, 1, 2].map((i) => Math.max(a.max[i], b.max[i])) as Box['max'] };
};

function meshBox(m: MeshData, t: readonly number[]): Box {
  const min: Box['min'] = [Infinity, Infinity, Infinity], max: Box['max'] = [-Infinity, -Infinity, -Infinity];
  const p = m.positions;
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = t[k] * p[i] + t[4 + k] * p[i + 1] + t[8 + k] * p[i + 2] + t[12 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

export interface MarkerInput {
  objects: readonly ProjectObject[];
  mesh: (id: string) => MeshData | undefined;
  config: FlatConfig;
  /** The plate an object is on (-1: off every plate). */
  plateOf: (o: ProjectObject) => number;
}

/** Per-mesh, per-transform cache: dragging one object doesn't recompute the others. */
const cache = new Map<string, MassSum>();

const densityOf = (config: FlatConfig) => {
  const densities = asList(config.filament_density).map((v) => toNumber(v, 0));
  return (slot: number) => { const d = densities[Math.max(1, slot) - 1] ?? 0; return d > 0 ? d : DEFAULT_FILAMENT_DENSITY; };
};
const objectSlot = (o: ProjectObject) => Math.trunc(toNumber(valueAt(o.overrides.extruder, 0), 1)) || 1;

/** The object's model parts and negative volumes in desktop's volume order, in the object's frame. */
function assemblyParts(o: ProjectObject, mesh: (id: string) => MeshData | undefined, density: (slot: number) => number): { key: string; parts: BodyInput[]; meshes: MeshData[] } | null {
  const own = mesh(o.meshId);
  if (!own) return null;
  const objSlot = objectSlot(o);
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const parts: BodyInput[] = [{ positions: own.positions, indices: own.indices, transform: I, density: density(objSlot), negative: false }];
  const meshes = [own];
  for (const p of o.parts ?? []) {
    if (p.type !== 'part' && p.type !== 'negative') continue;
    const pm = mesh(p.meshId);
    if (!pm) continue;
    const slot = Math.trunc(toNumber(valueAt(p.overrides.extruder, 0), 0)) || objSlot;
    parts.push({ positions: pm.positions, indices: pm.indices, transform: composeTRS(p.position, p.rotation, p.scale), density: density(slot), negative: p.type === 'negative' });
    meshes.push(pm);
  }
  const solids = parts.filter((x) => !x.negative).length;
  if (!(solids > 1 || (solids > 0 && parts.length > solids))) return null;
  const key = parts.map((x, i) => `${meshes[i].id}|${x.negative ? 'n' : x.density}|${x.transform.map((v) => v.toFixed(6)).join(',')}`).join(';');
  return { key, parts, meshes };
}

/** Assembly bodies by assembly key (null: a part isn't closed — sum the parts instead). */
const bodyCache = new Map<string, SolidBodyMesh[] | null>();
const pending = new Map<string, Promise<void>>();

/** Compute the bodies of every assembly that has none cached yet; resolves when done (true: something new). */
export async function prepareMassBodies(input: MarkerInput): Promise<boolean> {
  const density = densityOf(input.config);
  const jobs: Promise<void>[] = [];
  const live = new Set<string>();
  for (const o of input.objects) {
    if (!o.visible || o.cad?.node.contribution === 'subtract') continue;
    const a = assemblyParts(o, input.mesh, density);
    if (!a) continue;
    live.add(a.key);
    if (bodyCache.has(a.key)) continue;
    let job = pending.get(a.key);
    if (!job) {
      job = solidBodies(a.parts).then((b) => { bodyCache.set(a.key, b); }).finally(() => pending.delete(a.key));
      pending.set(a.key, job);
    }
    jobs.push(job);
  }
  await Promise.all(jobs);
  for (const k of [...bodyCache.keys()]) if (!live.has(k)) bodyCache.delete(k);
  return jobs.length > 0;
}

export function massMarkers(input: MarkerInput): MassMarker[] {
  const density = densityOf(input.config);
  const used = new Set<string>();
  const massOf = (m: MeshData, t: number[], d: number) => {
    const key = `${m.id}|${t.map((v) => v.toFixed(5)).join(',')}|${d}`;
    used.add(key);
    let s = cache.get(key);
    if (!s) { s = meshMass(m.positions, m.indices, t, d); cache.set(key, s); }
    return s;
  };
  const out: MassMarker[] = [];
  const plates = new Map<number, MassMarker>();
  for (const o of input.objects) {
    if (!o.visible || o.cad?.node.contribution === 'subtract') continue;
    const mesh = input.mesh(o.meshId);
    if (!mesh) continue;
    const objT = composeTRS(o.position, o.rotation, o.scale);
    const objSlot = objectSlot(o);
    const asm = assemblyParts(o, input.mesh, density);
    const solved = asm ? bodyCache.get(asm.key) : undefined;
    if (asm && solved) {
      // solid_bodies: the object is the sum of its bodies; a marker per body when there are several.
      let box: Box | null = null;
      asm.parts.forEach((x, i) => { if (!x.negative) box = mergeBox(box, meshBox(asm.meshes[i], mat4Multiply(objT, [...x.transform]))); });
      const parts: MassMarker[] = [];
      const sum = emptySum();
      solved.forEach((b, bi) => {
        const bs = emptySum();
        let bb: Box | null = null;
        b.pieces.forEach((pc, pi) => {
          const key = `${asm.key}#${bi}.${pi}|${objT.map((v) => v.toFixed(5)).join(',')}`;
          used.add(key);
          let ms = cache.get(key);
          if (!ms) { ms = meshMass(pc.positions, pc.indices, objT, pc.density); cache.set(key, ms); }
          addSum(bs, ms);
          bb = mergeBox(bb, meshBox({ positions: pc.positions } as MeshData, objT));
        });
        if (bs.mass > 0) { parts.push({ kind: 'body', sum: bs, box: bb }); addSum(sum, bs); }
      });
      if (!(sum.mass > 0)) continue;
      out.push({ kind: 'object', sum, box, assembly: true });
      if (parts.length > 1) out.push(...parts);
      const plate = input.plateOf(o);
      if (plate >= 0) {
        const pm = plates.get(plate) ?? { kind: 'plate' as const, sum: emptySum(), box: null };
        addSum(pm.sum, sum);
        pm.box = mergeBox(pm.box, box);
        plates.set(plate, pm);
      }
      continue;
    }
    const bodies: MassMarker[] = [];
    let negatives = emptySum();
    let box: Box | null = meshBox(mesh, objT);
    bodies.push({ kind: 'body', sum: massOf(mesh, objT, density(objSlot)), box });
    for (const p of o.parts ?? []) {
      if (p.type !== 'part' && p.type !== 'negative') continue;
      const pm = input.mesh(p.meshId);
      if (!pm) continue;
      const t = mat4Multiply(objT, composeTRS(p.position, p.rotation, p.scale));
      const slot = Math.trunc(toNumber(valueAt(p.overrides.extruder, 0), 0)) || objSlot;
      if (p.type === 'negative') { negatives = addSum(negatives, massOf(pm, t, density(objSlot))); continue; }
      const b = meshBox(pm, t);
      box = mergeBox(box, b);
      bodies.push({ kind: 'body', sum: massOf(pm, t, density(slot)), box: b });
    }
    const sum = emptySum();
    for (const b of bodies) addSum(sum, b.sum);
    if (negatives.volume > 0) addSum(sum, negatives, -1);
    if (!(sum.mass > 0)) continue;
    const assembly = bodies.length > 1 || negatives.volume > 0;
    out.push({ kind: 'object', sum, box, assembly });
    if (bodies.length > 1) out.push(...bodies.filter((b) => b.sum.mass > 0));
    const plate = input.plateOf(o);
    if (plate >= 0) {
      const pm = plates.get(plate) ?? { kind: 'plate' as const, sum: emptySum(), box: null };
      addSum(pm.sum, sum);
      pm.box = mergeBox(pm.box, box);
      plates.set(plate, pm);
    }
  }
  for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
  return [...plates.values(), ...out];
}

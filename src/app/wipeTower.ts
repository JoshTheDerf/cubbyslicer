/**
 * Prime tower placement through the engine's `wipe_tower_footprint` op
 * (docs/ENGINE-CONTRACT.md "Prime tower"): desktop's footprint estimate for
 * the plate (its filaments, tallest object, thinnest layer) and its placement
 * rules, so the tower stays on the bed and inside every extruder's printable
 * area (H2D / H2C: the right extruder starts at x 25; Prusa MK4: 210 mm deep).
 *
 * Before a plate is sliced, its tower anchor (`wipe_tower_x/y[plate]`, project
 * config) is set the way desktop sets it: a plate without one gets
 * PartPlateList::set_default_wipe_tower_pos_for_plate's spot; an anchor the
 * footprint doesn't fit at is moved by desktop's clamp + move-inside. The
 * result is written back to the project, so the next slice (and a saved 3MF)
 * has it. The engine reads a job's anchor at index 0 (its Print has plate
 * index 0), so a job carries the plate's own anchor there.
 */
import type { FlatConfig, SliceJob, SliceObjectInput } from '../engine/types';
import type { WipeTowerFootprintArgs, WipeTowerFootprintResult } from '../engine/tools';
import { asList, toBool, toNumber, valueAt } from '../lib/configValue';
import { paintStatesUsed } from '../lib/paintStates';
import { boundsOf, meshHull2d, relocateAnchor, towerObstacle, type P2, type Poly, type Relocation } from './wipeTowerPlace';

const NON_PRINTING = new Set(['negative', 'support_blocker', 'support_enforcer']);

const int = (cfg: FlatConfig | undefined, key: string): number | undefined => {
  const v = cfg?.[key];
  if (v === undefined) return undefined;
  const n = Math.trunc(toNumber(valueAt(v, 0)));
  return Number.isFinite(n) ? n : undefined;
};

/** The physical filaments a mixed slot prints with (1-based), or [slot] for a physical one. */
export function expandMixed(cfg: FlatConfig, slot: number): number[] {
  const mixed = asList(cfg.filament_is_mixed);
  if (mixed[slot - 1] !== '1') return [slot];
  const comps = (asList(cfg.filament_mixed_components)[slot - 1] ?? '').split(',').map((s) => parseInt(s, 10)).filter((n) => n >= 1);
  return comps.length ? comps : [slot];
}

/**
 * PartPlate::get_extruders(true) over a slice job: each printing volume's
 * filament (its own, else its object's) and its colour paint, layer-range
 * filaments, support / interface filaments where support is on, the
 * per-feature filaments (object, else the print's), tool-change custom
 * G-codes; mixed slots expanded to their physical components. Sorted, unique.
 */
export function plateFilaments(job: Pick<SliceJob, 'config' | 'objects' | 'options'>): number[] {
  const g = job.config;
  const count = Math.max(1, asList(g.filament_colour).length || asList(g.filament_diameter).length);
  const out = new Set<number>();
  const add = (id: number | undefined) => { if (id !== undefined && id >= 1 && id <= count) out.add(id); };
  const paint = (p: SliceObjectInput['paint']) => {
    if (!p?.color?.length) return;
    const states = new Set<number>();
    for (const [, hex] of p.color) paintStatesUsed(hex, states);
    for (const s of states) if (s > 0) add(s);
  };
  const glbOuter = int(g, 'outer_wall_filament_id') || int(g, 'inner_wall_filament_id') || 0;
  const glbInner = int(g, 'inner_wall_filament_id') || int(g, 'outer_wall_filament_id') || 0;
  const glbSupport = toBool(valueAt(g.enable_support, 0)) || (int(g, 'raft_layers') ?? 0) > 0;
  for (const o of job.objects) {
    const objExtruder = int(o.config, 'extruder') || 1;
    add(objExtruder);
    paint(o.paint);
    for (const p of o.parts ?? []) {
      if (NON_PRINTING.has(p.type) || p.type.startsWith('precise_seam')) continue;
      add(int(p.config, 'extruder') || objExtruder);
      paint(p.paint);
    }
    for (const r of o.layerRanges ?? []) { const e = int(r.config, 'extruder'); if (e && e > 0) add(e); }
    const oc = o.config;
    const objSupport = oc?.enable_support !== undefined || oc?.raft_layers !== undefined
      ? toBool(valueAt(oc?.enable_support, 0)) || (int(oc, 'raft_layers') ?? 0) > 0 : glbSupport;
    if (objSupport) {
      add(int(oc, 'support_interface_filament') || int(g, 'support_interface_filament') || undefined);
      add(int(oc, 'support_filament') || int(g, 'support_filament') || undefined);
    }
    add((int(oc, 'outer_wall_filament_id') || int(oc, 'inner_wall_filament_id') || glbOuter) || undefined);
    add((int(oc, 'inner_wall_filament_id') || int(oc, 'outer_wall_filament_id') || glbInner) || undefined);
    for (const k of ['sparse_infill_filament_id', 'internal_solid_filament_id', 'top_surface_filament_id', 'bottom_surface_filament_id']) {
      add(int(oc, k) || int(g, k) || undefined);
    }
  }
  for (const c of job.options?.customGcodes ?? []) if (c.type === 'tool_change' && c.extruder && c.extruder <= count) add(c.extruder);
  const physical = new Set<number>();
  for (const s of out) for (const f of expandMixed(g, s)) physical.add(f);
  return [...physical].sort((a, b) => a - b);
}

/** Tallest object (mesh z extent after its transform) and thinnest layer (object / part / height range / variable layer height, else the print's). */
export function plateHeights(job: Pick<SliceJob, 'config' | 'objects'>): { maxHeight: number; layerHeight: number } {
  const global = toNumber(valueAt(job.config.layer_height, 0), 0.2);
  let maxHeight = 0, layerHeight = Infinity;
  for (const o of job.objects) {
    const t = o.transform, p = o.positions;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const z = t[2] * p[i] + t[6] * p[i + 1] + t[10] * p[i + 2] + t[14];
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
    if (hi > lo) maxHeight = Math.max(maxHeight, hi - lo);
    const own = toNumber(valueAt(o.config?.layer_height, 0), global);
    layerHeight = Math.min(layerHeight, own);
    // Thinner layers anywhere on the object (part settings, height ranges, variable layer height) deepen the tower.
    for (const p of o.parts ?? []) if (!NON_PRINTING.has(p.type)) layerHeight = Math.min(layerHeight, toNumber(valueAt(p.config?.layer_height, 0), own));
    for (const r of o.layerRanges ?? []) layerHeight = Math.min(layerHeight, toNumber(valueAt(r.config.layer_height, 0), own));
    const prof = o.layerHeightProfile ?? [];
    for (let i = 1; i < prof.length; i += 2) if (prof[i] > 0) layerHeight = Math.min(layerHeight, prof[i]);
  }
  return { maxHeight, layerHeight: Number.isFinite(layerHeight) ? layerHeight : global };
}

/** Whether the plate may print a tower at all (skip the engine round trip for single-filament plates). */
export function towerMayPrint(cfg: FlatConfig, filaments: number[]): boolean {
  if (!toBool(valueAt(cfg.enable_prime_tower, 0), false)) return false;
  return filaments.length > 1 || valueAt(cfg.timelapse_type, 0) === 'Smooth';
}

/** The plate's own anchor in a project-config list, if it has one. */
export function anchorOf(cfg: FlatConfig, plate: number): [number, number] | null {
  const xs = asList(cfg.wipe_tower_x), ys = asList(cfg.wipe_tower_y);
  const x = toNumber(xs[plate]), y = toNumber(ys[plate]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

export type FootprintCall = (args: WipeTowerFootprintArgs) => Promise<WipeTowerFootprintResult>;

/**
 * Where the plate's tower goes: the result of the placement call, null when no
 * tower prints. `own` = the plate's saved anchor (null: desktop's default spot
 * for a new plate, sized for at least 2 filaments as desktop's init does).
 */
export async function placeTower(job: Pick<SliceJob, 'config' | 'objects' | 'options'>, own: [number, number] | null,
                                  call: FootprintCall, printerModelId?: string): Promise<PlacedTower | null> {
  const filaments = plateFilaments(job);
  if (!towerMayPrint(job.config, filaments)) return null;
  const { maxHeight, layerHeight } = plateHeights(job);
  const base: WipeTowerFootprintArgs = { config: job.config, filaments, maxHeight, layerHeight, objects: job.objects.length, plate: 0, printerModelId };
  let position = own;
  if (!position) {
    const d = await call({ ...base, minFilaments: 2 });
    position = [d.defaultPosition.x, d.defaultPosition.y];
  }
  const r: PlacedTower = await call({ ...base, position });
  if (!r.printed) return null;
  // A saved anchor desktop re-places (more than 5 mm off the plate) goes to the clear spot
  // nearest it (PartPlate::estimate_wipe_tower_polygon's relocation, which the engine op leaves out).
  if (own) {
    const plate = plateSize(job.config);
    if (plate) {
      const rel = relocateAnchor(own[0], own[1], { width: r.width, depth: r.depth, brim: r.brim, cone: r.coneMargin, rotation: r.rotation },
        plate[0], plate[1], () => towerObstacles(job));
      if (rel.moved) {
        r.relocation = rel;
        if (!rel.overlapsObjects) r.placement = { ...r.placement, x: rel.x, y: rel.y, moved: true };
      }
    }
  }
  return r;
}

/** The footprint result plus desktop's relocation, when the saved anchor was re-placed. */
export type PlacedTower = WipeTowerFootprintResult & { relocation?: Relocation };

/** printable_area's bounding box size (the plate size estimate_wipe_tower_polygon clamps against). */
export function plateSize(cfg: FlatConfig): [number, number] | null {
  const pts: P2[] = asList(cfg.printable_area).map((s) => s.split('x').map(Number) as P2).filter((p) => p.length === 2 && p.every(Number.isFinite));
  if (pts.length < 3) return null;
  const b = boundsOf(pts);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1]];
}

/** PartPlate::wipe_tower_obstacles over a slice job: every printing object's outline grown by its brim and 1 mm. */
export function towerObstacles(job: Pick<SliceJob, 'config' | 'objects'>): Poly[] {
  const out: Poly[] = [];
  for (const o of job.objects) {
    const hull = meshHull2d(o.positions, o.transform);
    if (hull.length < 3) continue;
    const opt = (k: string) => valueAt(o.config?.[k] ?? job.config[k], 0);
    const brim = opt('brim_type') !== undefined && opt('brim_type') !== 'no_brim' ? toNumber(opt('brim_width'), 0) : 0;
    out.push(towerObstacle(hull, brim));
  }
  return out;
}

/** The job config with the plate's anchor at index 0 (what the engine reads). */
export function withTowerAnchor(cfg: FlatConfig, x: number, y: number): FlatConfig {
  return { ...cfg, wipe_tower_x: [String(round(x))], wipe_tower_y: [String(round(y))] };
}

/** A project-config anchor list with plate `plate` set (earlier plates without one take this value). */
export function setAnchor(list: readonly string[], plate: number, v: number): string[] {
  const next = list.slice();
  while (next.length <= plate) next.push(next[next.length - 1] ?? String(round(v)));
  next[plate] = String(round(v));
  return next;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

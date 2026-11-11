/**
 * Orca 2.5 belt printers' purge prism (GUI/BeltPurgeTower.cpp
 * ensure_belt_purge_tower): instead of the classic prime tower, every plate whose
 * parts use more than one filament gets a "Belt Purge Tower" object along the far
 * lateral edge of the bed, one island per extra filament, sized from the flush
 * volume, the belt angle and the parts' extent along the belt. The prism is a real
 * object (object config `belt_purge_tower_object`), kept in sync by the app:
 * created, resized or removed as the plate and the settings change (not an undo step).
 */
import { watch } from 'vue';
import type { FlatConfig } from '../engine/types';
import { asList, SCALAR, cfgBool, cfgNumber, cfgString, toNumber, valueAt } from '../lib/configValue';
import { paintStatesUsed } from '../lib/paintStates';
import type { MeshData, ProjectObject } from '../project/types';
import { activeEngine, resolvedConfig } from './state';
import { engineCaps } from '../engine/types';
import { getMeshPaint, objectInfo, objects, objectPlate, plates, bed, syncDerivedObjects } from '../project/store';
import { plateOffset } from '../project/plates';
import { expandMixed } from './wipeTower';

export const PRISM_KEY = 'belt_purge_tower_object';
export const PRISM_NAME = 'Belt Purge Tower';
/** The object settings desktop gives the prism. */
export const PRISM_OVERRIDES: Record<string, string> = {
  [PRISM_KEY]: '1', flush_into_objects: '1', extruder: '1', wall_loops: '1', top_shell_layers: '0', bottom_shell_layers: '0',
  sparse_infill_density: '100%', sparse_infill_pattern: 'rectilinear', enable_support: '0', brim_type: 'no_brim',
  seam_slope_type: 'none', precise_z_height: '0',
};

export const isPrism = (o: Pick<ProjectObject, 'overrides'>) => valueAt(o.overrides[PRISM_KEY], SCALAR) === '1';

export interface PlateParts {
  /** Filaments the plate's parts print with (1-based; object / part extruders and colour paint). */
  filaments: number[];
  /** World box of the parts on the plate, or null when it has none. */
  box: { min: [number, number, number]; max: [number, number, number] } | null;
  /** The plate's world origin (its grid offset). */
  origin: [number, number];
}

export interface PrismPlan {
  /** Quantised inputs (desktop's BeltPurgeSignature): an unchanged key keeps the prism. */
  key: string;
  islands: number;
  /** Island width across the belt, length along it, height. */
  wSub: number;
  length: number;
  height: number;
  /** The belt runs along Y (else X). */
  beltIsY: boolean;
  /** World centre of the prism footprint. */
  center: [number, number];
}

const GAP = 1, INSET = 1, MARGIN = 5;

/** The plan for one plate, null when it gets no prism. */
export function planPrism(cfg: FlatConfig, plate: PlateParts, flush: number[][] | null): PrismPlan | null {
  const belt = cfgBool(cfg, 'belt_printer', SCALAR, false);
  const enabled = cfgBool(cfg, 'enable_belt_purge_tower', SCALAR, false);
  const byObject = cfgString(cfg, 'print_sequence', SCALAR, '') === 'by object';
  const filaments = [...new Set(plate.filaments.flatMap((f) => expandMixed(cfg, f)))].sort((a, b) => a - b);
  if (!belt || !enabled || byObject || !plate.box || filaments.length <= 1) return null;
  const rot = cfgString(cfg, 'belt_slice_rotation', SCALAR, 'x').toLowerCase();
  const beltIsY = rot !== 'y';
  const angle = cfgNumber(cfg, 'belt_slice_rotation_angle', SCALAR, 0);
  let theta = Math.PI / 2;
  if ((rot === 'x' || rot === 'y') && Math.abs(angle) > 1e-6) theta = Math.min(Math.PI / 2, Math.max((5 * Math.PI) / 180, (Math.abs(angle) * Math.PI) / 180));
  const sinT = Math.sin(theta), cotT = Math.cos(theta) / sinT;
  const layerH = cfgNumber(cfg, 'layer_height', SCALAR, 0.2);
  const useMatrix = cfgBool(cfg, 'purge_in_prime_tower', SCALAR, true) && cfgBool(cfg, 'single_extruder_multi_material', SCALAR, true);
  const primeVolume = cfgNumber(cfg, 'prime_volume', SCALAR, 45);
  const printableHeight = cfgNumber(cfg, 'printable_height', SCALAR, 250);

  const n = Math.max(1, filaments.length - 1);
  const minWidth = n + (n - 1) * GAP;
  const width = Math.max(minWidth, cfgNumber(cfg, 'belt_purge_tower_width', SCALAR, 35));
  const printableWidth = width - (n - 1) * GAP;
  const { min, max } = plate.box;
  const beltMin = beltIsY ? min[1] : min[0], beltMax = beltIsY ? max[1] : max[0];
  const latMin = beltIsY ? min[0] : min[1], latMax = beltIsY ? max[0] : max[1];
  const zMax = max[2];

  let maxFlush = primeVolume;
  if (useMatrix && flush) {
    let m = 0;
    for (const i of filaments) for (const j of filaments) if (i !== j) m = Math.max(m, flush[i - 1]?.[j - 1] ?? 0);
    if (m > 0) maxFlush = m * toNumber(asList(cfg.flush_multiplier)[0], 1);
  }
  const vLayer = (filaments.length - 1) * maxFlush;
  let height = (1.6 * vLayer * sinT) / (printableWidth * layerH * 0.85);
  height = Math.min(Math.max(height, 8), Math.max(8, printableHeight));

  const pts = asList(cfg.printable_area).map((s) => s.split('x').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
  const bedMax = pts.length ? [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] : null;
  const q = (v: number) => Math.round(v * 10);
  const key = [filaments.length, q(width), q(layerH), q(height), q(beltMin), q(beltMax), q(latMin), q(zMax), rot, Math.round(theta * 1e4), q(latMax),
    q(plate.origin[0]), q(plate.origin[1]), bedMax ? q(bedMax[0]) : '', bedMax ? q(bedMax[1]) : ''].join('|');

  const ramp = height / sinT;
  const beltOrigin = plate.origin[beltIsY ? 1 : 0];
  let beltEnd = beltMax + MARGIN + ramp + zMax * cotT;
  if (bedMax) beltEnd = Math.min(beltEnd, beltOrigin + (beltIsY ? bedMax[1] : bedMax[0]) - INSET);
  const beltStart = Math.max(beltOrigin, Math.min(beltMin - ramp, beltEnd - 10));
  const length = Math.max(beltEnd - beltStart, 10);
  const beltCenter = beltStart + length / 2;
  const latOrigin = plate.origin[beltIsY ? 0 : 1];
  const latCenter = bedMax ? latOrigin + (beltIsY ? bedMax[0] : bedMax[1]) - INSET - width / 2 : latMax + 5 + width / 2;
  return {
    key, islands: n, wSub: (width - (n - 1) * GAP) / n, length, height, beltIsY,
    center: beltIsY ? [latCenter, beltCenter] : [beltCenter, latCenter],
  };
}

/** The prism mesh: one box per island, side by side across the belt, corner at the origin. */
export function prismMesh(p: PrismPlan): { positions: Float32Array; indices: Uint32Array; size: [number, number, number] } {
  const pos: number[] = [], idx: number[] = [];
  const F = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  const [bx, by] = p.beltIsY ? [p.wSub, p.length] : [p.length, p.wSub];
  for (let i = 0; i < p.islands; i++) {
    const off = i * (p.wSub + GAP);
    const ox = p.beltIsY ? off : 0, oy = p.beltIsY ? 0 : off;
    const base = pos.length / 3;
    for (const [x, y, z] of [[0, 0, 0], [bx, 0, 0], [bx, by, 0], [0, by, 0], [0, 0, p.height], [bx, 0, p.height], [bx, by, p.height], [0, by, p.height]]) pos.push(ox + x, oy + y, z);
    for (const f of F) idx.push(base + f);
  }
  const span = p.islands * p.wSub + (p.islands - 1) * GAP;
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), size: p.beltIsY ? [span, p.length, p.height] : [p.length, span, p.height] };
}

/** The first extruder's block of flush_volumes_matrix as rows (get_flush_volumes_matrix(values, 0, extruders)). */
export function flushMatrixOf(cfg: FlatConfig): number[][] | null {
  const flat = asList(cfg.flush_volumes_matrix).map((v) => toNumber(v, 0));
  const extruders = Math.max(1, asList(cfg.nozzle_diameter).length);
  const block = Math.floor(flat.length / extruders);
  const n = Math.round(Math.sqrt(block));
  if (n < 1 || n * n !== block) return null;
  return Array.from({ length: n }, (_, i) => flat.slice(i * n, i * n + n));
}

// ---- keeping the project in sync -----------------------------------------------------------

/** The filaments a part prints with: its extruder (else the object's) and its colour paint (ModelVolume::get_extruders). */
function partFilaments(meshId: string, extruder: number, into: Set<number>): void {
  into.add(extruder);
  const color = getMeshPaint(meshId)?.color;
  if (!color?.length) return;
  const states = new Set<number>();
  for (const [, hex] of color) paintStatesUsed(hex, states);
  for (const s of states) if (s > 0) into.add(s);
}

const int = (v: unknown) => Math.trunc(toNumber(valueAt(v as never, SCALAR), 0));

function plateParts(i: number): PlateParts {
  const [ox, oy] = plateOffset(i, plates.value.length, bed.value);
  const fil = new Set<number>();
  let box: PlateParts['box'] = null;
  for (const o of objects.value) {
    if (isPrism(o) || objectPlate.value.get(o.id) !== i || !o.printable) continue;
    const info = objectInfo.value.get(o.id);
    if (!info) continue;
    box = box ? { min: [Math.min(box.min[0], info.min[0]), Math.min(box.min[1], info.min[1]), Math.min(box.min[2], info.min[2])],
      max: [Math.max(box.max[0], info.max[0]), Math.max(box.max[1], info.max[1]), Math.max(box.max[2], info.max[2])] }
      : { min: [...info.min] as [number, number, number], max: [...info.max] as [number, number, number] };
    const objExt = int(o.overrides.extruder) || 1;
    partFilaments(o.meshId, objExt, fil);
    for (const p of o.parts ?? []) if (p.type === 'part') partFilaments(p.meshId, int(p.overrides.extruder) || objExt, fil);
  }
  // Extruder numbers past the project's filaments print with an existing one (the engine clamps them).
  const count = Math.max(1, asList(resolvedConfig.value.filament_colour).length || asList(resolvedConfig.value.filament_diameter).length);
  return { filaments: [...fil].filter((f) => f <= count), box, origin: [ox, oy] };
}

/** Desktop's per-plate signatures (in memory, as m_belt_purge_sigs). */
const sigs = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** One sync pass: add, resize or remove the prisms (exported for tests / e2e). */
export function ensureBeltPurgeTower(): boolean {
  const cfg = resolvedConfig.value;
  const orca = engineCaps(activeEngine.value).orcaConfig;
  const prisms = objects.value.filter(isPrism);
  const byPlate = new Map<number, ProjectObject[]>();
  const stale: string[] = [];
  for (const o of prisms) {
    const p = objectPlate.value.get(o.id) ?? -1;
    if (p < 0 || p >= plates.value.length) stale.push(o.id);
    else byPlate.set(p, [...(byPlate.get(p) ?? []), o]);
  }
  const remove = [...stale];
  const add: Parameters<typeof syncDerivedObjects>[1][number][] = [];
  const flush = flushMatrixOf(cfg);
  for (let i = 0; i < plates.value.length; i++) {
    const existing = byPlate.get(i) ?? [];
    const plan = orca ? planPrism(cfg, plateParts(i), flush) : null;
    if (!plan) { for (const o of existing) { remove.push(o.id); sigs.delete(o.id); } continue; }
    if (existing.length === 1 && sigs.get(existing[0].id) === plan.key) continue;
    for (const o of existing) { remove.push(o.id); sigs.delete(o.id); }
    const m = prismMesh(plan);
    add.push({
      name: PRISM_NAME, positions: m.positions, indices: m.indices, overrides: { ...PRISM_OVERRIDES },
      position: [plan.center[0] - m.size[0] / 2, plan.center[1] - m.size[1] / 2, 0],
    });
    (add[add.length - 1] as { key?: string }).key = plan.key;
  }
  if (!remove.length && !add.length) return false;
  const ids = syncDerivedObjects(remove, add);
  ids.forEach((id, k) => sigs.set(id, (add[k] as { key?: string }).key ?? ''));
  return true;
}

let started = false;
/** Follow the project and the settings (once, from the Prepare viewport). */
export function startBeltPurge(): void {
  if (started) return;
  started = true;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; ensureBeltPurgeTower(); }, 200);
  };
  watch([resolvedConfig, activeEngine, objects, objectPlate, () => plates.value.length], schedule, { deep: true, immediate: true });
}

export type { MeshData };

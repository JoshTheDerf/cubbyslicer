/**
 * A calibration plan: what Orca's Plater::calib_* does to the project,
 * computed without touching it (the planners in `prints/` are pure), then
 * applied by `apply.ts`. Also the belt-printer helpers Orca 2.5 added for the
 * calibration tests (Plater.cpp belt_calib_rotation_params,
 * _calib_apply_belt_mode).
 */
import type { CalibParams, ConfigValue, CustomGcodeItem } from '../engine/types';
import { quatFromAxisAngle, type Quat, type Vec3 } from '../project/math';
import type { Edits } from './edits';

/** Calib_Params as the job carries them (2.5: `nozzleBasedResize`, `vfaLayerHeight`, stored like desktop's Calib_Params). */
export type CalibRequest = CalibParams;

/** Orca's EPSILON. */
export const EPSILON = 1e-4;

export interface Mesh { positions: Float32Array; indices: Uint32Array }

/** cut_horizontal at `z` above the object's bottom; skipped unless `(when ?? z)` is below the object's height. */
export interface PlanCut { z: number; keep: 'lower' | 'upper'; when?: number }

export interface PlanObject {
  name: string;
  /** Staged model path under public/calib; `part` picks one object of a multi-object file (else all are merged). */
  model?: string;
  part?: number;
  /** A literal mesh instead of a model (PA pattern handle cube). */
  mesh?: Mesh;
  cuts?: PlanCut[];
  scale?: Vec3;
  /** Scale X down (never up) so the object fits this width (max volumetric speed test). */
  fitWidth?: number;
  /** Turn 180° about Z first (belt_calib_flip_ringing_tower). */
  turn?: boolean;
  /** Centre XY: offset from plate 0's centre (default 0, 0), or absolute. */
  offset?: [number, number];
  at?: [number, number];
  /** Belt overhang tower: centred on X with its front edge at Y = 0 (designed belt entry). */
  beltEntry?: boolean;
  overrides?: Record<string, ConfigValue>;
}

export interface CalibPlan {
  /** Project name (Orca's new_project title). */
  title: string;
  edits: Edits;
  objects: PlanObject[];
  /** Calib_Params for the engine, or null (flow ratio, belt overhang tower). */
  params: CalibRequest | null;
  /** Plates the layout needs (PA pattern). */
  plates?: number;
  /** Plate 0 custom G-code (belt overhang tower temperature steps). */
  customGcodes?: CustomGcodeItem[];
  /** Information shown to the user once the project is set up (Orca's notifications). */
  notes?: string[];
  /** Belt handling after placing: counter-rotate every object, or lay temperature sections along the belt. */
  belt?: { mode: 'counter-rotate' | 'sections'; tilt: BeltTilt };
}

export interface BedRect { min: [number, number]; max: [number, number] }
export interface PlanContext {
  /** Bed rectangle of plate `i` (bed coordinates). */
  bed(i: number): BedRect;
}

// ---- belt printers -----------------------------------------------------------------------

/** The belt's slice rotation: Orca's signed angle (−deg2rad(belt_slice_rotation_angle)) about X or Y. */
export interface BeltTilt { angle: number; axis: 'x' | 'y' }

export function isBeltPrinter(e: Edits): boolean { return e.first('printer', 'belt_printer') > 0; }

/** belt_calib_rotation_params: null unless a belt printer tilts about X or Y by a real angle. */
export function beltTilt(e: Edits): BeltTilt | null {
  if (!isBeltPrinter(e)) return null;
  const axis = String(e.tab('printer', 'belt_slice_rotation') ?? '').toLowerCase();
  if (axis !== 'x' && axis !== 'y') return null;
  const angle = -(e.first('printer', 'belt_slice_rotation_angle') * Math.PI) / 180;
  return Math.abs(angle) > EPSILON ? { angle, axis } : null;
}

/**
 * _calib_apply_belt_mode's preset side (no skirt: it would print in the first
 * slicing plane, mostly above the belt) and the plan's belt step; undefined
 * unless the printer is a tilted belt.
 */
export function counterRotate(e: Edits): CalibPlan['belt'] {
  const tilt = beltTilt(e);
  if (!tilt) return undefined;
  e.print('skirt_loops', 0);
  return { mode: 'counter-rotate', tilt };
}

/** The rotation that cancels the belt's pre-slice rotation (applied in world space). */
export function cancelRotation(t: BeltTilt): Quat {
  return quatFromAxisAngle(t.axis === 'x' ? [1, 0, 0] : [0, 1, 0], t.angle);
}

/** _calib_apply_belt_mode: manual hybrid tree support builds the wedge under the floating bottom face. */
export const BELT_SUPPORT = {
  enable_support: true, support_type: 'tree(manual)', support_style: 'tree_hybrid', support_on_build_plate_only: false,
  support_base_pattern: 'rectilinear',
} as const;

export interface YSpan { offsetY: number; minY: number; maxY: number }

/**
 * _calib_apply_belt_mode row spacing: objects whose offsets are within 1 mm
 * in Y form a row; rows keep together and move apart so each support wedge
 * (depth × |tan angle|) clears the next row. Returns each item's Y shift.
 */
export function beltRowShifts(items: YSpan[], angle: number): number[] {
  const shifts = items.map(() => 0);
  if (items.length < 2) return shifts;
  const order = items.map((_, i) => i).sort((a, b) => items[a].offsetY - items[b].offsetY);
  const rows: number[][] = [];
  let rowY = NaN;
  for (const i of order) {
    if (!rows.length || items[i].offsetY - rowY > 1) rows.push([]);
    rows[rows.length - 1].push(i);
    rowY = items[i].offsetY;
  }
  const wedge = Math.abs(Math.tan(angle));
  let cursor = NaN;
  for (const row of rows) {
    const rmin = Math.min(...row.map((i) => items[i].minY)), rmax = Math.max(...row.map((i) => items[i].maxY));
    if (Number.isNaN(cursor)) cursor = rmin;
    for (const i of row) shifts[i] = cursor - rmin;
    cursor += (rmax - rmin) * (1 + wedge) + 5;
  }
  return shifts;
}

/**
 * _calib_temp_belt_sectioned spacing: each block starts past the previous
 * block's highest slicing plane (height / tan angle), from Y = 20. Returns
 * each item's Y shift.
 */
export function beltSectionShifts(items: { minY: number; sizeY: number; sizeZ: number }[], angle: number): number[] {
  const cot = 1 / Math.max(0.1, Math.tan(Math.abs(angle)));
  let cursor = 20;
  return items.map((b) => {
    const shift = cursor - b.minY;
    cursor += b.sizeY + b.sizeZ * cot + 5;
    return shift;
  });
}

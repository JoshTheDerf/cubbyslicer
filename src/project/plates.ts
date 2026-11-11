/**
 * Multiple plates, laid out like OrcaSlicer's PartPlateList: plates sit in a
 * grid in world space (row-major, ceil(sqrt(n)) columns, new rows towards -Y)
 * with a gap of 1/5 of the plate size between them. An object belongs to the
 * plate whose area contains the centre of its footprint; objects on no plate
 * are "off-plate" (not sliced, flagged outside). Pure — no Vue/three.
 */
import type { BedShape } from '../app/state';
import type { ConfigValue, CustomGcodeItem } from '../engine/types';
import type { ElementPassthrough } from './types';
import { SCALAR, toBool, valueAt } from '../lib/configValue';

export interface PlateMeta {
  /** '' = "Plate N". */
  name: string;
  /** Locked plates are skipped by "arrange all" / "orient all" (Orca's plate lock). */
  locked: boolean;
  /**
   * Per-plate config overrides (Orca PartPlate::m_config via PlateSettingsDialog:
   * curr_bed_type, print_sequence, spiral_mode, first/other layer filament
   * sequence; 2.5: imex_parallel_mode, imex_head_filament_map, filament_map_mode,
   * filament_map, filament_volume_map). Applied over the resolved config when
   * this plate is sliced.
   */
  config?: Record<string, ConfigValue>;
  /** Colour changes / pauses / custom G-code on the preview's layer slider (Orca CustomGCode::Info per plate). */
  customGcodes?: CustomGcodeItem[];
  /** Plate metadata from an opened 3MF this engine doesn't know, written back verbatim. Immutable. */
  passthrough?: ElementPassthrough;
}

/** Orca LOGICAL_PART_PLATE_GAP. */
export const PLATE_GAP_RATIO = 1 / 5;
export const MAX_PLATES = 36;

export function newPlate(): PlateMeta { return { name: '', locked: false }; }

/** Deep copy of a plate record (undo snapshots, persistence). Empty optional fields are dropped. */
export function clonePlate(p: PlateMeta): PlateMeta {
  const out: PlateMeta = { name: String(p.name ?? ''), locked: !!p.locked };
  if (p.config && Object.keys(p.config).length) {
    out.config = Object.fromEntries(Object.entries(p.config).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  }
  if (p.customGcodes?.length) out.customGcodes = p.customGcodes.map((g) => ({ ...g }));
  if (p.passthrough) out.passthrough = p.passthrough; // immutable, shared
  return out;
}

/**
 * Whether plates may override the bed type: Bambu printers, or printers with
 * `support_multi_bed_types` (Orca 2.5 Plater::normalize_bed_types).
 */
export function platesMayOverrideBedType(printer: { vendor?: string; config: Record<string, ConfigValue | undefined> }): boolean {
  if (printer.vendor === 'BBL') return true;
  return toBool(valueAt(printer.config.support_multi_bed_types, SCALAR));
}

/**
 * Drop per-plate bed types on a printer that has a single bed type (Orca
 * resets them to the global one and says so). Returns the new list, and
 * whether anything was reset.
 */
export function resetPlateBedTypes(list: PlateMeta[]): { plates: PlateMeta[]; reset: boolean } {
  let reset = false;
  const plates = list.map((p) => {
    if (!p.config || !('curr_bed_type' in p.config)) return p;
    reset = true;
    const { curr_bed_type: _, ...rest } = p.config;
    const out = { ...p };
    if (Object.keys(rest).length) out.config = rest; else delete out.config;
    return out;
  });
  return { plates, reset };
}

export function plateLabel(p: PlateMeta | undefined, i: number): string {
  return p?.name.trim() || `Plate ${i + 1}`;
}

export function plateCols(n: number): number { return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n)))); }

/** World-space offset of plate `i` (of `n`) relative to the printer's bed coordinates. */
export function plateOffset(i: number, n: number, bed: BedShape): [number, number] {
  const cols = plateCols(n);
  const w = bed.max[0] - bed.min[0], h = bed.max[1] - bed.min[1];
  const col = i % cols, row = Math.floor(i / cols);
  return [col * w * (1 + PLATE_GAP_RATIO), row ? -row * h * (1 + PLATE_GAP_RATIO) : 0];
}

/** The bed shape of plate `i`, translated into world space. */
export function plateBed(bed: BedShape, i: number, n: number): BedShape {
  const [dx, dy] = plateOffset(i, n, bed);
  if (dx === 0 && dy === 0) return bed;
  const t = (p: [number, number]): [number, number] => [p[0] + dx, p[1] + dy];
  return {
    ...bed,
    polygon: bed.polygon.map(t),
    min: t(bed.min),
    max: t(bed.max),
    excludeAreas: bed.excludeAreas.map((a) => a.map(t)),
  };
}

/** Index of the plate whose bed rectangle contains (x, y), or -1. */
export function plateIndexAt(x: number, y: number, n: number, bed: BedShape): number {
  for (let i = 0; i < n; i++) {
    const [dx, dy] = plateOffset(i, n, bed);
    if (x >= bed.min[0] + dx && x <= bed.max[0] + dx && y >= bed.min[1] + dy && y <= bed.max[1] + dy) return i;
  }
  return -1;
}

/**
 * Translation that keeps an object on plate `from` (layout of `nFrom`
 * plates) at the same place on plate `to` in a layout of `nTo` plates.
 */
export function plateShift(bed: BedShape, from: number, nFrom: number, to: number, nTo: number): [number, number] {
  const a = plateOffset(from, nFrom, bed), b = plateOffset(to, nTo, bed);
  return [b[0] - a[0], b[1] - a[1]];
}

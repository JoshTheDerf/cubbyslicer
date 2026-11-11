/**
 * Orca 2.5 toolhead collision volumes (`bed_exclude_volumes`,
 * `extruder_bed_exclude_volumes`): `"XxY, XxY, …"` is a full-height polygon,
 * `"ZMIN..ZMAX;XxY, …"` a Z-limited one (either bound may be empty: 0 /
 * printable height), volumes separated by `|` (or newlines). Mirrors
 * PrintConfig.cpp append_bed_exclusion_volume_regions /
 * is_valid_bed_exclude_volumes_string.
 */
import { formatNumber } from '../../presets/values';

export type Pt = [number, number];
export interface CollisionVolume {
  /** null: from the bed (0) / to the printable height. */
  zMin: number | null;
  zMax: number | null;
  points: Pt[];
}

const num = (s: string): number | null => {
  const t = s.trim();
  if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  return Number(t);
};

/** One volume spec, or null when invalid (fewer than 3 points, bad numbers, zero area, empty Z range). */
export function parseVolume(spec: string, printableHeight = Infinity): CollisionVolume | null {
  let zMin: number | null = null, zMax: number | null = null, hasZ = false;
  let pointsField: string | null = null;
  for (const raw of spec.split(';')) {
    let f = raw.trim();
    if (!f) continue;
    const r = f.indexOf('..');
    if (r >= 0 && !f.includes('x')) {
      const a = f.slice(0, r).trim(), b = f.slice(r + 2).trim();
      const lo = a ? num(a) : 0, hi = b ? num(b) : printableHeight;
      if (lo === null || hi === null) return null;
      const cl = (v: number) => Math.min(Math.max(v, 0), printableHeight);
      if (!(cl(lo) < cl(hi))) return null;
      zMin = a ? lo : null; zMax = b ? hi : null; hasZ = true;
      continue;
    }
    f = f.replace(/^(points|polygon)=/i, '');
    pointsField = f;
  }
  if (pointsField === null) return null;
  const points: Pt[] = [];
  for (const tok of pointsField.split(',')) {
    const parts = tok.trim().split('x');
    if (parts.length !== 2) return null;
    const x = num(parts[0]), y = num(parts[1]);
    if (x === null || y === null) return null;
    points.push([x, y]);
  }
  if (points.length < 3) return null;
  let area = 0;
  for (let i = 0; i < points.length; i++) { const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length]; area += x1 * y2 - x2 * y1; }
  if (area === 0) return null;
  return { zMin: hasZ ? zMin : null, zMax: hasZ ? zMax : null, points };
}

/** All volumes of a value; `bad` counts specs that don't parse. */
export function parseVolumes(value: string, printableHeight = Infinity): { volumes: CollisionVolume[]; bad: number } {
  const volumes: CollisionVolume[] = [];
  let bad = 0;
  for (const spec of value.split(/[|\n]/)) {
    if (!spec.trim()) continue;
    const v = parseVolume(spec, printableHeight);
    if (v) volumes.push(v); else bad++;
  }
  return { volumes, bad };
}

export function serializeVolume(v: CollisionVolume): string {
  const pts = v.points.map(([x, y]) => `${formatNumber(x)}x${formatNumber(y)}`).join(',');
  if (v.zMin === null && v.zMax === null) return pts;
  return `${v.zMin === null ? '' : formatNumber(v.zMin)}..${v.zMax === null ? '' : formatNumber(v.zMax)};${pts}`;
}

export const serializeVolumes = (vs: CollisionVolume[]): string => vs.map(serializeVolume).join('|');

/** Axis-aligned box volume (the common toolhead shape). */
export function boxVolume(x0: number, y0: number, x1: number, y1: number, zMin: number | null = null, zMax: number | null = null): CollisionVolume {
  return { zMin, zMax, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
}

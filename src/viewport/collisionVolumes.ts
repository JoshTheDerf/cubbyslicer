/**
 * Orca 2.5 toolhead collision volumes (`bed_exclude_volumes`,
 * `bed_exclude_volume_mode`, `extruder_bed_exclude_volumes`): parsing and the
 * Prepare / Preview drawing. The settings editor owns editing; the engine owns
 * the checks (arrange, G-code). Ports of PrintConfig.cpp
 * `append_bed_exclusion_volume_regions`, `parse_z_range_token`,
 * `resolve_bed_excluded_regions` and PartPlate.cpp
 * `update_exclusion_volume_previews`.
 *
 * Syntax: `XxY, XxY, …` (full height) or `ZMIN..ZMAX;XxY, …` (either bound may
 * be empty), volumes separated by `|` or newlines; a points field may carry a
 * `points=` / `polygon=` prefix.
 */
import {
  BufferGeometry, DoubleSide, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial,
  Shape, ShapeGeometry, Vector2, type Color,
} from 'three';
import type { FlatConfig } from '../engine/types';
import { SCALAR, asList, cfgNumber, cfgString } from '../lib/configValue';

type P = [number, number];

export interface CollisionVolume {
  /** Counter-clockwise footprint (mm, bed coordinates). */
  polygon: P[];
  zMin: number;
  zMax: number;
  /** The definition gave a Z range (otherwise 0 … printable height). */
  hasZRange: boolean;
  /** 0-based extruder the volume belongs to (always 0 in shared mode). */
  extruder: number;
}

export type CollisionVolumeMode = 'shared' | 'toolhead_offset' | 'per_extruder';

const num = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

function signedArea(poly: P[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

function parsePolygon(field: string): P[] | null {
  const pts: P[] = [];
  for (const tok of field.split(',')) {
    const t = tok.trim();
    const k = t.indexOf('x');
    if (k < 0 || t.indexOf('x', k + 1) >= 0) return null;
    const x = num(t.slice(0, k)), y = num(t.slice(k + 1));
    if (x === null || y === null) return null;
    pts.push([x, y]);
  }
  if (pts.length < 3) return null;
  const a = signedArea(pts);
  if (a === 0) return null;
  return a < 0 ? pts.reverse() : pts;
}

/** Parse one definition string (the shared one, or one extruder's). Invalid volumes are skipped, like Orca. */
export function parseCollisionVolumes(spec: string, printableHeight: number, extruder = 0): CollisionVolume[] {
  const height = Math.max(0, printableHeight);
  const out: CollisionVolume[] = [];
  for (const raw of spec.split(/[|\n]/)) {
    const s = raw.trim();
    if (!s) continue;
    let zMin = 0, zMax = height, hasZRange = false, points = '', invalid = false;
    for (const f0 of s.split(';')) {
      let f = f0.trim();
      if (!f) continue;
      const r = f.indexOf('..');
      if (r >= 0 && !f.includes('x')) {
        const lo = f.slice(0, r).trim(), hi = f.slice(r + 2).trim();
        const a = lo ? num(lo) : 0, b = hi ? num(hi) : height;
        if (a === null || b === null) { invalid = true; break; }
        zMin = Math.min(Math.max(a, 0), height);
        zMax = Math.min(Math.max(b, 0), height);
        if (!(zMin < zMax)) { invalid = true; break; }
        hasZRange = true;
        continue;
      }
      if (/^points=/i.test(f)) f = f.slice(7);
      else if (/^polygon=/i.test(f)) f = f.slice(8);
      points = f;
    }
    if (invalid || !(zMin < zMax)) continue;
    const polygon = parsePolygon(points);
    if (polygon) out.push({ polygon, zMin, zMax, hasZRange, extruder });
  }
  return out;
}

const hasText = (s: string | undefined) => !!s && /\S/.test(s);

/** The engine's `bed_exclude_volume_mode` (falls back to shared). */
export function collisionVolumeMode(cfg: FlatConfig): CollisionVolumeMode {
  const m = cfgString(cfg, 'bed_exclude_volume_mode', SCALAR, 'shared');
  return m === 'toolhead_offset' || m === 'per_extruder' ? m : 'shared';
}

/**
 * Every collision volume the printer defines, resolved per extruder the way
 * Orca's preview shows them (`get_bed_excluded_regions_by_extruder`): shared →
 * one set; toolhead-relative → the shared set moved by each nozzle's
 * `extruder_offset` relative to `master_extruder_id`; individual → each
 * extruder's own set.
 */
export function collisionVolumesFromConfig(cfg: FlatConfig): CollisionVolume[] {
  const height = cfgNumber(cfg, 'printable_height', SCALAR, 0);
  const shared = cfgString(cfg, 'bed_exclude_volumes', SCALAR, '');
  const perExtruder = cfg.extruder_bed_exclude_volumes === undefined ? [] : asList(cfg.extruder_bed_exclude_volumes);
  const mode = collisionVolumeMode(cfg);
  if (mode === 'per_extruder') {
    return perExtruder.flatMap((s, e) => (hasText(s) ? parseCollisionVolumes(s, height, e) : []));
  }
  if (!hasText(shared)) return [];
  const base = parseCollisionVolumes(shared, height);
  if (mode === 'shared') return base;
  const offsets = asList(cfg.extruder_offset, { serialized: true }).map((t): P => {
    const m = /^\s*(-?[\d.]+)\s*x\s*(-?[\d.]+)\s*$/i.exec(t);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  });
  if (offsets.length < 2) return base;
  const ref = offsets[Math.min(Math.max(0, cfgNumber(cfg, 'master_extruder_id', SCALAR, 1) - 1), offsets.length - 1)];
  return offsets.flatMap(([ox, oy], e) => base.map((v) => ({
    ...v, extruder: e, polygon: v.polygon.map(([x, y]): P => [x + ox - ref[0], y + oy - ref[1]]),
  })));
}

/** XY bounds of a footprint. */
export function footprintBounds(poly: readonly P[]): { min: P; max: P } {
  const min: P = [Infinity, Infinity], max: P = [-Infinity, -Infinity];
  for (const [x, y] of poly) {
    if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y;
    if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y;
  }
  return { min, max };
}

export interface CollisionDrawOptions {
  /** Draw every prism at full height (Orca View > "Show all collision volumes"). */
  showAll: boolean;
  /**
   * Otherwise each prism is drawn up to this height (Orca: the tallest
   * object whose footprint meets a volume); 0 draws only the bed marks.
   */
  heightFor(v: CollisionVolume): number;
  /** Border colour per extruder (individual / toolhead-relative modes); default the theme colour. */
  extruderColor?(extruder: number): Color | null;
}

/**
 * Bed marks and prisms for a plate (bed coordinates; add `offset` for other
 * plates): a filled footprint for volumes that start on the bed, a ribbon for
 * raised ones, and translucent prisms with edges where objects come near
 * (or everywhere with `showAll`).
 */
export function buildCollisionVolumes(vols: readonly CollisionVolume[], color: Color, opts: CollisionDrawOptions): Group {
  const g = new Group();
  g.name = 'collision-volumes';
  for (const v of vols) {
    const shape = new Shape(v.polygon.map(([x, y]) => new Vector2(x, y)));
    const edge = opts.extruderColor?.(v.extruder) ?? color;
    const raised = v.hasZRange && v.zMin > 1e-6;
    // Bed mark: footprint fill, or a ribbon (outline) under a raised volume.
    if (!raised) {
      const floor = new Mesh(new ShapeGeometry(shape), new MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, side: DoubleSide }));
      floor.position.z = 0.012;
      floor.name = 'collision-floor';
      g.add(floor);
    }
    g.add(outline(v.polygon, 0.02, edge, raised ? 0.95 : 0.7, 'collision-border'));
    const top = opts.showAll ? v.zMax : Math.min(v.zMax, opts.heightFor(v));
    if (top > v.zMin + 1e-6) g.add(prism(v.polygon, v.zMin, top, color, edge));
  }
  return g;
}

function outline(poly: readonly P[], z: number, color: Color, opacity: number, name: string): LineSegments {
  const pts: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) pts.push(poly[j][0], poly[j][1], z, poly[i][0], poly[i][1], z);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pts, 3));
  const l = new LineSegments(geo, new LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  l.name = name;
  return l;
}

function prism(poly: readonly P[], z0: number, z1: number, color: Color, edge: Color): Group {
  const g = new Group();
  g.name = 'collision-prism';
  const n = poly.length;
  const pos: number[] = [];
  // Side walls
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    pos.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
  }
  const walls = new BufferGeometry();
  walls.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide });
  g.add(new Mesh(walls, mat));
  // Caps
  const shape = new Shape(poly.map(([x, y]) => new Vector2(x, y)));
  for (const z of [z0, z1]) {
    const cap = new Mesh(new ShapeGeometry(shape), mat.clone());
    cap.position.z = z;
    g.add(cap);
  }
  // Edges: top / bottom loops and the verticals.
  const e: number[] = [];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    for (const z of [z0, z1]) e.push(poly[j][0], poly[j][1], z, poly[i][0], poly[i][1], z);
    e.push(poly[i][0], poly[i][1], z0, poly[i][0], poly[i][1], z1);
  }
  const eg = new BufferGeometry();
  eg.setAttribute('position', new Float32BufferAttribute(e, 3));
  g.add(new LineSegments(eg, new LineBasicMaterial({ color: edge, transparent: true, opacity: 0.85, depthWrite: false })));
  g.renderOrder = 2;
  return g;
}

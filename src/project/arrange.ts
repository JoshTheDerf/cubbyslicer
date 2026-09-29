/**
 * Auto-arrange: greedy bottom-left packing of XY footprint rectangles
 * (AABB of each object's convex hull) inside the bed polygon, avoiding
 * exclude areas and fixed obstacles, then centring the packed group on the
 * bed when that keeps everything valid. Pure — no Vue/three.
 */
import type { BedShape } from '../app/state';
import { pointInPolygon, polygonsOverlap, type Pt } from './math';

export interface Rect { minX: number; minY: number; maxX: number; maxY: number }

export interface ArrangeItem extends Rect { id: string }

export interface ArrangeResult {
  /** Translation to apply to each placed item. */
  moves: Map<string, [number, number]>;
  /** Items that did not fit (moved off-bed, to the right of the plate). */
  unplaced: string[];
}

export interface ArrangeOptions {
  spacing?: number;
  /** Footprints that stay where they are (other objects) — new items avoid them. */
  obstacles?: Rect[];
  /** Try to centre the packed group on the bed (default true). */
  center?: boolean;
  /**
   * Candidate order: 'bottom-left' packs tightly (full arrange);
   * 'nearest-center' puts each item in the free spot closest to the bed
   * centre (placing newly added objects next to existing ones).
   */
  strategy?: 'bottom-left' | 'nearest-center';
}

const rectPoly = (r: Rect): Pt[] => [[r.minX, r.minY], [r.maxX, r.minY], [r.maxX, r.maxY], [r.minX, r.maxY]];

function rectsOverlap(a: Rect, b: Rect, gap: number): boolean {
  return a.minX < b.maxX + gap - 1e-9 && b.minX < a.maxX + gap - 1e-9 && a.minY < b.maxY + gap - 1e-9 && b.minY < a.maxY + gap - 1e-9;
}

function insideBed(r: Rect, bed: BedShape): boolean {
  const w = r.maxX - r.minX, h = r.maxY - r.minY;
  // Corners + edge midpoints (enough for convex and mildly concave beds).
  const pts: Pt[] = [
    [r.minX, r.minY], [r.maxX, r.minY], [r.maxX, r.maxY], [r.minX, r.maxY],
    [r.minX + w / 2, r.minY], [r.maxX, r.minY + h / 2], [r.minX + w / 2, r.maxY], [r.minX, r.minY + h / 2],
  ];
  for (const p of pts) if (!pointInPolygon(p, bed.polygon, 1e-6)) return false;
  for (const ex of bed.excludeAreas) if (polygonsOverlap(rectPoly(r), ex)) return false;
  return true;
}

export function arrange(items: ArrangeItem[], bed: BedShape, opts: ArrangeOptions = {}): ArrangeResult {
  const spacing = opts.spacing ?? 6;
  const obstacles = opts.obstacles ?? [];
  const placed: Rect[] = [];
  const placedIds: Array<{ id: string; r: Rect; orig: Rect }> = [];
  const unplaced: string[] = [];
  const bw = bed.max[0] - bed.min[0], bh = bed.max[1] - bed.min[1];
  const step = Math.max(2, Math.min(bw, bh) / 60);

  const order = items.slice().sort((a, b) => {
    const ea = Math.max(a.maxX - a.minX, a.maxY - a.minY), eb = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    return eb - ea || (b.maxX - b.minX) * (b.maxY - b.minY) - (a.maxX - a.minX) * (a.maxY - a.minY);
  });

  const fits = (r: Rect) => {
    for (const p of placed) if (rectsOverlap(r, p, spacing)) return false;
    for (const o of obstacles) if (rectsOverlap(r, o, spacing)) return false;
    return insideBed(r, bed);
  };

  for (const it of order) {
    const w = it.maxX - it.minX, h = it.maxY - it.minY;
    if (w > bw + 1e-6 || h > bh + 1e-6) { unplaced.push(it.id); continue; }
    const xs = new Set<number>([bed.min[0]]);
    const ys = new Set<number>([bed.min[1]]);
    for (const p of [...placed, ...obstacles]) { xs.add(p.maxX + spacing); ys.add(p.maxY + spacing); xs.add(p.minX - spacing - w); ys.add(p.minY - spacing - h); }
    for (let x = bed.min[0]; x <= bed.max[0] - w + 1e-9; x += step) xs.add(x);
    for (let y = bed.min[1]; y <= bed.max[1] - h + 1e-9; y += step) ys.add(y);
    const sx = [...xs].filter((x) => x >= bed.min[0] - 1e-9 && x + w <= bed.max[0] + 1e-9).sort((a, b) => a - b);
    const sy = [...ys].filter((y) => y >= bed.min[1] - 1e-9 && y + h <= bed.max[1] + 1e-9).sort((a, b) => a - b);
    let found: Rect | null = null;
    if (opts.strategy === 'nearest-center') {
      const bcx = (bed.min[0] + bed.max[0]) / 2 - w / 2, bcy = (bed.min[1] + bed.max[1]) / 2 - h / 2;
      sx.push(bcx); sy.push(bcy);
      const cands: Array<[number, number, number]> = [];
      for (const y of sy) for (const x of sx) cands.push([x, y, (x - bcx) ** 2 + (y - bcy) ** 2]);
      cands.sort((a, b) => a[2] - b[2]);
      for (const [x, y] of cands) {
        const r = { minX: x, minY: y, maxX: x + w, maxY: y + h };
        if (fits(r)) { found = r; break; }
      }
    } else {
      outer: for (const y of sy) {
        for (const x of sx) {
          const r = { minX: x, minY: y, maxX: x + w, maxY: y + h };
          if (fits(r)) { found = r; break outer; }
        }
      }
    }
    if (!found) { unplaced.push(it.id); continue; }
    placed.push(found);
    placedIds.push({ id: it.id, r: found, orig: it });
  }

  // Centre the group on the bed if possible (bisect toward bottom-left if not).
  if ((opts.center ?? true) && placed.length) {
    let gminX = Infinity, gminY = Infinity, gmaxX = -Infinity, gmaxY = -Infinity;
    for (const r of placed) {
      gminX = Math.min(gminX, r.minX); gminY = Math.min(gminY, r.minY);
      gmaxX = Math.max(gmaxX, r.maxX); gmaxY = Math.max(gmaxY, r.maxY);
    }
    const cx = (bed.min[0] + bed.max[0]) / 2 - (gminX + gmaxX) / 2;
    const cy = (bed.min[1] + bed.max[1]) / 2 - (gminY + gmaxY) / 2;
    const valid = (dx: number, dy: number) => placed.every((r) => {
      const s = { minX: r.minX + dx, minY: r.minY + dy, maxX: r.maxX + dx, maxY: r.maxY + dy };
      if (!insideBed(s, bed)) return false;
      return obstacles.every((o) => !rectsOverlap(s, o, spacing));
    });
    for (const f of [1, 0.75, 0.5, 0.25]) {
      if (valid(cx * f, cy * f)) {
        for (const p of placedIds) { p.r = { minX: p.r.minX + cx * f, minY: p.r.minY + cy * f, maxX: p.r.maxX + cx * f, maxY: p.r.maxY + cy * f }; }
        break;
      }
    }
  }

  const moves = new Map<string, [number, number]>();
  for (const p of placedIds) moves.set(p.id, [p.r.minX - p.orig.minX, p.r.minY - p.orig.minY]);
  // Park the unplaced ones in a column right of the bed so they're visible and flagged.
  let py = bed.min[1];
  for (const id of unplaced) {
    const it = items.find((i) => i.id === id)!;
    const x = bed.max[0] + spacing * 2;
    moves.set(id, [x - it.minX, py - it.minY]);
    py += it.maxY - it.minY + spacing;
  }
  return { moves, unplaced };
}

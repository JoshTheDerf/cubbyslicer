/**
 * Orca BedShape (BedShapeDialog.cpp / libslic3r BedShape): rectangular
 * (size + origin), circular (diameter, origin at the centre) or custom
 * polygon. Origin follows Orca: the position of X0 Y0 measured from the
 * bed's front-left corner, i.e. the rectangle starts at (−origin).
 */
import { parsePoint, serializePoint } from '../../presets/values';

export type Pt = [number, number];
export type BedType = 'rect' | 'circle' | 'custom';

export interface BedModel {
  type: BedType;
  rect: { width: number; depth: number; originX: number; originY: number };
  circle: { diameter: number };
  custom: Pt[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function parseBed(points: string[]): BedModel {
  const pts = points.map((p) => parsePoint(p)).filter((p): p is Pt => !!p);
  const model: BedModel = { type: 'rect', rect: { width: 220, depth: 220, originX: 0, originY: 0 }, circle: { diameter: 200 }, custom: pts };
  if (pts.length === 4) {
    const xs = [...new Set(pts.map((p) => p[0]))], ys = [...new Set(pts.map((p) => p[1]))];
    if (xs.length === 2 && ys.length === 2) {
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      model.rect = { width: round(Math.max(...xs) - x0), depth: round(Math.max(...ys) - y0), originX: round(-x0), originY: round(-y0) };
      return model;
    }
  }
  if (pts.length >= 16) {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const r = pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
    const avg = r.reduce((a, b) => a + b, 0) / r.length;
    if (Math.abs(cx) < avg * 0.01 && Math.abs(cy) < avg * 0.01 && r.every((x) => Math.abs(x - avg) < avg * 0.01)) {
      model.type = 'circle';
      model.circle = { diameter: round(avg * 2) };
      return model;
    }
  }
  if (pts.length >= 3) model.type = 'custom';
  return model;
}

export function bedPoints(m: BedModel): Pt[] {
  if (m.type === 'rect') {
    const { width: w, depth: d, originX: ox, originY: oy } = m.rect;
    return [[-ox, -oy], [w - ox, -oy], [w - ox, d - oy], [-ox, d - oy]].map(([x, y]) => [round(x), round(y)] as Pt);
  }
  if (m.type === 'circle') {
    // Orca BedShape::get_circle: 1 point per degree … we use 64 segments like PrusaSlicer's preview.
    const n = 72, r = m.circle.diameter / 2;
    return Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [round(r * Math.cos(a)), round(r * Math.sin(a))] as Pt; });
  }
  return m.custom;
}

export function serializeBed(pts: Pt[]): string[] { return pts.map(serializePoint); }

/** Parse the custom-shape text area ("XxY" per line, or comma separated). */
export function parseCustomText(text: string): { pts: Pt[]; bad: boolean } {
  const toks = text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  const pts = toks.map((s) => parsePoint(s)).filter((p): p is Pt => !!p);
  return { pts, bad: pts.length !== toks.length };
}

/** 2D convex hull (monotone chain) of mesh vertices projected on XY — Orca's "Load shape from STL". */
export function convexHullXY(positions: Float32Array | number[]): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) pts.push([positions[i], positions[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map(([x, y]) => [round(x), round(y)] as Pt);
}

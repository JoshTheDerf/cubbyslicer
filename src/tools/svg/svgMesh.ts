/**
 * SVG → extruded mesh (Orca GLGizmoSVG: fills and strokes of the SVG become
 * the emboss shape). Parsing uses three's SVGLoader (browser DOMParser);
 * fills honour the SVG fill rule via SVGLoader.createShapes, strokes are
 * outlined with SVGLoader.pointsToStroke and traced back into contours.
 *
 * Output is mesh-local mm: XY plane (+Y up), centred, z = 0 … depth, scaled
 * so the drawing is `width` mm wide.
 */
import type { ShapePath } from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import type { SvgEmboss } from '../../project/types';
import { centerXY, cleanContour, extrudeRegions, regionsFromContours, signedArea, type Contour, type MeshArrays, type Region } from '../geom/extrude';
import { weldVertices } from '../../project/mesh';

export const MAX_SVG_BYTES = 1024 * 1024;

export interface SvgOutline { regions: Region[]; strokeContours: Contour[]; width: number; height: number; warnings: string[] }

const DIVISIONS = 12;

interface SvgPathLike { shapePath: ShapePath; fill: boolean; stroke: boolean; style: Record<string, unknown> }

function isPainted(v: unknown): boolean {
  return typeof v === 'string' ? v !== 'none' && v !== 'transparent' : v !== undefined && v !== null;
}

/** Parsed SVG (three SVGLoader output) → outlines in SVG units, y flipped up. */
export function outlineFromPaths(paths: SvgPathLike[]): SvgOutline {
  const regions: Region[] = [];
  const strokes: Contour[] = [];
  const warnings: string[] = [];
  for (const p of paths) {
    if (p.fill) {
      for (const shape of SVGLoader.createShapes(p.shapePath)) {
        const e = shape.extractPoints(DIVISIONS);
        const outer = cleanContour(e.shape.map((v) => [v.x, -v.y] as [number, number]));
        if (!outer) continue;
        const holes = e.holes.map((h) => cleanContour(h.map((v) => [v.x, -v.y] as [number, number]))).filter((h): h is Contour => !!h);
        regions.push({
          outer: signedArea(outer) > 0 ? outer : outer.slice().reverse(),
          holes: holes.map((h) => (signedArea(h) < 0 ? h : h.slice().reverse())),
        });
      }
    }
    if (p.stroke) {
      for (const sub of p.shapePath.subPaths) {
        const pts = sub.getPoints(DIVISIONS);
        const geo = SVGLoader.pointsToStroke(pts, p.style as never, DIVISIONS, 0.001);
        if (!geo) continue;
        // Stroke geometry is in SVG coordinates (y down): flip like the fills.
        strokes.push(...strokeOutline(geo.getAttribute('position').array as Float32Array).map((c) => c.map(([x, y]) => [x, -y] as [number, number])));
        geo.dispose();
      }
    }
  }
  const all = [...regions.flatMap((r) => [r.outer, ...r.holes]), ...strokes];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of all) for (const [x, y] of c) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (!all.length) warnings.push('The SVG has no filled or stroked shapes.');
  return { regions, strokeContours: strokes, width: all.length ? x1 - x0 : 0, height: all.length ? y1 - y0 : 0, warnings };
}

/** Boundary loops of a 2D triangle soup (the outline of a stroke). */
export function strokeOutline(soup: ArrayLike<number>): Contour[] {
  const pos = new Float32Array(soup.length);
  pos.set(soup as Float32Array);
  // Stroke vertices are xy0; weld and walk the edges used by exactly one triangle.
  const w = weldVertices(pos, null, 1e-4);
  const count = new Map<string, number>();
  const idx = w.indices;
  // Orient every triangle CCW so boundary edges chain consistently.
  const tri: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ax = w.positions[a * 3], ay = w.positions[a * 3 + 1];
    const cross = (w.positions[b * 3] - ax) * (w.positions[c * 3 + 1] - ay) - (w.positions[b * 3 + 1] - ay) * (w.positions[c * 3] - ax);
    if (Math.abs(cross) < 1e-12) continue;
    if (cross > 0) tri.push(a, b, c); else tri.push(a, c, b);
  }
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t < tri.length; t += 3) for (let k = 0; k < 3; k++) { const e = key(tri[t + k], tri[t + (k + 1) % 3]); count.set(e, (count.get(e) ?? 0) + 1); }
  const next = new Map<number, number[]>();
  for (let t = 0; t < tri.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = tri[t + k], b = tri[t + (k + 1) % 3];
      if (count.get(key(a, b)) !== 1) continue;
      const l = next.get(a);
      if (l) l.push(b); else next.set(a, [b]);
    }
  }
  const loops: Contour[] = [];
  for (const start of [...next.keys()]) {
    let l = next.get(start);
    if (!l?.length) continue;
    const loop: Contour = [];
    let v = start;
    for (let guard = 0; guard < 1e6; guard++) {
      loop.push([w.positions[v * 3], w.positions[v * 3 + 1]]);
      l = next.get(v);
      const n = l?.pop();
      if (n === undefined) break;
      v = n;
      if (v === start) break;
    }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

/** Outline → mesh at the requested width / depth. */
export function meshFromOutline(o: SvgOutline, width: number, depth: number): MeshArrays | null {
  if (!(o.width > 0) || !(o.height > 0)) return null;
  const s = width / o.width;
  const scale = (c: Contour): Contour => c.map(([x, y]) => [x * s, y * s]);
  const regions: Region[] = [
    ...o.regions.map((r) => ({ outer: scale(r.outer), holes: r.holes.map(scale) })),
    ...regionsFromContours(o.strokeContours.map(scale)),
  ];
  if (!regions.length) return null;
  const m = extrudeRegions(regions, 0, Math.max(0.05, depth));
  centerXY(m);
  return m;
}

/** Parse SVG source (browser only: uses DOMParser). */
export function parseSvg(source: string): SvgOutline {
  const data = new SVGLoader().parse(source);
  const paths: SvgPathLike[] = data.paths.map((sp) => {
    const style = (sp.userData?.style ?? {}) as Record<string, unknown>;
    return { shapePath: sp, fill: isPainted(style.fill), stroke: isPainted(style.stroke) && Number(style.strokeWidth ?? 1) > 0, style };
  });
  return outlineFromPaths(paths);
}

export function buildSvgMesh(p: SvgEmboss): MeshArrays | null {
  return meshFromOutline(parseSvg(p.svg), p.width, p.depth);
}

export function svgDisplayName(fileName: string): string {
  return fileName.replace(/\.svg$/i, '').slice(0, 60) || 'SVG';
}

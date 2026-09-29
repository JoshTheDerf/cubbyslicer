/**
 * 2D outlines → closed, outward-wound triangle meshes (text / SVG emboss).
 *
 * Contours are closed polylines (no repeated closing point). Nesting decides
 * what is solid: a contour inside an even number of others is an outer
 * boundary, an odd number makes it a hole of its innermost containing outer
 * (the even-odd rule, which is what glyph outlines and most SVG fills need).
 * Winding is normalised (outer CCW, holes CW) before triangulating with
 * earcut (three's ShapeUtils), so side walls and caps face outward.
 */
import { ShapeUtils, Vector2 } from 'three';

export type Contour = Array<[number, number]>;
export interface Region { outer: Contour; holes: Contour[] }
export interface MeshArrays { positions: Float32Array; indices: Uint32Array }

export function signedArea(c: Contour): number {
  let a = 0;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) a += (c[j][0] - c[i][0]) * (c[j][1] + c[i][1]);
  return a / 2; // > 0 = counter-clockwise
}

function pointIn(p: [number, number], c: Contour): boolean {
  let inside = false;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    const [xi, yi] = c[i], [xj, yj] = c[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Drop consecutive duplicates / the closing repeat; returns null for degenerate contours. */
export function cleanContour(c: Contour, eps = 1e-6): Contour | null {
  const out: Contour = [];
  for (const p of c) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) < eps && Math.abs(q[1] - p[1]) < eps) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < eps && Math.abs(out[0][1] - out[out.length - 1][1]) < eps) out.pop();
  if (out.length < 3 || Math.abs(signedArea(out)) < eps * eps) return null;
  return out;
}

/** A representative point strictly inside a contour (for containment tests). */
function probe(c: Contour): [number, number] {
  // Midpoint of the first edge nudged towards the interior.
  const ccw = signedArea(c) > 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) continue;
    const s = Math.min(l * 1e-3, 1e-3);
    const nx = ccw ? -dy / l : dy / l, ny = ccw ? dx / l : -dx / l;
    const p: [number, number] = [(a[0] + b[0]) / 2 + nx * s, (a[1] + b[1]) / 2 + ny * s];
    if (pointIn(p, c)) return p;
  }
  return c[0];
}

/** Group contours into solid regions with the even-odd rule. */
export function regionsFromContours(raw: Contour[]): Region[] {
  const cs = raw.map((c) => cleanContour(c)).filter((c): c is Contour => !!c);
  const probes = cs.map(probe);
  const depth = cs.map((_, i) => cs.reduce((n, c, j) => (j !== i && pointIn(probes[i], c) ? n + 1 : n), 0));
  const areas = cs.map((c) => Math.abs(signedArea(c)));
  const regions: Region[] = [];
  const regionOf = new Map<number, Region>();
  cs.forEach((c, i) => {
    if (depth[i] % 2 !== 0) return;
    const outer = signedArea(c) > 0 ? c : c.slice().reverse();
    const r: Region = { outer, holes: [] };
    regions.push(r);
    regionOf.set(i, r);
  });
  cs.forEach((c, i) => {
    if (depth[i] % 2 === 0) return;
    // Innermost containing outer: depth one less, smallest area containing the probe.
    let best = -1;
    for (let j = 0; j < cs.length; j++) {
      if (depth[j] !== depth[i] - 1 || !pointIn(probes[i], cs[j])) continue;
      if (best < 0 || areas[j] < areas[best]) best = j;
    }
    const r = best >= 0 ? regionOf.get(best) : undefined;
    if (r) r.holes.push(signedArea(c) < 0 ? c : c.slice().reverse());
  });
  return regions;
}

/**
 * Extrude regions from z = z0 to z = z1 (z1 > z0) into one indexed mesh.
 * `skew` shears x by y (synthetic italic): x' = x + skew * y.
 */
export function extrudeRegions(regions: Region[], z0: number, z1: number, skew = 0): MeshArrays {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const r of regions) {
    const loops = [r.outer, ...r.holes];
    const base = pos.length / 3;
    const n = loops.reduce((s, l) => s + l.length, 0);
    // Bottom ring vertices [base, base+n), top ring [base+n, base+2n).
    for (const z of [z0, z1]) for (const l of loops) for (const [x, y] of l) pos.push(x + skew * y, y, z);
    // Caps.
    const tris = ShapeUtils.triangulateShape(r.outer.map(([x, y]) => new Vector2(x, y)), r.holes.map((h) => h.map(([x, y]) => new Vector2(x, y))));
    for (const [a, b, c] of tris) {
      idx.push(base + a, base + c, base + b); // bottom faces down
      idx.push(base + n + a, base + n + b, base + n + c); // top faces up
    }
    // Walls: outer CCW / holes CW → (i, i+1) with the interior on the left; outward normal on the right.
    let off = 0;
    for (const l of loops) {
      for (let i = 0; i < l.length; i++) {
        const a = base + off + i, b = base + off + ((i + 1) % l.length);
        idx.push(a, b, b + n, a, b + n, a + n);
      }
      off += l.length;
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Flatten a quadratic / cubic Bézier into `out` (excluding the start point). */
export function flattenQuad(out: Contour, p0: [number, number], c: [number, number], p1: [number, number], tol: number): void {
  const d = Math.hypot(c[0] - (p0[0] + p1[0]) / 2, c[1] - (p0[1] + p1[1]) / 2);
  const n = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(d / Math.max(tol, 1e-6)))));
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
}

export function flattenCubic(out: Contour, p0: [number, number], c1: [number, number], c2: [number, number], p1: [number, number], tol: number): void {
  const d = Math.max(
    Math.hypot(c1[0] - (2 * p0[0] + p1[0]) / 3, c1[1] - (2 * p0[1] + p1[1]) / 3),
    Math.hypot(c2[0] - (p0[0] + 2 * p1[0]) / 3, c2[1] - (p0[1] + 2 * p1[1]) / 3),
  );
  const n = Math.max(1, Math.min(96, Math.ceil(Math.sqrt((d * 1.5) / Math.max(tol, 1e-6)))));
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, cc = 3 * u * t * t, e = t * t * t;
    out.push([a * p0[0] + b * c1[0] + cc * c2[0] + e * p1[0], a * p0[1] + b * c1[1] + cc * c2[1] + e * p1[1]]);
  }
}

/** Centre a mesh on its XY bbox centre (z untouched). Returns the removed offset. */
export function centerXY(m: MeshArrays): [number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
  }
  if (!Number.isFinite(x0)) return [0, 0];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (let i = 0; i < p.length; i += 3) { p[i] -= cx; p[i + 1] -= cy; }
  return [cx, cy];
}

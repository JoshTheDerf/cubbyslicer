/**
 * Build plate visuals from a BedShape: plate surface, 10/50 mm grid clipped
 * to the polygon, origin axes, tinted exclude areas and the build-volume
 * wireframe.
 */
import {
  BufferGeometry, DoubleSide, Float32BufferAttribute, Group, LineBasicMaterial, LineLoop, LineSegments, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Shape, ShapeGeometry, Sprite, SpriteMaterial, CanvasTexture,
  SRGBColorSpace, Vector2, type Texture,
} from 'three';
import type { BedShape } from '../app/state';
import type { ViewportTheme } from './tokens';

type P = [number, number];

/** Intersections of the vertical (axis=0) or horizontal (axis=1) line at `c` with the polygon, as sorted param pairs. */
export function clipLine(poly: P[], axis: 0 | 1, c: number): Array<[number, number]> {
  const o = axis === 0 ? 1 : 0;
  const hits: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if ((a[axis] <= c && b[axis] > c) || (b[axis] <= c && a[axis] > c)) {
      const t = (c - a[axis]) / (b[axis] - a[axis]);
      hits.push(a[o] + t * (b[o] - a[o]));
    }
  }
  hits.sort((x, y) => x - y);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]]);
  return out;
}

function shapeOf(poly: P[]): Shape {
  return new Shape(poly.map(([x, y]) => new Vector2(x, y)));
}

function loop(poly: P[], z: number): Float32Array {
  const a = new Float32Array(poly.length * 3);
  poly.forEach(([x, y], i) => a.set([x, y, z], i * 3));
  return a;
}

export function buildBed(bed: BedShape, theme: ViewportTheme): Group {
  const g = new Group();
  g.name = 'bed';
  const poly = bed.polygon;

  // Plate
  const plate = new Mesh(
    new ShapeGeometry(shapeOf(poly)),
    new MeshStandardMaterial({ color: theme.bed, roughness: 0.95, metalness: 0, side: DoubleSide }),
  );
  plate.position.z = -0.05;
  plate.renderOrder = -2;
  plate.name = 'plate';
  g.add(plate);

  // Grid
  const minor: number[] = [], major: number[] = [];
  const z = -0.02;
  for (const axis of [0, 1] as const) {
    const lo = Math.ceil(bed.min[axis] / 10) * 10, hi = Math.floor(bed.max[axis] / 10) * 10;
    for (let c = lo; c <= hi + 1e-6; c += 10) {
      const target = Math.round(c) % 50 === 0 ? major : minor;
      for (const [s, e] of clipLine(poly, axis, c + (c === bed.min[axis] ? 1e-4 : c === bed.max[axis] ? -1e-4 : 0))) {
        if (axis === 0) target.push(c, s, z, c, e, z); else target.push(s, c, z, e, c, z);
      }
    }
  }
  const lines = (arr: number[], color: ViewportTheme['grid']) => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(arr, 3));
    return new LineSegments(geo, new LineBasicMaterial({ color, depthWrite: false }));
  };
  g.add(lines(minor, theme.grid), lines(major, theme.gridStrong));

  // Edge
  const edgeGeo = new BufferGeometry();
  edgeGeo.setAttribute('position', new Float32BufferAttribute(loop(poly, 0), 3));
  g.add(new LineLoop(edgeGeo, new LineBasicMaterial({ color: theme.bedEdge })));

  // Exclude areas
  for (const ex of bed.excludeAreas) {
    const m = new Mesh(new ShapeGeometry(shapeOf(ex)),
      new MeshBasicMaterial({ color: theme.exclude, transparent: true, opacity: 0.18, depthWrite: false, side: DoubleSide }));
    m.position.z = 0.01;
    g.add(m);
    const eg = new BufferGeometry();
    eg.setAttribute('position', new Float32BufferAttribute(loop(ex, 0.02), 3));
    g.add(new LineLoop(eg, new LineBasicMaterial({ color: theme.exclude, transparent: true, opacity: 0.6 })));
  }

  // Origin axes
  const L = Math.max(10, Math.min(30, (bed.max[0] - bed.min[0]) / 10));
  const axis = (to: [number, number, number], color: ViewportTheme['axisX']) => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([0, 0, 0.03, ...to], 3));
    return new LineSegments(geo, new LineBasicMaterial({ color, depthTest: false }));
  };
  g.add(axis([L, 0, 0.03], theme.axisX), axis([0, L, 0.03], theme.axisY), axis([0, 0, L], theme.axisZ));

  // Build volume
  if (bed.maxHeight > 0) {
    const h = bed.maxHeight;
    const segs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) segs.push(poly[j][0], poly[j][1], h, poly[i][0], poly[i][1], h);
    const verts = poly.length <= 16 ? poly : [0, 0.25, 0.5, 0.75].map((f) => poly[Math.floor(f * poly.length)]);
    for (const [x, y] of verts) segs.push(x, y, 0, x, y, h);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(segs, 3));
    g.add(new LineSegments(geo, new LineBasicMaterial({ color: theme.volume, transparent: true, opacity: 0.55, depthWrite: false })));
  }
  return g;
}

/**
 * Vendor bed visuals: the machine's bed mesh (origin at the bed centre, a hair
 * below z=0 like Orca's Bed3D) and/or its texture stretched over the bed's
 * bounding box. Geometry and texture are shared cache entries (userData.shared),
 * so disposal leaves them alone.
 */
export function buildBedExtras(bed: BedShape, theme: ViewportTheme, mesh: BufferGeometry | null, texture: Texture | null): Group {
  const g = new Group();
  g.name = 'bed-extras';
  if (mesh) {
    const m = new Mesh(mesh, new MeshStandardMaterial({ color: theme.bed, roughness: 0.9, metalness: 0.05 }));
    m.position.set((bed.min[0] + bed.max[0]) / 2, (bed.min[1] + bed.max[1]) / 2, -0.03);
    m.userData.shared = true;
    m.renderOrder = -3;
    g.add(m);
  }
  if (texture) {
    const w = bed.max[0] - bed.min[0], h = bed.max[1] - bed.min[1];
    const quad = new Mesh(new PlaneGeometry(w, h),
      new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.9 }));
    quad.position.set(bed.min[0] + w / 2, bed.min[1] + h / 2, -0.01);
    quad.renderOrder = -1;
    g.add(quad);
  }
  return g;
}

export function disposeObject3D(root: Group): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!o.userData.shared) m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) {
      // Label sprites own their canvas texture; shared bed textures are marked.
      if (o.name === 'plate-label') (mat as SpriteMaterial).map?.dispose();
      mat.dispose();
    }
  });
}

/** "1", "2", … just outside the front-left corner of a plate (multi-plate layouts). */
export function plateLabelSprite(bed: BedShape, index: number, theme: ViewportTheme): Sprite {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = `#${theme.bedEdge.getHexString()}`;
    ctx.beginPath(); ctx.arc(64, 64, 58, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 64px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(index + 1), 64, 68);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const sp = new Sprite(new SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  const size = Math.max(10, Math.min(24, (bed.max[0] - bed.min[0]) / 12));
  sp.scale.set(size, size, 1);
  sp.position.set(bed.min[0] - size * 0.7, bed.min[1] - size * 0.7, 0.5);
  sp.name = 'plate-label';
  return sp;
}

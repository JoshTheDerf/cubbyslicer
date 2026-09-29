/**
 * Generic shapes for Orca's "Add part / negative part / modifier / support
 * blocker / support enforcer" menus (Plater::load_generic_subobject): box,
 * cylinder, sphere and slab, welded and centred on the origin. Pure.
 */

export type PrimitiveKind = 'box' | 'cylinder' | 'sphere' | 'slab';

export const PRIMITIVE_LABELS: Record<PrimitiveKind, string> = {
  box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere', slab: 'Slab',
};

export interface PrimitiveMesh { positions: Float32Array; indices: Uint32Array }

export function boxMesh(sx: number, sy: number, sz: number): PrimitiveMesh {
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const positions = new Float32Array([-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  return { positions, indices };
}

export function cylinderMesh(r: number, h: number, segments = 48): PrimitiveMesh {
  const n = Math.max(3, segments);
  const pos: number[] = [0, 0, -h / 2, 0, 0, h / 2]; // 0 bottom centre, 1 top centre
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
    pos.push(c, s, -h / 2, c, s, h / 2); // 2+2i bottom, 3+2i top
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const b0 = 2 + 2 * i, t0 = b0 + 1, b1 = 2 + 2 * ((i + 1) % n), t1 = b1 + 1;
    idx.push(0, b1, b0, 1, t0, t1, b0, b1, t1, b0, t1, t0);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

export function sphereMesh(r: number, rings = 24, segments = 48): PrimitiveMesh {
  const pos: number[] = [0, 0, -r]; // south pole
  for (let j = 1; j < rings; j++) {
    const phi = -Math.PI / 2 + (j / rings) * Math.PI, cz = Math.sin(phi) * r, cr = Math.cos(phi) * r;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * cr, Math.sin(a) * cr, cz);
    }
  }
  pos.push(0, 0, r); // north pole
  const north = pos.length / 3 - 1;
  const ring = (j: number, i: number) => 1 + (j - 1) * segments + (i % segments);
  const idx: number[] = [];
  for (let i = 0; i < segments; i++) idx.push(0, ring(1, i + 1), ring(1, i));
  for (let j = 1; j < rings - 1; j++) {
    for (let i = 0; i < segments; i++) {
      const a = ring(j, i), b = ring(j, i + 1), c = ring(j + 1, i + 1), d = ring(j + 1, i);
      idx.push(a, b, c, a, c, d);
    }
  }
  for (let i = 0; i < segments; i++) idx.push(north, ring(rings - 1, i), ring(rings - 1, i + 1));
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/**
 * A shape sized for an object whose local bounding box is `size` (Orca sizes
 * generic sub-objects from the instance bounding box): half its footprint;
 * a slab is a thin full-footprint plate (e.g. a modifier for a layer range).
 */
export function primitiveFor(kind: PrimitiveKind, size: [number, number, number]): PrimitiveMesh {
  const [sx, sy, sz] = size.map((v) => Math.max(1, v));
  const side = Math.max(2, Math.min(sx, sy, sz) * 0.5);
  switch (kind) {
    case 'box': return boxMesh(side, side, side);
    case 'cylinder': return cylinderMesh(side / 2, side);
    case 'sphere': return sphereMesh(side / 2);
    case 'slab': return boxMesh(sx * 1.2, sy * 1.2, Math.max(0.5, Math.min(5, sz * 0.1)));
  }
}

/** A shape with an exact bounding box `size` (mm), centred on the origin: an ellipsoid / elliptic cylinder when the sides differ. */
export function primitiveOfSize(kind: PrimitiveKind, size: [number, number, number]): PrimitiveMesh {
  const [sx, sy, sz] = size.map((v) => Math.max(0.01, v));
  if (kind === 'box' || kind === 'slab') return boxMesh(sx, sy, sz);
  const m = kind === 'cylinder' ? cylinderMesh(0.5, 1) : sphereMesh(0.5);
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) { p[i] *= sx; p[i + 1] *= sy; p[i + 2] *= sz; }
  return m;
}

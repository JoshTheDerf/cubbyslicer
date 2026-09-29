/**
 * Small, dependency-free transform math for the project model.
 *
 * Conventions: vectors are [x, y, z], quaternions are [x, y, z, w] (unit),
 * matrices are 16-number column-major arrays (same layout as three.js
 * `Matrix4.elements` and the engine contract's `transform`).
 */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Mat4 = number[];

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

export function mat4Identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Rotation * scale (3x3, column-major, 9 numbers). */
export function linearRS(q: Quat, s: Vec3): number[] {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz,
  ];
}

/** T * R * S as a column-major 4x4. */
export function composeTRS(p: Vec3, q: Quat, s: Vec3): Mat4 {
  const l = linearRS(q, s);
  return [l[0], l[1], l[2], 0, l[3], l[4], l[5], 0, l[6], l[7], l[8], 0, p[0], p[1], p[2], 1];
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Inverse of an affine (last row 0 0 0 1) column-major 4x4. */
export function mat4InvertAffine(m: Mat4): Mat4 {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) return mat4Identity();
  const r = 1 / det;
  const l = [
    A * r, B * r, C * r,
    -(b * i - c * h) * r, (a * i - c * g) * r, -(a * h - b * g) * r,
    (b * f - c * e) * r, -(a * f - c * d) * r, (a * e - b * d) * r,
  ];
  // l is column-major: columns (l0 l1 l2), (l3 l4 l5), (l6 l7 l8)
  const tx = m[12], ty = m[13], tz = m[14];
  return [
    l[0], l[1], l[2], 0,
    l[3], l[4], l[5], 0,
    l[6], l[7], l[8], 0,
    -(l[0] * tx + l[3] * ty + l[6] * tz), -(l[1] * tx + l[4] * ty + l[7] * tz), -(l[2] * tx + l[5] * ty + l[8] * tz), 1,
  ];
}

export function transformPoint(m: Mat4, v: Vec3): Vec3 {
  const [x, y, z] = v;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

export function mat4Determinant3(m: Mat4): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6])
    - m[4] * (m[1] * m[10] - m[9] * m[2])
    + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(l > 1e-12) || !Number.isFinite(l)) return [0, 0, 0, 1];
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** a * b (apply b first, then a). */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(angle / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** Shortest rotation taking unit vector `from` onto unit vector `to`. */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  let r = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + 1;
  let q: Quat;
  if (r < 1e-8) {
    r = 0;
    q = Math.abs(from[0]) > Math.abs(from[2])
      ? [-from[1], from[0], 0, r]
      : [0, -from[2], from[1], r];
  } else {
    q = [
      from[1] * to[2] - from[2] * to[1],
      from[2] * to[0] - from[0] * to[2],
      from[0] * to[1] - from[1] * to[0],
      r,
    ];
  }
  return quatNormalize(q);
}

/** Intrinsic XYZ Euler (radians) — matches three.js default order. */
export function quatFromEuler(x: number, y: number, z: number): Quat {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

export function eulerFromQuat(q: Quat): Vec3 {
  const m = linearRS(q, [1, 1, 1]);
  // m column-major: m11=m[0], m12=m[3], m13=m[6], m22=m[4], m23=m[7], m32=m[5], m33=m[8]
  const m11 = m[0], m12 = m[3], m13 = m[6], m22 = m[4], m23 = m[7], m32 = m[5], m33 = m[8];
  const y = Math.asin(Math.max(-1, Math.min(1, m13)));
  let x: number, z: number;
  if (Math.abs(m13) < 0.9999999) {
    x = Math.atan2(-m23, m33);
    z = Math.atan2(-m12, m11);
  } else {
    x = Math.atan2(m32, m22);
    z = 0;
  }
  return [x, y, z];
}

/**
 * Decompose a column-major affine matrix into T, R, S. Returns `exact=false`
 * when the linear part has shear (recomposition would differ).
 */
export function decomposeTRS(m: Mat4): { position: Vec3; rotation: Quat; scale: Vec3; exact: boolean } {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  if (mat4Determinant3(m) < 0) sx = -sx;
  const position: Vec3 = [m[12], m[13], m[14]];
  if (!(Math.abs(sx) > 1e-12 && sy > 1e-12 && sz > 1e-12)) {
    return { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1], exact: false };
  }
  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
  const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
  const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
  const trace = r00 + r11 + r22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(r21 - r12) * s, (r02 - r20) * s, (r10 - r01) * s, 0.25 / s];
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    q = [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    q = [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
    q = [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s];
  }
  const rotation = quatNormalize(q);
  const scale: Vec3 = [sx, sy, sz];
  const back = composeTRS(position, rotation, scale);
  let err = 0;
  const mag = Math.max(Math.abs(sx), sy, sz, 1);
  for (let i = 0; i < 11; i++) if (i % 4 !== 3) err = Math.max(err, Math.abs(back[i] - m[i]));
  return { position, rotation, scale, exact: err <= 1e-6 * mag };
}

// ---- 2D geometry --------------------------------------------------------

export type Pt = [number, number];

/** Andrew's monotone chain on interleaved xy. Returns CCW hull (no repeat). */
export function convexHull(points: Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function pointInPolygon(p: Pt, poly: Pt[], eps = 1e-6): boolean {
  // On-edge counts as inside (objects touching the bed edge are fine).
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (distToSegment(p, poly[j], poly[i]) <= eps) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** True if two simple polygons overlap with positive area (touching doesn't count). */
export function polygonsOverlap(a: Pt[], b: Pt[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i], a1 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a0, a1, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  // Containment: centroid-ish interior point test (strict).
  const inner = (poly: Pt[], other: Pt[]) => {
    const c = centroid(poly);
    return pointInPolygon(c, poly, 0) && pointStrictlyInside(c, other);
  };
  return inner(a, b) || inner(b, a);
}

function pointStrictlyInside(p: Pt, poly: Pt[]): boolean {
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) if (distToSegment(p, poly[j], poly[i]) <= 1e-9) return false;
  return pointInPolygon(p, poly, 0);
}

export function centroid(poly: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

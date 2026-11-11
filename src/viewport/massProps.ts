/**
 * Orca 2.5 "Center of mass" (GLCanvas3D::CenterOfMass::model_markers): mass
 * properties of solid meshes (its_mass_properties), weighed by the filament
 * density of each part (desktop's filament presets, DEFAULT_FILAMENT_DENSITY
 * when unset). Masses in mg (mm³ × g/cm³), lengths in mm, world (bed) frame.
 */

/** GCodeProcessor.hpp */
export const DEFAULT_FILAMENT_DENSITY = 1.245;

/** Desktop's `Sum`: mass, volume, first and second moments (per axis) of the mass. */
export interface MassSum {
  mass: number;
  volume: number;
  /** ∫ρ·p dV */
  first: [number, number, number];
  /** ∫ρ·(x², y², z²) dV */
  second: [number, number, number];
}

export const emptySum = (): MassSum => ({ mass: 0, volume: 0, first: [0, 0, 0], second: [0, 0, 0] });

export function addSum(a: MassSum, b: MassSum, sign = 1): MassSum {
  a.mass += sign * b.mass;
  a.volume += sign * b.volume;
  for (let i = 0; i < 3; i++) { a.first[i] += sign * b.first[i]; a.second[i] += sign * b.second[i]; }
  return a;
}

/**
 * Mass properties of a closed mesh under a column-major 4x4 transform, at `density`
 * (signed tetrahedra from the origin; inside-out meshes come out negative and are flipped).
 */
export function meshMass(positions: ArrayLike<number>, indices: ArrayLike<number>, t: readonly number[], density: number): MassSum {
  const n = positions.length / 3;
  const w = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    w[3 * i] = t[0] * x + t[4] * y + t[8] * z + t[12];
    w[3 * i + 1] = t[1] * x + t[5] * y + t[9] * z + t[13];
    w[3 * i + 2] = t[2] * x + t[6] * y + t[10] * z + t[14];
  }
  let vol = 0;
  const f = [0, 0, 0], s = [0, 0, 0];
  for (let k = 0; k + 2 < indices.length; k += 3) {
    const a = 3 * indices[k], b = 3 * indices[k + 1], c = 3 * indices[k + 2];
    const ax = w[a], ay = w[a + 1], az = w[a + 2], bx = w[b], by = w[b + 1], bz = w[b + 2], cx = w[c], cy = w[c + 1], cz = w[c + 2];
    // Tetrahedron (0, a, b, c): V = a · (b × c) / 6.
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    vol += v;
    const sx = ax + bx + cx, sy = ay + by + cy, sz = az + bz + cz;
    f[0] += (v * sx) / 4; f[1] += (v * sy) / 4; f[2] += (v * sz) / 4;
    // ∫x² over the tetrahedron with one vertex at the origin: V/20 · (Σxᵢ² + (Σxᵢ)²).
    s[0] += (v / 20) * (ax * ax + bx * bx + cx * cx + sx * sx);
    s[1] += (v / 20) * (ay * ay + by * by + cy * cy + sy * sy);
    s[2] += (v / 20) * (az * az + bz * bz + cz * cz + sz * sz);
  }
  const sign = vol < 0 ? -1 : 1;
  return {
    mass: sign * vol * density, volume: sign * vol,
    first: [sign * f[0] * density, sign * f[1] * density, sign * f[2] * density],
    second: [sign * s[0] * density, sign * s[1] * density, sign * s[2] * density],
  };
}

export function centerOf(s: MassSum): [number, number, number] {
  return s.mass > 0 ? [s.first[0] / s.mass, s.first[1] / s.mass, s.first[2] / s.mass] : [0, 0, 0];
}

/** Moments of inertia about the axes through the centre (render_details), in mg·mm². */
export function inertiaOf(s: MassSum): [number, number, number] {
  const c = centerOf(s);
  const sp = [0, 1, 2].map((i) => Math.max(0, s.second[i] / s.mass - c[i] * c[i]));
  return [s.mass * (sp[1] + sp[2]), s.mass * (sp[0] + sp[2]), s.mass * (sp[0] + sp[1])];
}

/** Marker kinds, largest first (desktop's mkPlate, mkObject, mkSupport, mkBody). */
export type MarkerKind = 'plate' | 'object' | 'support' | 'body';
/** On-screen radii, px (marker_radii). */
export const MARKER_RADII: Record<MarkerKind, number> = { plate: 9, object: 7, support: 6, body: 5 };

export interface MassMarker {
  kind: MarkerKind;
  sum: MassSum;
  /** World box (min, max) of what the marker stands for. */
  box: { min: [number, number, number]; max: [number, number, number] } | null;
  /** An object made of several parts (desktop's "Assembly center of mass"). */
  assembly?: boolean;
}

/** The details desktop shows for a picked marker (render_details), formatted as there. */
export function markerDetails(m: MassMarker): { title: string; rows: Array<[string, string]> } {
  const title = m.kind === 'plate' ? 'Plate center of mass' : m.kind === 'body' ? 'Part center of mass' : m.kind === 'support' ? 'Support center of mass'
    : m.assembly ? 'Assembly center of mass' : 'Object center of mass';
  const c = centerOf(m.sum);
  const xyz = (v: number[], digits: number, unit: string) => `X: ${v[0].toFixed(digits)}, Y: ${v[1].toFixed(digits)}, Z: ${v[2].toFixed(digits)} ${unit}`;
  const rows: Array<[string, string]> = [
    ['Weight', `${(m.sum.mass / 1000).toFixed(2)} g`],
    ['Volume', `${(m.sum.volume / 1000).toFixed(2)} cm³`],
  ];
  if (m.box) {
    rows.push(['Center in bounding box', xyz(c.map((v, i) => v - m.box!.min[i]), 2, 'mm')]);
    rows.push(['Bounding box size', xyz(m.box.max.map((v, i) => v - m.box!.min[i]), 2, 'mm')]);
  }
  rows.push(['Moment of inertia', xyz(inertiaOf(m.sum).map((v) => v / 1000), 0, 'g·mm²')]);
  return { title, rows };
}

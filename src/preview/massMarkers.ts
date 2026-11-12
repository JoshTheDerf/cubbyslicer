/**
 * Orca 2.5 Preview "Center of mass" (GLCanvas3D::CenterOfMass::render, preview branch): the G-code
 * processor's masses (GCodeProcessorResult plate_mass / object_masses / body_masses / support_masses,
 * from the engine's report). Each shows the finished print's marker and, while the top layer shown
 * isn't the last, one of what is printed up to it, over the others fainter. A belt print's designed
 * view moves the sums and boxes by the toolpaths' back-transform (ObjectMass::transform).
 */
import type { SliceMass, SliceObjectMass } from '../engine/types';
import type { MarkerKind, MassMarker, MassSum } from '../viewport/massProps';

/** One layer's Sum: mass, volume, moment, second (x², y², z²) and cross (xy, xz, yz) moments. */
interface FullSum { mass: number; volume: number; moment: number[]; second: number[]; cross: number[] }

const STRIDE = 11;

function sumAt(layers: number[], k: number): FullSum {
  const o = k * STRIDE;
  return { mass: layers[o], volume: layers[o + 1], moment: layers.slice(o + 2, o + 5), second: layers.slice(o + 5, o + 8), cross: layers.slice(o + 8, o + 11) };
}

/**
 * ObjectMass::transform for an affine `m` (column-major 4x4): the second moments become
 * L S Lᵀ + M tᵀ + t Mᵀ + m t tᵀ and the moment L M + m t.
 */
export function transformSum(s: FullSum, m: readonly number[]): FullSum {
  const L = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]];
  const t = [m[12], m[13], m[14]];
  const S = [
    [s.second[0], s.cross[0], s.cross[1]],
    [s.cross[0], s.second[1], s.cross[2]],
    [s.cross[1], s.cross[2], s.second[2]],
  ];
  const M = [0, 1, 2].map((i) => L[i][0] * s.moment[0] + L[i][1] * s.moment[1] + L[i][2] * s.moment[2]);
  const LS = [0, 1, 2].map((i) => [0, 1, 2].map((j) => L[i][0] * S[0][j] + L[i][1] * S[1][j] + L[i][2] * S[2][j]));
  const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) =>
    LS[i][0] * L[j][0] + LS[i][1] * L[j][1] + LS[i][2] * L[j][2] + M[i] * t[j] + t[i] * M[j] + s.mass * t[i] * t[j]));
  return {
    mass: s.mass, volume: s.volume,
    moment: [0, 1, 2].map((i) => M[i] + s.mass * t[i]),
    second: [R[0][0], R[1][1], R[2][2]], cross: [R[0][1], R[0][2], R[1][2]],
  };
}

const toMassSum = (s: FullSum): MassSum => ({
  mass: s.mass, volume: s.volume, first: s.moment as [number, number, number], second: s.second as [number, number, number],
});

type Box = MassMarker['box'];
function boxOf(o: SliceObjectMass, m: readonly number[] | null): Box {
  // ObjectMass::transform: the belt box moved by the translation.
  const b = m ? o.beltBox : o.box;
  if (!b || b.length < 6) return null;
  const t = m ? [m[12], m[13], m[14]] : [0, 0, 0];
  return { min: [b[0] + t[0], b[1] + t[1], b[2] + t[2]], max: [b[3] + t[0], b[4] + t[1], b[5] + t[2]] };
}

/**
 * The markers for the top layer shown (0-based) of `layerCount`; `matrix` (column-major) is the
 * belt designed view's back-transform, null for the G-code as written.
 */
export function previewMassMarkers(mass: SliceMass | undefined, topLayer: number, layerCount: number, matrix: readonly number[] | null): MassMarker[] {
  if (!mass) return [];
  const printing = topLayer + 1 < layerCount;
  const out: MassMarker[] = [];
  const add = (o: SliceObjectMass, kind: MarkerKind) => {
    const n = Math.floor(o.layers.length / STRIDE);
    if (n === 0) return;
    const at = (k: number) => { const s = sumAt(o.layers, k); return matrix ? transformSum(s, matrix) : s; };
    const box = boxOf(o, matrix);
    const total = at(n - 1);
    if (total.mass > 0) out.push({ kind, sum: toMassSum(total), box, assembly: o.assembly, stage: 0, alpha: printing ? 0.4 : 1, note: 'Finished print' });
    if (printing) {
      const s = at(Math.min(Math.max(0, topLayer), n - 1));
      if (s.mass > 0) out.push({ kind, sum: toMassSum(s), box, assembly: o.assembly, stage: 1, alpha: 1, note: `Printed up to layer ${topLayer + 1}` });
    }
  };
  add(mass.plate, 'plate');
  for (const o of mass.objects) add(o, 'object');
  for (const o of mass.bodies) add(o, 'body');
  for (const o of mass.supports) add(o, 'support');
  return out;
}

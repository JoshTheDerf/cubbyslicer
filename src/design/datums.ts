/**
 * Datum geometry drawn in the Design view, as Orca 2.5 draws it (DesignPanel
 * `refresh_datum_planes` / `refresh_mate_connectors`, DesignSketchTool `render_datum_planes` /
 * `render_mate_connectors`):
 * - **datum planes**: every enabled Plane feature as a translucent rectangle of its Size U × V
 *   (80 × 80 mm when unset), drawn over the model;
 * - **coordinate systems** (mate connectors): every enabled CoordSys that resolves, as Orca's
 *   face glyph (`render_mate_face`, preference "Draw mate connectors as a face", on by default) or
 *   its disc (in its own XY plane with the +X / +Y quadrant), with a +Z arrow — grey, blue (filled
 *   arrow) for the one a Mate moves (B). A connector whose roll could not be derived (Face +
 *   direction with no edge) always gets the disc, its quadrant amber. Occlusion as Orca: the disc
 *   and quadrant are depth-tested (hidden behind the model), the face and the arrow are drawn over
 *   it. A dashed line joins the two connectors of each Mate (and of the open Mate card's A / B);
 * - **datum axes** are not drawn (Orca 2.5 draws none).
 * Nothing is labelled, and nothing is drawn while a sketch is open. The planes are picked only as
 * the Plane card's offset base (Orca's base pick: a click that hits no body).
 */
import { markRaw, shallowRef, watch } from 'vue';
import type { Vec3 } from '../project/math';
import type { DatumsResult, PlaneFrame } from './kernel/types';
import { design, readDesign } from './session';

export interface DatumPlaneDraw { feature: number; name: string; frame: PlaneFrame; u: number; v: number; ordinal: number }
export interface ConnectorDraw { feature: number; name: string; origin: Vec3; x: Vec3; y: Vec3; driven: boolean; rollUndefined: boolean }
export interface DatumDrawing { planes: DatumPlaneDraw[]; connectors: ConnectorDraw[]; mates: Array<[number, number]> }

export const datumDrawing = shallowRef<DatumDrawing>({ planes: [], connectors: [], mates: [] });

/** Orca's default half extent when a plane has no size (render_datum_planes `H`). */
export const DEFAULT_PLANE_SIZE = 80;

type FeatureJson = Record<string, unknown>;

/**
 * The drawing from the kernel's `datums` (resolved frames, enabled features in document order)
 * and the features' own fields (sizes, coordinate system type, mates' A / B).
 */
export async function readDatumDrawing(read: (index: number) => Promise<FeatureJson>, datums: DatumsResult, features: ReadonlyArray<{ index: number; type: string; name: string; enabled: boolean }>): Promise<DatumDrawing> {
  const planesF = features.filter((f) => f.type === 'Plane' && f.enabled);
  const csF = features.filter((f) => f.type === 'CoordSys' && f.enabled);
  const planes: DatumPlaneDraw[] = [];
  for (let i = 0; i < planesF.length && i < datums.planes.length; i++) {
    const j = await read(planesF[i].index);
    const u = Number(j.plane_u_size), v = Number(j.plane_v_size);
    planes.push({ feature: planesF[i].index, name: planesF[i].name, frame: datums.planes[i].plane, u: u > 1e-6 ? u : DEFAULT_PLANE_SIZE, v: v > 1e-6 ? v : DEFAULT_PLANE_SIZE, ordinal: i });
  }
  const mates: Array<[number, number]> = [];
  for (const f of features) {
    if (f.type !== 'Mate' || !f.enabled) continue;
    const j = await read(f.index);
    mates.push([Number(j.mate_cs_a ?? -1), Number(j.mate_cs_b ?? -1)]);
  }
  const driven = new Set(mates.map((m) => m[1]));
  const connectors: ConnectorDraw[] = [];
  for (let i = 0; i < csF.length && i < datums.coordsys.length; i++) {
    const fr = datums.coordsys[i];
    if (fr.error) continue; // unresolved: nothing drawn, never a guess
    const j = await read(csF[i].index);
    connectors.push({ feature: csF[i].index, name: csF[i].name, origin: fr.origin, x: fr.x, y: fr.y, driven: driven.has(csF[i].index),
      rollUndefined: j.coordsys_type === 'FaceAndDirection' && !(Number(j.coordsys_edge ?? -1) >= 0) });
  }
  return { planes, connectors, mates };
}

let gen = -1;
async function refresh(): Promise<void> {
  const g = design.generation;
  if (design.phase !== 'open') { datumDrawing.value = { planes: [], connectors: [], mates: [] }; return; }
  const features = design.features.slice();
  if (!features.some((f) => f.type === 'Plane' || f.type === 'CoordSys')) { datumDrawing.value = { planes: [], connectors: [], mates: [] }; gen = g; return; }
  try {
    const out = await readDesign(async (c, doc) => {
      const datums = (await c.call<DatumsResult>('datums', { doc })).result;
      return readDatumDrawing(async (index) => (await c.call<{ feature: FeatureJson }>('get_feature', { doc, index })).result.feature, datums, features);
    });
    if (design.generation === g) { datumDrawing.value = markRaw(out); gen = g; }
  } catch { /* the next rebuild tries again */ }
}

let timer: ReturnType<typeof setTimeout> | null = null;
watch(() => [design.generation, design.phase, design.features.length] as const, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; if (design.generation !== gen || design.phase !== 'open') void refresh(); }, 60);
});

/** Run the refresh now (tests). */
export function refreshDatumDrawing(): Promise<void> { gen = -1; return refresh(); }

// ---- Orca's face glyph (DesignSketchTool `render_mate_face`) ----------------------------------------

// Orca's tables (emitted from its bear.step, normalised to the part's span and centred; the
// renderer scales by the disc's diameter). Copied as they are.
const BEAR_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [+0.3842, +0.3294], [+0.3156, +0.4002], [+0.2424, +0.3294],
  [-0.2524, +0.3294], [-0.3377, +0.3877], [-0.3693, +0.3298],
  [-0.3256, +0.2631], [-0.4893, -0.3337], [-0.3960, -0.4002],
  [+0.4151, -0.4002], [+0.5000, -0.3154], [+0.3156, +0.2631],
];
const BEAR_CHIN: ReadonlyArray<readonly [number, number]> = [[-0.2682, -0.3578], [+0.2628, -0.3578], [+0.2237, -0.1786]];
/** [cx, cy, r]: two eyes, then the cheek dot that carries handedness. */
const BEAR_MARKS: ReadonlyArray<readonly [number, number, number]> = [[-0.1997, +0.1760, +0.0590], [+0.1947, +0.1760, +0.0590], [+0.2797, +0.0760, +0.0380]];
const BEAR_PLATE_Z = 0.0360;
const BEAR_SNOUT_BASE: ReadonlyArray<readonly [number, number]> = [[-0.0727, -0.2417], [+0.0630, -0.2417], [+0.0259, +0.1939], [-0.0356, +0.1939]];
const BEAR_CREST: ReadonlyArray<Vec3> = [[-0.0048, -0.1793, +0.2073], [-0.0048, +0.1605, +0.1279]];

/** One flat facet of the face glyph: world points, its tone and Lambert factor, painter's depth. */
export interface FaceFacet { pts: Vec3[]; tone: 'body' | 'mark' | 'accent'; k: number; depth: number }

/**
 * Orca's face glyph for a connector at `origin` with axes X, Y, Z and disc radius `R` (mm, ~22 px):
 * a plate in the frame's XY (its outline, sides first), two eyes, a cheek dot and the chin in a dark
 * tone, and the muzzle — the one feature standing along +Z — in the accent, 1.8× wide. Shaded by a
 * light fixed in camera space (ambient floor 0.42), sorted far to near: Orca draws it with the
 * depth test off, so draw order is the depth and it shows over the model.
 */
export function faceGlyph(origin: Vec3, X: Vec3, Y: Vec3, Z: Vec3, R: number, cam: { right: Vec3; up: Vec3; fwd: Vec3 }): FaceFacet[] {
  const S = 2 * R;
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const lin = (a: Vec3, sa: number, b: Vec3, sb: number, c: Vec3, sc: number): Vec3 => [a[0] * sa + b[0] * sb + c[0] * sc, a[1] * sa + b[1] * sb + c[1] * sc, a[2] * sa + b[2] * sb + c[2] * sc];
  const lu = lin(cam.right, -0.35, cam.up, 0.55, cam.fwd, -0.76), ll = Math.hypot(...lu);
  const light: Vec3 = [lu[0] / ll, lu[1] / ll, lu[2] / ll];
  const world = (p: Vec3): Vec3 => { const d = lin(X, p[0] * S, Y, p[1] * S, Z, p[2] * S); return [origin[0] + d[0], origin[1] + d[1], origin[2] + d[2]]; };
  const out: FaceFacet[] = [];
  const emit = (local: Vec3[], tone: FaceFacet['tone'], shade: boolean) => {
    if (local.length < 3) return;
    const w = local.map(world);
    const e1 = [w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]], e2 = [w[2][0] - w[0][0], w[2][1] - w[0][1], w[2][2] - w[0][2]];
    let n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(...n);
    n = nl > 1e-12 ? [n[0] / nl, n[1] / nl, n[2] / nl] : Z;
    if (dot(n, cam.fwd) > 0) n = [-n[0], -n[1], -n[2]]; // the camera-facing side
    const k = shade ? 0.42 + 0.58 * Math.max(0, dot(n, light)) : 1;
    out.push({ pts: w, tone, k, depth: w.reduce((a, p) => a + dot(p, cam.fwd), 0) / w.length });
  };
  const NO = BEAR_OUTLINE.length, zp = BEAR_PLATE_Z;
  for (let i = 0; i < NO; i++) {
    const a = BEAR_OUTLINE[i], b = BEAR_OUTLINE[(i + 1) % NO];
    emit([[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], zp], [a[0], a[1], zp]], 'body', true);
  }
  emit(BEAR_OUTLINE.map(([x, y]) => [x, y, zp] as Vec3), 'body', true);
  const zm = zp + 0.004;
  for (const [cx, cy, r] of BEAR_MARKS) emit(Array.from({ length: 12 }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / 12), cy + r * Math.sin((2 * Math.PI * i) / 12), zm] as Vec3), 'mark', false);
  emit(BEAR_CHIN.map(([x, y]) => [x, y, zm] as Vec3), 'mark', false);
  const widen = 1.8, base = (i: number): Vec3 => [BEAR_SNOUT_BASE[i][0] * widen, BEAR_SNOUT_BASE[i][1], zp];
  const [A, B] = BEAR_CREST, nl = base(0), nr = base(1), tr = base(2), tl = base(3);
  emit([nl, tl, B, A], 'accent', true); // left flank
  emit([nr, A, B, tr], 'accent', true); // right flank
  emit([nl, A, nr], 'accent', true); // nose cap
  emit([tr, B, tl], 'accent', true); // tail cap
  return out.sort((a, b) => b.depth - a.depth);
}


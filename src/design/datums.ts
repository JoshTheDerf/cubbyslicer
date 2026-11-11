/**
 * Datum geometry drawn in the Design view, as Orca 2.5 draws it (DesignPanel
 * `refresh_datum_planes` / `refresh_mate_connectors`, DesignSketchTool `render_datum_planes` /
 * `render_mate_connectors`):
 * - **datum planes**: every enabled Plane feature as a translucent rectangle of its Size U × V
 *   (80 × 80 mm when unset), drawn over the model;
 * - **coordinate systems** (mate connectors): every enabled CoordSys that resolves, as a disc in
 *   its own XY plane with the +X / +Y quadrant and a +Z arrow — grey, blue (filled arrow) for the
 *   one a Mate moves (B), its quadrant hatched-amber when the roll could not be derived (Face +
 *   direction with no edge); a dashed line joins the two connectors of each Mate (and of the open
 *   Mate card's A / B);
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

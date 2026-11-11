/**
 * Finished sketches in the Design view (Orca draws a committed sketch's strokes and lets a click
 * inside a closed region pick it): the Sketch features' entities, planes and imported regions,
 * re-read after every rebuild, which features consume each sketch, and screen-space hit-testing
 * (a stroke within a few px, or inside a closed region by even-odd crossing).
 *
 * Shown: sketches nothing consumes yet (just finished), the selected ones, and — while a feature
 * card with a Sketch row is open — every sketch, so a click can pick it into the card.
 */
import { markRaw, shallowRef, watch } from 'vue';
import type { FeatureJson, PlaneFrame } from '../kernel/types';
import { design, readDesign } from '../session';
import { card } from '../create';
import { sample, toWorld, type SkEntity, type V2 } from './model';

export interface CommittedSketch { index: number; name: string; plane: PlaneFrame; entities: SkEntity[]; regions: V2[][][]; offset: V2; consumed: boolean }

export const committedSketches = shallowRef<readonly CommittedSketch[]>([]);

const CONSUMER_KEYS = ['sketch_ref', 'sweep_path_ref', 'rib_sketch_ref', 'pattern_curve_sketch'] as const;
const PLANES: Record<string, PlaneFrame> = {
  XY: { origin: [0, 0, 0], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] },
  XZ: { origin: [0, 0, 0], normal: [0, 1, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1] },
  YZ: { origin: [0, 0, 0], normal: [1, 0, 0], x_axis: [0, 1, 0], y_axis: [0, 0, 1] },
};

let gen = -1;
async function refresh(): Promise<void> {
  const g = design.generation;
  if (design.phase !== 'open') { committedSketches.value = []; return; }
  const list = design.features.filter((f) => f.type === 'Sketch' && f.enabled);
  if (!list.length) { committedSketches.value = []; gen = g; return; }
  const consumers = design.features.filter((f) => f.enabled && f.type !== 'Sketch' && f.type !== 'Plane' && f.type !== 'Axis');
  try {
    const out = await readDesign(async (c, doc) => {
      const read = async (index: number) => (await c.call<{ feature: FeatureJson }>('get_feature', { doc, index })).result.feature;
      const used = new Set<number>();
      for (const f of consumers) {
        const j = await read(f.index);
        for (const k of CONSUMER_KEYS) { const v = Number(j[k]); if (v >= 0) used.add(v); }
        for (const v of (j.loft_profile_refs as number[] | undefined) ?? []) used.add(v);
      }
      const res: CommittedSketch[] = [];
      for (const f of list) {
        const j = await read(f.index);
        const plane = typeof j.plane === 'string' ? withOrigin(PLANES[j.plane] ?? PLANES.XY) : j.plane as PlaneFrame;
        res.push({ index: f.index, name: f.name, plane, entities: (j.entities as SkEntity[] | undefined) ?? [], regions: (j.imported_regions as V2[][][] | undefined) ?? [], offset: (j.import_offset as V2 | undefined) ?? [0, 0], consumed: used.has(f.index) });
      }
      return res;
    });
    if (design.generation === g) { committedSketches.value = markRaw(out); gen = g; }
  } catch { /* the next rebuild tries again */ }
}
function withOrigin(p: PlaneFrame): PlaneFrame { return { ...p, origin: design.modelingOrigin }; }

let timer: ReturnType<typeof setTimeout> | null = null;
watch(() => [design.generation, design.phase, design.features.length] as const, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; if (design.generation !== gen || design.phase !== 'open') void refresh(); }, 60);
});

/** Polylines (world mm) of a committed sketch: its non-construction entities, and its region loops. */
export function sketchPolylines(s: CommittedSketch, withConstruction = false): Array<{ pts: Array<[number, number, number]>; construction: boolean; region: boolean }> {
  const out: Array<{ pts: Array<[number, number, number]>; construction: boolean; region: boolean }> = [];
  for (const e of s.entities) {
    if (e.type === 'point' || (e.construction && !withConstruction)) continue;
    out.push({ pts: sample(e, 64).map((p) => toWorld(s.plane, p)), construction: e.construction, region: false });
  }
  for (const reg of s.regions) for (const loop of reg) out.push({ pts: [...loop, loop[0]].map((p) => toWorld(s.plane, [p[0] + s.offset[0], p[1] + s.offset[1]])), construction: false, region: true });
  return out;
}

/**
 * Which shown sketch is under a screen point: a stroke within `tolPx`, else the innermost one
 * whose closed outline contains it (even-odd over all its projected strokes).
 */
export function hitSketch(list: readonly CommittedSketch[], project: (p: [number, number, number]) => [number, number] | null, x: number, y: number, tolPx = 8): number | null {
  let best: { index: number; d: number } | null = null;
  let inside: { index: number; area: number } | null = null;
  for (const s of list) {
    const segs: Array<[[number, number], [number, number]]> = [];
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const pl of sketchPolylines(s)) {
      const pts = pl.pts.map(project);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        if (!a || !b) continue;
        segs.push([a, b]);
        minx = Math.min(minx, a[0]); maxx = Math.max(maxx, a[0]); miny = Math.min(miny, a[1]); maxy = Math.max(maxy, a[1]);
      }
    }
    let crossings = 0;
    for (const [a, b] of segs) {
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
      const d = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
      if (d < tolPx && (!best || d < best.d)) best = { index: s.index, d };
      if ((a[1] > y) !== (b[1] > y) && x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) crossings++;
    }
    const area = (maxx - minx) * (maxy - miny);
    if (crossings % 2 === 1 && (!inside || area < inside.area)) inside = { index: s.index, area };
  }
  return best?.index ?? inside?.index ?? null;
}

/** The open feature card's Sketch rows (and their values): a click on a sketch fills one. */
export function cardSketchRows(): Array<{ key: string; label: string; value: number }> {
  const t = card.tool;
  if (!t) return [];
  return t.rows.filter((r) => r.kind === 'sketch' && (!r.when || r.when(card.draft))).map((r) => ({ key: r.key, label: r.label, value: Number(card.draft[r.key] ?? -1) }));
}

/**
 * Applies a calibration plan to the app: Orca's new_project, add_model,
 * cut_horizontal / scale, the preset edits (unsaved, like Orca's edited
 * presets), per-object overrides, belt handling and the Calib_Params every
 * slice sends (state.ts).
 */
import { activeEngine, activeView, resolvedConfig } from '../app/state';
import { confirmAction } from '../app/shell/uiState';
import { calibrationUnavailable } from '../engine/capabilities';
import { addCustomGcode } from '../plates/store';
import { currentPresets } from '../presets/store';
import { isVectorType } from '../presets/values';
import { parseModelFile } from '../project/import';
import { quatFromAxisAngle, quatMultiply, type Quat, type Vec3 } from '../project/math';
import { computeBBox } from '../project/mesh';
import { resetSections } from '../project/persistence/sections';
import {
  addParsedObjects, addPlate, getObject, objectInfo, objects, plateBedOf, plates, projectName, resetProject, setObjectOverrides,
  setTransforms, type TransformPatch,
} from '../project/store';
import type { ParsedObject } from '../project/types';
import { mergeMeshes, transformed } from '../tools/geom/meshUtil';
import { toast } from '../ui';
import { fitBed } from '../viewport/controller';
import { objectOverrides, type PresetSource } from './edits';
import {
  BELT_SUPPORT, beltRowShifts, beltSectionShifts, cancelRotation, type CalibPlan, type Mesh, type PlanContext, type PlanObject,
} from './plan';
import { cutHorizontal } from './planeCut';
import { setActiveCalib } from './state';

// ---- sources -----------------------------------------------------------------------------

/** The selected presets (with unsaved edits) and the resolved config. */
export function livePresetSource(): PresetSource {
  const p = currentPresets.value;
  const schema = p.schema.value;
  return {
    option: (key) => {
      if (!schema) return null;
      const def = schema.options[key];
      return def ? { vector: isVectorType(def.type) } : undefined;
    },
    value: (kind, key, slot) => p.value(kind, key, slot),
    resolved: resolvedConfig.value,
  };
}

export const liveContext: PlanContext = {
  bed: (i) => { const b = plateBedOf(i); return { min: [b.min[0], b.min[1]], max: [b.max[0], b.max[1]] }; },
};

// ---- models ------------------------------------------------------------------------------

export function calibAssetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}calib/${path}`;
}

/** Fetch + parse a staged calibration model (lazy; STL / 3MF). */
export async function loadCalibModel(path: string): Promise<ParsedObject[]> {
  const rsp = await fetch(calibAssetUrl(path));
  if (!rsp.ok) throw new Error(`The calibration model ${path} is not available on this server (HTTP ${rsp.status}). Run scripts/stage-calib.mjs.`);
  const res = await parseModelFile(path.split('/').pop()!, await rsp.arrayBuffer());
  if (!res.objects.length) throw new Error(`${path} contains no geometry`);
  return res.objects;
}

/** An object of a file with its file placement baked in. */
export function bakedMesh(p: ParsedObject): Mesh {
  return { positions: p.transform ? transformed(p.positions, p.transform) : p.positions, indices: p.indices };
}

/** XY centre of an object's (baked) bounds in its file. */
export function fileCentre(p: ParsedObject): [number, number] {
  const b = computeBBox(bakedMesh(p).positions);
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
}

function heightOf(m: Mesh): number { const b = computeBBox(m.positions); return b.max[2] - b.min[2]; }

/** Translate so the XY centre is at the origin and the bottom at z = 0. */
function centred(m: Mesh): { mesh: Mesh; size: Vec3 } {
  const b = computeBBox(m.positions);
  const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]];
  const pos = new Float32Array(m.positions.length);
  for (let i = 0; i < pos.length; i += 3) { pos[i] = m.positions[i] - c[0]; pos[i + 1] = m.positions[i + 1] - c[1]; pos[i + 2] = m.positions[i + 2] - c[2]; }
  return { mesh: { positions: pos, indices: m.indices }, size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] };
}

async function meshOf(o: PlanObject, cache: Map<string, Promise<ParsedObject[]>>): Promise<Mesh> {
  if (o.mesh) return o.mesh;
  if (!o.model) throw new Error(`${o.name}: no model`);
  if (!cache.has(o.model)) cache.set(o.model, loadCalibModel(o.model));
  const list = await cache.get(o.model)!;
  if (o.part !== undefined) return bakedMesh(list[o.part]);
  return list.length === 1 ? bakedMesh(list[0]) : mergeMeshes(list.map(bakedMesh));
}

// ---- project lifecycle ---------------------------------------------------------------------

/**
 * Orca new_project(false, false, name): asks before discarding the current
 * plate, clears it, names the project and shows the 3D editor.
 */
async function beginProject(name: string): Promise<boolean> {
  if (objects.value.length) {
    const ok = await confirmAction({
      title: `Start “${name}”?`,
      message: 'Calibration prints start a new project: the current plate is cleared. Save it first if you want to keep it. The test’s suggested settings are applied as unsaved changes to your presets.',
      confirmLabel: 'Start calibration',
    });
    if (!ok) return false;
  }
  resetProject();
  resetSections();
  projectName.value = name;
  activeView.value = 'prepare';
  return true;
}

/** Toast-wrapped calibration setup; false when it failed (or the engine can't run calibrations). */
export async function runCalibration(label: string, fn: () => Promise<boolean>): Promise<boolean> {
  try {
    const unavailable = calibrationUnavailable(activeEngine.value);
    if (unavailable) throw new Error(unavailable);
    return await fn();
  } catch (e) {
    toast.error(`Couldn’t set up the ${label}.`, { detail: (e as Error)?.message ?? String(e) });
    return false;
  }
}

/**
 * Plan (validation and refusals happen before anything changes, like Orca),
 * start the project, re-plan against the fresh project and apply.
 * `build` is called twice and must be pure.
 */
export async function startCalibration(build: () => CalibPlan): Promise<boolean> {
  const title = build().title;
  if (!(await beginProject(title))) return false;
  const plan = build();
  const ids = await applyPlan(plan);
  setActiveCalib(plan.params, ids);
  for (const n of plan.notes ?? []) toast.info(n);
  requestAnimationFrame(() => fitBed());
  return true;
}

// ---- applying ------------------------------------------------------------------------------

function translation(x: number, y: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1];
}

const TURN_Z: Quat = quatFromAxisAngle([0, 0, 1], Math.PI);

export async function applyPlan(plan: CalibPlan, ctx: PlanContext = liveContext): Promise<string[]> {
  const p = currentPresets.value;
  for (const w of plan.edits.writes) p.setValue(w.kind, w.key, w.value, w.slot);
  while (plates.value.length < (plan.plates ?? 1) && addPlate() >= 0) { /* grow */ }

  const cache = new Map<string, Promise<ParsedObject[]>>();
  const ids: string[] = [];
  const b0 = ctx.bed(0);
  const cx = (b0.min[0] + b0.max[0]) / 2, cy = (b0.min[1] + b0.max[1]) / 2;
  for (const o of plan.objects) {
    let mesh = await meshOf(o, cache);
    for (const cut of o.cuts ?? []) {
      if ((cut.when ?? cut.z) < heightOf(mesh)) mesh = cutHorizontal(mesh, computeBBox(mesh.positions).min[2] + cut.z, cut.keep);
    }
    const c = centred(mesh);
    const [id] = addParsedObjects([{ name: o.name, positions: c.mesh.positions, indices: c.mesh.indices, transform: translation(cx, cy) }], { label: `Add ${o.name}` });
    if (!id) continue;
    ids.push(id);
    let scale = o.scale;
    if (o.fitWidth !== undefined && c.size[0] > 0 && o.fitWidth / c.size[0] < 1) scale = [o.fitWidth / c.size[0], 1, 1];
    const patch: TransformPatch = { id };
    if (scale && scale.some((s) => Math.abs(s - 1) > 1e-9)) patch.scale = scale;
    if (o.turn) patch.rotation = TURN_Z;
    if (o.at) patch.position = [o.at[0], o.at[1], 0];
    else if (o.beltEntry) patch.position = [cx, c.size[1] / 2, 0];
    else patch.position = [cx + (o.offset?.[0] ?? 0), cy + (o.offset?.[1] ?? 0), 0];
    setTransforms([patch], 'Place', { drop: true });
    if (o.overrides && Object.keys(o.overrides).length) setObjectOverrides(id, o.overrides);
  }

  if (plan.belt) applyBelt(plan, ids, cx);
  for (const g of plan.customGcodes ?? []) addCustomGcode(0, g);
  return ids;
}

function yspan(id: string): { minY: number; maxY: number; sizeZ: number } | null {
  const i = objectInfo.value.get(id);
  return i ? { minY: i.min[1], maxY: i.max[1], sizeZ: i.max[2] - i.min[2] } : null;
}

/** _calib_apply_belt_mode / _calib_temp_belt_sectioned layout. */
function applyBelt(plan: CalibPlan, ids: string[], cx: number): void {
  const belt = plan.belt!;
  const live = ids.filter((id) => getObject(id));
  if (belt.mode === 'counter-rotate') {
    const support = objectOverrides(livePresetSource(), { ...BELT_SUPPORT });
    const q = cancelRotation(belt.tilt);
    setTransforms(live.map((id) => ({ id, rotation: quatMultiply(q, getObject(id)!.rotation) })), 'Belt', { drop: true });
    for (const id of live) setObjectOverrides(id, { ...getObject(id)!.overrides, ...support });
    const spans = live.map((id) => ({ offsetY: getObject(id)!.position[1], ...(yspan(id) ?? { minY: 0, maxY: 0 }) }));
    const shifts = beltRowShifts(spans, belt.tilt.angle);
    setTransforms(live.map((id, k) => { const o = getObject(id)!; return { id, position: [o.position[0], o.position[1] + shifts[k], o.position[2]] as Vec3 }; }), 'Belt layout');
  } else {
    const spans = live.map((id) => { const s = yspan(id) ?? { minY: 0, maxY: 0, sizeZ: 0 }; return { minY: s.minY, sizeY: s.maxY - s.minY, sizeZ: s.sizeZ }; });
    const shifts = beltSectionShifts(spans, belt.tilt.angle);
    setTransforms(live.map((id, k) => { const o = getObject(id)!; return { id, position: [cx, o.position[1] + shifts[k], o.position[2]] as Vec3 }; }), 'Belt layout');
  }
}

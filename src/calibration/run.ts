/**
 * Calibration projects — ports of OrcaSlicer 2.4.2 Plater::calib_* (Plater.cpp)
 * and adjust_settings_for_flowrate_calib: start a new project, load Orca's
 * test model (public/calib, staged by scripts/stage-calib.mjs), cut / scale it
 * like Orca, write the suggested settings as unsaved preset edits (Orca edits
 * the selected presets the same way) and per-object overrides, and remember
 * the Calib_Params that the engine needs for every slice (state.ts).
 */
import type { CalibParams, ConfigValue, FlatConfig } from '../engine/types';
import { activeEngine, activeView, resolvedConfig } from '../app/state';
import { confirmAction } from '../app/shell/uiState';
import { parseModelFile } from '../project/import';
import { resetSections } from '../project/persistence/sections';
import {
  addParsedObjects, addPlate, bed, objects, plateBedOf, plates, projectName, resetProject, setObjectOverrides, setTransforms,
} from '../project/store';
import type { ParsedObject } from '../project/types';
import { boxMesh } from '../project/primitives';
import { currentPresets } from '../presets/store';
import type { PresetKind } from '../presets/types';
import { asArray, isVectorType } from '../presets/values';
import { toast } from '../ui';
import { fitBed } from '../viewport/controller';
import { absValue, autoExtrusionWidth, findOptimalPASpeed, mm3PerMm, num, PAPatternGeometry } from './flowMath';
import { cutHorizontal, meshBounds } from './planeCut';
import { setActiveCalib } from './state';
import { isOrcaFamily } from '../engine/types';

const EPSILON = 1e-4;

// ---- model loading --------------------------------------------------------------------

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

interface Mesh { positions: Float32Array; indices: Uint32Array }

/** Bake an object's file placement into its vertices. */
function baked(p: ParsedObject): Mesh {
  const m = p.transform;
  if (!m) return { positions: p.positions, indices: p.indices };
  const src = p.positions, pos = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    pos[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    pos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    pos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return { positions: pos, indices: p.indices };
}

/** Merge every object of a file into one mesh (Orca loads the single-object models as one object). */
function merged(list: ParsedObject[]): Mesh {
  const parts = list.map(baked);
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.positions.length; ni += p.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const p of parts) {
    positions.set(p.positions, vo);
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + vo / 3;
    vo += p.positions.length; io += p.indices.length;
  }
  return { positions, indices };
}

/** Translate so the XY centre is at the origin and the bottom at z = 0; returns the old centre. */
function centre(m: Mesh): { mesh: Mesh; centre: [number, number, number]; size: [number, number, number] } {
  const b = meshBounds(m.positions);
  const c: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]];
  const pos = new Float32Array(m.positions.length);
  for (let i = 0; i < pos.length; i += 3) { pos[i] = m.positions[i] - c[0]; pos[i + 1] = m.positions[i + 1] - c[1]; pos[i + 2] = m.positions[i + 2] - c[2]; }
  return { mesh: { positions: pos, indices: m.indices }, centre: c, size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] };
}

function heightOf(m: Mesh): number { const b = meshBounds(m.positions); return b.max[2] - b.min[2]; }

/** Orca cut_horizontal(obj, 0, z, KeepLower / KeepUpper), z from the object's bottom. */
function cutAt(m: Mesh, z: number, keep: 'lower' | 'upper'): Mesh {
  const b = meshBounds(m.positions);
  return cutHorizontal(m, b.min[2] + z, keep);
}

function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** Add one object at the plate centre (optionally offset); returns its id. */
function addObject(name: string, m: Mesh, opts: { offset?: [number, number]; scale?: [number, number, number]; overrides?: Record<string, ConfigValue> } = {}): string {
  const c = centre(m);
  const b = plateBedOf(0);
  const cx = (b.min[0] + b.max[0]) / 2 + (opts.offset?.[0] ?? 0), cy = (b.min[1] + b.max[1]) / 2 + (opts.offset?.[1] ?? 0);
  const [id] = addParsedObjects([{ name, positions: c.mesh.positions, indices: c.mesh.indices, transform: translation(cx, cy, 0) }], { label: `Add ${name}` });
  if (id && opts.scale && opts.scale.some((s) => Math.abs(s - 1) > 1e-9)) setTransforms([{ id, scale: opts.scale }], 'Scale', { drop: true });
  if (id && opts.overrides && Object.keys(opts.overrides).length) setObjectOverrides(id, opts.overrides);
  return id;
}

// ---- settings --------------------------------------------------------------------------

type Scalar = string | number | boolean;

function serialize(v: Scalar): string {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  return v;
}

/**
 * Edits applied to the selected presets (unsaved, like Orca's
 * get_edited_preset().config.set_key_value) plus a local view of the full
 * config so later computations see earlier edits.
 */
class Edits {
  readonly cfg: FlatConfig;
  constructor(private readonly slot = 0) { this.cfg = { ...resolvedConfig.value }; }

  private def(key: string) { return currentPresets.value.schema.value?.options[key]; }

  set(kind: PresetKind, key: string, v: Scalar): void {
    const p = currentPresets.value;
    const def = this.def(key);
    if (p.schema.value && !def) return; // not an option of this engine build
    const s = serialize(v);
    let value: ConfigValue = s;
    if (def && isVectorType(def.type)) {
      const cur = asArray(p.value(kind, key, kind === 'filament' ? this.slot : 0));
      value = cur.length ? cur.map(() => s) : [s];
    }
    p.setValue(kind, key, value, kind === 'filament' ? this.slot : 0);
    // local mirror: filament vectors are per slot in the resolved config
    const full = this.cfg[key];
    if (Array.isArray(full)) {
      const next = full.slice();
      if (kind === 'filament') next[this.slot] = s; else next.fill(s);
      this.cfg[key] = next;
    } else this.cfg[key] = s;
  }
  print(key: string, v: Scalar): void { this.set('process', key, v); }
  printer(key: string, v: Scalar): void { this.set('printer', key, v); }
  filament(key: string, v: Scalar): void { this.set('filament', key, v); }

  n(key: string, index = 0, fallback = 0): number { return num(this.cfg[key], index, fallback); }
  s(key: string): string { const v = this.cfg[key]; return String(Array.isArray(v) ? v[0] ?? '' : v ?? ''); }
  nozzle(i = 0): number { return this.n('nozzle_diameter', i, 0.4) || 0.4; }
  abs(key: string, over = 0): number { return absValue(this.cfg, key, over); }
  hasJunctionDeviation(): boolean { return this.s('gcode_flavor') === 'marlin2' && this.n('machine_max_junction_deviation') > 0; }
}

/** Object overrides builder with serialisation. */
function obj(values: Record<string, Scalar>): Record<string, ConfigValue> {
  const def = (k: string) => currentPresets.value.schema.value?.options[k];
  const out: Record<string, ConfigValue> = {};
  for (const [k, v] of Object.entries(values)) {
    if (currentPresets.value.schema.value && !def(k)) continue;
    out[k] = serialize(v);
  }
  return out;
}

// ---- project -----------------------------------------------------------------------------

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

function finish(ids: string[], params: CalibParams | null): void {
  setActiveCalib(params, ids.filter(Boolean));
  requestAnimationFrame(() => fitBed());
}

function requireOrca(): void {
  if (!isOrcaFamily(activeEngine.value)) throw new Error('Calibration prints need the OrcaSlicer engine. Switch the engine in the Printer section.');
}

async function run(label: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    requireOrca();
    await fn();
    return true;
  } catch (e) {
    toast.error(`Couldn’t set up the ${label}.`, { detail: (e as Error)?.message ?? String(e) });
    return false;
  }
}

// ---- Pressure advance -----------------------------------------------------------------------

export async function calibPA(params: CalibParams): Promise<boolean> {
  return run('pressure advance test', async () => {
    if (!(await beginProject('Pressure Advance Test'))) return;
    const e = new Edits(params.extruderId ?? 0);
    e.print('overhang_reverse', false);
    e.print('precise_z_height', false);
    e.printer('resonance_avoidance', false);
    let ids: string[] = [];
    let final = params;
    if (params.mode === 'pa_line') {
      ids = [addObject('pressure_advance_test', merged(await loadCalibModel('pressure_advance/pressure_advance_test.stl')))];
    } else if (params.mode === 'pa_pattern') {
      ({ ids, params: final } = await paPattern(params, e));
    } else {
      ids = await paTower(params, e);
    }
    finish(ids, final);
  });
}

async function paTower(params: CalibParams, e: Edits): Promise<string[]> {
  let mesh = merged(await loadCalibModel('pressure_advance/tower_with_seam.stl'));
  const nozzle = e.nozzle();
  e.print('enable_wrapping_detection', false);
  e.filament('slow_down_layer_time', 1);
  const wallSpeed = findOptimalPASpeed(e.cfg, e.abs('line_width', nozzle), e.abs('layer_height'), 0, 0);
  e.print('max_volumetric_extrusion_rate_slope', 0);
  const newHeight = Math.ceil((params.end - params.start) / params.step) + 1;
  if (newHeight < heightOf(mesh)) mesh = cutAt(mesh, newHeight, 'lower');
  return [addObject('tower_with_seam', mesh, {
    overrides: obj({
      alternate_extra_wall: false, outer_wall_speed: wallSpeed, inner_wall_speed: wallSpeed, seam_position: 'back', wall_loops: 2,
      top_shell_layers: 0, bottom_shell_layers: 0, sparse_infill_density: '0%', brim_type: 'brim_ears', brim_object_gap: 0,
      brim_ears_max_angle: 135, brim_width: 6, seam_slope_type: 'none',
    }),
  })];
}

async function paPattern(params: CalibParams, e: Edits): Promise<{ ids: string[]; params: CalibParams }> {
  const speeds = (params.speeds ?? []).slice();
  const accels = (params.accelerations ?? []).slice();
  const nozzle = e.nozzle();
  e.filament('filament_retract_when_changing_layer', false);
  e.filament('filament_wipe', false);
  e.printer('wipe', false);
  e.printer('retract_when_changing_layer', false);
  e.printer('resonance_avoidance', false);

  let accel = e.n('outer_wall_acceleration');
  if (accel === 0) accel = e.n('inner_wall_acceleration');
  if (accel === 0) accel = e.n('default_acceleration');
  if (!accels.length) {
    accels.push(accel);
    toast.info(`No accelerations given: using ${Math.round(accel)} mm/s².`);
  } else accel = Math.max(...accels);
  e.print('outer_wall_acceleration', accel);
  e.print('print_sequence', 'by layer');

  if (!e.hasJunctionDeviation() && e.n('default_jerk') > 0) {
    let jerk = e.n('outer_wall_jerk');
    if (jerk === 0) jerk = e.n('inner_wall_jerk');
    if (jerk === 0) jerk = e.n('default_jerk');
    for (const k of ['default_jerk', 'outer_wall_jerk', 'inner_wall_jerk', 'top_surface_jerk', 'infill_jerk', 'travel_jerk']) e.print(k, jerk);
  }
  if (e.hasJunctionDeviation()) e.print('default_junction_deviation', 0);

  // SuggestedConfigCalibPAPattern
  e.print('initial_layer_speed', 30);
  e.print('line_width', (nozzle * 112.5) / 100);
  e.print('initial_layer_line_width', (nozzle * 140) / 100);
  e.print('skirt_loops', 0);
  e.print('wall_loops', 3);
  e.print('brim_type', 'no_brim');
  e.print('enable_wrapping_detection', false);

  if (!speeds.length) {
    const speed = findOptimalPASpeed(e.cfg, e.abs('line_width', nozzle), e.abs('layer_height'), 0, 0);
    e.print('outer_wall_speed', speed);
    speeds.push(speed);
    toast.info(`No speeds given: using the optimal speed ${speed} mm/s.`);
  } else if (speeds.length === 1) {
    e.print('outer_wall_speed', speeds[0]);
  }

  const g = new PAPatternGeometry(e.cfg, params.start, params.end, params.step, accel);
  const fw = g.printSizeX() + 4, fh = g.printSizeY() + 4;
  const handle = PAPatternGeometry.handleXY, hz = g.maxLayerZ();
  const offset = g.handlePosOffset();

  // Arrange the N = speeds × accels test footprints on as many plates as needed.
  const count = speeds.length * accels.length;
  const b = plateBedOf(0);
  const bw = b.max[0] - b.min[0], bh = b.max[1] - b.min[1];
  const cols = Math.max(1, Math.floor((bw - 10) / fw)), rows = Math.max(1, Math.floor((bh - 10) / fh));
  const perPlate = cols * rows;
  const platesNeeded = Math.ceil(count / perPlate);
  while (plates.value.length < platesNeeded && addPlate() >= 0) { /* grow */ }

  const cube = boxMesh(handle, handle, hz);
  const ids: string[] = [];
  const patches: Array<{ id: string; position: [number, number, number] }> = [];
  for (let t = 0; t < count; t++) {
    const plate = Math.min(Math.floor(t / perPlate), plates.value.length - 1);
    const k = t % perPlate;
    const n = Math.min(perPlate, count - plate * perPlate);
    const c = Math.min(cols, n), r = Math.ceil(n / cols);
    const col = k % cols, row = Math.floor(k / cols);
    const pb = plateBedOf(plate);
    const cx = (pb.min[0] + pb.max[0]) / 2 + (col - (c - 1) / 2) * fw;
    const cy = (pb.min[1] + pb.max[1]) / 2 + ((r - 1) / 2 - row) * fh;
    const spd = speeds[t % speeds.length], acc = accels[Math.floor(t / speeds.length)];
    const ov: Record<string, Scalar> = {};
    if (speeds.length > 1) ov.outer_wall_speed = spd;
    if (accels.length > 1) ov.outer_wall_acceleration = acc;
    const id = addObject(`pa_pattern_${Math.trunc(spd)}_${Math.trunc(acc)}`, { positions: cube.positions.slice(), indices: cube.indices.slice() }, { overrides: obj(ov) });
    ids.push(id);
    patches.push({ id, position: [cx + offset[0], cy + offset[1], 0] });
  }
  setTransforms(patches, 'Arrange', { drop: true });
  return { ids, params: { ...params, speeds, accelerations: accels } };
}

// ---- Flow rate ----------------------------------------------------------------------------

export type FlowPass = { linear: boolean; pass: 1 | 2; pattern: 'archimedeanchords' | 'monotonic' };

export async function calibFlowRate(opt: FlowPass): Promise<boolean> {
  const name = opt.linear ? `Orca YOLO Flow Calibration${opt.pass === 2 ? ' - Perfectionist version' : ''}` : `Flowrate Test - Pass${opt.pass}`;
  return run('flow ratio test', async () => {
    if (!(await beginProject(name))) return;
    const file = opt.linear ? (opt.pass === 1 ? 'Orca-LinearFlow.3mf' : 'Orca-LinearFlow_fine.3mf') : `flowrate-test-pass${opt.pass}.3mf`;
    const parsed = await loadCalibModel(`filament_flow/${file}`);
    const e = new Edits(0);

    // --- scale: the model is made for a 0.4 nozzle; z gives 10 layers (2 bottom, 5 top, 3 sparse)
    const nozzle = e.nozzle();
    const xyScale = nozzle / 0.6;
    const layerHeight = nozzle / 2;
    const firstLayer = Math.max(e.abs('initial_layer_print_height'), layerHeight);
    const zScale = (firstLayer + 9 * layerHeight) / 2;
    const s = xyScale > 1.2 ? xyScale : 1;

    const curFlow = e.n('filament_flow_ratio', 0, 1) || 1;
    const infill = mm3PerMm(nozzle * 1.2, layerHeight);
    const maxVol = e.n('filament_max_volumetric_speed', 0, 0);
    const maxInfillSpeed = opt.linear
      ? maxVol / ((infill * (curFlow + (opt.pass === 2 ? 0.035 : 0.05))) / curFlow)
      : maxVol / (infill * (opt.pass === 1 ? 1.2 : 1));
    const cap = (v: number) => (maxVol > 0 ? Math.floor(Math.min(v, maxInfillSpeed)) : Math.floor(v));
    const internalSolidSpeed = cap(e.n('internal_solid_infill_speed'));
    const topSpeed = cap(e.n('top_surface_speed'));

    // Keep Orca's layout, centred on the plate (scaled about the group centre like selection.scale).
    const items = parsed.map((p) => ({ p, c: centre(baked(p)) }));
    const gb = meshBounds(new Float32Array(items.flatMap((i) => [i.c.centre[0], i.c.centre[1], 0])));
    const gx = (gb.min[0] + gb.max[0]) / 2, gy = (gb.min[1] + gb.max[1]) / 2;
    const ids: string[] = [];
    for (const { p, c } of items) {
      let modifier = 1;
      let tag = p.name.length > 9 ? p.name.slice(9) : '';
      if (tag.startsWith('m')) tag = `-${tag.slice(1)}`;
      const parsedMod = parseFloat(tag);
      if (Number.isFinite(parsedMod)) modifier = parsedMod;
      const flowRatio = opt.linear ? (curFlow + modifier) / curFlow : 1 + modifier / 100;
      const id = addObject(p.name, c.mesh, {
        offset: [(c.centre[0] - gx) * s, (c.centre[1] - gy) * s],
        scale: [s, s, zScale],
        overrides: obj({
          wall_loops: 1, only_one_wall_top: true, thick_internal_bridges: false, enable_extra_bridge_layer: 'disabled',
          internal_bridge_density: '100%', sparse_infill_density: '35%', min_width_top_surface: '100%', bottom_shell_layers: 2,
          top_shell_layers: 5, top_shell_thickness: 0, bottom_shell_thickness: 0, detect_thin_wall: true, filter_out_gap_fill: 0,
          sparse_infill_pattern: 'rectilinear', top_surface_line_width: nozzle * 1.2, internal_solid_infill_line_width: nozzle * 1.2,
          top_surface_pattern: opt.pattern, top_solid_infill_flow_ratio: 1, infill_direction: 45, solid_infill_direction: 135,
          align_infill_direction_to_model: true, ironing_type: 'no ironing', internal_solid_infill_speed: internalSolidSpeed,
          top_surface_speed: topSpeed, seam_slope_type: 'none', gap_fill_target: 'nowhere', calib_flowrate_topinfill_special_order: true,
          print_flow_ratio: Math.round(flowRatio * 1e6) / 1e6,
        }),
      });
      ids.push(id);
    }
    e.print('max_volumetric_extrusion_rate_slope', 0);
    e.print('layer_height', layerHeight);
    e.print('alternate_extra_wall', false);
    e.print('initial_layer_print_height', firstLayer);
    e.print('reduce_crossing_wall', true);
    e.print('enable_wrapping_detection', false);
    e.printer('resonance_avoidance', false);
    // Orca sets no Calib_Params for flow ratio (the per-object flow ratios do the work).
    finish(ids, null);
  });
}

// ---- Temperature tower ------------------------------------------------------------------------

export async function calibTemp(params: CalibParams): Promise<boolean> {
  return run('temperature tower', async () => {
    if (!(await beginProject('Nozzle temperature test'))) return;
    let mesh = merged(await loadCalibModel('temperature_tower/temperature_tower.stl'));
    const e = new Edits(params.extruderId ?? 0);
    const start = Math.round(params.start);
    const nozzleCount = asArray(e.cfg.nozzle_diameter).length || 1;
    const nozzle = e.nozzle(Math.min(Math.max(params.extruderId ?? 0, 0), nozzleCount - 1)) || 0.4;
    const scale = nozzle / 0.4;
    const block = 10, stepT = 5;
    // cut upper
    let blocks = Math.round((500 - params.end) / stepT + 1);
    if (blocks > 0 && blocks * block - EPSILON < heightOf(mesh)) mesh = cutAt(mesh, blocks * block - EPSILON, 'lower');
    // cut bottom
    blocks = Math.round((500 - params.start) / stepT);
    if (blocks > 0 && blocks * block + EPSILON < heightOf(mesh)) mesh = cutAt(mesh, blocks * block + EPSILON, 'upper');
    e.printer('resonance_avoidance', false);
    e.filament('nozzle_temperature_initial_layer', start);
    e.filament('nozzle_temperature', start);
    e.print('enable_wrapping_detection', false);
    e.print('initial_layer_print_height', nozzle / 2);
    const id = addObject('temperature_tower', mesh, {
      scale: Math.abs(scale - 1) > EPSILON ? [scale, scale, scale] : undefined,
      overrides: obj({
        layer_height: nozzle / 2, brim_type: 'outer_only', brim_width: 5, brim_object_gap: 0, alternate_extra_wall: false,
        seam_slope_type: 'none', overhang_reverse: false, precise_z_height: false,
      }),
    });
    finish([id], params);
  });
}

// ---- Max volumetric speed ---------------------------------------------------------------------

export async function calibMaxVolSpeed(params: CalibParams): Promise<boolean> {
  return run('max flowrate test', async () => {
    if (!(await beginProject('Max volumetric speed test'))) return;
    let mesh = merged(await loadCalibModel('volumetric_speed/SpeedTestStructure.stl'));
    const e = new Edits(0);
    const bedW = bed.value.max[0] - bed.value.min[0];
    const sx0 = meshBounds(mesh.positions);
    const scaleX = Math.min(1, (bedW - 10) / (sx0.max[0] - sx0.min[0]));
    const nozzle = e.nozzle();
    const lineWidth = nozzle * 1.75;
    const layerHeight = nozzle * 0.8;
    const maxLh = asArray(e.cfg.max_layer_height);
    if (num(maxLh, 0, 0) < layerHeight) {
      const p = currentPresets.value;
      const cur = asArray(p.value('printer', 'max_layer_height'));
      p.setValue('printer', 'max_layer_height', (cur.length ? cur : ['0']).map((v, i) => (i === 0 ? String(layerHeight) : v)));
    }
    e.filament('filament_max_volumetric_speed', 200);
    e.filament('slow_down_layer_time', 0);
    e.printer('resonance_avoidance', false);
    e.print('timelapse_type', '0');
    e.print('spiral_mode', true);
    e.print('max_volumetric_extrusion_rate_slope', 0);
    e.print('enable_wrapping_detection', false);
    const height = (params.end - params.start + 1) / params.step;
    if (height < heightOf(mesh)) mesh = cutAt(mesh, height, 'lower');
    const id = addObject('SpeedTestStructure', mesh, {
      scale: scaleX < 1 ? [scaleX, 1, 1] : undefined,
      overrides: obj({
        enable_overhang_speed: false, wall_loops: 1, alternate_extra_wall: false, top_shell_layers: 0, bottom_shell_layers: 0,
        sparse_infill_density: '0%', outer_wall_line_width: lineWidth, layer_height: layerHeight, brim_type: 'outer_and_inner',
        brim_width: 5, brim_object_gap: 0, precise_z_height: false,
      }),
    });
    const perMm = mm3PerMm(lineWidth, layerHeight) * (e.n('filament_flow_ratio', 0, 1) || 1);
    finish([id], { ...params, start: params.start / perMm, end: params.end / perMm, step: params.step / perMm });
  });
}

// ---- Retraction -----------------------------------------------------------------------------

export async function calibRetraction(params: CalibParams): Promise<boolean> {
  return run('retraction test', async () => {
    if (!(await beginProject('Retraction'))) return;
    let mesh = merged(await loadCalibModel('retraction/retraction_tower.stl'));
    const e = new Edits(0);
    e.print('enable_wrapping_detection', false);
    const nozzle = e.nozzle();
    const lh = nozzle <= 0.1 ? 0.05 : nozzle <= 0.2 ? 0.1 : 0.2;
    if (e.n('max_layer_height') < lh) {
      const p = currentPresets.value;
      const cur = asArray(p.value('printer', 'max_layer_height'));
      p.setValue('printer', 'max_layer_height', (cur.length ? cur : ['0']).map((v, i) => (i === 0 ? String(lh) : v)));
    }
    e.printer('resonance_avoidance', false);
    e.printer('use_firmware_retraction', false);
    e.print('initial_layer_print_height', lh);
    const height = 1.0 + 0.4 + (params.end - params.start) / params.step - EPSILON;
    if (height < heightOf(mesh)) mesh = cutAt(mesh, height, 'lower');
    const id = addObject('retraction_tower', mesh, {
      overrides: obj({
        wall_loops: 2, top_shell_layers: 0, bottom_shell_layers: 3, sparse_infill_density: '0%', layer_height: lh,
        alternate_extra_wall: false, seam_position: 'aligned', wall_sequence: 'inner wall/outer wall', overhang_reverse: false,
        precise_z_height: false,
      }),
    });
    finish([id], params);
  });
}

// ---- VFA ------------------------------------------------------------------------------------------

export async function calibVFA(params: CalibParams): Promise<boolean> {
  return run('VFA test', async () => {
    if (!(await beginProject('VFA test'))) return;
    let mesh = merged(await loadCalibModel('vfa/vfa.stl'));
    const e = new Edits(0);
    e.printer('resonance_avoidance', false);
    e.filament('slow_down_layer_time', 0);
    e.print('enable_overhang_speed', false);
    e.print('timelapse_type', '0');
    e.print('wall_loops', 1);
    e.print('alternate_extra_wall', false);
    e.print('top_shell_layers', 0);
    e.print('bottom_shell_layers', 1);
    e.print('sparse_infill_density', '0%');
    e.print('detect_thin_wall', false);
    e.print('spiral_mode', true);
    e.print('enable_wrapping_detection', false);
    e.print('precise_z_height', false);
    const height = 5 * ((params.end - params.start) / params.step + 1);
    if (height < heightOf(mesh)) mesh = cutAt(mesh, height, 'lower');
    const id = addObject('vfa', mesh, { overrides: obj({ brim_type: 'outer_only', brim_width: 3, brim_object_gap: 0 }) });
    finish([id], params);
  });
}

// ---- Input shaping / cornering ------------------------------------------------------------------

function motionTestSettings(e: Edits, accel: number): void {
  e.printer('resonance_avoidance', false);
  e.filament('slow_down_layer_time', 0);
  e.filament('slow_down_min_speed', 0);
  e.filament('slow_down_for_layer_cooling', false);
  e.print('enable_overhang_speed', false);
  e.print('timelapse_type', '0');
  e.print('wall_loops', 1);
  e.print('top_shell_layers', 0);
  e.print('bottom_shell_layers', 1);
  e.print('sparse_infill_density', '0%');
  e.print('detect_thin_wall', false);
  e.print('spiral_mode', true);
  e.print('spiral_mode_smooth', false);
  e.print('bottom_surface_pattern', 'rectilinear');
  e.print('outer_wall_speed', 200);
  e.print('default_acceleration', accel);
  e.print('outer_wall_acceleration', accel);
  e.print('precise_z_height', false);
}

function ensurePressureAdvance(e: Edits): void {
  if (e.n('enable_pressure_advance') === 0) {
    e.filament('enable_pressure_advance', true);
    e.filament('pressure_advance', 0);
    e.filament('adaptive_pressure_advance', false);
  }
}

const BRIM3 = { brim_type: 'outer_only', brim_width: 3, brim_object_gap: 0 } as const;

async function inputShaping(params: CalibParams, title: string): Promise<boolean> {
  return run('input shaping test', async () => {
    if (!(await beginProject(title))) return;
    const model = (params.testModel ?? 0) < 1 ? 'input_shaping/ringing_tower.stl' : 'input_shaping/fast_tower_test.stl';
    const mesh = merged(await loadCalibModel(model));
    const e = new Edits(0);
    if (e.hasJunctionDeviation()) {
      e.printer('machine_max_junction_deviation', Math.max(e.n('machine_max_junction_deviation'), 0.25));
      e.print('default_junction_deviation', 0);
    } else {
      const jerk = e.s('gcode_flavor') === 'klipper' ? 5 : 10;
      e.printer('machine_max_jerk_x', Math.max(e.n('machine_max_jerk_x'), jerk));
      e.printer('machine_max_jerk_y', Math.max(e.n('machine_max_jerk_y'), jerk));
      e.print('default_jerk', 0);
    }
    ensurePressureAdvance(e);
    e.printer('input_shaping_emit', false);
    if (params.mode === 'input_shaping_freq') e.print('layer_height', 0.2);
    motionTestSettings(e, 20000);
    const id = addObject(model.split('/').pop()!.replace('.stl', ''), mesh, { overrides: obj(BRIM3) });
    finish([id], params);
  });
}

export function calibInputShapingFreq(params: CalibParams): Promise<boolean> { return inputShaping(params, 'Input shaping Frequency test'); }
export function calibInputShapingDamp(params: CalibParams): Promise<boolean> { return inputShaping(params, 'Input shaping Damping test'); }

export async function calibCornering(params: CalibParams): Promise<boolean> {
  return run('cornering test', async () => {
    if (!(await beginProject('Cornering test'))) return;
    const tm = params.testModel ?? 0;
    const model = tm === 0 ? 'input_shaping/ringing_tower.stl' : tm === 1 ? 'input_shaping/fast_tower_test.stl' : 'cornering/SCV-V2.stl';
    const mesh = merged(await loadCalibModel(model));
    const e = new Edits(0);
    if (e.hasJunctionDeviation()) {
      e.printer('machine_max_junction_deviation', params.end);
      e.print('default_junction_deviation', 0);
    } else {
      e.printer('machine_max_jerk_x', params.end);
      e.printer('machine_max_jerk_y', params.end);
      e.print('default_jerk', 0);
    }
    ensurePressureAdvance(e);
    e.printer('input_shaping_emit', true);
    e.printer('input_shaping_type', 'Disable');
    e.filament('filament_max_volumetric_speed', 200);
    motionTestSettings(e, 2000);
    const id = addObject(model.split('/').pop()!.replace('.stl', ''), mesh, { overrides: obj(BRIM3) });
    finish([id], params);
  });
}

// ---- Orca tolerance test (handy model, added to the current plate) --------------------------------

export async function addToleranceTest(): Promise<boolean> {
  try {
    const mesh = merged(await loadCalibModel('handy/OrcaToleranceTest.stl'));
    addObject('OrcaToleranceTest', mesh);
    activeView.value = 'prepare';
    return true;
  } catch (e) {
    toast.error('Couldn’t add the tolerance test.', { detail: (e as Error)?.message ?? String(e) });
    return false;
  }
}

// ---- Handy models (Orca MenuFactory::append_submenu_add_handy_model) ----------------------------

export interface HandyModel { id: string; label: string; files: string[]; arrange?: boolean; stringHell?: boolean }

export const HANDY_MODELS: HandyModel[] = [
  { id: 'orca-cube', label: 'Orca Cube', files: ['OrcaCube_v2.stl', 'OrcaPlug_v2.stl'], arrange: true },
  { id: 'orca-sliced', label: 'OrcaSliced Combo', files: ['OrcaSliced.3mf', 'OrcaCube_v2.stl', 'OrcaPlug_v2.stl'], arrange: true },
  { id: 'tolerance', label: 'Orca Tolerance Test', files: ['OrcaToleranceTest.stl'] },
  { id: 'benchy', label: '3DBenchy', files: ['3DBenchy.stl'] },
  { id: 'calicat', label: 'Cali Cat', files: ['calicat.stl'] },
  { id: 'fdm-test', label: 'Autodesk FDM Test', files: ['ksr_fdmtest_v4.stl'] },
  { id: 'voron-cube', label: 'Voron Cube', files: ['Voron_Design_Cube_v7.stl'] },
  { id: 'bunny', label: 'Stanford Bunny', files: ['Stanford_Bunny.stl'] },
  { id: 'string-hell', label: 'Orca String Hell', files: ['Orca_stringhell.stl'], stringHell: true },
];

/** Add a handy model to the current plate, like Orca's Add ▸ Handy models. */
export async function addHandyModel(id: string): Promise<boolean> {
  const m = HANDY_MODELS.find((h) => h.id === id);
  if (!m) return false;
  const { importBuffer } = await import('../app/shell/actions');
  const { arrangeObjects } = await import('../project/store');
  try {
    let added = 0;
    for (const f of m.files) {
      const rsp = await fetch(calibAssetUrl(`handy/${f}`));
      if (!rsp.ok) throw new Error(`${f} is not available on this server (HTTP ${rsp.status}). Run scripts/stage-calib.mjs.`);
      added += (await importBuffer(f, await rsp.arrayBuffer())).length;
    }
    if (m.arrange && added) arrangeObjects(undefined, 6, 'plate');
    activeView.value = 'prepare';
  } catch (e) {
    toast.error(`Couldn’t add ${m.label}.`, { detail: (e as Error)?.message ?? String(e) });
    return false;
  }
  // String Hell has embossed text on its top: Orca suggests a zero one-wall threshold.
  if (m.stringHell) {
    const p = currentPresets.value;
    const oneWall = String(p.value('process', 'only_one_wall_top') ?? '') === '1';
    const thr = parseFloat(String(p.value('process', 'min_width_top_surface') ?? '0'));
    if (oneWall && thr > 0) {
      const ok = await confirmAction({
        title: 'Suggestion',
        message: 'This model has text embossed on its top surface. For best results with “Only one wall on top surfaces”, set the one wall threshold (min_width_top_surface) to 0. Change it now?',
        confirmLabel: 'Change setting',
      });
      if (ok) p.setValue('process', 'min_width_top_surface', '0', 0);
    }
  }
  return true;
}

/** Nozzle / flavour facts the dialogs show (defaults depend on them like in calib_dlg.cpp). */
export function calibPrinterFacts(): { flavor: string; junctionDeviation: boolean; nozzle: number; nozzles: number; lineWidth: number } {
  const cfg = resolvedConfig.value;
  const flavor = String(Array.isArray(cfg.gcode_flavor) ? cfg.gcode_flavor[0] : cfg.gcode_flavor ?? '');
  const nozzle = num(cfg.nozzle_diameter, 0, 0.4) || 0.4;
  return {
    flavor,
    junctionDeviation: flavor === 'marlin2' && num(cfg.machine_max_junction_deviation) > 0,
    nozzle,
    nozzles: asArray(cfg.nozzle_diameter).length || 1,
    lineWidth: absValue(cfg, 'line_width', nozzle) || autoExtrusionWidth(nozzle),
  };
}

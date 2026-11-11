/**
 * Orca 2.5 belt printers: the geometry shared by Prepare (placement, bed),
 * plate validation and Preview (designed vs raw G-code). Pure; matrices are
 * three.js Matrix4 so both views can use them directly.
 *
 * Ports of libslic3r/BeltTransform.cpp (`build_gcode_back_transform`),
 * GCode/MachineFrameTransform.cpp and GUI_App `build_plate_tilt_up_direction`.
 * The build-height check needs nothing belt-specific (Print::validate compares
 * a belt part's model Z). Orca slices a belt part rotated by the belt angle,
 * un-rotates the toolpaths and writes them through the G-code axis remap and
 * the machine-frame shear / scale:
 *   gcode = MachineFrame( AxisRemap( model ) )
 * so the upright ("designed") preview is AxisRemap⁻¹ · MachineFrame⁻¹ · gcode,
 * anchored on the model (GCodeViewer::load_as_gcode).
 */
import {
  Box3, BufferGeometry, DoubleSide, Float32BufferAttribute, Group, LineBasicMaterial, LineDashedMaterial, LineSegments, Matrix4, Mesh,
  MeshBasicMaterial, Vector3,
} from 'three';
import type { BedShape } from '../app/state';
import type { ViewportTheme } from './tokens';
import type { FlatConfig } from '../engine/types';
import { SCALAR, cfgBool, cfgNumber, cfgString } from '../lib/configValue';
import { Feature, FIRST_NON_EXTRUSION } from '../preview/parser/features';
import type { ParsedGcode } from '../preview/parser/types';

const EPS = 1e-6;
const deg = (d: number) => (d * Math.PI) / 180;

export function isBeltPrinter(cfg: FlatConfig): boolean { return cfgBool(cfg, 'belt_printer', SCALAR, false); }

type Axis = 'x' | 'y' | 'z' | 'none';
function rotationAxis(cfg: FlatConfig): Axis {
  const a = cfgString(cfg, 'belt_slice_rotation', SCALAR, 'none').toLowerCase();
  return a === 'x' || a === 'y' || a === 'z' ? a : 'none';
}
const sliceAngle = (cfg: FlatConfig) => cfgNumber(cfg, 'belt_slice_rotation_angle', SCALAR, 0) || 0;

/** `belt_printer_infinite_y` (default on): parts may run past the bed along Y (PartPlate::belt_open_y). */
export function beltOpenY(cfg: FlatConfig): boolean {
  return isBeltPrinter(cfg) && cfgBool(cfg, 'belt_printer_infinite_y', SCALAR, true);
}

/** The way the layers lean (the gantry), from build_plate_tilt_x / _y; null when the plate isn't tilted. */
export function buildPlateUp(cfg: FlatConfig): Vector3 | null {
  const tx = cfgNumber(cfg, 'build_plate_tilt_x', SCALAR, 0) || 0, ty = cfgNumber(cfg, 'build_plate_tilt_y', SCALAR, 0) || 0;
  if (!tx && !ty) return null;
  return new Vector3(Math.tan(deg(ty)), Math.tan(deg(tx)), 1).normalize();
}

/** MachineFrameTransform: shear (height into belt travel, cot a) then scale (1/sin a) on the gantry axis. */
export function machineFrame(cfg: FlatConfig): Matrix4 | null {
  if (!isBeltPrinter(cfg)) return null;
  const axis = rotationAxis(cfg);
  if (axis !== 'x' && axis !== 'y') return null;
  const a = cfgBool(cfg, 'belt_frame_tilt_decouple', SCALAR, false) ? cfgNumber(cfg, 'belt_frame_tilt_angle', SCALAR, 0) || 0 : sliceAngle(cfg);
  if (Math.abs(a) <= EPS) return null;
  const s = Math.sin(deg(a));
  if (Math.abs(s) <= EPS) return null;
  const cot = Math.cos(deg(a)) / s, inv = 1 / Math.abs(s);
  // scale · shear, row-major
  return axis === 'x'
    ? new Matrix4().set(1, 0, 0, 0, 0, inv, 0, 0, 0, cot, 1, 0, 0, 0, 0, 1)
    : new Matrix4().set(inv, 0, 0, 0, 0, 1, 0, 0, -cot, 0, 1, 0, 0, 0, 0, 1);
}

const REMAP = ['pos_x', 'pos_y', 'pos_z', 'neg_x', 'neg_y', 'neg_z', 'rev_x', 'rev_y', 'rev_z'];

/** The G-code axis remap as an affine matrix (GCodeWriter::apply_axis_remap); null = identity. */
export function axisRemap(cfg: FlatConfig, bed: { max: [number, number] }, height: number): Matrix4 | null {
  if (!isBeltPrinter(cfg)) return null;
  const rr = (['gcode_remap_x', 'gcode_remap_y', 'gcode_remap_z'] as const).map((k, i) => {
    const v = REMAP.indexOf(cfgString(cfg, k, SCALAR, REMAP[i]).toLowerCase());
    return v < 0 ? i : v;
  });
  if (rr[0] === 0 && rr[1] === 1 && rr[2] === 2) return null;
  const vmax = [bed.max[0], bed.max[1], height];
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0], t = [0, 0, 0];
  rr.forEach((r, i) => {
    const axis = r % 3;
    if (r < 3) m[i * 3 + axis] = 1;
    else if (r < 6) m[i * 3 + axis] = -1;
    else { m[i * 3 + axis] = -1; t[i] = vmax[axis]; }
  });
  return new Matrix4().set(m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2], 0, 0, 0, 1);
}

/** G-code (machine) → model, unanchored (BeltTransformPipeline::build_gcode_back_transform); null when not a belt. */
export function beltBackTransform(cfg: FlatConfig, bed: { max: [number, number] }, height: number): Matrix4 | null {
  if (!isBeltPrinter(cfg)) return null;
  const mf = machineFrame(cfg), ar = axisRemap(cfg, bed, height);
  if (!mf && !ar) return null;
  const out = new Matrix4();
  if (ar) out.copy(ar.clone().invert());
  if (mf) out.multiply(mf.clone().invert());
  return out;
}

const NOT_BODY = new Set<number>([Feature.Support, Feature.SupportInterface, Feature.SupportTransition, Feature.SkirtBrim, Feature.WipeTower]);

/**
 * The designed (upright) view's G-code → model matrix: the back transform,
 * then a translation that puts the object-body toolpaths' min corner on the
 * model's (`modelMin`, plate-local; without one the toolpaths are set on the
 * bed: min Z = 0). Like Orca, only extrusions after the first layer that
 * aren't support / brim / prime tower anchor it, and with a model box the
 * moves more than 10 mm outside it along Y are dropped as outliers when most
 * moves survive.
 */
export function beltDesignedMatrix(data: ParsedGcode, back: Matrix4, model: { min: [number, number, number]; max: [number, number, number] } | null): Matrix4 {
  const e = back.elements;
  const full = new Box3(), clip = new Box3(), v = new Vector3();
  let n = 0, kept = 0;
  const yLo = model ? model.min[1] - 10 : -Infinity, yHi = model ? model.max[1] + 10 : Infinity;
  const firstLayerEnd = data.layerCount > 1 ? data.layerStart[1] : 0;
  const scan = (bodyOnly: boolean) => {
    full.makeEmpty(); clip.makeEmpty(); n = 0; kept = 0;
    for (let s = firstLayerEnd; s < data.segmentCount; s++) {
      const f = data.feature[s];
      if (f >= FIRST_NON_EXTRUSION || (bodyOnly && NOT_BODY.has(f))) continue;
      n++;
      const i = (s + 1) * 3, x = data.points[i], y = data.points[i + 1], z = data.points[i + 2];
      v.set(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      full.expandByPoint(v);
      if (v.y >= yLo && v.y <= yHi) { clip.expandByPoint(v); kept++; }
    }
  };
  scan(true);
  if (!n) scan(false);
  const box = !clip.isEmpty() && n && kept >= 0.5 * n ? clip : full;
  const out = back.clone();
  if (box.isEmpty()) return out;
  const d = model ? new Vector3(model.min[0] - box.min.x, model.min[1] - box.min.y, model.min[2] - box.min.z) : new Vector3(0, 0, -box.min.z);
  return new Matrix4().makeTranslation(d.x, d.y, d.z).multiply(out);
}

// ---- Prepare: bed marks ----------------------------------------------------------------

/**
 * Belt marks on a plate (bed coordinates of that plate): the line the layers
 * lean along (Orca Bed3D::render_gravity_arrow, from the bed corner) and, with
 * an open Y axis, the belt running on past the bed's front and back edges
 * (`ext` mm each way, translucent with dashed sides).
 */
export function buildBeltMarks(bed: BedShape, up: Vector3 | null, openY: boolean, ext: number, theme: ViewportTheme): Group {
  const g = new Group();
  g.name = 'belt-marks';
  const [x0, y0] = bed.min, [x1, y1] = bed.max;
  if (up) {
    const len = Math.max(20, Math.min(80, (x1 - x0) / 5));
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([x0, y0, 0.03, x0 + up.x * len, y0 + up.y * len, up.z * len], 3));
    const l = new LineSegments(geo, new LineBasicMaterial({ color: theme.axisZ, transparent: true, opacity: 0.85, depthTest: false }));
    l.name = 'belt-up';
    g.add(l);
  }
  if (openY && ext > 0) {
    for (const [ya, yb] of [[y1, y1 + ext], [y0 - ext, y0]]) {
      const geo = new BufferGeometry();
      const pos = [x0, ya, 0, x1, ya, 0, x1, yb, 0, x0, yb, 0];
      geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      const strip = new Mesh(geo, new MeshBasicMaterial({ color: theme.gridStrong, transparent: true, opacity: 0.4, depthWrite: false, side: DoubleSide }));
      strip.position.z = -0.06;
      strip.name = 'belt-open-y';
      g.add(strip);
      const edges = new BufferGeometry();
      edges.setAttribute('position', new Float32BufferAttribute([x0, ya, 0, x0, yb, 0, x1, ya, 0, x1, yb, 0], 3));
      const dashed = new LineSegments(edges, new LineDashedMaterial({ color: theme.bedEdge, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.8 }));
      dashed.computeLineDistances();
      g.add(dashed);
    }
  }
  return g;
}

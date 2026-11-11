/**
 * CubbyCAD shapes as design bodies.
 *
 * - The shape palette adds a primitive to the design (`addPrimitiveBody`), and "Convert to
 *   Design body" turns a CubbyCAD node-tree object on the plate into one (`convertObjectToBody`).
 * - **Exact** where the kernel has an equivalent: the shape is rebuilt from kernel features in its
 *   CubbyCAD frame (Z up, base on z = 0), placed by the node's matrix — a sketch plane frame, so
 *   rotation is exact; scale folds into the dimensions where the shape allows it (a box scales on
 *   each axis, a sphere only uniformly). Boxes and polygon / star / wedge / roof prisms are an
 *   extruded profile, revolved shapes (cylinder, cone, sphere, hemisphere, torus, tube, capsule)
 *   a revolved profile, the half cylinder and the fillet shape an extruded sketch with an arc;
 *   CubbyCAD's bevel on a box / cylinder is a kernel fillet of every edge. A group of such shapes
 *   (CubbyCAD manifold groups, holes included, nested) becomes kernel booleans: adds joined
 *   first, then holes subtracted, as CubbyCAD evaluates it.
 * - **Mesh-backed** otherwise (pyramid, paraboloid, icosahedron, star, heart, diamond, ring,
 *   imported meshes, text, sketches, SDF / loft groups, sheared transforms): CubbyCAD's own mesh
 *   through `import_mesh` (coplanar triangles merged into faces; no exact curves).
 *
 * Each conversion is one `runEdit` (one undo step); a kernel refusal mid-way undoes the kernel
 * steps already made, so nothing half-built is kept.
 */
import { createPrimitiveNode, getSharedShape, isCadGroup, isCadPrimitive, RENDER_TO_ZUP, transformToMatrix, type CadNode } from '../cad/api';
import { ensureCadWasm, evaluateCadMesh, warmCadMesh } from '../cad/build';
import { composeTRS, mat4Multiply, type Mat4, type Vec3 } from '../project/math';
import { getObject } from '../project/store';
import { hexToRgba } from './commands';
import { KernelError, type JobContext } from './kernel/client';
import type { MutationResult, PlaneFrame } from './kernel/types';
import { meshBlob, transformed } from './io';
import { activateDesign, design, designReady, DesignEditError, editBlocker, runEdit, type EditOutcome } from './session';
import { designUi } from './state';

type P = Record<string, number>;
type Pt = [number, number];

/** How one shape is built: profile / sketch + extrude or revolve in a local frame of the shape. */
type Build =
  | { op: 'extrude'; profile: Pt[]; length: number; local?: Mat4 }
  | { op: 'extrudeSketch'; entities: unknown[]; length: number; local?: Mat4 }
  | { op: 'revolve'; profile: Pt[] }
  | { op: 'revolveSketch'; entities: unknown[] };

/** The kernel's one-feature primitive verb for the shape (kernel v1.2: an Import feature holding the B-rep). */
interface Prim { verb: 'box' | 'cylinder' | 'cone' | 'sphere' | 'torus'; args: Record<string, number> }

interface Exact { build: Build; fillet?: number; label: string; prim?: Prim }

const I4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const rotX90: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]; // Manifold rotate([90,0,0])
const rotY90: Mat4 = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]; // Manifold rotate([0,90,0])
const tr = (x: number, y: number, z: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const line = (p0: Pt, p1: Pt) => ({ type: 'line', p0, p1 });
const arc = (center: Pt, radius: number, a0: number, a1: number) => ({ type: 'arc', center, radius, start_angle: a0, end_angle: a1 });

/** Shape ids that convert exactly (when their parameters and scale allow it). */
export const EXACT_SHAPES = ['box', 'cylinder', 'sphere', 'cone', 'torus', 'tube', 'capsule', 'halfSphere', 'halfCylinder', 'polygon', 'wedge', 'roof', 'extrudeStar', 'fillet'] as const;

const EPS = 1e-6;
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * The exact kernel build of a shape with these params, scaled by (sx, sy, sz) along its own
 * axes; null with the reason when it has no exact equivalent.
 */
export function exactBuild(shape: string, params: P, s: Vec3): Exact | { reason: string } {
  const [sx, sy, sz] = s;
  const uniformXY = same(sx, sy), uniform = uniformXY && same(sy, sz);
  const v = (k: string, d: number) => (typeof params[k] === 'number' && Number.isFinite(params[k]) ? params[k] : d);
  const noXYStretch = (what: string) => ({ reason: `a ${what} stretched unevenly across its axis has no exact equivalent` });
  switch (shape) {
    case 'box': {
      const w = v('width', 20) * sx, d = v('depth', 20) * sy, h = v('height', 20) * sz, b = v('bevel', 0);
      if (b > 0 && !uniform) return { reason: 'a bevelled box scaled unevenly has no exact equivalent' };
      return { prim: { verb: 'box', args: { width: w, depth: d, height: h } }, build: { op: 'extrude', profile: [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]], length: h }, fillet: b > 0 ? Math.min(b * sx, w / 2, d / 2, h / 2) * 0.999 : undefined, label: 'extruded rectangle' };
    }
    case 'cylinder': {
      if (!uniformXY) return noXYStretch('cylinder');
      const r = v('radius', 10) * sx, h = v('height', 20) * sz, b = v('bevel', 0);
      if (b > 0 && !uniform) return { reason: 'a bevelled cylinder scaled unevenly has no exact equivalent' };
      return { prim: { verb: 'cylinder', args: { radius: r, height: h } }, build: { op: 'revolve', profile: [[0, 0], [r, 0], [r, h], [0, h]] }, fillet: b > 0 ? Math.min(b * sx, r, h / 2) * 0.999 : undefined, label: 'revolved rectangle' };
    }
    case 'cone': {
      if (!uniformXY) return noXYStretch('cone');
      const rb = v('radiusBottom', 10) * sx, rt = v('radiusTop', 0) * sx, h = v('height', 20) * sz;
      const prof: Pt[] = [[0, 0]];
      if (rb > EPS) prof.push([rb, 0]);
      if (rt > EPS) prof.push([rt, h]);
      prof.push([0, h]);
      if (prof.length < 3) return { reason: 'a cone with no radius has no volume' };
      const prim: Prim | undefined = same(rb, rt) ? undefined : { verb: 'cone', args: { radius1: Math.max(0, rb), radius2: Math.max(0, rt), height: h } };
      return { prim, build: { op: 'revolve', profile: prof }, label: 'revolved profile' };
    }
    case 'tube': {
      if (!uniformXY) return noXYStretch('tube');
      if (v('bevel', 0) > 0) return { reason: 'a bevelled tube is converted as a mesh' };
      const ro = v('radius', 10) * sx, ri = Math.max(0, v('radius', 10) - v('thickness', 2.5)) * sx, h = v('height', 10) * sz;
      return { build: { op: 'revolve', profile: ri > EPS ? [[ri, 0], [ro, 0], [ro, h], [ri, h]] : [[0, 0], [ro, 0], [ro, h], [0, h]] }, label: 'revolved rectangle' };
    }
    case 'sphere': {
      if (!uniform) return { reason: 'a sphere scaled unevenly is an ellipsoid (no exact equivalent)' };
      const r = v('radius', 10) * sx;
      return { prim: { verb: 'sphere', args: { radius: r } }, build: { op: 'revolveSketch', entities: [arc([0, r], r, -Math.PI / 2, Math.PI / 2), line([0, 2 * r], [0, 0])] }, label: 'revolved half circle' };
    }
    case 'halfSphere': {
      if (!uniform) return { reason: 'a hemisphere scaled unevenly has no exact equivalent' };
      const r = v('radius', 10) * sx;
      return { build: { op: 'revolveSketch', entities: [arc([0, 0], r, 0, Math.PI / 2), line([0, r], [0, 0]), line([0, 0], [r, 0])] }, label: 'revolved quarter circle' };
    }
    case 'torus': {
      if (!uniform) return { reason: 'a torus scaled unevenly has no exact equivalent' };
      const R = v('radius', 10) * sx, r = v('tube', 2.5) * sx;
      if (r >= R) return { reason: 'a self-intersecting torus (tube ≥ radius) is converted as a mesh' };
      return { prim: { verb: 'torus', args: { major_radius: R, minor_radius: r } }, build: { op: 'revolveSketch', entities: [{ type: 'circle', center: [R, r], radius: r }] }, label: 'revolved circle' };
    }
    case 'capsule': {
      if (!uniform || !same(v('topScale', 1), 1) || !same(v('bottomScale', 1), 1)) return { reason: 'a tapered or unevenly scaled capsule is converted as a mesh' };
      const r = v('radius', 10) * sx, h = Math.max(0, v('height', 20)) * sz;
      return { build: { op: 'revolveSketch', entities: [
        arc([0, r], r, -Math.PI / 2, 0), line([r, r], [r, r + h]), arc([0, r + h], r, 0, Math.PI / 2), line([0, 2 * r + h], [0, 0]),
      ] }, label: 'revolved stadium half' };
    }
    case 'polygon': {
      if (!uniformXY) return noXYStretch('polygon prism');
      if (v('bevel', 0) > 0) return { reason: 'a bevelled polygon prism is converted as a mesh' };
      const r = v('radius', 10) * sx, n = Math.max(3, Math.round(v('sides', 6)));
      const prof: Pt[] = Array.from({ length: n }, (_, i) => { const a = (2 * Math.PI * i) / n - Math.PI / 2; return [r * Math.cos(a), r * Math.sin(a)] as Pt; });
      return { build: { op: 'extrude', profile: prof, length: v('height', 20) * sz }, label: 'extruded polygon' };
    }
    case 'extrudeStar': {
      if (!uniformXY) return noXYStretch('star prism');
      const n = Math.max(3, Math.round(v('sides', 5))), outer = v('radius', 10) * sx, inner = outer * Math.max(0.001, Math.min(1, v('innerRadius', 0.5)));
      const a0 = Math.PI / 2 - Math.PI / 10;
      const prof: Pt[] = Array.from({ length: 2 * n }, (_, i) => { const r = i % 2 === 0 ? outer : inner, a = a0 + (2 * Math.PI * i) / (2 * n); return [r * Math.cos(a), r * Math.sin(a)] as Pt; });
      return { build: { op: 'extrude', profile: prof, length: v('height', 10) * sz }, label: 'extruded star' };
    }
    case 'wedge': {
      // CubbyCAD: profile [[0,0],[d,0],[0,h]] extruded w, then rotate Y 90°, z += d/2, rotate X 90°.
      if (!uniform) return { reason: 'a wedge scaled unevenly is converted as a mesh' };
      const w = v('width', 20) * sx, h = v('height', 20) * sx, d = v('depth', 20) * sx;
      return { build: { op: 'extrude', profile: [[0, 0], [d, 0], [0, h]], length: w, local: mat4Multiply(rotX90, mat4Multiply(tr(0, 0, d / 2), rotY90)) }, label: 'extruded triangle' };
    }
    case 'roof': {
      if (!uniform) return { reason: 'a roof scaled unevenly is converted as a mesh' };
      const w = v('width', 20) * sx, h = v('height', 10) * sx, d = v('depth', 20) * sx;
      return { build: { op: 'extrude', profile: [[-w / 2, 0], [w / 2, 0], [0, h]], length: d, local: rotX90 }, label: 'extruded triangle' };
    }
    case 'halfCylinder': {
      if (!uniform) return { reason: 'a half cylinder scaled unevenly is converted as a mesh' };
      const r = v('radius', 10) * sx, hh = v('height', v('radius', 10)) * sx, d = v('depth', 20) * sx;
      if (!same(r, hh)) return { reason: 'a half cylinder with an elliptical section is converted as a mesh' };
      return { build: { op: 'extrudeSketch', entities: [arc([0, 0], r, 0, Math.PI), line([-r, 0], [r, 0])], length: d, local: mat4Multiply(rotX90, tr(0, 0, -d / 2)) }, label: 'extruded half circle' };
    }
    case 'fillet': {
      if (v('bevel', 0) > 0) return { reason: 'a bevelled fillet shape is converted as a mesh' };
      if (!uniform) return { reason: 'a fillet shape scaled unevenly is converted as a mesh' };
      const r = v('radius', 10) * sx, h = v('height', 20) * sx;
      return { build: { op: 'extrudeSketch', entities: [line([0, 0], [r, 0]), arc([r, r], r, Math.PI, 1.5 * Math.PI), line([0, r], [0, 0])], length: h, local: rotX90 }, label: 'extruded corner profile' };
    }
    default:
      return { reason: 'the CAD kernel has no exact equivalent of this shape' };
  }
}

// ---- matrices ----------------------------------------------------------------------------

const col = (m: Mat4, c: number): Vec3 => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: Vec3): Vec3 => { const l = len(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const apply = (m: Mat4, p: Vec3): Vec3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];

/** A shape's world matrix split into a rigid frame and per-axis scale; null when it shears or mirrors. */
export function splitScale(m: Mat4): { rigid: Mat4; scale: Vec3 } | null {
  const x = col(m, 0), y = col(m, 1), z = col(m, 2);
  const s: Vec3 = [len(x), len(y), len(z)];
  if (s.some((v) => v < 1e-9)) return null;
  const ex = unit(x), ey = unit(y), ez = unit(z);
  if (Math.abs(dot(ex, ey)) > 1e-6 || Math.abs(dot(ey, ez)) > 1e-6 || Math.abs(dot(ex, ez)) > 1e-6) return null;
  const c = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
  if (c[0] * ez[0] + c[1] * ez[1] + c[2] * ez[2] < 0) return null; // mirrored
  return { rigid: [...ex, 0, ...ey, 0, ...ez, 0, m[12], m[13], m[14], 1] as Mat4, scale: s };
}

/** The sketch plane of a profile in shape frame `local`, placed by the rigid world frame. */
function planeOf(rigid: Mat4, local: Mat4 = I4): PlaneFrame {
  const m = mat4Multiply(rigid, local);
  return { origin: apply(m, [0, 0, 0]), x_axis: unit(col(m, 0)), y_axis: unit(col(m, 1)), normal: unit(col(m, 2)) };
}
/** Revolve frame: profile x = radius along the shape's X, profile y = the shape's Z (the axis). */
function revolvePlane(rigid: Mat4): PlaneFrame {
  const x = unit(col(rigid, 0)), z = unit(col(rigid, 2));
  const n: Vec3 = [x[1] * z[2] - x[2] * z[1], x[2] * z[0] - x[0] * z[2], x[0] * z[1] - x[1] * z[0]];
  return { origin: apply(rigid, [0, 0, 0]), x_axis: x, y_axis: z, normal: n };
}

// ---- kernel steps -------------------------------------------------------------------------

/** Kernel calls of one conversion; every successful mutating call is one kernel undo step. */
class Steps {
  done = 0;
  /** Build box / cylinder / cone / sphere / torus with the kernel's primitive verbs (the palette). */
  primitives = false;
  /** A primitive verb was used (for the report). */
  usedPrimitive = false;
  constructor(private c: JobContext, private doc: number) {}
  async call(method: string, params: Record<string, unknown>, blob?: Uint8Array): Promise<MutationResult & Record<string, unknown>> {
    const r = (await this.c.call<MutationResult & Record<string, unknown>>(method, { doc: this.doc, ...params }, blob ?? null)).result;
    if (!r.ok) throw new StepFailed(r.error || `${method} was refused`, r);
    this.done++;
    return r;
  }
  async read<T>(method: string, params: Record<string, unknown> = {}): Promise<T> { return (await this.c.call<T>(method, { doc: this.doc, ...params })).result; }
  /** Undo what this conversion did (the kernel's own undo, one step per successful call). */
  async rollback(): Promise<void> { while (this.done > 0) { await this.c.call('undo', { doc: this.doc }).catch(() => {}); this.done--; } }
}
class StepFailed extends Error { constructor(m: string, readonly result: MutationResult) { super(m); } }

async function bodyCount(st: Steps): Promise<number> { return (await st.read<{ bodies: unknown[] }>('describe_scene')).bodies.length; }

/** Kernels before v1.2 have no primitive verbs (-32601): remembered, so they're asked once. */
let primitiveVerbs = true;

/** Build one exact shape as a new body; returns its body index. */
async function buildExact(st: Steps, e: Exact, rigid: Mat4, name: string): Promise<number> {
  const b = e.build;
  const plane = b.op === 'revolve' || b.op === 'revolveSketch' ? revolvePlane(rigid) : planeOf(rigid, b.local);
  let built = false;
  if (e.prim && st.primitives && primitiveVerbs) {
    // One history entry (an Import feature with the exact B-rep; not parametric), resting on the
    // shape frame's XY plane like the CubbyCAD shape. Older kernels: the Sketch + feature path.
    try { await st.call(e.prim.verb, { plane: planeOf(rigid), ...e.prim.args, name }); built = true; st.usedPrimitive = true; }
    catch (err) { if (err instanceof KernelError && err.code === -32601) primitiveVerbs = false; else throw err; }
  }
  if (built) { /* done */ } else if (b.op === 'extrude') await st.call('extrude', { profile: b.profile, plane, distance: b.length, name });
  else if (b.op === 'revolve') await st.call('revolve', { profile: b.profile, plane, axis: 1, angle: 360, name });
  else {
    const sk = await st.call('add_feature', { type: 'Sketch', name: `${name} sketch`, fields: { plane, entities: b.entities } });
    if (b.op === 'extrudeSketch') await st.call('extrude', { sketch: sk.index, distance: b.length, name });
    else await st.call('revolve', { sketch: sk.index, axis: 1, angle: 360, name });
  }
  const body = (await bodyCount(st)) - 1;
  if (e.fillet) await st.call('fillet', { body, face_group: 'All', radius: e.fillet, name: `${name} bevel` });
  return body;
}

/** A mesh (design coordinates) as a new body. */
async function buildMesh(st: Steps, positions: Float32Array, indices: Uint32Array, name: string): Promise<{ body: number; watertight: boolean }> {
  const { blob, layout } = meshBlob(positions, indices);
  const r = await st.call('import_mesh', layout, blob);
  if (typeof r.first_feature === 'number' && r.first_feature >= 0) await st.call('rename_feature', { index: r.first_feature, name }).catch(() => {});
  return { body: (await bodyCount(st)) - 1, watertight: !!r.watertight };
}

// ---- plans: what a node tree turns into ------------------------------------------------------

export interface ShapeReport { name: string; shape: string; exact: boolean; how: string }

type Plan =
  | { kind: 'exact'; e: Exact; rigid: Mat4; name: string; shape: string }
  | { kind: 'group'; adds: Plan[]; subs: Plan[]; name: string };

/**
 * The exact plan of a node in world frame `world` (zup), or the reason it can't be exact.
 * `world` maps the node's own zup geometry to design coordinates.
 */
function planNode(n: CadNode, world: Mat4, reports: ShapeReport[]): Plan | string {
  const name = (typeof n.name === 'string' && n.name) || (isCadPrimitive(n) ? getSharedShape(n.geometry.type)?.label ?? n.geometry.type : 'Group');
  if (isCadPrimitive(n)) {
    const shape = n.geometry.type;
    const split = splitScale(world);
    if (!split) { reports.push({ name, shape, exact: false, how: 'sheared or mirrored transform' }); return `${name}: its transform shears or mirrors it`; }
    const e = exactBuild(shape, (n.geometry.params ?? {}) as P, split.scale);
    if ('reason' in e) { reports.push({ name, shape, exact: false, how: e.reason }); return `${name}: ${e.reason}`; }
    reports.push({ name, shape, exact: true, how: e.label + (e.fillet ? ' + fillet (bevel)' : '') });
    return { kind: 'exact', e, rigid: split.rigid, name, shape };
  }
  if (isCadGroup(n)) {
    if (n.csgMode && n.csgMode !== 'manifold') return `${name}: a ${n.csgMode} group is converted as a mesh`;
    const adds: Plan[] = [], subs: Plan[] = [];
    let why = '';
    for (const c of n.children) {
      if (c.hidden) continue;
      const m = mat4Multiply(world, renderToZup(transformToMatrix(c.transform)));
      const p = planNode(c, m, reports);
      if (typeof p === 'string') { why ||= p; continue; }
      (c.contribution === 'subtract' ? subs : adds).push(p);
    }
    if (why) return why;
    if (!adds.length) return `${name}: nothing solid in the group`;
    return { kind: 'group', adds, subs, name };
  }
  return `${name}: ${n.type} nodes are converted as a mesh`;
}

const ZUP_TO_RENDER_M: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
function renderToZup(m: Mat4): Mat4 { return mat4Multiply(RENDER_TO_ZUP, mat4Multiply(m, ZUP_TO_RENDER_M)); }

async function runPlan(st: Steps, p: Plan): Promise<number> {
  if (p.kind === 'exact') return buildExact(st, p.e, p.rigid, p.name);
  const target = await runPlan(st, p.adds[0]);
  for (const a of p.adds.slice(1)) { const tool = await runPlan(st, a); await st.call('boolean', { op: 'union', target, tool, name: `${p.name}: join ${a.name}` }); }
  for (const s of p.subs) { const tool = await runPlan(st, s); await st.call('boolean', { op: 'subtract', target, tool, name: `${p.name}: subtract ${s.name}` }); }
  return target;
}

export interface ConversionResult extends EditOutcome { exact: boolean; body: number; shapes: ShapeReport[]; reason?: string; watertight?: boolean }

async function convert(label: string, node: CadNode, world: Mat4, name: string, color: string | undefined, meshOf: () => Promise<{ positions: Float32Array; indices: Uint32Array }>, primitives = false): Promise<ConversionResult> {
  activateDesign();
  await designReady();
  const blocked = editBlocker();
  if (blocked) throw new DesignEditError(blocked);
  const reports: ShapeReport[] = [];
  const plan = planNode(node, world, reports);
  const mesh = typeof plan === 'string' ? await meshOf() : null;
  let body = -1, watertight: boolean | undefined;
  const r = await runEdit(label, async (c, doc) => {
    const st = new Steps(c, doc);
    st.primitives = primitives;
    try {
      if (mesh) ({ body, watertight } = await buildMesh(st, mesh.positions, mesh.indices, name));
      else body = await runPlan(st, plan as Plan);
      if (st.usedPrimitive && reports.length === 1) reports[0].how = `kernel ${reports[0].shape} primitive${(plan as Plan & { e?: Exact }).e?.fillet ? ' + fillet (bevel)' : ''}`;
      await c.call('set_body', { doc, body, name, ...(color && hexToRgba(color) ? { color: hexToRgba(color) } : {}) });
      return { ok: true, bodies: body + 1 };
    } catch (e) {
      await st.rollback();
      if (e instanceof StepFailed) return { ok: false, error: e.message };
      throw e;
    }
  }, { done: mesh ? `${name} added as a mesh body (${plan as string})` : `${name} added as an exact body` });
  if (r.ok && body >= 0) { designUi.pick = { kind: 'body', body }; designUi.selected = []; }
  return { ...r, exact: !mesh, body, shapes: reports, ...(mesh ? { reason: plan as string } : {}), ...(watertight !== undefined ? { watertight } : {}) };
}

/** Where a new palette body goes: the modeling origin, or right of what the design has. */
function freeSpot(): Vec3 {
  const o = design.modelingOrigin;
  let maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of design.bodies) if (b.bbox) { maxX = Math.max(maxX, b.bbox.max[0]); minY = Math.min(minY, b.bbox.min[1]); maxY = Math.max(maxY, b.bbox.max[1]); }
  return Number.isFinite(maxX) ? [maxX + 25, (minY + maxY) / 2, 0] : [o[0], o[1], 0];
}

/** The shape palette in the Design tab: add a CubbyCAD primitive as a body (exact where possible). */
export async function addPrimitiveBody(shapeId: string, opts: { params?: Record<string, unknown>; position?: Vec3; name?: string } = {}): Promise<ConversionResult> {
  const s = getSharedShape(shapeId);
  if (!s) throw new DesignEditError(`Unknown shape "${shapeId}".`);
  const node = createPrimitiveNode(shapeId, { name: opts.name ?? s.label }) as CadNode;
  if (opts.params && isCadPrimitive(node)) node.geometry.params = { ...(node.geometry.params ?? {}), ...opts.params } as typeof node.geometry.params;
  const { transform: _t, ...root } = node as CadNode & { transform?: unknown };
  const at = opts.position ?? freeSpot();
  const world = composeTRS(at, [0, 0, 0, 1], [1, 1, 1]);
  return convert(`Add ${s.label.toLowerCase()} body`, root as CadNode, world, opts.name ?? s.label, undefined, async () => {
    await ensureCadWasm();
    const m = await warmCadMesh(root as CadNode);
    return { positions: transformed(m.positions, world), indices: m.indices };
  }, true);
}

/**
 * "Convert to Design body": a CubbyCAD object on the plate becomes a body where it sits (the
 * design frame is the bed's). The object stays on the plate; Commit to Plate brings the body
 * back as a live-linked object (the reverse direction).
 */
export async function convertObjectToBody(objectId: string): Promise<ConversionResult> {
  const o = getObject(objectId);
  if (!o?.cad) throw new DesignEditError(o ? `${o.name} is not a CubbyCAD shape — use "Import as a mesh body".` : `No object "${objectId}".`);
  const world = composeTRS(o.position, o.rotation, o.scale);
  const root = o.cad.node;
  const color = typeof root.material?.color === 'string' ? root.material.color : o.color || undefined;
  return convert(`Convert ${o.name} to a design body`, root, world, o.name, color, async () => {
    const m = evaluateCadMesh(root);
    return { positions: transformed(m.positions, world), indices: m.indices };
  });
}

/** For the palette UI: which shapes convert exactly at their default size. */
export function isExactShape(shapeId: string): boolean {
  return (EXACT_SHAPES as readonly string[]).includes(shapeId) && !('reason' in exactBuild(shapeId, {}, [1, 1, 1]));
}

/**
 * Feature cards for creating features on existing geometry (Orca 2.5 DesignPanel.cpp cards):
 * rows in Orca's order with its labels and new-feature defaults, which rows pick in the viewport,
 * the prefill from the current pick (DesignOffer / the key handlers), and the CadFeature fields
 * each card writes. Every card creates one feature with `add_feature {type, fields}` (the same
 * fields `feature_preview` takes for the ghost), so one mapping serves preview and commit.
 *
 * Differences from Orca, on purpose: rows a type doesn't use are hidden (Orca shows them all);
 * the Hole card has Orca's kernel-only style (counterbore / countersink) and standards; the Cut
 * card can split with a picked face (Orca's offer has it greyed); a refused add keeps the card
 * open with the kernel's message (Orca keeps only the Plane card).
 */
import type { Vec3 } from '../project/math';
import type {
  DatumsResult, EdgeInfo, FaceInfo, FeatureType, HoleStandard, PlaneFrame, SceneBody, SceneFeature, ThreadStandard,
} from './kernel/types';
import type { PickHit, PickKind, PickValue } from './pick';
import type { DesignPick } from './state';

export type Draft = Record<string, unknown>;

/** Kernel reads on the open document (inside the preview / commit job). */
export interface KernelReads { call<T>(method: string, params?: Record<string, unknown>): Promise<T> }

export interface ToolCtx {
  bodies: readonly SceneBody[];
  features: readonly SceneFeature[];
  datums: DatumsResult | null;
  threads: readonly ThreadStandard[];
  holes: readonly HoleStandard[];
  generation: number;
  modelingOrigin: Vec3;
}

export type RowKind = 'number' | 'int' | 'bool' | 'enum' | 'vec3' | 'pick' | 'plane' | 'body' | 'sketch' | 'sketches' | 'datum' | 'standard' | 'axisDir';
export type Option = readonly [value: string | number, label: string];

export interface CardRow {
  key: string;
  label: string;
  kind: RowKind;
  unit?: string;
  min?: number;
  max?: number;
  /** Fixed choices (enum). */
  options?: readonly Option[];
  /** pick rows: what is picked. plane rows: the face pick accepts planar (and cylindrical when `axes`). */
  pick?: PickKind;
  prompt?: string;
  /** plane rows: also offer datum axes and cylindrical faces (an axis frame). */
  axes?: boolean;
  /** standard rows: which table. */
  table?: 'thread' | 'hole';
  /** sketch rows: also offer Helix features (sweep paths). */
  helix?: boolean;
  /** pick rows: only these faces (checked with face_info on click). */
  accept?: 'flat' | 'cylinder';
  /** Required reference (validated on Confirm). */
  required?: string;
  when?: (d: Draft) => boolean;
  hint?: string;
}

export type ToolGroup = 'material' | 'dressup' | 'hole' | 'repeat' | 'placement' | 'combine' | 'reference';

export interface CreateTool {
  id: string;
  title: string;
  icon: string;
  group: ToolGroup;
  /** Orca's hint line under the title. */
  hint?: string;
  rows: CardRow[];
  /** Why the card can't open (Orca's guards), or null. */
  needs?: (c: ToolCtx) => string | null;
  /** Defaults for a new feature, prefilled from the current pick. */
  init: (c: ToolCtx, p: DesignPick | null) => Draft;
  /** The feature type the draft makes (Fillet / Chamfer share a card). */
  type: (d: Draft) => FeatureType;
  /** A row changed (or was picked): derived updates (thread standards, hole latch…). */
  changed?: (key: string, d: Draft, k: KernelReads, c: ToolCtx) => Promise<void> | void;
  /** Refusal message for an incomplete draft (Orca's Confirm guards). */
  validate?: (d: Draft, c: ToolCtx) => string | null;
  /** The CadFeature fields. */
  fields: (d: Draft, k: KernelReads, c: ToolCtx) => Promise<Record<string, unknown>>;
  /** No ghost (Orca: datums, helix — "Plane ready"). */
  noPreview?: boolean;
}

// ---- helpers ----------------------------------------------------------------------------

const MM = 'mm', DEG = '°';
export const PICK_FACE = 'Click a solid FACE in the viewport';
export const PICK_EDGE = 'Click a solid EDGE in the viewport';
export const PICK_BODY = 'Click a body in the viewport';

const RESULT: Option[] = [['New', 'New body'], ['Add', 'Join'], ['Cut', 'Cut'], ['Intersect', 'Intersect']];
const hasBody = (c: ToolCtx) => c.bodies.some((b) => b.face_count > 0);
const needBody = (what: string) => (c: ToolCtx) => (hasBody(c) ? null : `${what} needs a solid body — add or import one first`);
const lastBody = (c: ToolCtx) => { for (let i = c.bodies.length - 1; i >= 0; i--) if (c.bodies[i].face_count > 0) return i; return 0; };
/** The picked body, else the last one with faces (Orca's selected_body_default). */
const pickedBody = (c: ToolCtx, p: DesignPick | null) => (p && c.bodies[p.body] ? p.body : lastBody(c));
const pv = (v: unknown): PickValue | null => (v && typeof v === 'object' && Array.isArray((v as PickValue).ids) ? v as PickValue : null);
const faceOf = (p: DesignPick | null): PickValue | null => (p?.kind === 'face' ? { body: p.body, ids: [p.face], generation: p.generation } : null);
/** The picked edge — or Orca's Shift+click edge set, all of it ("Fillet/Chamfer dresses them all"). */
const edgeOf = (p: DesignPick | null): PickValue | null => (p?.kind === 'edge' ? { body: p.body, ids: [...(p.more ?? []), p.edge], generation: p.generation } : null);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const sketches = (c: ToolCtx) => c.features.filter((f) => f.type === 'Sketch');
const lastSketch = (c: ToolCtx) => sketches(c).at(-1)?.index ?? -1;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

/** A frame with this origin and normal (x along the world axis least parallel to it). */
export function frameFromAxis(origin: Vec3, normal: Vec3): PlaneFrame {
  const n = norm(normal);
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = norm(cross(ref, n));
  return { origin, normal: n, x_axis: x, y_axis: cross(n, x) };
}

/** The same plane facing the other way (Orca's hole / thread plane points into the material). */
export function flipFrame(f: PlaneFrame): PlaneFrame { return { origin: f.origin, normal: neg(f.normal), x_axis: f.x_axis, y_axis: neg(f.y_axis) }; }

/** A point's coordinates in a plane frame. */
export function inFrame(f: PlaneFrame, p: Vec3): [number, number] { const d = sub(p, f.origin); return [dot(d, f.x_axis), dot(d, f.y_axis)]; }

async function faceInfo(k: KernelReads, v: PickValue): Promise<FaceInfo> {
  return k.call<FaceInfo>('face_info', { body: v.body, face: v.ids[0], generation: v.generation });
}

/**
 * A `plane` row's value as the kernel takes it: 'XY' | 'XZ' | 'YZ' (through the modeling origin),
 * 'plane:N' (Nth datum plane), 'axis:N' (a frame on the Nth datum axis) or 'face' (the picked face:
 * its plane, or the axis of a cylinder). `inward` flips a face's plane into the material.
 */
export async function resolvePlane(choice: unknown, face: PickValue | null, k: KernelReads, c: ToolCtx, inward = false): Promise<string | PlaneFrame> {
  const s = typeof choice === 'string' ? choice : 'XY';
  if (s === 'XY' || s === 'XZ' || s === 'YZ') return s;
  if (s.startsWith('plane:') || s.startsWith('axis:')) {
    const d = c.datums ?? await k.call<DatumsResult>('datums');
    const n = Number(s.split(':')[1]);
    if (s.startsWith('plane:')) { const p = d.planes[n]; if (!p) throw new Error('That datum plane is gone — choose another plane.'); return p.plane; }
    const a = d.axes[n];
    if (!a || a.error) throw new Error(`That datum axis ${a?.error ? `doesn’t build (${a.error})` : 'is gone'} — choose another.`);
    return frameFromAxis(a.origin, a.direction);
  }
  if (!face?.ids.length) throw new Error('Pick a face for the plane, or choose a plane.');
  const f = await faceInfo(k, face);
  if (f.plane) return inward ? flipFrame(f.plane) : f.plane;
  if (f.cylinder) return frameFromAxis(f.cylinder.base, f.cylinder.axis);
  throw new Error('That face is not flat — pick a flat face or choose a plane.');
}

/** Choices of a plane row. */
export function planeOptions(c: ToolCtx, axes = false, picked = true): Option[] {
  const out: Option[] = [['XY', 'XY'], ['XZ', 'XZ'], ['YZ', 'YZ']];
  c.datums?.planes.forEach((p, i) => out.push([`plane:${i}`, p.name || `Plane ${i + 1}`]));
  if (axes) c.datums?.axes.forEach((a, i) => { if (!a.error) out.push([`axis:${i}`, `${a.name || `Axis ${i + 1}`} (axis)`]); });
  if (picked) out.push(['face', 'Picked face']);
  return out;
}

/** Datum ordinals (Plane `plane_base`, Axis `axis_plane_a/b`): 0 XY, 1 XZ, 2 YZ, 3+N datum plane N. */
export function datumOptions(c: ToolCtx): Option[] {
  const out: Option[] = [[0, 'XY'], [1, 'XZ'], [2, 'YZ']];
  c.datums?.planes.forEach((p, i) => out.push([3 + i, p.name || `Plane ${i + 1}`]));
  return out;
}

export function bodyOptions(c: ToolCtx): Option[] {
  return c.bodies.map((b) => [b.index, `Body ${b.index + 1} — ${b.name}`] as const);
}

export function sketchOptions(c: ToolCtx, helix = false, exclude = -1): Option[] {
  return c.features.filter((f) => (f.type === 'Sketch' || (helix && f.type === 'Helix')) && f.index !== exclude).map((f) => [f.index, f.name] as const);
}

/** Generation guard for new-feature references: ids are ordinals of one rebuild. */
function fresh(v: PickValue | null, c: ToolCtx, what: string): PickValue | null {
  if (v && v.ids.length && v.generation !== c.generation) throw new Error(`The design was rebuilt since you picked the ${what} — pick ${what === 'edges' || what === 'faces' ? 'them' : 'it'} again.`);
  return v;
}

/** Nearest thread standard to a diameter (major for a boss, minor for a bore — Orca infer_thread_spec). */
export function nearestThread(list: readonly ThreadStandard[], d: number, internal: boolean): ThreadStandard | null {
  let best: ThreadStandard | null = null, bestD = Infinity;
  for (const t of list) {
    const ref = internal ? t.minor_diameter : t.major_diameter;
    const e = Math.abs(ref - d);
    if (e < bestD - 1e-9) { bestD = e; best = t; }
  }
  return best;
}

function applyThread(d: Draft, t: ThreadStandard): void {
  d.diameter = t.major_diameter;
  d.thread_pitch = t.pitch;
  d.thread_depth = d.thread_internal ? t.internal_depth : t.depth;
}

// ---- the cards ----------------------------------------------------------------------------

const extrudeEnd: Option[] = [['Blind', 'Blind'], ['Symmetric', 'Symmetric'], ['TwoSided', 'Two-sided'], ['ThroughAll', 'Through all'], ['UpToFace', 'Up to face']];

export const CREATE_TOOLS: CreateTool[] = [
  // ---- add material ----
  {
    id: 'extrude', title: 'Extrude', icon: 'i-lucide-arrow-up-from-line', group: 'material',
    hint: 'Extrude a sketch profile already in the design.',
    rows: [
      { key: 'sketch_ref', label: 'Sketch', kind: 'sketch', required: 'Pick a sketch to extrude first' },
      { key: 'distance', label: 'Extrude dist', kind: 'number', unit: MM, min: -1000, max: 1000 },
      { key: 'extrude_end', label: 'End', kind: 'enum', options: extrudeEnd },
      { key: 'distance2', label: '2nd dist', kind: 'number', unit: MM, min: 0, when: (d) => d.extrude_end === 'TwoSided' },
      { key: 'upFace', label: 'Up to face', kind: 'pick', pick: 'face', prompt: PICK_FACE, when: (d) => d.extrude_end === 'UpToFace', required: 'Pick the face to extrude up to' },
      { key: 'taper_deg', label: 'Taper', kind: 'number', unit: DEG, min: -89, max: 89 },
      { key: 'mode', label: 'Result', kind: 'enum', options: RESULT },
      { key: 'target_body', label: 'Body', kind: 'body', when: (d) => d.mode !== 'New' },
      { key: 'flip', label: 'Flip direction', kind: 'bool' },
    ],
    needs: (c) => (sketches(c).length ? null : 'Create a sketch, or pick a solid face, first'),
    init: (c) => ({ sketch_ref: lastSketch(c), distance: 10, extrude_end: 'Blind', distance2: 5, taper_deg: 0, mode: 'New', target_body: lastBody(c), flip: false, upFace: null }),
    type: () => 'Extrude',
    changed: async (key, d, k) => {
      if (key !== 'sketch_ref' || num(d.sketch_ref, -1) < 0) return;
      // Orca: Join when the profile touches a body, otherwise a new body.
      const r = await k.call<{ body: number }>('body_touching_sketch', { sketch: d.sketch_ref }).catch(() => ({ body: -1 }));
      if (r.body >= 0) { d.mode = 'Add'; d.target_body = r.body; } else d.mode = 'New';
    },
    fields: async (d, _k, c) => {
      const up = d.extrude_end === 'UpToFace' ? fresh(pv(d.upFace), c, 'face') : null;
      return {
        sketch_ref: d.sketch_ref, distance: d.distance, extrude_end: d.extrude_end, distance2: d.distance2, taper_deg: d.taper_deg, mode: d.mode, flip: d.flip,
        target_body: d.mode === 'New' ? -1 : d.target_body, ...(up ? { up_to_face: up.ids[0] } : {}),
      };
    },
  },
  {
    id: 'pushpull', title: 'Push / pull face', icon: 'i-lucide-arrow-up-from-line', group: 'material',
    hint: 'Extrude a flat face of a body (a positive distance adds material, Cut removes it).',
    rows: [
      { key: 'face', label: 'Face', kind: 'pick', pick: 'face', accept: 'flat', prompt: 'Click a flat face to push or pull', required: 'Pick a flat face first' },
      { key: 'distance', label: 'Extrude dist', kind: 'number', unit: MM, min: -1000, max: 1000 },
      { key: 'taper_deg', label: 'Taper', kind: 'number', unit: DEG, min: -89, max: 89 },
      { key: 'mode', label: 'Result', kind: 'enum', options: RESULT },
      { key: 'flip', label: 'Flip direction', kind: 'bool' },
    ],
    needs: needBody('Push / pull'),
    init: (_c, p) => ({ face: faceOf(p), distance: 10, taper_deg: 0, mode: 'Add', flip: false }),
    type: () => 'Extrude',
    fields: async (d, _k, c) => {
      const f = fresh(pv(d.face), c, 'face')!;
      return { sketch_ref: -1, extrude_src_face: f.ids[0], target_body: f.body, distance: d.distance, taper_deg: d.taper_deg, mode: d.mode, flip: d.flip, extrude_end: 'Blind' };
    },
  },
  {
    id: 'revolve', title: 'Revolve', icon: 'i-lucide-rotate-3d', group: 'material',
    hint: 'Revolve a sketch profile about an axis of its plane, or a line of the sketch.',
    rows: [
      { key: 'sketch_ref', label: 'Sketch', kind: 'sketch', required: 'Pick a sketch profile to revolve first' },
      { key: 'revolve_angle', label: 'Angle', kind: 'number', unit: DEG, min: 1, max: 360 },
      { key: 'axis', label: 'Axis', kind: 'enum' },
      { key: 'mode', label: 'Result', kind: 'enum', options: RESULT },
      { key: 'target_body', label: 'Body', kind: 'body', when: (d) => d.mode !== 'New' },
      { key: 'flip', label: 'Flip direction', kind: 'bool' },
    ],
    needs: (c) => (sketches(c).length ? null : 'Create a sketch profile to revolve first'),
    init: (c) => ({ sketch_ref: lastSketch(c), revolve_angle: 360, axis: 'x', axisOptions: [['x', 'Plane X'], ['y', 'Plane Y']], mode: 'New', target_body: lastBody(c), flip: false }),
    type: () => 'Revolve',
    changed: async (key, d, k) => {
      if (key !== 'sketch_ref' || num(d.sketch_ref, -1) < 0) return;
      const { feature } = await k.call<{ feature: { entities?: Array<{ type: string; construction: boolean }> } }>('get_feature', { index: d.sketch_ref });
      const opts: Option[] = [['x', 'Plane X'], ['y', 'Plane Y']];
      const lines = (feature.entities ?? []).map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'line');
      for (const { e, i } of lines) opts.push([`e${i}`, `${e.construction ? 'Centerline' : 'Line'} E${i}`]);
      d.axisOptions = opts;
      const centre = lines.filter(({ e }) => e.construction);
      d.axis = centre.length === 1 ? `e${centre[0].i}` : 'x';
    },
    fields: async (d) => {
      const a = String(d.axis ?? 'x');
      return {
        sketch_ref: d.sketch_ref, revolve_angle: d.revolve_angle, mode: d.mode, flip: d.flip, target_body: d.mode === 'New' ? -1 : d.target_body,
        revolve_axis: a === 'y' ? 1 : 0, revolve_axis_entity: a.startsWith('e') ? Number(a.slice(1)) : -1,
      };
    },
  },
  {
    id: 'sweep', title: 'Sweep', icon: 'i-lucide-spline', group: 'material',
    hint: 'Sweep a profile sketch along a path sketch (or a helix).',
    rows: [
      { key: 'sketch_ref', label: 'Profile', kind: 'sketch', required: 'Pick a profile sketch to sweep first' },
      { key: 'sweep_path_ref', label: 'Path', kind: 'sketch', helix: true, required: 'Pick a path sketch for the sweep' },
      { key: 'mode', label: 'Result', kind: 'enum', options: RESULT },
      { key: 'target_body', label: 'Body', kind: 'body', when: (d) => d.mode !== 'New' },
    ],
    needs: (c) => (sketches(c).length && c.features.filter((f) => f.type === 'Sketch' || f.type === 'Helix').length >= 2 ? null : 'Create a profile sketch and a path sketch to sweep first'),
    init: (c) => {
      const s = sketches(c);
      const path = c.features.filter((f) => (f.type === 'Sketch' || f.type === 'Helix') && f.index !== s.at(-1)?.index)[0]?.index ?? -1;
      return { sketch_ref: s.at(-1)?.index ?? -1, sweep_path_ref: path, mode: 'New', target_body: lastBody(c) };
    },
    type: () => 'Sweep',
    validate: (d) => (d.sketch_ref === d.sweep_path_ref ? 'The path must be another sketch than the profile' : null),
    fields: async (d) => ({ sketch_ref: d.sketch_ref, sweep_path_ref: d.sweep_path_ref, mode: d.mode, target_body: d.mode === 'New' ? -1 : d.target_body }),
  },
  {
    id: 'loft', title: 'Loft', icon: 'i-lucide-layers-2', group: 'material',
    hint: 'Loft (skin) between two or more profile sketches, in list order.',
    rows: [
      { key: 'loft_profile_refs', label: 'Profiles (check 2+, in order)', kind: 'sketches' },
      { key: 'mode', label: 'Result', kind: 'enum', options: RESULT },
      { key: 'target_body', label: 'Body', kind: 'body', when: (d) => d.mode !== 'New' },
      { key: 'loft_ruled', label: 'Ruled (straight) sections', kind: 'bool' },
    ],
    needs: (c) => (sketches(c).length >= 2 ? null : 'Create at least two profile sketches to loft'),
    init: (c) => ({ loft_profile_refs: [], mode: 'New', target_body: lastBody(c), loft_ruled: false }),
    type: () => 'Loft',
    validate: (d) => ((d.loft_profile_refs as number[]).length >= 2 ? null : 'Check at least two profile sketches to loft'),
    fields: async (d) => ({ loft_profile_refs: [...(d.loft_profile_refs as number[])].sort((a, b) => a - b), loft_ruled: d.loft_ruled, mode: d.mode, target_body: d.mode === 'New' ? -1 : d.target_body }),
  },
  {
    id: 'thicken', title: 'Thicken', icon: 'i-lucide-panel-top', group: 'material',
    hint: 'Pick a solid face and offset it into a new thin body.',
    rows: [
      { key: 'face', label: 'Face', kind: 'pick', pick: 'face', prompt: PICK_FACE, required: 'Pick a solid face to thicken first' },
      { key: 'thicken_thickness', label: 'Thickness', kind: 'number', unit: MM, min: 0.01 },
      { key: 'thicken_flip', label: 'Flip direction', kind: 'bool' },
    ],
    needs: needBody('Thicken'),
    init: (_c, p) => ({ face: faceOf(p), thicken_thickness: 2, thicken_flip: false }),
    type: () => 'Thicken',
    fields: async (d, _k, c) => { const f = fresh(pv(d.face), c, 'face')!; return { target_body: f.body, thicken_face: f.ids[0], thicken_thickness: d.thicken_thickness, thicken_flip: d.thicken_flip }; },
  },
  // ---- dress-up ----
  {
    id: 'fillet', title: 'Fillet / Chamfer', icon: 'i-lucide-square-round-corner', group: 'dressup',
    hint: 'Round or bevel picked edges — or, with none picked, every edge of a group.',
    rows: [
      { key: 'kind', label: 'Type', kind: 'enum', options: [['Fillet', 'Fillet'], ['Chamfer', 'Chamfer']] },
      { key: 'edges', label: 'Target', kind: 'pick', pick: 'edges', prompt: PICK_EDGE },
      { key: 'face_group', label: 'Edges', kind: 'enum', options: [['Top', 'Top'], ['Bottom', 'Bottom'], ['Lateral', 'Lateral'], ['All', 'All']], when: (d) => !pv(d.edges)?.ids.length },
      { key: 'target_body', label: 'Body', kind: 'body', when: (d) => !pv(d.edges)?.ids.length },
      { key: 'dressup_size', label: 'Size (r/dist)', kind: 'number', unit: MM, min: 0.01 },
    ],
    needs: (c) => (hasBody(c) ? null : 'Add a solid (sketch + extrude) first'),
    init: (c, p) => ({ kind: 'Fillet', edges: edgeOf(p), face_group: 'All', target_body: pickedBody(c, p), dressup_size: 2 }),
    type: (d) => (d.kind === 'Chamfer' ? 'Chamfer' : 'Fillet'),
    fields: async (d, _k, c) => {
      const e = fresh(pv(d.edges), c, 'edges');
      if (e?.ids.length) return { dressup_size: d.dressup_size, dressup_edges: e.ids, dressup_edge: e.ids[0], target_body: e.body, face_group: d.face_group };
      return { dressup_size: d.dressup_size, dressup_edges: [], dressup_edge: -1, face_group: d.face_group, target_body: d.target_body };
    },
  },
  {
    id: 'draft', title: 'Draft', icon: 'i-lucide-triangle-right', group: 'dressup',
    hint: 'Pick a side face, then set the draft angle. The face pivots about the body base.',
    rows: [
      { key: 'draft_angle', label: 'Angle', kind: 'number', unit: DEG, min: -89, max: 89 },
      { key: 'face', label: 'Face', kind: 'pick', pick: 'face', prompt: 'Click a side face to taper', required: 'Draft needs a picked face — click a side face first' },
    ],
    needs: needBody('Draft'),
    init: (_c, p) => ({ draft_angle: 5, face: faceOf(p) }),
    type: () => 'Draft',
    fields: async (d, _k, c) => { const f = fresh(pv(d.face), c, 'face')!; return { draft_angle: d.draft_angle, draft_face: f.ids[0], target_body: f.body }; },
  },
  {
    id: 'shell', title: 'Shell', icon: 'i-lucide-package-open', group: 'dressup',
    hint: 'Pick a solid face to open it, then set the wall thickness.',
    rows: [
      { key: 'shell_thickness', label: 'Thickness', kind: 'number', unit: MM, min: 0.01 },
      { key: 'face', label: 'Open face', kind: 'pick', pick: 'face', prompt: 'Click the face to leave open', required: 'Pick the face to leave open first (the kernel can’t make a closed hollow)' },
      { key: 'target_body', label: 'Body', kind: 'body', when: (d) => !pv(d.face)?.ids.length },
    ],
    needs: needBody('Shell'),
    init: (c, p) => ({ shell_thickness: 2, face: faceOf(p), target_body: pickedBody(c, p) }),
    type: () => 'Shell',
    fields: async (d, _k, c) => {
      const f = fresh(pv(d.face), c, 'face');
      return { shell_thickness: d.shell_thickness, shell_face: f?.ids.length ? f.ids[0] : -1, target_body: f?.ids.length ? f.body : d.target_body };
    },
  },
  {
    id: 'deleteface', title: 'Delete Face', icon: 'i-lucide-eraser', group: 'dressup',
    hint: 'Remove faces and let the neighbours grow over the gap (fillets, holes, bosses).',
    rows: [{ key: 'faces', label: 'Faces to delete', kind: 'pick', pick: 'faces', prompt: PICK_FACE, required: 'Add at least one face to delete first' }],
    needs: needBody('Delete Face'),
    init: (_c, p) => ({ faces: faceOf(p) }),
    type: () => 'DeleteFace',
    fields: async (d, _k, c) => { const f = fresh(pv(d.faces), c, 'faces')!; return { delete_faces: f.ids, target_body: f.body }; },
  },
  // ---- hole / thread ----
  {
    id: 'hole', title: 'Hole', icon: 'i-lucide-circle-dot', group: 'hole',
    hint: 'Click where the hole goes on a flat face (or use a plane and a position).',
    rows: [
      { key: 'face', label: 'On face', kind: 'pick', pick: 'point', accept: 'flat', prompt: 'Click a flat face where the hole goes' },
      { key: 'plane', label: 'Hole plane', kind: 'plane', when: (d) => !pv(d.face)?.ids.length },
      { key: 'standard', label: 'Standard', kind: 'standard', table: 'hole' },
      { key: 'hole_style', label: 'Style', kind: 'enum', options: [[0, 'Simple'], [1, 'Counterbore'], [2, 'Countersink']] },
      { key: 'hole_diameter', label: 'Diameter', kind: 'number', unit: MM, min: 0.1, max: 1000 },
      { key: 'hole_through', label: 'Through', kind: 'bool' },
      { key: 'hole_depth', label: 'Depth (blind)', kind: 'number', unit: MM, min: 0.1, max: 1000, when: (d) => !d.hole_through },
      { key: 'hole_cbore_diameter', label: 'Counterbore Ø', kind: 'number', unit: MM, min: 0.1, when: (d) => d.hole_style === 1 },
      { key: 'hole_cbore_depth', label: 'Counterbore depth', kind: 'number', unit: MM, min: 0.01, when: (d) => d.hole_style === 1 },
      { key: 'hole_csink_diameter', label: 'Countersink Ø', kind: 'number', unit: MM, min: 0.1, when: (d) => d.hole_style === 2 },
      { key: 'hole_csink_angle', label: 'Countersink angle', kind: 'number', unit: DEG, min: 1, max: 179, when: (d) => d.hole_style === 2 },
      { key: 'hole_x', label: 'Pos X', kind: 'number', unit: MM, min: -1000, max: 1000 },
      { key: 'hole_y', label: 'Pos Y', kind: 'number', unit: MM, min: -1000, max: 1000 },
    ],
    needs: needBody('Hole'),
    init: (c, p) => ({
      face: faceOf(p), plane: 'XY', planeFace: null, standard: '', hole_style: 0, hole_diameter: 6, hole_through: true, hole_depth: 10,
      hole_cbore_diameter: 11, hole_cbore_depth: 6, hole_csink_diameter: 12, hole_csink_angle: 90, hole_x: 0, hole_y: 0, target_body: pickedBody(c, p),
    }),
    type: () => 'Hole',
    changed: async (key, d, k, c) => {
      if (key === 'face') {
        const f = pv(d.face);
        if (!f?.ids.length) return;
        // Orca latches the face: the hole plane is the face's, pointing inward; X/Y = the clicked spot.
        const info = await faceInfo(k, f);
        if (!info.plane) { d.face = null; throw new Error('That face is not flat — click a flat face to drill into'); }
        const fr = flipFrame(info.plane);
        const [x, y] = f.point ? inFrame(fr, f.point) : [0, 0];
        d.hole_x = Math.round(x * 100) / 100; d.hole_y = Math.round(y * 100) / 100;
        d.target_body = f.body;
      } else if (key === 'standard') {
        const h = c.holes.find((s) => s.designation === d.standard);
        if (!h) return;
        d.hole_diameter = h.clearance;
        d.hole_cbore_diameter = h.cbore_diameter; d.hole_cbore_depth = h.cbore_depth;
        d.hole_csink_diameter = h.csink_diameter; d.hole_csink_angle = h.csink_angle;
        if (d.hole_style === 0) d.hole_style = 1;
      }
    },
    validate: (d) => (!pv(d.face)?.ids.length && d.plane === 'face' && !pv(d.planeFace)?.ids.length ? 'Pick a face or a plane to drill into' : null),
    fields: async (d, k, c) => {
      const f = fresh(pv(d.face), c, 'face');
      const plane = f?.ids.length ? await resolvePlane('face', f, k, c, true) : await resolvePlane(d.plane, pv(d.planeFace), k, c, true);
      return {
        plane, hole_x: d.hole_x, hole_y: d.hole_y, hole_diameter: d.hole_diameter, hole_depth: d.hole_depth, hole_through: d.hole_through, hole_style: d.hole_style,
        hole_cbore_diameter: d.hole_cbore_diameter, hole_cbore_depth: d.hole_cbore_depth, hole_csink_diameter: d.hole_csink_diameter, hole_csink_angle: d.hole_csink_angle,
        hole_standard: d.standard || '', target_body: f?.ids.length ? f.body : d.target_body,
      };
    },
  },
  {
    id: 'thread', title: 'Thread', icon: 'i-lucide-cable', group: 'hole',
    hint: 'Pick a cylindrical face (a boss or a bore) or its circular edge: the thread follows it.',
    rows: [
      { key: 'face', label: 'On face', kind: 'pick', pick: 'face', accept: 'cylinder', prompt: 'Click a cylindrical face (a bore or a boss)' },
      { key: 'plane', label: 'Thread plane', kind: 'plane', axes: true, when: (d) => !pv(d.face)?.ids.length },
      { key: 'standard', label: 'Standard', kind: 'standard', table: 'thread' },
      { key: 'diameter', label: 'Diameter (nominal/major)', kind: 'number', unit: MM, min: 0.1 },
      { key: 'thread_pitch', label: 'Pitch', kind: 'number', unit: MM, min: 0.05 },
      { key: 'thread_height', label: 'Length', kind: 'number', unit: MM, min: 0.1 },
      { key: 'thread_depth', label: 'Thread depth', kind: 'number', unit: MM, min: 0.01 },
      { key: 'thread_x', label: 'Pos X', kind: 'number', unit: MM, when: (d) => !pv(d.face)?.ids.length },
      { key: 'thread_y', label: 'Pos Y', kind: 'number', unit: MM, when: (d) => !pv(d.face)?.ids.length },
      { key: 'thread_internal', label: 'Internal', kind: 'bool' },
    ],
    init: (c, p) => ({
      face: faceOf(p), plane: 'XY', planeFace: null, standard: '', diameter: 10, thread_pitch: 2, thread_height: 10, thread_depth: 1, thread_x: 0, thread_y: 0,
      thread_internal: false, target_body: pickedBody(c, p),
    }),
    type: () => 'Thread',
    changed: async (key, d, k, c) => {
      if (key === 'face') {
        const f = pv(d.face);
        if (!f?.ids.length) return;
        const info = await faceInfo(k, f);
        if (!info.cylinder) { d.face = null; throw new Error('Pick a cylindrical surface (bore / outer) or a circular edge for a thread'); }
        d.thread_internal = info.cylinder.internal;
        d.thread_height = Math.round(info.cylinder.height * 100) / 100;
        d.target_body = f.body;
        const t = nearestThread(c.threads, info.cylinder.radius * 2, info.cylinder.internal);
        if (t) { d.standard = t.name; applyThread(d, t); }
      } else if (key === 'standard' || key === 'thread_internal') {
        const t = c.threads.find((s) => s.name === d.standard);
        if (t) applyThread(d, t);
      }
    },
    fields: async (d, k, c) => {
      const f = fresh(pv(d.face), c, 'face');
      let plane: string | PlaneFrame, x = num(d.thread_x), y = num(d.thread_y);
      if (f?.ids.length) {
        const info = await faceInfo(k, f);
        if (!info.cylinder) throw new Error('Pick a cylindrical surface (bore / outer) or a circular edge for a thread');
        plane = frameFromAxis(info.cylinder.base, info.cylinder.axis); x = 0; y = 0;
      } else plane = await resolvePlane(d.plane, pv(d.planeFace), k, c);
      return {
        plane, thread_x: x, thread_y: y, thread_radius: num(d.diameter, 10) / 2, thread_pitch: d.thread_pitch, thread_height: d.thread_height, thread_depth: d.thread_depth,
        thread_internal: d.thread_internal, thread_major_nominal: true, target_body: f?.ids.length ? f.body : d.target_body,
      };
    },
  },
  // ---- repeat ----
  {
    id: 'pattern', title: 'Pattern', icon: 'i-lucide-grid-3x3', group: 'repeat',
    hint: 'Linear: copies along an axis of the plane. Circular: copies around the plane’s normal (pick a cylindrical face for its axis).',
    rows: [
      { key: 'pattern_circular', label: 'Type', kind: 'enum', options: [[0, 'Linear'], [1, 'Circular']] },
      { key: 'target_body', label: 'Body', kind: 'body' },
      { key: 'pattern_count', label: 'Count', kind: 'int', min: 1, max: 999 },
      { key: 'pattern_spacing', label: 'Spacing', kind: 'number', unit: MM, min: 0.01, when: (d) => !d.pattern_circular },
      { key: 'pattern_dir', label: 'Direction', kind: 'enum', options: [[0, 'Plane X'], [1, 'Plane Y']], when: (d) => !d.pattern_circular },
      { key: 'pattern_angle', label: 'Total angle', kind: 'number', unit: DEG, min: 1, max: 360, when: (d) => !!d.pattern_circular },
      { key: 'plane', label: 'Plane / axis', kind: 'plane', axes: true },
    ],
    needs: (c) => (hasBody(c) ? null : 'Create a solid body to pattern first'),
    init: (c, p) => ({ pattern_circular: 0, target_body: pickedBody(c, p), pattern_count: 3, pattern_spacing: 20, pattern_dir: 0, pattern_angle: 360, plane: 'XY', planeFace: null }),
    type: () => 'Pattern',
    fields: async (d, k, c) => ({
      plane: await resolvePlane(d.plane, fresh(pv(d.planeFace), c, 'face'), k, c), pattern_circular: !!d.pattern_circular, pattern_count: d.pattern_count, pattern_spacing: d.pattern_spacing,
      pattern_dir: d.pattern_dir, pattern_angle: d.pattern_angle, pattern_inclusive: true, target_body: d.target_body,
    }),
  },
  {
    id: 'mirror', title: 'Mirror', icon: 'i-lucide-flip-horizontal-2', group: 'repeat',
    hint: 'Reflect the selected body about a plane. The mirror is always a new body; keeping the original gives you both.',
    rows: [
      { key: 'target_body', label: 'Body', kind: 'body' },
      { key: 'plane', label: 'Mirror plane', kind: 'plane' },
      { key: 'mirror_keep_original', label: 'Keep original', kind: 'bool' },
    ],
    needs: needBody('Mirror'),
    init: (c, p) => ({ target_body: pickedBody(c, p), plane: 'XY', planeFace: null, mirror_keep_original: true }),
    type: () => 'Mirror',
    fields: async (d, k, c) => ({ plane: await resolvePlane(d.plane, fresh(pv(d.planeFace), c, 'face'), k, c), mirror_keep_original: d.mirror_keep_original, mode: d.mirror_keep_original ? 'New' : 'Add', target_body: d.target_body }),
  },
  // ---- placement ----
  {
    id: 'transform', title: 'Transform', icon: 'i-lucide-move-3d', group: 'placement',
    hint: 'Translate and/or rotate the selected body. Rotation is applied about the pivot, then translation follows.',
    rows: [
      { key: 'target_body', label: 'Body', kind: 'body' },
      { key: 'xf_translate', label: 'Translate', kind: 'vec3', unit: MM },
      { key: 'axis', label: 'Rotate axis', kind: 'axisDir' },
      { key: 'xf_angle_deg', label: 'Angle', kind: 'number', unit: DEG, min: -360, max: 360 },
      { key: 'xf_pivot', label: 'Pivot', kind: 'vec3', unit: MM },
      { key: 'xf_copy', label: 'Keep original (make a copy)', kind: 'bool' },
    ],
    needs: needBody('Transform'),
    init: (c, p) => {
      const b = c.bodies[pickedBody(c, p)];
      const centre = b?.center ?? [0, 0, 0];
      return { target_body: pickedBody(c, p), xf_translate: [0, 0, 0], axis: 'Z', xf_angle_deg: 0, xf_pivot: centre.map((v) => Math.round(v * 100) / 100), xf_copy: false };
    },
    type: () => 'Transform',
    fields: async (d) => ({
      target_body: d.target_body, xf_translate: d.xf_translate, xf_axis: d.axis === 'X' ? [1, 0, 0] : d.axis === 'Y' ? [0, 1, 0] : [0, 0, 1], xf_angle_deg: d.xf_angle_deg,
      xf_pivot: d.xf_pivot, xf_copy: d.xf_copy,
    }),
  },
  // ---- combine ----
  {
    id: 'boolean', title: 'Boolean', icon: 'i-lucide-combine', group: 'combine',
    hint: 'Combine two bodies: the target is kept, the tool is used up (unless you keep it).',
    rows: [
      { key: 'mode', label: 'Operation', kind: 'enum', options: [['Add', 'Join'], ['Cut', 'Subtract'], ['Intersect', 'Intersect']] },
      { key: 'target_body', label: 'Target (kept)', kind: 'body' },
      { key: 'bool_tool_body', label: 'Tool', kind: 'body' },
      { key: 'bool_tolerance', label: 'Tolerance', kind: 'number', unit: MM, min: 0, max: 100 },
      { key: 'bool_keep_tool', label: 'Keep tool body', kind: 'bool' },
    ],
    needs: (c) => (c.bodies.filter((b) => b.face_count > 0).length >= 2 ? null : 'Boolean needs two bodies — add or import a second one'),
    init: (c, p) => {
      const t = p && c.bodies[p.body] ? p.body : 0;
      const tool = c.bodies.find((b) => b.index !== t && b.face_count > 0)?.index ?? (t === 0 ? 1 : 0);
      return { mode: 'Add', target_body: t, bool_tool_body: tool, bool_tolerance: 0, bool_keep_tool: false };
    },
    type: () => 'Boolean',
    validate: (d) => (d.target_body === d.bool_tool_body ? 'The target and the tool must be two different bodies' : null),
    fields: async (d) => ({ mode: d.mode, target_body: d.target_body, bool_tool_body: d.bool_tool_body, bool_tolerance: d.bool_tolerance, bool_keep_tool: d.bool_keep_tool }),
  },
  {
    id: 'cut', title: 'Cut', icon: 'i-lucide-slice', group: 'combine',
    hint: 'Split a body with a plane (or a picked face). Both halves are kept unless you untick one.',
    rows: [
      { key: 'target_body', label: 'Body', kind: 'body' },
      { key: 'by', label: 'Split with', kind: 'enum', options: [['plane', 'Plane'], ['face', 'Face of a body']] },
      { key: 'plane', label: 'Plane', kind: 'plane', when: (d) => d.by !== 'face' },
      { key: 'cut_offset', label: 'Offset', kind: 'number', unit: MM, min: -10000, max: 10000, when: (d) => d.by !== 'face' },
      { key: 'face', label: 'Splitting face', kind: 'pick', pick: 'face', prompt: PICK_FACE, when: (d) => d.by === 'face', required: 'Pick the face to split with' },
      { key: 'cut_keep_upper', label: 'Keep upper part', kind: 'bool' },
      { key: 'cut_keep_lower', label: 'Keep lower part', kind: 'bool' },
      { key: 'cut_flip', label: 'Flip', kind: 'bool' },
    ],
    needs: (c) => (hasBody(c) ? null : 'Create a solid body to cut first'),
    init: (c, p) => ({ target_body: pickedBody(c, p), by: 'plane', plane: 'XY', planeFace: null, cut_offset: 0, face: null, cut_keep_upper: true, cut_keep_lower: true, cut_flip: false }),
    type: () => 'Cut',
    validate: (d) => (!d.cut_keep_upper && !d.cut_keep_lower ? 'Keep at least one side of the cut' : null),
    fields: async (d, k, c) => {
      const common = { target_body: d.target_body, cut_keep_upper: d.cut_keep_upper, cut_keep_lower: d.cut_keep_lower, cut_flip: d.cut_flip };
      if (d.by === 'face') { const f = fresh(pv(d.face), c, 'face')!; return { ...common, cut_face_body: f.body, cut_face: f.ids[0] }; }
      return { ...common, plane: await resolvePlane(d.plane, fresh(pv(d.planeFace), c, 'face'), k, c), cut_offset: d.cut_offset, cut_face_body: -1, cut_face: -1 };
    },
  },
  // ---- reference ----
  {
    id: 'plane', title: 'Plane', icon: 'i-lucide-square-dashed', group: 'reference', noPreview: true,
    hint: 'A datum plane to sketch on, mirror about or cut with.',
    rows: [
      { key: 'plane_type', label: 'Plane type', kind: 'enum', options: [['Offset', 'Offset'], ['Angle', 'Angle'], ['Midplane', 'Midplane'], ['Tangent', 'Tangent'], ['TwoEdges', 'Two edges'], ['Coincident', 'Coincident']] },
      { key: 'plane_base', label: 'Base', kind: 'datum', when: (d) => (d.plane_type === 'Offset' || d.plane_type === 'Angle') && !pv(d.faceA)?.ids.length },
      { key: 'faceA', label: 'Face A', kind: 'pick', pick: 'face', prompt: PICK_FACE, when: (d) => d.plane_type !== 'TwoEdges' },
      { key: 'faceB', label: 'Face B', kind: 'pick', pick: 'face', prompt: PICK_FACE, when: (d) => d.plane_type === 'Midplane' },
      { key: 'edgeA', label: 'Edge A', kind: 'pick', pick: 'edge', prompt: PICK_EDGE, when: (d) => d.plane_type === 'Angle' || d.plane_type === 'TwoEdges' },
      { key: 'edgeB', label: 'Edge B', kind: 'pick', pick: 'edge', prompt: PICK_EDGE, when: (d) => d.plane_type === 'TwoEdges' },
      { key: 'plane_offset', label: 'Offset', kind: 'number', unit: MM, min: -10000, max: 10000, when: (d) => d.plane_type === 'Offset' },
      { key: 'plane_angle_tilt', label: 'Angle', kind: 'number', unit: DEG, min: -180, max: 180, when: (d) => d.plane_type === 'Angle' || d.plane_type === 'Tangent' },
      { key: 'plane_axis', label: 'Tilt axis', kind: 'enum', options: [[0, 'Base X'], [1, 'Base Y']], when: (d) => d.plane_type === 'Angle' && !pv(d.edgeA)?.ids.length },
      { key: 'plane_u_size', label: 'Size U', kind: 'number', unit: MM, min: 1 },
      { key: 'plane_v_size', label: 'Size V', kind: 'number', unit: MM, min: 1 },
    ],
    // Orca ignores the preselection here (reset_plane_refs); a picked flat face is the obvious base though.
    init: (_c, p) => ({ plane_type: 'Offset', plane_base: 0, faceA: faceOf(p), faceB: null, edgeA: null, edgeB: null, plane_offset: 20, plane_angle_tilt: 0, plane_axis: 0, plane_u_size: 60, plane_v_size: 60 }),
    type: () => 'Plane',
    validate: (d) => {
      const a = pv(d.faceA), b = pv(d.faceB), ea = pv(d.edgeA), eb = pv(d.edgeB);
      switch (d.plane_type) {
        case 'Angle': return ea?.ids.length ? null : 'An angled plane needs an edge to tilt about — pick Edge A';
        case 'Midplane': return !a?.ids.length || !b?.ids.length ? 'A midplane needs two faces — pick Face A and Face B' : a.body === b.body && a.ids[0] === b.ids[0] ? 'Face A and Face B are the same face — a midplane needs two different faces' : null;
        case 'Tangent': return a?.ids.length ? null : 'A tangent plane needs a cylindrical face — pick Face A';
        case 'TwoEdges': return ea?.ids.length && eb?.ids.length ? null : 'This plane needs two edges — pick Edge A and Edge B';
        case 'Coincident': return a?.ids.length ? null : 'Pick the face the plane lies on — Face A';
        default: return null;
      }
    },
    fields: async (d, _k, c) => {
      const ref = (v: unknown, what: string) => { const p = fresh(pv(v), c, what); return p?.ids.length ? p : null; };
      const a = ref(d.faceA, 'face'), b = ref(d.faceB, 'face'), ea = ref(d.edgeA, 'edge'), eb = ref(d.edgeB, 'edge');
      const t = d.plane_type;
      return {
        plane_type: t, plane_base: d.plane_base, plane_offset: d.plane_offset, plane_angle_tilt: d.plane_angle_tilt, plane_axis: d.plane_axis, plane_u_size: d.plane_u_size, plane_v_size: d.plane_v_size,
        plane_face_body: t !== 'TwoEdges' && a ? a.body : -1, plane_face: t !== 'TwoEdges' && a ? a.ids[0] : -1,
        plane_face2_body: t === 'Midplane' && b ? b.body : -1, plane_face2: t === 'Midplane' && b ? b.ids[0] : -1,
        plane_edge_body: (t === 'Angle' || t === 'TwoEdges') && ea ? ea.body : -1, plane_edge: (t === 'Angle' || t === 'TwoEdges') && ea ? ea.ids[0] : -1,
        plane_edge2_body: t === 'TwoEdges' && eb ? eb.body : -1, plane_edge2: t === 'TwoEdges' && eb ? eb.ids[0] : -1,
      };
    },
  },
  {
    id: 'axis', title: 'Axis', icon: 'i-lucide-move-diagonal', group: 'reference', noPreview: true,
    hint: 'A datum axis: for circular patterns and threads, or as a revolve reference.',
    rows: [
      { key: 'axis_type', label: 'Axis type', kind: 'enum', options: [['TwoPoints', 'Two points'], ['FaceNormal', 'Face normal'], ['CylinderCenterline', 'Cylinder centerline'], ['PlaneIntersection', 'Plane intersection'], ['AlongEdge', 'Along edge']] },
      { key: 'face', label: 'Face', kind: 'pick', pick: 'face', prompt: PICK_FACE, when: (d) => d.axis_type === 'FaceNormal' || d.axis_type === 'CylinderCenterline', required: 'Pick the face for the axis' },
      { key: 'edge', label: 'Edge', kind: 'pick', pick: 'edge', prompt: PICK_EDGE, when: (d) => d.axis_type === 'AlongEdge', required: 'Pick the edge for the axis' },
      { key: 'axis_plane_a', label: 'Plane A', kind: 'datum', when: (d) => d.axis_type === 'PlaneIntersection' },
      { key: 'axis_plane_b', label: 'Plane B', kind: 'datum', when: (d) => d.axis_type === 'PlaneIntersection' },
      { key: 'axis_p1', label: 'Point 1', kind: 'vec3', unit: MM, when: (d) => d.axis_type === 'TwoPoints' },
      { key: 'axis_p2', label: 'Point 2', kind: 'vec3', unit: MM, when: (d) => d.axis_type === 'TwoPoints' },
    ],
    init: (_c, p) => ({
      axis_type: p?.kind === 'edge' ? 'AlongEdge' : p?.kind === 'face' ? 'FaceNormal' : 'TwoPoints', face: faceOf(p), edge: p?.kind === 'edge' ? { body: p.body, ids: [p.edge], generation: p.generation } : null, axis_plane_a: 0, axis_plane_b: 1,
      axis_p1: [0, 0, 0], axis_p2: [10, 0, 0],
    }),
    type: () => 'Axis',
    changed: async (key, d, k) => {
      if (key !== 'face' || !pv(d.face)?.ids.length) return;
      const info = await faceInfo(k, pv(d.face)!);
      if (info.cylinder && d.axis_type === 'FaceNormal') d.axis_type = 'CylinderCenterline';
    },
    validate: (d) => (d.axis_type === 'PlaneIntersection' && d.axis_plane_a === d.axis_plane_b ? 'Plane A and Plane B must be two different planes' : null),
    fields: async (d, _k, c) => {
      const t = d.axis_type;
      const f = t === 'FaceNormal' || t === 'CylinderCenterline' ? fresh(pv(d.face), c, 'face') : null;
      const e = t === 'AlongEdge' ? fresh(pv(d.edge), c, 'edge') : null;
      return {
        axis_type: t, axis_p1: d.axis_p1, axis_p2: d.axis_p2, axis_plane_a: d.axis_plane_a, axis_plane_b: d.axis_plane_b,
        axis_body: f?.body ?? e?.body ?? -1, axis_face: f?.ids[0] ?? -1, axis_edge: e?.ids[0] ?? -1,
      };
    },
  },
  {
    id: 'helix', title: 'Helix', icon: 'i-lucide-git-commit-vertical', group: 'reference', noPreview: true,
    hint: 'A helical path for sweeps (springs, custom threads).',
    rows: [
      { key: 'plane', label: 'Plane', kind: 'plane', axes: true },
      { key: 'helix_radius', label: 'Radius', kind: 'number', unit: MM, min: 0.01 },
      { key: 'helix_pitch', label: 'Pitch', kind: 'number', unit: MM, min: 0.01 },
      { key: 'helix_height', label: 'Height', kind: 'number', unit: MM, min: 0.01 },
      { key: 'helix_taper_deg', label: 'Taper', kind: 'number', unit: DEG, min: -80, max: 80 },
      { key: 'helix_left_handed', label: 'Left-handed', kind: 'bool' },
    ],
    init: () => ({ plane: 'XY', planeFace: null, helix_radius: 10, helix_pitch: 5, helix_height: 20, helix_taper_deg: 0, helix_left_handed: false }),
    type: () => 'Helix',
    fields: async (d, k, c) => ({
      plane: await resolvePlane(d.plane, fresh(pv(d.planeFace), c, 'face'), k, c), helix_radius: d.helix_radius, helix_pitch: d.helix_pitch, helix_height: d.helix_height,
      helix_taper_deg: d.helix_taper_deg, helix_left_handed: d.helix_left_handed,
    }),
  },
];

export const TOOL_GROUPS: Array<{ id: ToolGroup; label: string }> = [
  { id: 'material', label: 'Add material' },
  { id: 'dressup', label: 'Fillet / chamfer / draft' },
  { id: 'hole', label: 'Hole / thread' },
  { id: 'repeat', label: 'Repeat' },
  { id: 'placement', label: 'Transform' },
  { id: 'combine', label: 'Combine / cut' },
  { id: 'reference', label: 'Reference' },
];

export function getTool(id: string): CreateTool | undefined { return CREATE_TOOLS.find((t) => t.id === id); }

/** Is a pick an acceptable click for this pick row? (Plane rows: flat, or cylindrical when `axes`.) */
export async function acceptFace(hit: PickHit, k: KernelReads, kind: 'flat' | 'cylinder'): Promise<string | null> {
  if (hit.face === undefined) return null;
  const f = await k.call<FaceInfo>('face_info', { body: hit.body, face: hit.face, generation: hit.generation });
  if (kind === 'flat') return f.plane ? null : 'That face is not flat — click a flat face';
  return f.cylinder ? null : 'Pick a cylindrical surface (bore / outer) for a thread';
}

export async function acceptPlaneFace(hit: PickHit, k: KernelReads, axes: boolean): Promise<string | null> {
  if (hit.face === undefined) return null;
  const f = await k.call<FaceInfo>('face_info', { body: hit.body, face: hit.face, generation: hit.generation });
  if (f.plane || (axes && f.cylinder)) return null;
  return axes ? 'That face is neither flat nor cylindrical — click a flat face, or a cylinder for its axis' : 'That face is not flat — click a flat face or choose a plane';
}

export type { EdgeInfo };

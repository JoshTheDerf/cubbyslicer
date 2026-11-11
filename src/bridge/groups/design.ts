/**
 * Bridge tools: the Design tab (src/design, OrcaSlicer 2.5's parametric CAD). Names are
 * `design_` + the kernel / McpControl method they run (docs/CAD-KERNEL-CONTRACT.md), with the
 * same argument names: an agent that knows Orca's control surface transfers directly. Each
 * mutating tool is one design edit — one kernel rebuild and one undo step, exactly like the UI's.
 * Face / edge ids belong to one `generation`: re-read them after every edit.
 *
 * Covered: describe the design (opening it if needed), read a feature, edit parameters and
 * expressions, variables, suppress (with force for repairs), rename / move / delete features;
 * the McpControl build verbs on existing geometry (fillet, chamfer, shell, draft, hole,
 * hole_styled, hole_standard, thread, pattern, mirror, transform, boolean, cut, split, thicken,
 * delete_face, plane_datum, axis, helix) and on sketches already in the document (extrude,
 * revolve, sweep, loft); add_feature / feature_preview with any CadFeature fields; bodies
 * (set_body, delete); topology reads (face_info, edge_info, plane_of_face, datums,
 * mass_properties, the thread / hole standards); STEP / mesh in and out; CubbyCAD shapes as
 * bodies; commit (assembly or separate bodies).
 */
import { argString, base64ToBytes, bytesToBase64, type BridgeTool } from '@cubby/shared/bridge';
import { activeView } from '../../app/state';
import { commitToPlate, deleteBody, deleteFeature, getFeature, moveFeature, renameFeature, setBodyColor, setFeatureParams, setSuppressed, setVariable, renameBody } from '../../design/commands';
import { standards } from '../../design/create';
import { exportStepBytes, importMeshToDesign, importObjectMesh, importStepToDesign } from '../../design/io';
import { addPrimitiveBody, convertObjectToBody } from '../../design/primitives';
import { decodePlateMeshes } from '../../design/kernel/mesh';
import type { PlateMeshLayout } from '../../design/kernel/types';
import { getObject, selectedIds } from '../../project/store';
import { design, designKernel, designReady, readDesign, runEdit } from '../../design/session';
import type { MutationResult } from '../../design/kernel/types';
import { designLinks } from '../../project/store';
import { resolveLink } from '../../design/link';
import { bool, num, obj, objectDetail, oneOfS, str, vec3s } from './util';
import * as SK from '../../design/sketch/session';
import { entity as skEntity, CONSTRAINT_TYPES, type SkConstraint, type SkConstraintType, type SkEntity, type SkType, type V2 } from '../../design/sketch/model';
import { DRAW_TOOL_BY_ID } from '../../design/sketch/shapes';
import { describeConstraint, fromWire, toWire } from '../../design/sketch/constraints';

function featureIndex(args: Record<string, unknown>, key = 'index'): number {
  const i = Number(args[key]);
  if (!Number.isInteger(i) || i < 0 || i >= design.features.length) throw new Error(`"${key}" must be a feature index 0–${design.features.length - 1} (see design_describe_scene).`);
  return i;
}

async function ready(): Promise<void> {
  await designReady();
  if (design.phase === 'unreadable') throw new Error(`The project's design can't be opened: ${design.phaseMessage}`);
  if (design.phase !== 'open') throw new Error(design.phaseMessage || 'The design is not open.');
}

/** describe_scene, plus what the app knows on top (failing feature, plate links). */
function sceneSummary() {
  return {
    generation: design.generation,
    read_only: design.readOnly || undefined,
    read_only_reason: design.readOnly ? design.readOnlyReason : undefined,
    rebuild_ok: design.ok,
    error: design.error || undefined,
    failing_feature: design.failing ? { index: design.failing.index, name: design.features[design.failing.index]?.name, error: design.failing.error } : undefined,
    modeling_origin: design.modelingOrigin,
    features: design.features.map((f) => ({ ...f, error: design.featureErrors[f.index] })),
    bodies: design.bodies.map((b) => ({
      index: b.index, name: b.name, source_feature: b.source_feature, face_count: b.face_count, edge_count: b.edge_count, is_solid: b.is_solid,
      bbox: b.bbox, on_plate: [...new Set(designLinks().filter((l) => resolveLink(l.link, design.bodies) === b.index).map((l) => l.owner.id))],
    })),
    variables: design.variables,
    mate_conflicts: design.mateConflicts.length ? design.mateConflicts : undefined,
    last_rebuild_ms: Math.round(design.lastRebuildMs),
  };
}

const outcome = (r: { ok: boolean; error: string; result: MutationResult | null }) => ({
  ok: r.ok, error: r.error || undefined, kept: r.result?.kept, generation: design.generation, rebuild_ok: design.ok, design_error: design.error || undefined,
  bodies: design.bodies.length,
});

const anyArgs = (description: string): Record<string, unknown> => ({ type: 'object', description, additionalProperties: true });

/**
 * A McpControl build verb as a tool: same name (design_<verb>) and arguments, one rebuild and
 * one undo step; the result carries the verb's own fields (`fillet_index`, …).
 */
function verbTool(method: string, description: string, props: Record<string, unknown>, required: string[] = []): BridgeTool {
  return {
    name: `design_${method}`,
    description: `${description} McpControl \`${method}\` (CAD-KERNEL-CONTRACT.md "Build verbs"): one rebuild, one undo step; a geometry failure is ok:false with the kernel's message (nothing changes). Pass \`generation\` with face / edge ids (design_query_topology).`,
    timeoutMs: 900_000,
    inputSchema: obj({ ...(props as Record<string, never>), name: str('Feature name (default: the kernel’s).'), generation: num('The generation the face / edge ids were read at.') }, required),
    async run(args) {
      await ready();
      const params: Record<string, unknown> = { ...args };
      if ('sweep_path' in params) { params.path = params.sweep_path; delete params.sweep_path; }
      let extra: Record<string, unknown> = {};
      const r = await runEdit(`Add ${method.replace(/_/g, ' ')}`, async (c, doc) => {
        const res = (await c.call<MutationResult & Record<string, unknown>>(method, { doc, ...params })).result;
        extra = Object.fromEntries(Object.entries(res).filter(([k]) => k.endsWith('_index') || k === 'end' || k === 'imported' || k === 'first_feature'));
        return res;
      });
      return { data: { ...outcome(r), ...extra } };
    },
  };
}

const ID = (what: string) => num(`${what} id (design_query_topology, same generation).`);
const BODY = num('Target body index (default -1 = last body).');
const PLANE = { description: 'Plane: "XY" | "XZ" | "YZ" (through the modeling origin) or a frame {origin, normal, x_axis, y_axis} (design_plane_of_face, design_datums).' };

// ---- sketch session tools -------------------------------------------------------------------------

/** The open sketch, as the tools report it (angles in degrees, as everywhere in the tools). */
function sketchState() {
  const k = SK.sk;
  if (!k.open) return { open: false };
  return {
    open: true, feature: k.feature, plane: k.plane, plane_label: k.planeLabel,
    entities: k.entities.map((e, i) => ({ index: i, ...e })),
    constraints: k.constraints.map((c, i) => ({ index: i, ...c, value: fromWire(c.type, c.value), text: describeConstraint(c, k.entities) })),
    dof: k.dof, solve_ok: k.solveOk, bad: k.bad, skipped: k.skipped, status: SK.dofText(),
    closed_loops: k.loops?.closed_loops.filter((l) => l.closed).length ?? 0, open_ends: k.loops?.open_ends ?? [], buildable: k.loops?.buildable ?? false,
    regions: k.regions ? { label: k.regions.label, count: k.regions.regions.length, offset: k.regions.offset, scale: k.regions.scale } : undefined,
    undo_steps: k.undo.length,
  };
}
function needSketch(): void { if (!SK.sk.open) throw new Error('No sketch is open: call design_sketch_begin first.'); }
const ROLE = oneOfS(['p0', 'p1', 'center'], 'Point role: p0 (start) | p1 (end) | center.');
const ENT_TYPES: SkType[] = ['line', 'arc', 'circle', 'point', 'ellipse', 'ellipse_arc', 'spline'];
/** An entity from the kernel's JSON or McpControl's shorthands (`p`, `centre`, `bspline`). */
function entityArg(e: Record<string, unknown>): SkEntity {
  const t = String(e.type ?? '').replace('bspline', 'spline').replace('ellipseArc', 'ellipse_arc') as SkType;
  if (!ENT_TYPES.includes(t)) throw new Error(`Entity type must be one of ${ENT_TYPES.join(', ')}.`);
  const v2 = (x: unknown) => (Array.isArray(x) && x.length >= 2 ? [Number(x[0]), Number(x[1])] as V2 : undefined);
  return skEntity(t, {
    p0: v2(e.p0 ?? e.p), p1: v2(e.p1), center: v2(e.center ?? e.centre), radius: e.radius !== undefined ? Number(e.radius) : undefined,
    start_angle: e.start_angle !== undefined ? Number(e.start_angle) : undefined, end_angle: e.end_angle !== undefined ? Number(e.end_angle) : undefined,
    construction: !!e.construction, rminor: e.rminor !== undefined ? Number(e.rminor) : undefined, rotation: e.rotation !== undefined ? Number(e.rotation) : undefined,
    ctrl: Array.isArray(e.ctrl) ? (e.ctrl as unknown[]).map((q) => v2(q)!).filter(Boolean) : undefined,
  });
}
function constraintArg(c: Record<string, unknown>): SkConstraint {
  const type = String(c.type ?? '').replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`) as SkConstraintType;
  if (!(CONSTRAINT_TYPES as readonly string[]).includes(type)) throw new Error(`Constraint type must be one of ${CONSTRAINT_TYPES.join(', ')}.`);
  const r = (x: unknown) => (x === 'p1' || x === 'center' ? x : 'p0') as 'p0' | 'p1' | 'center';
  return { type, ea: Number(c.ea ?? -1), ra: r(c.ra), eb: Number(c.eb ?? -1), rb: r(c.rb), value: toWire(type, Number(c.value ?? 0)), ec: Number(c.ec ?? -1), rc: r(c.rc) };
}
const ENTITY_SCHEMA = { type: 'object', additionalProperties: true, description: 'Sketch entity (contract "Sketch JSON"): {type: line|arc|circle|point|ellipse|ellipse_arc|spline, p0, p1, center, radius, start_angle, end_angle (radians), rminor, rotation, ctrl:[[x,y]…], construction}. Shorthands: point {p:[x,y]}, centre.' };
const CONSTRAINT_SCHEMA = { type: 'object', additionalProperties: true, description: `Constraint {type, ea, ra, eb, rb, ec, rc, value}: type one of ${CONSTRAINT_TYPES.join(', ')}; ea/eb/ec entity indices (-2 the sketch origin, -3 X axis, -4 Y axis); roles p0|p1|center; value in mm, angles in DEGREES.` };

function sketchTools(): BridgeTool[] {
  const st = () => ({ data: sketchState() });
  return [
    {
      name: 'design_sketch_begin',
      description: 'Open a sketch (Orca sketch_begin), as the Sketch button does: on a base plane (`plane` XY | XZ | YZ, or a frame {origin, normal, x_axis, y_axis}), on a flat face (`body` + `face` + `generation` from design_query_topology), or edit an existing Sketch feature (`feature`). Other design edits wait until design_sketch_commit / design_sketch_cancel. Coordinates are plane mm.',
      timeoutMs: 600_000,
      inputSchema: obj({ plane: { description: 'XY | XZ | YZ, or a plane frame.' }, body: num('Body of the face to sketch on.'), face: num('Face id.'), generation: num('Generation the face id is from.'), feature: num('A Sketch feature to edit.') }),
      async run(args) {
        await ready();
        if (SK.sk.open) throw new Error('A sketch is already open (design_sketch_commit or design_sketch_cancel it first).');
        const ok = args.feature !== undefined ? await SK.beginSketch({ feature: featureIndex(args, 'feature') })
          : args.face !== undefined ? await SK.beginSketch({ face: { body: Number(args.body ?? 0), face: Number(args.face) }, generation: Number(args.generation ?? design.generation) })
            : await SK.beginSketch({ plane: (typeof args.plane === 'object' && args.plane ? args.plane : String(args.plane ?? 'XY').toUpperCase()) as 'XY' });
        if (!ok) throw new Error(design.status?.text ?? 'The sketch could not be opened.');
        return st();
      },
    },
    { name: 'design_sketch_describe', description: 'The open sketch: entities, constraints (angles in degrees), degrees of freedom, conflicts (`bad`), closed loops / open ends (Orca sketch_describe).', inputSchema: obj({}), async run() { return st(); } },
    {
      name: 'design_sketch_add',
      description: 'Add entities (Orca sketch_add): `entities:[…]`, or `rect:[x0,y0,x1,y1]` (a constrained rectangle), or a drawing tool by `tool` + `points` (the clicks: line, rect, rect-center, rect-3pt, rect-rounded, circle, circle-2pt, circle-3pt, arc-3pt, arc-center, slot, arc-slot (centre, start, end, width), polygon (+ `sides`), ellipse, ellipse-arc, spline, point) which also adds the shape’s constraints, as the mouse tool does (same shape labels). `constraints` are added with them (indices absolute). `infer` (default true), at zero tolerance: joins new ends that lie exactly on existing ends (a tool’s clicks also on a centre or the origin) and makes exactly level / plumb lines H / V; for `entities` it is the kernel’s scripted add, which also pins exactly-true relations (parallel, equal …) within the batch. A constraint that would over-constrain the sketch is left out and listed in `dropped_constraints`. One sketch undo step.',
      timeoutMs: 300_000,
      inputSchema: obj({ entities: { type: 'array', items: ENTITY_SCHEMA }, rect: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, tool: str('A drawing tool id (see above).'), points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'The tool’s clicks, plane mm.' }, sides: num('Polygon sides (default 6).'), construction: bool('Make the new entities construction geometry.'), constraints: { type: 'array', items: CONSTRAINT_SCHEMA }, infer: bool('Infer exact Coincident / H / V (default true).') }),
      async run(args) {
        needSketch();
        const cons: SkConstraint[] = ((args.constraints as Record<string, unknown>[] | undefined) ?? []).map(constraintArg);
        const infer = args.infer !== false;
        const tool = args.rect ? 'rect' : args.tool ? String(args.tool) : '';
        let r: { first: number; added: number; dropped: SkConstraint[] };
        if (tool) {
          const t = DRAW_TOOL_BY_ID.get(tool as never);
          if (!t) throw new Error(`Unknown tool "${tool}".`);
          const pts = (args.rect ? [[Number((args.rect as number[])[0]), Number((args.rect as number[])[1])], [Number((args.rect as number[])[2]), Number((args.rect as number[])[3])]] : ((args.points as number[][] | undefined) ?? []).map((q) => [Number(q[0]), Number(q[1])])) as V2[];
          const s = await SK.addShape(t, pts, { infer, construction: !!args.construction, sides: Number(args.sides ?? 6), constraints: cons });
          if (!s) throw new Error(`${t.title}: those points don’t make a shape (${t.prompts.join(' → ')}).`);
          r = s;
        } else {
          const ents: SkEntity[] = ((args.entities as Record<string, unknown>[] | undefined) ?? []).map((e) => ({ ...entityArg(e), construction: !!e.construction || !!args.construction }));
          if (!ents.length) throw new Error('Nothing to add: give `entities`, `rect` or `tool` + `points`.');
          r = { ...(await SK.addEntities(ents, cons, 'Add', { infer })), added: ents.length };
        }
        return { data: { first_index: r.first, added: r.added, dropped_constraints: r.dropped.length ? r.dropped : undefined, ...sketchState() } };
      },
    },
    {
      name: 'design_sketch_constrain',
      description: 'Add constraints / dimensions (`constraint` or `constraints`; angles in degrees). A batch the solver can’t satisfy is not added: the result names the constraints it conflicts with (`conflicts_with`). `force` keeps it anyway (the sketch is then over-constrained, `bad` lists it). Use design_sketch_plan to let Orca’s planner build the constraint for a selection.',
      timeoutMs: 300_000,
      inputSchema: obj({ constraint: CONSTRAINT_SCHEMA, constraints: { type: 'array', items: CONSTRAINT_SCHEMA }, force: bool('Keep even if unsolvable.') }),
      async run(args) {
        needSketch();
        const list = (args.constraints ? (args.constraints as Record<string, unknown>[]) : [args.constraint as Record<string, unknown>]).filter(Boolean).map(constraintArg);
        if (!list.length) throw new Error('Give `constraint` or `constraints`.');
        const err = await SK.addConstraints(list, { force: !!args.force });
        const cf = SK.sk.conflict;
        return { data: { ok: !err, error: err ?? undefined, conflicts_with: cf?.offenders.map((i) => ({ index: i, text: describeConstraint(SK.sk.constraints[i], SK.sk.entities) })), ...sketchState() } };
      },
    },
    {
      name: 'design_sketch_plan',
      description: 'What a constraint button would do with these entities (Orca plan_entity_constraint; vertex selections planned the same way): apply / ask_value (prefill in mm or degrees) / reject (reason). `entities` are indices, or {e, role} for a vertex.',
      inputSchema: obj({ type: oneOfS(CONSTRAINT_TYPES, 'Constraint type.'), entities: { type: 'array', items: {}, description: 'Entity indices, or {e, role} vertices.' } }, ['type', 'entities']),
      async run(args) {
        needSketch();
        const sel = ((args.entities as unknown[]) ?? []).map((x) => (typeof x === 'object' && x ? { e: Number((x as { e: unknown }).e), role: (x as { role?: 'p0' }).role } : { e: Number(x) }));
        const p = await SK.planFor(String(args.type) as SkConstraintType, sel);
        return { data: p.kind === 'reject' ? p : { ...p, constraints: p.constraints.map((c) => ({ ...c, value: fromWire(c.type, c.value) })) } };
      },
    },
    {
      name: 'design_sketch_set_constraint', description: 'Change a dimension’s value (kernel sketch_set_constraint; angles in degrees). An unsatisfiable value changes nothing and says why.',
      inputSchema: obj({ index: num('Constraint index.'), value: num('New value (mm / degrees).') }, ['index', 'value']),
      async run(args) { needSketch(); const err = await SK.setConstraintValue(Number(args.index), Number(args.value)); return { data: { ok: !err, error: err ?? undefined, ...sketchState() } }; },
    },
    {
      name: 'design_sketch_delete_constraint', description: 'Delete constraints by index (re-solves).',
      inputSchema: obj({ index: num('Constraint index.'), indices: { type: 'array', items: { type: 'number' } } }),
      async run(args) { needSketch(); await SK.deleteConstraints(args.indices ? (args.indices as number[]).map(Number) : [Number(args.index)]); return st(); },
    },
    {
      name: 'design_sketch_delete', description: 'Delete entities (Orca sketch_delete; their constraints go with them, the others are re-indexed).',
      inputSchema: obj({ entities: { type: 'array', items: { type: 'number' } } }, ['entities']),
      async run(args) { needSketch(); SK.sk.sel = (args.entities as number[]).map((e) => ({ e: Number(e) })); await SK.deleteSelection(); return st(); },
    },
    {
      name: 'design_sketch_construction', description: 'Toggle construction geometry on entities (Orca sketch_construction).',
      inputSchema: obj({ entities: { type: 'array', items: { type: 'number' } } }, ['entities']),
      async run(args) { needSketch(); SK.sk.sel = (args.entities as number[]).map((e) => ({ e: Number(e) })); await SK.toggleConstruction(); return st(); },
    },
    {
      name: 'design_sketch_drag', description: 'Drag a point under the solver (kernel sketch_drag: what the constraints allow moves; the other end of a dragged line stays put).',
      inputSchema: obj({ entity: num('Entity index.'), role: ROLE, to: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }, ['entity', 'role', 'to']),
      async run(args) {
        needSketch();
        SK.beginGesture('Drag'); SK.drag({ kind: 'point', entity: Number(args.entity), role: String(args.role) as 'p0', to: [Number((args.to as number[])[0]), Number((args.to as number[])[1])] }); await SK.endGesture();
        return st();
      },
    },
    {
      name: 'design_sketch_offset', description: 'Offset entities by a distance (Orca sketch_offset; chains miter-joined; negative = the other side).',
      inputSchema: obj({ entities: { type: 'array', items: { type: 'number' } }, distance: num('mm') }, ['entities', 'distance']),
      async run(args) { needSketch(); const err = await SK.offsetEntities((args.entities as number[]).map(Number), Number(args.distance)); return { data: { ok: !err, error: err ?? undefined, ...sketchState() } }; },
    },
    {
      name: 'design_sketch_mirror', description: 'Mirror entities about a line of the sketch (`axis` entity index), or about the line `axis_a` → `axis_b` (Orca sketch_mirror).',
      inputSchema: obj({ entities: { type: 'array', items: { type: 'number' } }, axis: num('A line entity as the mirror.'), axis_a: { type: 'array', items: { type: 'number' } }, axis_b: { type: 'array', items: { type: 'number' } } }, ['entities']),
      async run(args) {
        needSketch();
        let axis = args.axis !== undefined ? Number(args.axis) : -1;
        if (axis < 0) {
          // A temporary construction line for an explicit axis.
          const a = (args.axis_a as number[] | undefined) ?? [0, 0], b = (args.axis_b as number[] | undefined) ?? [0, 1];
          await SK.addEntities([skEntity('line', { p0: [a[0], a[1]], p1: [b[0], b[1]], construction: true })], []);
          axis = SK.sk.entities.length - 1;
        }
        const err = await SK.mirrorEntities((args.entities as number[]).map(Number), axis);
        return { data: { ok: !err, error: err ?? undefined, ...sketchState() } };
      },
    },
    {
      name: 'design_sketch_ops',
      description: 'Sketch edit operations (kernel sketch_ops, with Orca’s constraint bookkeeping): trim {entity, pick:[x,y]} (drops the picked side to the nearest crossing), extend {entity, pick} (the end nearest the pick, to the next curve), fillet / chamfer {a, b, size} (two lines), array {entities, count, step:[dx,dy]}, polar {entities, count, pivot, angle (deg, default 360/count)}, transform {entities, move, angle (deg), scale, pivot, copy}, use_edges {body, edges:[…], generation} (project body edges, fixed).',
      timeoutMs: 300_000,
      inputSchema: obj({ op: oneOfS(['trim', 'extend', 'fillet', 'chamfer', 'array', 'polar', 'transform', 'use_edges'], 'Operation.'), entity: num(''), pick: { type: 'array', items: { type: 'number' } }, a: num(''), b: num(''), size: num('Fillet radius / chamfer distance.'), entities: { type: 'array', items: { type: 'number' } }, count: num(''), step: { type: 'array', items: { type: 'number' } }, pivot: { type: 'array', items: { type: 'number' } }, angle: num('Degrees.'), move: { type: 'array', items: { type: 'number' } }, scale: num(''), copy: bool(''), body: num(''), edges: { type: 'array', items: { type: 'number' } }, generation: num('') }, ['op']),
      async run(args) {
        needSketch();
        const v2 = (x: unknown, d: V2 = [0, 0]): V2 => (Array.isArray(x) ? [Number(x[0]), Number(x[1])] : d);
        const ents = ((args.entities as number[] | undefined) ?? []).map(Number);
        let err: string | null = null;
        switch (String(args.op)) {
          case 'trim': case 'extend': err = (await SK.trimExtend(String(args.op) as 'trim', Number(args.entity), v2(args.pick))) ? null : (design.status?.text ?? 'refused'); break;
          case 'fillet': case 'chamfer': err = await SK.filletLines(String(args.op) as 'fillet', Number(args.a), Number(args.b), Number(args.size)); break;
          case 'array': err = await SK.arrayEntities(ents, Number(args.count), { step: v2(args.step) }); break;
          case 'polar': err = await SK.arrayEntities(ents, Number(args.count), { angleStep: Number(args.angle ?? 360 / Number(args.count)), pivot: v2(args.pivot) }); break;
          case 'transform': err = await SK.transformEntities(ents, { move: v2(args.move), angle: Number(args.angle ?? 0), scale: Number(args.scale ?? 1), pivot: v2(args.pivot), copy: !!args.copy }); break;
          case 'use_edges': err = await SK.useEdges(Number(args.body ?? 0), ((args.edges as number[] | undefined) ?? []).map(Number), Number(args.generation ?? design.generation)); break;
        }
        return { data: { ok: !err, error: err ?? undefined, ...sketchState() } };
      },
    },
    {
      name: 'design_sketch_text', description: 'Text outlines as the sketch’s profile (Orca’s Text sketch: rigid imported regions, centred, placed at `offset`; the sketch must have no other geometry).',
      timeoutMs: 120_000,
      inputSchema: obj({ text: str('Text (newlines allowed).'), size: num('Letter height, mm (default 10).'), font: oneOfS(['noto-sans', 'noto-serif', 'noto-sans-mono'], 'Font.'), bold: bool(''), offset: { type: 'array', items: { type: 'number' } } }, ['text']),
      async run(args) {
        needSketch();
        const { textRegions } = await import('../../design/sketch/outline');
        const size = Number(args.size ?? 10), font = String(args.font ?? 'noto-sans');
        const err = SK.placeRegions(await textRegions(String(args.text), size, font, !!args.bold), 'Text', { offset: Array.isArray(args.offset) ? [Number(args.offset[0]), Number(args.offset[1])] : undefined, text: { string: String(args.text), font, height: size } });
        if (err) throw new Error(err);
        return st();
      },
    },
    {
      name: 'design_sketch_svg', description: 'An SVG’s filled shapes as the sketch’s profile (rigid imported regions, 96 dpi unless the SVG has mm units; `scale` multiplies).',
      timeoutMs: 120_000,
      inputSchema: obj({ svg: str('The SVG source.'), scale: num('Scale (default 1).'), offset: { type: 'array', items: { type: 'number' } } }, ['svg']),
      async run(args) {
        needSketch();
        const { svgRegions } = await import('../../design/sketch/outline');
        const err = SK.placeRegions(svgRegions(String(args.svg), Number(args.scale ?? 1)), 'SVG', { offset: Array.isArray(args.offset) ? [Number(args.offset[0]), Number(args.offset[1])] : undefined });
        if (err) throw new Error(err);
        return st();
      },
    },
    { name: 'design_sketch_undo', description: 'Undo the last sketch edit (the session’s own undo; Ctrl+Z in the app does the same while a sketch is open).', inputSchema: obj({}), async run() { needSketch(); await SK.sketchUndo(); return st(); } },
    { name: 'design_sketch_redo', description: 'Redo a sketch edit.', inputSchema: obj({}), async run() { needSketch(); await SK.sketchRedo(); return st(); } },
    {
      name: 'design_sketch_commit', description: 'Finish the sketch (Orca sketch_commit): a new Sketch feature, or the edited one updated — one design edit, one undo step. Returns `sketch_index` for design_extrude / design_revolve {sketch}.',
      timeoutMs: 900_000, inputSchema: obj({}),
      async run() { needSketch(); const r = await SK.finishSketch(); if (!r.ok) throw new Error(r.error); return { data: { ok: true, sketch_index: r.index, ...sceneSummary() } }; },
    },
    { name: 'design_sketch_cancel', description: 'Discard the open sketch (the design is unchanged).', inputSchema: obj({}), async run() { await SK.cancelSketch(); return { data: { ok: true } }; } },
  ];
}

export function designTools(): BridgeTool[] {
  return [
    ...sketchTools(),
    {
      name: 'design_describe_scene',
      description:
        'The project’s Design tab document (OrcaSlicer 2.5 parametric CAD, Metadata/orca_cad.bin): features (index, type, name, enabled), bodies ' +
        '(source feature, face/edge counts, bbox, plate objects linked to it), variables, whether it rebuilds and the first failing feature. Opens it (starts ' +
        'the CAD kernel, ~5 s; reopening replays the whole history) when needed. Pass `show: true` to switch the app to the Design tab.',
      timeoutMs: 600_000,
      inputSchema: obj({ show: bool('Also switch the app to the Design tab.') }),
      async run(args) {
        if (args.show === true) activeView.value = 'design';
        await ready();
        return { data: sceneSummary() };
      },
    },
    {
      name: 'design_get_feature',
      description: 'Every field of one feature (Orca’s CadFeature, keys = C++ member names; `expr` maps fields to expressions). Each type reads only its own fields (CAD-KERNEL-CONTRACT.md "Feature JSON").',
      timeoutMs: 600_000,
      inputSchema: obj({ index: num('Feature index (design_describe_scene).') }, ['index']),
      async run(args) {
        await ready();
        return { data: { index: featureIndex(args), feature: await getFeature(featureIndex(args)), generation: design.generation } };
      },
    },
    {
      name: 'design_set_feature',
      description:
        'Edit fields of one feature (any subset except `type`; `expr` replaces its field → expression map) as ONE rebuild and one undo step. A geometry ' +
        'failure is not an error: the kernel rolls back and the result is ok:false with its message. Linked plate objects are updated.',
      timeoutMs: 900_000,
      inputSchema: obj({
        index: num('Feature index.'),
        fields: { type: 'object', description: 'Fields to set, e.g. {"distance": 30} or {"dressup_size": 1.5, "face_group": "Top"}.' },
        generation: num('The generation face / edge ids in `fields` were read at (a stale one is refused).'),
      }, ['index', 'fields']),
      async run(args) {
        await ready();
        const i = featureIndex(args);
        const fields = { ...(args.fields as Record<string, unknown>) };
        if (!fields || typeof fields !== 'object') throw new Error('"fields" must be an object.');
        delete fields.type;
        const expr = fields.expr as Record<string, string> | undefined;
        delete fields.expr;
        return { data: outcome(await setFeatureParams(i, fields, expr, typeof args.generation === 'number' ? args.generation : undefined)) };
      },
    },
    {
      name: 'design_set_feature_expr',
      description: 'Bind a numeric field of a feature to an expression of the variables (McpControl set_feature_expr; empty `expr` clears). Trig is in degrees.',
      timeoutMs: 900_000,
      inputSchema: obj({ feature: num('Feature index.'), field: str('Field name (describe_tools bindable_fields, e.g. "distance").'), expr: str('Expression, e.g. "w * 2".') }, ['feature', 'field', 'expr']),
      async run(args) {
        await ready();
        const i = featureIndex(args, 'feature');
        const field = String(args.field ?? '');
        if (!design.tools?.bindable_fields.includes(field)) throw new Error(`"${field}" is not a value an expression can drive. Bindable: ${design.tools?.bindable_fields.join(', ')}.`);
        const r = await runEdit(`Edit ${design.features[i].name}`, async (c, doc) => (await c.call<MutationResult>('set_feature_expr', { doc, feature: i, field, expr: String(args.expr ?? '') })).result, { feature: i });
        return { data: outcome(r) };
      },
    },
    {
      name: 'design_set_variable',
      description: 'Add, change or (empty `expr`) delete a design variable (McpControl set_variable). One rebuild, one undo step.',
      timeoutMs: 900_000,
      inputSchema: obj({ name: str('Variable name (letters, digits, underscores).'), expr: str('Expression, e.g. "12" or "w / 2".') }, ['name', 'expr']),
      async run(args) {
        await ready();
        return { data: outcome(await setVariable(String(args.name ?? ''), String(args.expr ?? ''))) };
      },
    },
    {
      name: 'design_suppress_feature',
      description:
        'Suppress / unsuppress features (Orca’s eye; kernel suppress_feature). `indices` toggles several with one rebuild. On a design that doesn’t rebuild ' +
        '`force` (the default there) keeps the toggle even if it still fails — the way to repair it: suppress every failing feature together.',
      timeoutMs: 900_000,
      inputSchema: obj({
        index: num('One feature index.'),
        indices: { type: 'array', items: { type: 'number' }, description: 'Several feature indices.' },
        suppressed: bool('true = suppress (default), false = unsuppress.'),
        force: bool('Keep the toggle even when the rebuild still fails (default: true when the design doesn’t rebuild).'),
      }),
      async run(args) {
        await ready();
        const list = Array.isArray(args.indices) ? (args.indices as unknown[]).map((v) => featureIndex({ index: v })) : [featureIndex(args)];
        const suppressed = args.suppressed !== false;
        const r = await setSuppressed(list, suppressed, typeof args.force === 'boolean' ? { force: args.force } : {});
        return { data: { ...outcome(r), features: list.map((i) => ({ index: i, enabled: design.features[i]?.enabled })) } };
      },
    },
    {
      name: 'design_query_topology',
      description: 'Faces and edges of one body with their ids (McpControl query_topology): centroid, normal, kind, surface type, radius. Ids are valid for the returned `generation` only.',
      timeoutMs: 600_000,
      inputSchema: obj({ body: num('Body index (default 0).') }),
      async run(args) {
        await ready();
        const body = Number(args.body ?? 0);
        if (!design.bodies[body]) throw new Error(`No body ${body} (the design has ${design.bodies.length}).`);
        return { data: await readDesign(async (c, doc) => (await c.call('query_topology', { doc, body })).result) };
      },
    },
    {
      name: 'design_commit',
      description:
        'Commit to Plate: every visible body with faces not on the plate yet goes to the plate, live-linked (later design edits replace its mesh; paint ' +
        'resets with it). mode "assembly" (Orca’s default): one object with a part per body; "bodies": one object per body. Default: the user’s setting. ' +
        'Bodies already committed are not duplicated. One undo step.',
      timeoutMs: 600_000,
      inputSchema: obj({ show: bool('Switch to Prepare afterwards (default false).'), mode: oneOfS(['assembly', 'bodies'], 'Commit mode.') }),
      async run(args) {
        await ready();
        const ids = await commitToPlate({ switchView: args.show === true, ...(args.mode === 'assembly' || args.mode === 'bodies' ? { mode: args.mode } : {}) });
        return { data: { ok: true, objects: ids.map((id) => objectDetail(id)) } };
      },
    },
    // ---- feature list ----
    {
      name: 'design_rename_feature',
      description: 'Rename a feature (no rebuild; one undo step).',
      inputSchema: obj({ index: num('Feature index.'), name: str('New name.') }, ['index', 'name']),
      async run(args) { await ready(); return { data: outcome(await renameFeature(featureIndex(args), String(args.name ?? ''))) }; },
    },
    {
      name: 'design_move_feature',
      description: 'Move a feature one step up (delta -1) or down (+1) in the history (refused when a consumer would come before its input). Linked plate objects are remapped.',
      timeoutMs: 900_000,
      inputSchema: obj({ index: num('Feature index.'), delta: num('-1 (up) or +1 (down).') }, ['index', 'delta']),
      async run(args) { await ready(); return { data: outcome(await moveFeature(featureIndex(args), Number(args.delta) < 0 ? -1 : 1)) }; },
    },
    {
      name: 'design_delete_feature',
      description: 'Delete a feature (a Sketch takes the features made from it along). One undo step.',
      timeoutMs: 900_000,
      inputSchema: obj({ index: num('Feature index.') }, ['index']),
      async run(args) { await ready(); const r = await deleteFeature(featureIndex(args)); return { data: { ...outcome(r), removed: r.result?.removed } }; },
    },
    // ---- creating features (McpControl build verbs) ----
    verbTool('fillet', 'Round edges of a body (or, with face_group, every Top / Bottom / Lateral / All edge).', { edge: { description: 'Edge id or array of ids (one feature).' }, radius: num('Radius mm (default 1).'), body: BODY, face_group: oneOfS(['Top', 'Bottom', 'Lateral', 'All'], 'Instead of edge.') }),
    verbTool('chamfer', 'Bevel edges of a body.', { edge: { description: 'Edge id or array of ids.' }, distance: num('Distance mm (default 1).'), body: BODY, face_group: oneOfS(['Top', 'Bottom', 'Lateral', 'All'], 'Instead of edge.') }),
    verbTool('shell', 'Hollow a body to a wall thickness, leaving one face open. A closed hollow (face -1) and a shell that changes nothing are refused (ok:false).', { thickness: num('Wall mm (default 1).'), face: ID('Open face'), body: BODY }),
    verbTool('draft', 'Taper a side face by an angle (pivots about the body base).', { face: ID('Face'), angle: num('Degrees (default 5).'), body: BODY }, ['face']),
    verbTool('hole', 'A simple hole on a plane at x, y of the plane frame (a face plane from design_plane_of_face, normal pointing INTO the material).', { diameter: num('mm (default 5).'), depth: num('mm (default 10).'), through: bool('Through all.'), x: num('Plane-frame x.'), y: num('Plane-frame y.'), plane: PLANE, body: BODY }),
    verbTool('hole_styled', 'A counterbored (style 1) or countersunk (style 2) hole.', { style: num('0 simple, 1 counterbore, 2 countersink.'), diameter: num('mm.'), depth: num('mm.'), through: bool('Through all (default true).'), cbore_diameter: num('mm.'), cbore_depth: num('mm.'), csink_diameter: num('mm.'), csink_angle: num('Degrees (default 90).'), standard: str('Label only.'), x: num('x.'), y: num('y.'), plane: PLANE, body: BODY }),
    verbTool('hole_standard', 'A clearance hole sized from a standard (design_hole_standards: M3–M10, #6-32…3/8-16 UNC).', { designation: str('e.g. "M6".'), style: num('0 simple, 1 counterbore, 2 countersink.'), through: bool('Through all (default true).'), depth: num('mm.'), x: num('x.'), y: num('y.'), plane: PLANE }, ['designation']),
    verbTool('thread', 'A helical thread (axis = the plane normal, at x, y): designation from design_thread_standards fills pitch / depth.', { designation: str('e.g. "M8".'), diameter: num('Major diameter mm.'), pitch: num('mm.'), depth: num('Thread depth mm.'), height: num('Length mm (default 10).'), internal: bool('A tapped hole.'), x: num('x.'), y: num('y.'), plane: PLANE, body: BODY }),
    verbTool('pattern', 'Linear (along plane X / Y) or circular (about the plane normal) copies of a body.', { circular: bool('Circular.'), count: num('Copies incl. the original (default 3).'), spacing: num('Linear spacing mm.'), dir: num('0 plane X, 1 plane Y.'), angle: num('Circular total angle (default 360).'), plane: PLANE, body: BODY }),
    verbTool('mirror', 'Reflect a body about a plane (mode new: a copy; add: join it).', { plane: PLANE, mode: oneOfS(['new', 'add'], 'Default new.'), keep_original: bool('Default true.'), body: BODY }),
    verbTool('transform', 'Move / rotate a body (rotation about the pivot, then the translation).', { body: BODY, dx: num('mm.'), dy: num('mm.'), dz: num('mm.'), axis_x: num('Axis.'), axis_y: num('Axis.'), axis_z: num('Axis (default 0,0,1).'), pivot_x: num('mm.'), pivot_y: num('mm.'), pivot_z: num('mm.'), angle: num('Degrees.'), copy: bool('Keep the original.') }),
    verbTool('boolean', 'Join / subtract / intersect two bodies (the tool is consumed unless keep_tool).', { op: oneOfS(['union', 'subtract', 'intersect'], 'Default subtract.'), target: num('Target body (kept).'), tool: num('Tool body.'), keep_tool: bool('Keep the tool body.'), tolerance: num('Fuzzy tolerance mm.') }, ['target', 'tool']),
    verbTool('cut', 'Split a body with a plane (+ offset); keep either side or both (two bodies).', { plane: PLANE, offset: num('mm along the normal.'), flip: bool('Flip.'), keep_upper: bool('Default true.'), keep_lower: bool('Default false.'), body: BODY }),
    verbTool('split', 'Split a body with a face of another (or the same) body.', { body: BODY, face_body: num('Body of the splitting face.'), face: ID('Splitting face'), keep_upper: bool('Default true.'), keep_lower: bool('Default true.') }, ['face']),
    verbTool('thicken', 'Offset a face of a solid into a new thin body.', { body: BODY, face: ID('Face'), thickness: num('mm (default 2).'), flip: bool('Other side.') }, ['face']),
    verbTool('delete_face', 'Remove faces and let the neighbours close the gap (defeature fillets, holes, bosses).', { body: BODY, faces: { type: 'array', items: { type: 'number' }, description: 'Face ids.' } }, ['faces']),
    verbTool('plane_datum', 'A datum plane: offset from a base datum (0 XY, 1 XZ, 2 YZ, 3+N planes), or any Plane field via `fields` (plane_type Angle / Midplane / Tangent / TwoEdges / Coincident + face / edge refs).', { base: num('Datum ordinal.'), offset: num('mm (default 20).'), angle: num('Degrees.'), axis: num('Tilt axis 0 X, 1 Y.'), fields: anyArgs('Plane fields, e.g. {"plane_type":"Midplane","plane_face_body":0,"plane_face":2,"plane_face2_body":0,"plane_face2":4}.') }),
    verbTool('axis', 'A datum axis.', { type: oneOfS(['two_points', 'face_normal', 'cylinder', 'plane_intersection', 'along_edge'], 'Axis type.'), p1: vec3s('Point 1.'), p2: vec3s('Point 2.'), body: num('Body.'), face: ID('Face'), edge: ID('Edge'), plane_a: num('Datum ordinal.'), plane_b: num('Datum ordinal.') }),
    verbTool('helix', 'A helix (sweep path).', { radius: num('mm (10).'), pitch: num('mm (5).'), height: num('mm (20).'), left_handed: bool('Left-handed.'), taper_deg: num('Degrees.'), plane: PLANE }),
    verbTool('extrude', 'Extrude: an existing Sketch feature (`sketch`), a face of a body (`face`, push / pull), a rectangle (width × height) or a closed `profile` polygon.', { sketch: num('Sketch feature index.'), face: ID('Face (push / pull)'), body: BODY, width: num('mm.'), height: num('mm.'), profile: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[x,y]…] closed polygon in the plane.' }, plane: PLANE, distance: num('mm (default 10).'), boolean: oneOfS(['new', 'union', 'subtract', 'intersect'], 'Result.'), end: oneOfS(['blind', 'symmetric', 'two_sided', 'through_all', 'up_to_face', 'up_to_vertex'], 'End.'), distance2: num('Second distance.'), up_to_face: ID('Up-to face'), taper: num('Degrees.'), flip: bool('Flip.') }),
    verbTool('revolve', 'Revolve an existing Sketch (or a rectangle / profile) about the plane X (0) or Y (1) axis or a line of the sketch (axis_entity).', { sketch: num('Sketch feature index.'), width: num('mm.'), height: num('mm.'), profile: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[x,y]…].' }, angle: num('Degrees (360).'), axis: num('0 plane X, 1 plane Y.'), axis_entity: num('Line entity of the sketch.'), flip: bool('Flip.'), plane: PLANE, boolean: oneOfS(['new', 'union', 'subtract', 'intersect'], 'Result.'), body: BODY }),
    // `path` is reserved by cubby-mcp (a file to read) and never reaches the tab: the path sketch is `sweep_path`.
    verbTool('sweep', 'Sweep a profile Sketch along a path Sketch or Helix.', { profile: num('Profile sketch index.'), sweep_path: num('Path sketch / helix index (McpControl `path`).'), boolean: oneOfS(['new', 'union', 'subtract', 'intersect'], 'Result.'), body: BODY }, ['profile', 'sweep_path']),
    verbTool('loft', 'Loft through two or more Sketch profiles, in order.', { profiles: { type: 'array', items: { type: 'number' }, description: 'Sketch feature indices.' }, ruled: bool('Straight sections.'), boolean: oneOfS(['new', 'union', 'subtract', 'intersect'], 'Result.'), body: BODY }, ['profiles']),
    {
      name: 'design_add_feature',
      description: 'Append any feature type with any CadFeature fields (what the Design tab’s cards do): e.g. {"type":"Fillet","fields":{"dressup_edges":[3,6],"dressup_size":2,"target_body":0}}. One rebuild, one undo step.',
      timeoutMs: 900_000,
      inputSchema: obj({ type: str('Feature type (contract "Feature JSON").'), name: str('Name.'), fields: anyArgs('CadFeature fields.'), generation: num('The generation face / edge ids in `fields` were read at (a stale one is refused).') }, ['type']),
      async run(args) {
        await ready();
        const type = String(args.type ?? ''), fields = (args.fields ?? {}) as Record<string, unknown>;
        let index = -1;
        const r = await runEdit(`Add ${String(args.name ?? type)}`, async (c, doc) => {
          const res = (await c.call<MutationResult>('add_feature', { doc, type, fields, ...(args.name ? { name: String(args.name) } : {}), ...(typeof args.generation === 'number' ? { generation: args.generation } : {}) })).result;
          index = res.index ?? -1;
          return res;
        });
        return { data: { ...outcome(r), index } };
      },
    },
    {
      name: 'design_feature_preview',
      description: 'Try a candidate feature without adding it (Orca’s preview ghost): ok / error and the triangle count of the result. Costs a full replay, like an edit.',
      timeoutMs: 900_000,
      inputSchema: obj({ type: str('Feature type.'), fields: anyArgs('CadFeature fields.') }, ['type']),
      async run(args) {
        await ready();
        const r = await readDesign(async (c, doc) => {
          const p = await c.call<{ ok: boolean; error: string; meshes: PlateMeshLayout[] }>('feature_preview', { doc, type: String(args.type), fields: args.fields ?? {} });
          return { ok: p.result.ok, error: p.result.error || undefined, triangles: p.result.ok ? decodePlateMeshes(p.result.meshes.map((m) => ({ ...m, triFace: { offset: 0, count: 0 } })), p.blob).reduce((n, m) => n + m.indices.length / 3, 0) : 0 };
        }, 'Previewing');
        return { data: r };
      },
    },
    // ---- reads ----
    {
      name: 'design_face_info',
      description: 'One face: surface type, area, centroid, normal, plane frame (flat faces), cylinder axis / base / height / radius, its edges.',
      timeoutMs: 600_000,
      inputSchema: obj({ body: num('Body.'), face: num('Face id.'), generation: num('Generation of the id.') }, ['body', 'face']),
      async run(args) { await ready(); return { data: await readDesign(async (c, doc) => (await c.call('face_info', { doc, ...args })).result) }; },
    },
    {
      name: 'design_edge_info',
      description: 'One edge: curve type, length, ends, circle centre / axis / radius, the faces it bounds.',
      timeoutMs: 600_000,
      inputSchema: obj({ body: num('Body.'), edge: num('Edge id.'), generation: num('Generation of the id.') }, ['body', 'edge']),
      async run(args) {
        await ready();
        const r = await readDesign(async (c, doc) => (await c.call<Record<string, unknown>>('edge_info', { doc, ...args })).result);
        delete r.polyline;
        return { data: r };
      },
    },
    {
      name: 'design_plane_of_face',
      description: 'The sketch / hole plane frame of a flat face (normal pointing out of the material; flip it for design_hole).',
      timeoutMs: 600_000,
      inputSchema: obj({ body: num('Body.'), face: num('Face id.'), generation: num('Generation of the id.') }, ['body', 'face']),
      async run(args) { await ready(); return { data: await readDesign(async (c, doc) => (await c.call('plane_of_face', { doc, ...args })).result) }; },
    },
    {
      name: 'design_datums',
      description: 'The reference planes (XY / XZ / YZ through the modeling origin), datum planes, axes and coordinate systems with their frames.',
      timeoutMs: 600_000,
      inputSchema: obj({}),
      async run() { await ready(); return { data: await readDesign(async (c, doc) => (await c.call('datums', { doc })).result) }; },
    },
    {
      name: 'design_mass_properties',
      description: 'Volume (mm³), surface area, centre of mass of a body (Orca’s Volume and area).',
      timeoutMs: 600_000,
      inputSchema: obj({ body: num('Body (default 0).') }),
      async run(args) { await ready(); return { data: await readDesign(async (c, doc) => (await c.call('mass_properties', { doc, body: Number(args.body ?? 0) })).result) }; },
    },
    {
      name: 'design_thread_standards',
      description: 'The kernel’s thread table (ISO coarse / fine, UNC, UNF): name, major / minor diameter, pitch, depths — for design_thread `designation`.',
      inputSchema: obj({}),
      async run() { await ready(); return { data: (await standards()).threads }; },
    },
    {
      name: 'design_hole_standards',
      description: 'The kernel’s clearance hole table (M3–M10, UNC): clearance, counterbore, countersink — for design_hole_standard.',
      inputSchema: obj({}),
      async run() { await ready(); return { data: (await standards()).holes }; },
    },
    // ---- bodies ----
    {
      name: 'design_set_body',
      description: 'Rename a body and / or set its display colour (saved in the design; null / "" clears). One undo step.',
      inputSchema: obj({ body: num('Body index.'), name: str('Name ("" clears).'), color: str('"#rrggbb" or "" to clear.') }, ['body']),
      async run(args) {
        await ready();
        const b = Number(args.body);
        if (!design.bodies[b]) throw new Error(`No body ${b}.`);
        let r = null;
        if (typeof args.name === 'string') r = await renameBody(b, args.name);
        if (typeof args.color === 'string') r = await setBodyColor(b, args.color ? args.color : null);
        return { data: r ? outcome(r) : { ok: true } };
      },
    },
    {
      name: 'design_delete_body',
      description: 'Delete a body: removes the feature it was made from (Orca’s Delete Body; a Sketch cascades). One undo step.',
      timeoutMs: 900_000,
      inputSchema: obj({ body: num('Body index.') }, ['body']),
      async run(args) { await ready(); return { data: outcome(await deleteBody(Number(args.body))) }; },
    },
    {
      name: 'design_add_primitive',
      description: 'Add a CubbyCAD palette shape (list_shapes ids: box, cylinder, sphere, cone, torus, tube, capsule, halfSphere, halfCylinder, polygon, wedge, roof, extrudeStar, fillet → exact B-rep; others → a mesh body) as a design body, at `position` (default: beside the others). `params` = the shape’s parameters (mm). Reports exact / mesh and why.',
      timeoutMs: 900_000,
      inputSchema: obj({ shape: str('Shape id.'), params: anyArgs('Shape parameters, e.g. {"width": 40, "depth": 30, "height": 10}.'), position: vec3s('Design (bed) coordinates of the shape origin (base centre).'), name: str('Body name.') }, ['shape']),
      async run(args) {
        await ready();
        const r = await addPrimitiveBody(String(args.shape), { params: args.params as Record<string, unknown> | undefined, position: args.position as [number, number, number] | undefined, name: typeof args.name === 'string' ? args.name : undefined });
        return { data: { ...outcome(r), body: r.body, exact: r.exact, reason: r.reason, shapes: r.shapes } };
      },
    },
    {
      name: 'design_convert_object',
      description: 'Convert a plate object to a design body where it sits: a CubbyCAD shape tree is rebuilt exactly when every shape has a kernel equivalent (booleans for groups / holes), else imported as a mesh body; a plain mesh object is always a mesh body. The object stays on the plate (design_commit brings the body back, linked).',
      timeoutMs: 900_000,
      inputSchema: obj({ objectId: str('Object id (default: the single selected object).') }),
      async run(args) {
        const id = typeof args.objectId === 'string' ? args.objectId : selectedIds.value.length === 1 ? selectedIds.value[0] : '';
        const o = getObject(id);
        if (!o) throw new Error('Pass objectId (list_objects) or select one object.');
        await ready();
        if (o.cad) { const r = await convertObjectToBody(id); return { data: { ...outcome(r), body: r.body, exact: r.exact, reason: r.reason, shapes: r.shapes } }; }
        const r = await importObjectMesh(id, { show: false });
        return { data: { ...r, exact: false } };
      },
    },
    // ---- files ----
    {
      name: 'design_import_step',
      description: 'Import a STEP file as exact bodies (one Import feature per solid). One undo step.',
      timeoutMs: 900_000,
      inputSchema: obj({ name: str('File name.'), dataBase64: str('STEP bytes, base64.') }, ['dataBase64']),
      async run(args) {
        const r = await importStepToDesign(String(args.name ?? 'import.step'), base64ToBytes(argString(args, 'dataBase64')!), { show: false });
        return { data: { ...outcome(r), features: r.features } };
      },
    },
    {
      name: 'design_import_mesh',
      description: 'Import a triangle mesh as a body (McpControl import_mesh: flat regions become faces). Either `objectId` (a plate object, world placement) or `positions` + `indices` (design mm).',
      timeoutMs: 900_000,
      inputSchema: obj({ objectId: str('Plate object id.'), name: str('Body name.'), positions: { type: 'array', items: { type: 'number' }, description: 'Flat xyz list.' }, indices: { type: 'array', items: { type: 'number' }, description: 'Flat triangle list.' } }),
      async run(args) {
        if (typeof args.objectId === 'string') return { data: await importObjectMesh(args.objectId, { show: false }) };
        if (!Array.isArray(args.positions) || !Array.isArray(args.indices)) throw new Error('Pass objectId, or positions and indices.');
        return { data: await importMeshToDesign(String(args.name ?? 'Mesh'), new Float32Array(args.positions as number[]), new Uint32Array(args.indices as number[]), { show: false }) };
      },
    },
    {
      name: 'design_export_step',
      description: 'The design’s bodies as one STEP file (AP214, exact B-rep). Default: the visible bodies.',
      timeoutMs: 600_000,
      fileOutput: true,
      inputSchema: obj({ bodies: { type: 'array', items: { type: 'number' }, description: 'Body indices.' }, name: str('File name (default design.step).') }),
      async run(args) {
        await ready();
        const r = await exportStepBytes(Array.isArray(args.bodies) ? (args.bodies as number[]).map(Number) : undefined);
        const name = typeof args.name === 'string' && args.name ? args.name : 'design.step';
        return { data: { ok: true, bytes: r.bytes.length, bodies: r.bodies }, file: { name, mimeType: 'model/step', base64: bytesToBase64(r.bytes) } };
      },
    },
    {
      name: 'design_cancel',
      description: 'Cancel the running design rebuild (terminates the CAD kernel; the design reopens from its last saved state).',
      inputSchema: obj({}),
      async run() {
        return { data: { cancelled: designKernel().cancel(), busy: designKernel().status.busy?.label ?? null } };
      },
    },
  ];
}

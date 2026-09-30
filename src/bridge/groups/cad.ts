/**
 * Bridge tools: CubbyCAD modelling in the slicer. Names and argument shapes
 * mirror CubbyCAD's own bridge tools (cad-project/src/bridge/tools.ts,
 * nodeSettings.ts): list_shapes, add_primitive, get_node, set_node,
 * set_params, transform_node, group, set_hole, delete_nodes; plus
 * import_cad (cad_to_slicer's target), get_cad_tree and ungroup.
 *
 * Frames: an object's root node is placed by the object (bed coordinates,
 * Z up, like transform_objects). Child node transforms are CubbyCAD's own:
 * the render frame (Y up, mm) relative to the parent node, exactly what
 * cad_get_node shows for the same node in CubbyCAD.
 */
import { argString, type BridgeTool } from '@cubby/shared/bridge';
import { getSharedShape, isCadGroup, isCadPrimitive, parseCadTransfer, type CadNode } from '../../cad/api';
import { ensureCadWasm } from '../../cad/build';
import {
  addShape, cadSupportOf, deleteNodeOrThrow, editNodeOrThrow, groupObjectsAsync, importCadNodes, pickNode, setNodeTransformOrThrow, ungroupObjectAsync,
} from '../../cad/commands';
import { sanitizeCadNodes } from '../../cad/cubby';
import { paletteShapes } from '../../cad/shapes';
import { applyTransformArgs, findIn, nodeKindLabel, nodeName, type NodeSupport } from '../../cad/tree';
import { activePlate, getObject, objects, renameObject, select, setActivePlate } from '../../project/store';
import type { ProjectObject } from '../../project/types';
import { quatFromEuler } from '../../project/math';
import { vec3 } from '../logic';
import { DEG, bool, num, obj, objectDetail, plateArg, plateOrigin, round, str, strList, vec3s } from './util';

const COLOR = str('Hex colour, e.g. "#4a90d9".');

// ---- lookups ------------------------------------------------------------------------------------

/** The CAD object holding node `id` (a node id, or an object id meaning its root), optionally within `objectId`. */
function locate(id: string, objectId?: string): { o: ProjectObject; node: CadNode; isRoot: boolean } {
  const pool = objectId ? [getObject(objectId)].filter((x): x is ProjectObject => !!x) : objects.value;
  if (objectId && !pool.length) throw new Error(`No object "${objectId}". Use list_objects.`);
  for (const o of pool) {
    if (!o.cad) continue;
    if (o.id === id) return { o, node: o.cad.node, isRoot: true };
    const f = findIn(o.cad.node, id);
    if (f) return { o, node: f.node, isRoot: f.node === o.cad.node };
  }
  const cadObjs = objects.value.filter((o) => o.cad);
  throw new Error(`No CubbyCAD node "${id}"${objectId ? ` in ${objectId}` : ''}. ${cadObjs.length ? `CAD objects: ${cadObjs.slice(0, 20).map((o) => `${o.id} (${o.name})`).join(', ')}; get_cad_tree lists their nodes.` : 'No object is a CubbyCAD shape (add_primitive or import_cad makes one).'}`);
}

function schemaInfo(shapeId: string) {
  const s = getSharedShape(shapeId);
  if (!s?.schema) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of s.schema.order ?? Object.keys(s.schema.properties)) {
    const p = s.schema.properties[key] as { type: string; label: string; unit?: string; default?: unknown; min?: number; max?: number; step?: number; options?: Array<{ value: string }> } | undefined;
    if (!p) continue;
    out[key] = {
      type: p.type, label: p.label, default: s.defaults[key] ?? p.default, unit: p.unit,
      ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.step !== undefined ? { step: p.step } : {}),
      ...(p.options ? { options: p.options.map((o) => o.value) } : {}),
    };
  }
  return out;
}

const r = (v: readonly number[] | undefined, d = 3) => v?.map((x) => round(x, d));

/** One node row (get_cad_tree), children nested. */
function treeRow(n: CadNode, sup: Map<string, NodeSupport>, isRoot: boolean): Record<string, unknown> {
  const s = sup.get(n.id);
  return {
    id: n.id, name: nodeName(n), kind: nodeKindLabel(n), type: n.type,
    ...(isCadPrimitive(n) ? { shape: n.geometry.type } : {}),
    ...(isCadGroup(n) ? { groupType: (n.csgMode ?? 'manifold') === 'manifold' ? 'sharp' : n.csgMode } : {}),
    hole: n.contribution === 'subtract' || undefined, hidden: n.hidden || undefined, locked: n.locked || undefined,
    ...(s && !s.editable ? { editable: false, reason: s.reason, baked: s.baked || undefined } : {}),
    ...(isRoot ? {} : { transform: { position: r(n.transform?.position), rotation: r(n.transform?.rotation, 5), scale: r(n.transform?.scale, 4) } }),
    ...(isCadGroup(n) ? { children: n.children.map((c) => treeRow(c, sup, false)) } : {}),
  };
}

/** get_node: every setting, like CubbyCAD's describeNode for the fields the slicer edits. */
function describe(o: ProjectObject, n: CadNode) {
  const s = cadSupportOf(o).get(n.id);
  const base = {
    objectId: o.id, id: n.id, type: n.type, name: n.name ?? null, kind: nodeKindLabel(n), root: n === o.cad!.node,
    hidden: !!n.hidden, locked: !!n.locked, hole: n.contribution === 'subtract',
    material: { ...(n.material ?? {}) },
    editable: s?.editable !== false, ...(s && !s.editable ? { reason: s.reason } : {}),
    frame: n === o.cad!.node ? 'object (bed coordinates; move it with transform_objects)' : 'render frame (Y up, mm) of the parent node, as in CubbyCAD',
    ...(n === o.cad!.node ? {} : { transform: { position: n.transform?.position ?? [0, 0, 0], rotation: n.transform?.rotation ?? [0, 0, 0, 1], scale: n.transform?.scale ?? [1, 1, 1] } }),
  };
  if (isCadPrimitive(n)) return { ...base, geometry: { type: n.geometry.type, params: n.geometry.params && getSharedShape(n.geometry.type) ? { ...n.geometry.params } : undefined, schema: schemaInfo(n.geometry.type) } };
  if (isCadGroup(n)) {
    return { ...base, group: { type: (n.csgMode ?? 'manifold') === 'manifold' ? 'sharp' : n.csgMode, children: n.children.map((c) => ({ id: c.id, name: c.name ?? null, type: c.type, hole: c.contribution === 'subtract', hidden: !!c.hidden })) } };
  }
  return base;
}

function idList(args: Record<string, unknown>, key = 'ids'): string[] {
  const v = args[key];
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string')) throw new Error(`Pass "${key}": a list of ids.`);
  return [...new Set(v as string[])];
}

const NODE_ID = str('Node id (from get_cad_tree), or an object id for its root node.');
const OBJECT_ID = str('Object id (optional: node ids are unique across objects).');

export function cadTools(): BridgeTool[] {
  return [
    {
      name: 'import_cad',
      description:
        'Add CubbyCAD nodes (verbatim CubbyCAD scene JSON: primitives, groups, baked `mesh` nodes) as editable slicer objects, one per top-level node, ' +
        'laid out as in CubbyCAD around the plate centre (Y-up render frame → Z-up bed, `unit` → mm). cad_to_slicer calls this. ' +
        'Content only CubbyCAD can build (blended / loft / skin groups, sculpt, script parts, text, sketches, modifiers) is kept and shown from its baked `mesh` stand-in when one is sent (a mesh node carrying the original under `cubbyOriginal`).',
      timeoutMs: 300_000,
      inputSchema: obj({
        nodes: { type: 'array', items: { type: 'object' }, description: 'Top-level CubbyCAD nodes (render frame, Y up).' },
        format: str('Optional payload tag: "cubby-cad-nodes" (cad_export_nodes).'),
        name: str('Name for the object when there is one node (default: the node’s name).'),
        unit: { type: 'string', enum: ['mm', 'cm', 'm', 'in'], description: 'Scene unit (default mm).' },
        plate: num('Plate to add to (1-based, default the active plate).'),
      }, ['nodes']),
      async run(args) {
        const payload = parseCadTransfer({ nodes: args.nodes, format: args.format, name: args.name, unit: args.unit });
        const nodes = sanitizeCadNodes(payload.nodes, 'nodes');
        if (!nodes.length) throw new Error('nodes has no valid CubbyCAD node (each needs an id and a type; primitives a geometry).');
        const plate = plateArg(args);
        if (plate !== undefined) setActivePlate(plate);
        const name = argString(args, 'name', { optional: true });
        const res = await importCadNodes(nodes, { unit: argString(args, 'unit', { optional: true }) ?? 'mm', label: `Import ${name ?? (nodes.length === 1 ? nodes[0].name ?? 'shape' : `${nodes.length} shapes`)}` });
        if (!res.ids.length) throw new Error(`Nothing could be imported: ${res.warnings.join(' ')}`);
        if (name && res.ids.length === 1) renameObject(res.ids[0], name);
        return { data: { ok: true, objects: res.ids.map((id) => ({ ...objectDetail(id), rootNodeId: getObject(id)?.cad?.node.id })), warnings: res.warnings.length ? res.warnings : undefined } };
      },
    },

    {
      name: 'list_shapes',
      description: 'Built-in CubbyCAD shapes add_primitive accepts, with their parameters (defaults, units, limits). Same shapes and parameters as cad_list_shapes.',
      inputSchema: obj({}),
      run() {
        return { data: { shapes: paletteShapes().map((s) => ({ id: s.id, label: s.label, params: schemaInfo(s.id) ?? s.defaults })) } };
      },
    },

    {
      name: 'add_primitive',
      description:
        'Add a CubbyCAD primitive (see list_shapes) as a new, editable object, one undo step. params override the shape defaults (mm), e.g. box { width, depth, height }. ' +
        'position [x, y] or [x, y, z]: bed coordinates of the plate (default: next to what is on the plate); it rests on the bed. rotationDeg XYZ degrees about the bed axes, scale factors. ' +
        'hole: true makes it a hole: group it with solids (group) to cut it out; on its own it is not printed.',
      inputSchema: obj({
        shape: str('Shape id, e.g. "box".'), params: { type: 'object', description: 'Shape parameters (see list_shapes).' }, name: str('Object name.'),
        position: { type: 'array', items: { type: 'number' }, description: '[x, y] or [x, y, z], bed coordinates.' }, plate: num('Plate (1-based) for position.'),
        rotationDeg: vec3s('XYZ Euler degrees.'), scale: vec3s('Scale factors.'),
        hole: bool('Subtract instead of add when grouped.'), color: COLOR,
      }, ['shape']),
      async run(args) {
        const shape = argString(args, 'shape')!;
        const plate = plateArg(args);
        if (plate !== undefined) setActivePlate(plate);
        let position: [number, number, number] | undefined;
        if (args.position !== undefined) {
          const p = args.position;
          if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3) || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('position must be [x, y] or [x, y, z].');
          const [ox, oy] = plateOrigin(plate ?? activePlate.value);
          position = [p[0] + ox, p[1] + oy, p[2] ?? 0];
        }
        const rot = vec3(args.rotationDeg, 'rotationDeg');
        const scale = vec3(args.scale, 'scale');
        if (args.params !== undefined && (typeof args.params !== 'object' || !args.params || Array.isArray(args.params))) throw new Error('params must be an object.');
        const id = await addShape(shape, {
          params: args.params as Record<string, unknown> | undefined, name: argString(args, 'name', { optional: true }),
          color: argString(args, 'color', { optional: true }), hole: args.hole === true, position,
          rotation: rot ? quatFromEuler(rot[0] / DEG, rot[1] / DEG, rot[2] / DEG) : undefined, scale: scale ?? undefined,
        });
        const o = getObject(id)!;
        return { data: { ok: true, object: objectDetail(id), nodeId: o.cad!.node.id, shape, params: (o.cad!.node as { geometry?: { params?: unknown } }).geometry?.params, hole: args.hole === true } };
      },
    },

    {
      name: 'get_cad_tree',
      description: 'The CubbyCAD node tree of one object (or of every CAD object): ids, names, kinds, shapes, hole / hidden / locked, child transforms (CubbyCAD render frame), and which nodes are CubbyCAD-only (read-only here, with why).',
      inputSchema: obj({ objectId: str('Object id (default: every CAD object).') }),
      async run(args) {
        await ensureCadWasm();
        const id = argString(args, 'objectId', { optional: true });
        const list = id ? [getObject(id)].filter((o): o is ProjectObject => !!o) : objects.value.filter((o) => o.cad);
        if (id && !list.length) throw new Error(`No object "${id}". Use list_objects.`);
        if (id && !list[0].cad) throw new Error(`${list[0].name} is a plain mesh, not a CubbyCAD shape. Group it with a shape (group) to make it one.`);
        return { data: { objects: list.map((o) => ({ objectId: o.id, name: o.name, tree: treeRow(o.cad!.node, cadSupportOf(o), true) })) } };
      },
    },

    {
      name: 'get_node',
      description: 'Every setting of one CubbyCAD node: name, hidden, locked, hole, material, geometry params with their schema, group children, its transform (child nodes: CubbyCAD render frame) and whether the slicer can edit it. Change them with set_node.',
      inputSchema: obj({ id: NODE_ID, objectId: OBJECT_ID }, ['id']),
      async run(args) {
        await ensureCadWasm();
        const f = locate(argString(args, 'id')!, argString(args, 'objectId', { optional: true }));
        return { data: describe(f.o, f.node) };
      },
    },

    {
      name: 'set_node',
      description:
        'Change any mix of a CubbyCAD node’s settings as ONE undo step (like cad_set_node): name, hidden, locked, hole (subtract in its group), color, params (shape parameters, merged). ' +
        'A locked node refuses changes unless locked: false is in the same call. CubbyCAD-only nodes are read-only here. The object’s mesh re-evaluates (its painting is cleared, like any mesh change).',
      inputSchema: obj({
        id: NODE_ID, objectId: OBJECT_ID, name: str('Name.'), hidden: bool('Hide.'), locked: bool('Lock.'), hole: bool('Subtract in its group.'), color: COLOR,
        params: { type: 'object', description: 'Shape parameters to change.' },
      }, ['id']),
      async run(args) {
        await ensureCadWasm();
        const f = locate(argString(args, 'id')!, argString(args, 'objectId', { optional: true }));
        if (f.isRoot && args.hidden !== undefined) throw new Error('Hide the whole object with update_objects { visible }.');
        const changed = await editNodeOrThrow(f.o.id, {
          id: f.node.id, name: args.name as string | undefined, hidden: args.hidden as boolean | undefined, locked: args.locked as boolean | undefined,
          hole: args.hole as boolean | undefined, color: args.color as string | undefined, params: args.params as Record<string, unknown> | undefined,
        }, `Edit ${nodeName(f.node)}`);
        if (f.isRoot && typeof args.name === 'string' && args.name.trim()) renameObject(f.o.id, args.name);
        const o = getObject(f.o.id)!;
        return { data: { ok: true, changed, node: describe(o, findIn(o.cad!.node, f.node.id)!.node), object: objectDetail(o.id) } };
      },
    },

    {
      name: 'set_params',
      description: 'Change a CubbyCAD shape’s parameters (e.g. { "width": 40 }), merged into the current ones, clamped to the schema. One undo step. Same as set_node with params.',
      inputSchema: obj({ id: NODE_ID, objectId: OBJECT_ID, params: { type: 'object' } }, ['id', 'params']),
      async run(args) {
        await ensureCadWasm();
        const f = locate(argString(args, 'id')!, argString(args, 'objectId', { optional: true }));
        await editNodeOrThrow(f.o.id, { id: f.node.id, params: args.params as Record<string, unknown> }, `Change ${nodeName(f.node)}`);
        const o = getObject(f.o.id)!;
        const n = findIn(o.cad!.node, f.node.id)!.node as { geometry?: { params?: unknown } };
        return { data: { ok: true, id: f.node.id, params: n.geometry?.params, object: objectDetail(o.id) } };
      },
    },

    {
      name: 'transform_node',
      description:
        'Move, rotate or scale a CHILD node inside its object (like cad_transform_node): CubbyCAD’s render frame (Y up, mm) relative to its parent node. ' +
        'mode "set" (default) assigns; "offset" adds position, multiplies scale, composes rotation. rotationDeg XYZ degrees. One undo step. ' +
        'Move a whole object with transform_objects instead.',
      inputSchema: obj({
        id: NODE_ID, objectId: OBJECT_ID, mode: { type: 'string', enum: ['set', 'offset'] },
        position: vec3s('[x, y, z] mm'), rotationDeg: vec3s('[x, y, z] degrees'), scale: vec3s('[x, y, z]'),
      }, ['id']),
      async run(args) {
        await ensureCadWasm();
        const f = locate(argString(args, 'id')!, argString(args, 'objectId', { optional: true }));
        if (f.isRoot) throw new Error(`${nodeName(f.node)} is the object’s root: move the object with transform_objects (bed coordinates).`);
        const t = applyTransformArgs(f.node.transform, {
          mode: args.mode === 'offset' ? 'offset' : 'set',
          position: vec3(args.position, 'position') ?? undefined, rotationDeg: vec3(args.rotationDeg, 'rotationDeg') ?? undefined, scale: vec3(args.scale, 'scale') ?? undefined,
        });
        await setNodeTransformOrThrow(f.o.id, f.node.id, t, 'Move shape');
        const o = getObject(f.o.id)!;
        return { data: { ok: true, id: f.node.id, transform: t, object: objectDetail(o.id) } };
      },
    },

    {
      name: 'group',
      description:
        'Group objects (at least 2) into one CubbyCAD manifold group object: solids union, holes (hole: true / set_hole) are subtracted — e.g. add_primitive a cylinder with hole: true, place it, group it with the part to drill it. ' +
        'Plain mesh objects join as baked meshes. Each object keeps its place (its placement becomes the child transform). Returns the group object.',
      inputSchema: obj({ ids: strList('Object ids (or their root node ids).'), name: str('Group name (default "Group").') }, ['ids']),
      async run(args) {
        await ensureCadWasm();
        const ids = idList(args).map((id) => getObject(id)?.id ?? locate(id).o.id);
        if (new Set(ids).size < 2) throw new Error('Pass at least two objects.');
        const gid = await groupObjectsAsync([...new Set(ids)], argString(args, 'name', { optional: true }) || 'Group');
        const o = getObject(gid)!;
        return { data: { ok: true, object: objectDetail(gid), groupId: o.cad!.node.id, tree: treeRow(o.cad!.node, cadSupportOf(o), true) } };
      },
    },

    {
      name: 'ungroup',
      description: 'Dissolve a group object: its children become objects of their own, in place (baked meshes become plain mesh objects again). Like CubbyCAD’s Ungroup (object.ungroup).',
      inputSchema: obj({ id: str('Group object id (or its root node id).') }, ['id']),
      async run(args) {
        await ensureCadWasm();
        const id = argString(args, 'id')!;
        const oid = getObject(id)?.id ?? locate(id).o.id;
        const made = await ungroupObjectAsync(oid);
        return { data: { ok: true, objects: made.map((x) => objectDetail(x)) } };
      },
    },

    {
      name: 'set_hole',
      description: 'Make CubbyCAD nodes holes (subtract) or solids (add) inside their group; an object id means its root (a hole object on its own is not printed until grouped).',
      inputSchema: obj({ ids: strList('Node or object ids.'), hole: bool('true = hole.') }, ['ids', 'hole']),
      async run(args) {
        await ensureCadWasm();
        if (typeof args.hole !== 'boolean') throw new Error('hole must be true or false.');
        const done: string[] = [];
        for (const id of idList(args)) {
          const f = locate(id);
          await editNodeOrThrow(f.o.id, { id: f.node.id, hole: args.hole }, args.hole ? 'Make hole' : 'Make solid');
          done.push(f.node.id);
        }
        return { data: { ok: true, ids: done, hole: args.hole } };
      },
    },

    {
      name: 'delete_nodes',
      description: 'Delete CubbyCAD nodes by id (each one undo step). Deleting an object’s root deletes the object.',
      inputSchema: obj({ ids: strList('Node ids.') }, ['ids']),
      async run(args) {
        await ensureCadWasm();
        const missing: string[] = [];
        let deleted = 0;
        for (const id of idList(args)) {
          let f;
          try { f = locate(id); } catch { missing.push(id); continue; }
          await deleteNodeOrThrow(f.o.id, f.node.id);
          deleted++;
        }
        return { data: { ok: missing.length === 0, deleted, missing: missing.length ? missing : undefined } };
      },
    },

    {
      name: 'select_node',
      description: 'Pick a CubbyCAD node in the shape panel (the gizmo then moves it), or an object id to pick its root.',
      inputSchema: obj({ id: NODE_ID, objectId: OBJECT_ID }, ['id']),
      async run(args) {
        const f = locate(argString(args, 'id')!, argString(args, 'objectId', { optional: true }));
        select([f.o.id]);
        pickNode(f.o.id, f.isRoot ? null : f.node.id);
        return { data: { ok: true, objectId: f.o.id, nodeId: f.node.id } };
      },
    },
  ];
}


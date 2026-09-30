/**
 * User-level CubbyCAD modelling commands (palette, params panel, node tree,
 * actions, bridge): each validates, applies through the project store (one
 * undo step) and reports problems with a toast or a thrown CadEditError.
 */
import { computed, reactive, watch } from 'vue';
import { toast } from '../ui';
import {
  activePlate, addCadObjects, endGesture, getObject, groupObjects, objects, planGroup, planUngroup, plateBedOf, plateOf, primarySelection,
  removeObjects, select, selectedIds, setCadNode, ungroupObject,
} from '../project/store';
import type { ProjectObject } from '../project/types';
import type { Vec3 } from '../project/math';
import { createPrimitiveNode, getSharedShape, isCadGroup, type CadNode, type CadTransform } from './api';
import { CadEvalError, ensureCadWasm, isHoleObject, supportIssues, warmCadMesh } from './build';
import { buildCubbyScene, parseCubbyScene, planCadImport, type CadImportPlan } from './cubby';
import { CadEditError, applyNodeSettings, findIn, mapNode, removeNodeFrom, supportMap, type NodeSettingsArgs } from './tree';
import { ImportError } from '../project/mesh';

// ---- which node of the selected object is being edited (UI state, not undoable) ----

export const cadUi = reactive({
  objectId: null as string | null,
  nodeId: null as string | null,
  /** The shape palette popover is open. */
  paletteOpen: false,
  /** The shape panel (tree + params) is expanded (phones start collapsed: it would cover the view). */
  panelOpen: !(typeof matchMedia !== 'undefined' && matchMedia('(max-width: 640px)').matches),
});

/** The one selected object, when it is a CAD object. */
export const cadObject = computed<ProjectObject | null>(() => {
  const o = primarySelection.value;
  return o && o.cad && selectedIds.value.length === 1 ? o : null;
});

/** The node the params panel / gizmo edit: the picked child, else the root. */
export const cadNode = computed<CadNode | null>(() => {
  const o = cadObject.value;
  if (!o?.cad) return null;
  const root = o.cad.node;
  if (cadUi.objectId === o.id && cadUi.nodeId) return findIn(root, cadUi.nodeId)?.node ?? root;
  return root;
});

/** A picked child (not the root): the gizmo moves it instead of the object. */
export const cadChild = computed<{ objectId: string; nodeId: string } | null>(() => {
  const o = cadObject.value, n = cadNode.value;
  return o && n && n.id !== o.cad!.node.id ? { objectId: o.id, nodeId: n.id } : null;
});

export const cadSupportOf = (o: ProjectObject) => supportMap(o.cad!.node, supportIssues(o.cad!.node));

export function pickNode(objectId: string, nodeId: string | null): void {
  if (selectedIds.value.length !== 1 || selectedIds.value[0] !== objectId) select([objectId]);
  cadUi.objectId = objectId;
  cadUi.nodeId = nodeId;
}

// Load the modelling engine as soon as the project has CAD objects (restored autosave, opened project).
watch(() => objects.value.some((o) => o.cad), (has) => { if (has) void ensureCadWasm().catch(() => {}); }, { immediate: true });

watch([selectedIds, objects], () => {
  if (!cadUi.objectId) return;
  const o = cadObject.value;
  if (!o || o.id !== cadUi.objectId || (cadUi.nodeId && !findIn(o.cad!.node, cadUi.nodeId))) { cadUi.objectId = null; cadUi.nodeId = null; }
});

// ---- errors -----------------------------------------------------------------------------

function report(e: unknown, what: string): void {
  if (e instanceof CadEditError || e instanceof CadEvalError || e instanceof ImportError) toast.warn(`${what}: ${e.message}`);
  else toast.error(`${what} failed.`, { detail: (e as Error)?.message ?? String(e) });
}

/** Run a command, toasting user errors. Returns undefined when it failed. */
export function attempt<T>(what: string, fn: () => T): T | undefined {
  try { return fn(); } catch (e) { report(e, what); return undefined; }
}

export async function attemptAsync<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch (e) { report(e, what); return undefined; }
}

/**
 * Build a new tree from an object's current one, evaluate it off the main
 * thread, then commit it as one undo step. When the tree changed meanwhile
 * (undo, another edit) the new tree is rebuilt from the current one.
 * `build` returns null for "nothing to change". Returns whether it committed.
 */
async function commitTree(objectId: string, build: (o: ProjectObject) => CadNode | null, opts: { label: string; mergeKey?: string }): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    const o = getObject(objectId);
    if (!o?.cad) throw new CadEditError('That object is not a CubbyCAD shape.');
    const base = o.cad.node;
    const next = build(o);
    if (!next) return false;
    await warmCadMesh(next);
    if (getObject(objectId)?.cad?.node !== base) continue;
    setCadNode(objectId, next, opts);
    return true;
  }
  throw new CadEditError('The shape kept changing while it was rebuilt. Try again.');
}

// ---- adding -------------------------------------------------------------------------------

/**
 * Add a built-in CubbyCAD primitive as a new object (the shape palette, the
 * "Add shape" menu, slicer_add_primitive). Returns the new object id.
 */
export async function addShape(shapeId: string, opts: { params?: Record<string, unknown>; name?: string; color?: string; hole?: boolean; position?: Vec3; rotation?: [number, number, number, number]; scale?: Vec3 } = {}): Promise<string> {
  const s = getSharedShape(shapeId);
  if (!s || !s.palette) throw new CadEditError(`Unknown shape "${shapeId}". Use list_shapes.`);
  let node: CadNode = createPrimitiveNode(shapeId, { name: opts.name ?? s.label, ...(opts.color ? { color: opts.color } : {}), hole: opts.hole });
  if (opts.params) node = applyNodeSettings(node, { id: node.id, params: opts.params }).root; // CubbyCAD's rules + the schema's limits
  const { transform: _t, ...stored } = node;
  await warmCadMesh(stored as CadNode);
  const [id] = addCadObjects([{ node: stored as CadNode, name: opts.name ?? s.label, position: opts.position, rotation: opts.rotation, scale: opts.scale }],
    { label: `Add ${s.label.toLowerCase()}`, exact: !!opts.position });
  return id;
}

export async function addShapeCmd(shapeId: string): Promise<void> {
  await attemptAsync('Add shape', () => addShape(shapeId));
}

/** Plate centre of the active plate, where the CubbyCAD origin lands. */
function activeOrigin(): Vec3 {
  const b = plateBedOf(activePlate.value);
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0];
}

/**
 * Import CubbyCAD top-level nodes (a .cubby scene, cad_to_slicer): one object
 * per node, laid out as in CubbyCAD around the plate centre when it fits.
 */
export async function importCadNodes(nodes: CadNode[], opts: { unit?: string; label?: string } = {}): Promise<{ ids: string[]; warnings: string[] }> {
  const plan: CadImportPlan = await planCadImport(nodes, { unit: opts.unit, origin: activeOrigin() });
  if (!plan.items.length) return { ids: [], warnings: plan.warnings.length ? plan.warnings : ['Nothing to import.'] };
  const ids = addCadObjects(plan.items, { label: opts.label ?? (plan.items.length === 1 ? `Import ${plan.items[0].name}` : `Import ${plan.items.length} objects`), keepPlacement: true });
  return { ids, warnings: plan.warnings };
}

/** Open a .cubby file (File → Import, drag and drop). Returns the new object ids. */
export async function importCubbyBuffer(name: string, buffer: ArrayBuffer): Promise<string[]> {
  const scene = parseCubbyScene(new TextDecoder().decode(buffer));
  const r = await importCadNodes(scene.nodes, { label: `Import ${name}` });
  if (r.warnings.length) toast.warn(r.ids.length ? `Imported ${name} with ${r.warnings.length === 1 ? 'a warning' : `${r.warnings.length} warnings`}.` : `Couldn’t import anything from ${name}.`, { detail: r.warnings.slice(0, 6).join('\n') });
  return r.ids;
}

/** The given (default: selected, else all) CAD objects as a .cubby scene. */
export function cubbySceneOf(list?: ProjectObject[], name?: string) {
  const objs = (list ?? (selectedIds.value.length ? objects.value.filter((o) => selectedIds.value.includes(o.id)) : objects.value)).filter((o) => o.cad);
  return buildCubbyScene(objs, (o) => {
    const b = plateBedOf(Math.max(0, plateOf(o.id)));
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0];
  }, name);
}

// ---- group / ungroup / hole -------------------------------------------------------------------

/** Group objects into one manifold group object (evaluated off-thread first). Returns the new object id. */
export async function groupObjectsAsync(ids: string[], name = 'Group'): Promise<string> {
  const plan = planGroup(ids, name);
  await warmCadMesh(plan.root);
  const still = plan.list.every((o) => getObject(o.id) === o);
  return groupObjects(ids, name, still ? plan : planGroup(ids, name));
}

/** Ungroup a group object (children evaluated off-thread first). Returns the new object ids. */
export async function ungroupObjectAsync(id: string): Promise<string[]> {
  const plan = planUngroup(id);
  for (const p of plan.pieces) if (p.node) await warmCadMesh(p.node);
  const o = getObject(id);
  return ungroupObject(id, o === plan.source && o?.cad?.node === plan.source.cad?.node ? plan : planUngroup(id));
}

export async function groupSelectionCmd(): Promise<void> {
  await attemptAsync('Group', () => groupObjectsAsync(selectedIds.value.slice()));
}

export async function ungroupSelectionCmd(): Promise<void> {
  const groups = objects.value.filter((o) => selectedIds.value.includes(o.id) && o.cad && isCadGroup(o.cad.node));
  if (!groups.length) { toast.info('Select a group to ungroup.'); return; }
  const made: string[] = [];
  for (const g of groups) made.push(...((await attemptAsync('Ungroup', () => ungroupObjectAsync(g.id))) ?? []));
  if (made.length) select(made);
}

/** Selection is (or contains) a hole: CubbyCAD's make-hole / make-solid toggle target state. */
export function selectionHoleState(): 'hole' | 'solid' | 'mixed' | null {
  const child = cadChild.value;
  if (child) return cadNode.value?.contribution === 'subtract' ? 'hole' : 'solid';
  const list = objects.value.filter((o) => selectedIds.value.includes(o.id) && o.cad);
  if (!list.length) return null;
  const holes = list.filter((o) => isHoleObject(o.cad!.node)).length;
  return holes === list.length ? 'hole' : holes ? 'mixed' : 'solid';
}

/** CubbyCAD make hole / make solid: the picked child node, or each selected CAD object's root. */
export async function setHoleCmd(hole: boolean): Promise<void> {
  const child = cadChild.value;
  if (child) { await editNode(child.objectId, { id: child.nodeId, hole }, hole ? 'Make hole' : 'Make solid'); return; }
  for (const o of objects.value.filter((x) => selectedIds.value.includes(x.id) && x.cad)) {
    await editNode(o.id, { id: o.cad!.node.id, hole }, hole ? 'Make hole' : 'Make solid');
  }
}

/** The node the lock command locks / unlocks: the picked shape, or the selected CAD object's root. */
export function lockTarget(): CadNode | null { return cadObject.value ? cadNode.value : null; }

export async function toggleLockCmd(): Promise<void> {
  const o = cadObject.value, n = lockTarget();
  if (o && n) await editNode(o.id, { id: n.id, locked: !n.locked }, n.locked ? 'Unlock shape' : 'Lock shape');
}

// ---- node edits ---------------------------------------------------------------------------------

/** set_node for one node of a CAD object, as one undo step. Resolves false (after a toast) on error. */
export async function editNode(objectId: string, args: NodeSettingsArgs, label = 'Edit shape', mergeKey?: string): Promise<boolean> {
  return (await attemptAsync(label, () => editNodeOrThrow(objectId, args, label, mergeKey))) ?? false;
}

export async function editNodeOrThrow(objectId: string, args: NodeSettingsArgs, label = 'Edit shape', mergeKey?: string): Promise<boolean> {
  return commitTree(objectId, (o) => {
    const r = applyNodeSettings(o.cad!.node, args, cadSupportOf(o));
    return r.changed ? r.root : null;
  }, { label, mergeKey });
}

function assertEditable(o: ProjectObject, nodeId: string): CadNode {
  const f = findIn(o.cad!.node, nodeId);
  if (!f) throw new CadEditError(`No node "${nodeId}" in ${o.name}.`);
  const s = cadSupportOf(o).get(nodeId);
  if (s && !s.editable) throw new CadEditError(`“${f.node.name ?? nodeId}” can’t be edited in the slicer: ${s.reason}`);
  if (f.node.locked) throw new CadEditError(`“${f.node.name ?? nodeId}” is locked.`);
  return f.node;
}

/** Move / rotate / scale a child node (render-frame transform in its parent's frame). */
export async function setNodeTransformOrThrow(objectId: string, nodeId: string, t: CadTransform, label = 'Move shape'): Promise<void> {
  await commitTree(objectId, (o) => {
    if (o.cad!.node.id === nodeId) throw new CadEditError('The root moves with the object: use transform_objects.');
    assertEditable(o, nodeId);
    return mapNode(o.cad!.node, nodeId, (n) => ({ ...n, transform: t }));
  }, { label });
}

export async function setNodeTransform(objectId: string, nodeId: string, t: CadTransform, label = 'Move shape'): Promise<void> {
  await attemptAsync(label, () => setNodeTransformOrThrow(objectId, nodeId, t, label));
}

/** Delete a node; deleting the root deletes the object. */
export async function deleteNodeOrThrow(objectId: string, nodeId: string): Promise<void> {
  const o = getObject(objectId);
  if (!o?.cad) throw new CadEditError('That object is not a CubbyCAD shape.');
  if (o.cad.node.id === nodeId) { removeObjects([objectId]); return; }
  const name = findIn(o.cad.node, nodeId)?.node.name ?? 'shape';
  await commitTree(objectId, (x) => {
    const n = findIn(x.cad!.node, nodeId)?.node;
    if (n?.locked) throw new CadEditError(`“${n.name ?? nodeId}” is locked.`);
    return removeNodeFrom(x.cad!.node, nodeId);
  }, { label: `Delete ${name}` });
  if (cadUi.nodeId === nodeId) cadUi.nodeId = null;
}

export async function deleteNode(objectId: string, nodeId: string): Promise<void> {
  await attemptAsync('Delete', () => deleteNodeOrThrow(objectId, nodeId));
}

// ---- slider drags: debounced, evaluated off-thread, one undo step per drag -----------------------

interface PendingParams { objectId: string; nodeId: string; params: Record<string, unknown>; key: string }
const queue: PendingParams[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let draining = false;
let closeGesture = false;
const PARAM_DEBOUNCE_MS = 45;

/** Commit queued parameter edits one at a time (a slow tree just skips intermediate values). */
async function drain(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const p = queue.shift()!;
      await editNode(p.objectId, { id: p.nodeId, params: p.params }, 'Change shape', `cad:params:${p.nodeId}:${p.key}`);
    }
  } finally {
    draining = false;
    if (closeGesture && !queue.length) { closeGesture = false; endGesture(); }
  }
}

/**
 * A parameter changed in the params form. Rapid changes (a slider drag) are
 * evaluated at most every few frames, off the main thread, and coalesce into
 * one undo step; `final` (drag end / typed value) commits and closes the step.
 */
export function queueParam(objectId: string, nodeId: string, key: string, value: unknown, final = false): void {
  const last = queue.at(-1);
  if (last && last.objectId === objectId && last.nodeId === nodeId) { last.params[key] = value; last.key = key; }
  else queue.push({ objectId, nodeId, params: { [key]: value }, key });
  if (final) { closeGesture = true; void drain(); return; }
  timer ??= setTimeout(() => { void drain(); }, PARAM_DEBOUNCE_MS);
}

/** Drag released: commit what is queued and close the undo step. */
export function commitParams(): void { closeGesture = true; void drain(); }

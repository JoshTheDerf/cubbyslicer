/**
 * CubbyCAD modelling: objects that carry a node tree (src/cad). Adding tree
 * objects, replacing a tree, group / ungroup. See docs/DEVELOPMENT.md
 * "CubbyCAD modelling" for the frames involved.
 */
import { groupNodes, isCadGroup, ungroupNode, type CadGeometry, type CadNode } from '../../cad/api';
import { evaluateCadMesh } from '../../cad/build';
import { cadTransformToTrs, trsToCadTransform } from '../../cad/frames';
import {
  CadEditError, allIds, decodeMesh, encodeMesh, isPlainMeshNode, renderToZupPositions, withFreshIds, zupToRenderPositions,
} from '../../cad/tree';
import { composeTRS, decomposeTRS, mat4Multiply, quatNormalize, type Quat, type Vec3 } from '../math';
import type { MeshData, ProjectObject } from '../types';
import { cadData, cloneOverrides } from './clone';
import { objectWorldInfo, objectsOnPlate } from './derived';
import { mutate } from './history';
import type { AddOptions } from './objects';
import { anyClash, arrangeInternal, dropObj, placeOnPlates } from './placement';
import { activePlate, addMesh, getObject, meshes, objects, plateBedOf, selectedIds, targets, uid, uniqueName } from './state';

/** Tree hash → mesh id, so reverting an edit (or undo + redo) reuses the mesh. */
const cadMeshIds = new Map<string, string>();

/** The mesh a tree evaluates to (evaluated or cached). Throws CadEvalError when nothing can be built. */
function cadMeshOf(node: CadNode): MeshData {
  const r = evaluateCadMesh(node);
  const known = cadMeshIds.get(r.hash);
  const m = known ? meshes.get(known) : undefined;
  if (m) return m;
  const mesh = addMesh(r.positions.slice(), r.indices.slice());
  cadMeshIds.set(r.hash, mesh.id);
  return mesh;
}

/** The root of a stored tree carries no transform (the object's TRS replaces it) and no visibility flag. */
function storedRoot(node: CadNode): CadNode {
  const { transform: _t, hidden: _h, ...rest } = node;
  return rest as CadNode;
}

const rootColor = (n: CadNode): string => (typeof n.material?.color === 'string' && /^#[0-9a-f]{6}$/i.test(n.material.color) ? n.material.color : '');

export interface CadObjectInput {
  name?: string;
  node: CadNode;
  /** Bed-space placement (default: next to what is on the active plate). */
  position?: Vec3; rotation?: Quat; scale?: Vec3;
  visible?: boolean;
}

/**
 * Add objects made of CubbyCAD trees (the palette, .cubby import, the
 * bridge). Every tree is evaluated before anything changes, so a bad one
 * adds nothing. `keepPlacement`: keep the given x/y when they fit (file
 * layouts), otherwise place like an import; `exact`: keep them regardless.
 * Returns the new object ids.
 */
export function addCadObjects(items: CadObjectInput[], opts: AddOptions & { keepPlacement?: boolean; exact?: boolean } = {}): string[] {
  if (!items.length) return [];
  const prepared = items.map((it) => { const node = storedRoot(it.node); return { it, node, mesh: cadMeshOf(node) }; });
  const ids: string[] = [];
  mutate(opts.label ?? (items.length === 1 ? `Add ${prepared[0].it.name ?? prepared[0].node.name ?? 'shape'}` : `Add ${items.length} objects`), () => {
    const plate = activePlate.value;
    const existing = objectsOnPlate(plate);
    const b = plateBedOf(plate);
    const fresh: ProjectObject[] = [];
    for (const { it, node, mesh } of prepared) {
      const o: ProjectObject = {
        id: uid(), name: uniqueName(it.name ?? ((typeof node.name === 'string' && node.name) || 'Shape')), meshId: mesh.id,
        position: it.position ? [...it.position] as Vec3 : [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0],
        rotation: it.rotation ? quatNormalize(it.rotation) : [0, 0, 0, 1], scale: it.scale ? [...it.scale] as Vec3 : [1, 1, 1],
        visible: it.visible ?? true, printable: true, overrides: {}, color: rootColor(node), cad: cadData(node),
      };
      objects.value.push(o);
      const live = objects.value[objects.value.length - 1];
      dropObj(live);
      fresh.push(live);
      ids.push(o.id);
    }
    // `exact`: the caller placed it on purpose (a hole over a part, the bridge's `position`).
    if (opts.exact) return;
    const clash = anyClash(fresh, existing, plate);
    if (!opts.keepPlacement || clash) {
      if (fresh.length === 1 && !clash) return;
      if (existing.length === 0 && fresh.length > 1) arrangeInternal(fresh, existing, 6, true, 'bottom-left', plate);
      else placeOnPlates(fresh, existing, plate);
    }
  });
  if (opts.select ?? true) selectedIds.value = ids;
  return ids;
}

/**
 * Replace an object's tree (and every instance's: they share the mesh) and
 * re-evaluate its mesh. A new mesh starts unpainted, like any mesh-replacing
 * tool (paint is keyed by mesh). `mergeKey` coalesces slider drags into one
 * undo step. Throws (changing nothing) when the tree can't be built.
 */
export function setCadNode(objId: string, node: CadNode, opts: { label: string; mergeKey?: string }): void {
  const o = getObject(objId);
  if (!o?.cad) throw new CadEditError('That object is not a CubbyCAD shape.');
  const root = storedRoot(node);
  const mesh = cadMeshOf(root);
  mutate(opts.label, () => {
    const from = getObject(objId)!.meshId;
    for (const x of objects.value) {
      if (x.meshId !== from && x.id !== objId) continue;
      x.meshId = mesh.id;
      x.cad = cadData(root);
      const c = rootColor(root);
      if (c) x.color = c;
      dropObj(x);
    }
  }, { mergeKey: opts.mergeKey });
}

/** Where a set of objects sits: the centre of their footprint at the bed (z = min). */
function pivotOf(list: ProjectObject[]): Vec3 {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of list) {
    const i = objectWorldInfo(o);
    if (!i) continue;
    minX = Math.min(minX, i.min[0]); minY = Math.min(minY, i.min[1]); minZ = Math.min(minZ, i.min[2]);
    maxX = Math.max(maxX, i.max[0]); maxY = Math.max(maxY, i.max[1]);
  }
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2, minZ] : [0, 0, 0];
}

/** An object as a child node of a new group around `pivot` (render-frame transform; plain meshes become `mesh` nodes). */
function objectAsChild(o: ProjectObject, pivot: Vec3, seen: Set<string>): CadNode {
  const transform = trsToCadTransform({ position: o.position, rotation: o.rotation, scale: o.scale }, pivot);
  let node: CadNode;
  if (o.cad) {
    node = o.cad.node;
    // Instances (or copies) of one tree: the second one gets fresh ids.
    const ids = allIds(node);
    if ([...ids].some((id) => seen.has(id))) node = withFreshIds(node);
    for (const id of allIds(node)) seen.add(id);
    if (!o.visible) node = { ...node, hidden: true };
  } else {
    const m = meshes.get(o.meshId);
    if (!m) throw new CadEditError(`${o.name} has no mesh.`);
    node = {
      id: `mesh-${uid('n').slice(2)}`, type: 'primitive', name: o.name,
      geometry: encodeMesh(zupToRenderPositions(m.positions), m.indices, o.name),
      ...(o.color && /^#[0-9a-f]{6}$/i.test(o.color) ? { material: { color: o.color } } : {}),
      ...(o.visible ? {} : { hidden: true }),
    };
    seen.add(node.id);
  }
  return { ...node, transform };
}

/**
 * CubbyCAD Group (Ctrl+G there): the selected objects become one object
 * whose tree is a manifold group of them — solids union, holes subtract.
 * Each object's TRS becomes its child transform (Z-up bed → render frame,
 * around the selection's bottom centre). Returns the new object id.
 */
export function groupObjects(ids = selectedIds.value.slice(), name = 'Group', plan = planGroup(ids, name)): string {
  const { list, pivot, root } = plan;
  const mesh = cadMeshOf(root);
  const first = list[0];
  const id = uid();
  mutate(`Group ${list.length} objects`, () => {
    const at = objects.value.findIndex((x) => x.id === first.id);
    const drop = new Set(list.map((o) => o.id));
    const o: ProjectObject = {
      id, name: uniqueName(name), meshId: mesh.id, position: pivot, rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      visible: true, printable: first.printable, overrides: cloneOverrides(first.overrides), color: rootColor(root) || first.color,
      cad: cadData(root),
    };
    objects.value = [...objects.value.slice(0, at).filter((x) => !drop.has(x.id)), o, ...objects.value.slice(at).filter((x) => !drop.has(x.id))];
    dropObj(objects.value.find((x) => x.id === id)!);
  });
  selectedIds.value = [id];
  return id;
}

/** What groupObjects will build (validated; nothing changes). Warm `root` off-thread, then pass the plan in. */
export function planGroup(ids: string[], name = 'Group'): { list: ProjectObject[]; pivot: Vec3; root: CadNode } {
  const list = targets(ids);
  if (list.length < 2) throw new CadEditError('Select at least two objects to group.');
  const withParts = list.find((o) => o.parts?.length);
  if (withParts) throw new CadEditError(`${withParts.name} has parts or modifiers; groups combine whole objects only. Remove its parts first.`);
  const pivot = pivotOf(list);
  const seen = new Set<string>();
  return { list, pivot, root: storedRoot(groupNodes(list.map((o) => objectAsChild(o, pivot, seen)), { name })) };
}

export interface UngroupPlan {
  source: ProjectObject;
  pieces: Array<{ node: CadNode | null; mesh: MeshData | null; trs: { position: Vec3; rotation: Quat; scale: Vec3 }; visible: boolean; name: string; color: string }>;
}

/** What ungroupObject will make (validated; plain meshes decoded). Warm each piece's `node` off-thread, then pass the plan in. */
export function planUngroup(id: string): UngroupPlan {
  const o = getObject(id);
  const g = o?.cad?.node;
  if (!o || !g || !isCadGroup(g)) throw new CadEditError('Select a group to ungroup.');
  if (g.locked) throw new CadEditError(`“${g.name ?? 'Group'}” is locked.`);
  if (!g.children.length) throw new CadEditError('The group is empty.');
  const objM = composeTRS(o.position, o.rotation, o.scale);
  const made: UngroupPlan['pieces'] = [];
  for (const child of ungroupNode({ ...g, transform: undefined })) {
    const t = cadTransformToTrs(child.transform);
    let trs = { position: t.position, rotation: t.rotation, scale: t.scale };
    let node: CadNode = { ...child, transform: undefined };
    const visible = !child.hidden;
    if (child.hidden) node = { ...node, hidden: undefined };
    if (!t.exact) {
      // Sheared (non-uniform scale under a rotation): keep the exact matrix inside a one-child group.
      node = groupNodes([child], { name: child.name ?? 'Group' });
      trs = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    }
    const d = decomposeTRS(mat4Multiply(objM, composeTRS(trs.position, trs.rotation, trs.scale)));
    const name = typeof child.name === 'string' && child.name ? child.name : 'Shape';
    const color = rootColor(node) || o.color;
    if (isPlainMeshNode(node) && node.contribution !== 'subtract') {
      const dec = decodeMesh((node as { geometry: CadGeometry }).geometry);
      if (dec) { made.push({ node: null, mesh: addMesh(renderToZupPositions(dec.positions), dec.indices), trs: d, visible, name, color }); continue; }
    }
    const root = storedRoot(node);
    made.push({ node: root, mesh: null, trs: d, visible, name, color });
  }
  return { source: o, pieces: made };
}

/**
 * CubbyCAD Ungroup: a group object's children become objects of their own,
 * in place (the object's TRS · the child transform, back in bed space). Plain
 * baked meshes become mesh objects again. Returns the new object ids.
 */
export function ungroupObject(id: string, plan = planUngroup(id)): string[] {
  const o = plan.source;
  const made = plan.pieces.map((m) => ({ ...m, mesh: m.mesh ?? cadMeshOf(m.node!) }));
  const created: string[] = [];
  mutate(`Ungroup ${o.name}`, () => {
    const at = objects.value.findIndex((x) => x.id === id);
    const fresh: ProjectObject[] = made.map((m) => ({
      id: uid(), name: uniqueName(m.name), meshId: m.mesh.id, position: m.trs.position, rotation: quatNormalize(m.trs.rotation), scale: m.trs.scale,
      visible: m.visible, printable: o.printable, overrides: cloneOverrides(o.overrides), color: m.color,
      ...(m.node ? { cad: cadData(m.node) } : {}),
    }));
    objects.value.splice(at, 1, ...fresh);
    for (const f of fresh) created.push(f.id);
  });
  selectedIds.value = created;
  return created;
}

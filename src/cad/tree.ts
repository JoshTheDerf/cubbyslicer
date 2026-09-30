/**
 * Slicer-side helpers over CubbyCAD node trees. Trees are treated as
 * IMMUTABLE: every edit returns a new root that shares untouched subtrees,
 * so undo snapshots can hold them by reference.
 */
import {
  CUBBY_ORIGINAL_KEY, cloneCadNode, computeAncestorMatrix, isCadStandIn, findNode, getSharedShape, isCadGroup, isCadPrimitive, removeNode, updateNode, walkCadNodes,
  applyTransformArgs as sharedTransformArgs, applyCadNodeSettings, decodeMeshGeometry, encodeMeshGeometry, type CadGeometry, type CadGroupNode, type CadNode, type CadTransform, type EvalIssue, type TransformArgs,
} from './api';
import { mat4Identity, type Mat4 } from '../project/math';
import { cleanTransform } from './frames';

export class CadEditError extends Error { override name = 'CadEditError'; }

/** Visit every node, depth-first, parents before children. */
export function walkNodes(root: CadNode, fn: (n: CadNode, parent: CadGroupNode | null, depth: number) => void): void {
  walkCadNodes(root, fn);
}

/** Find a node in one object's tree. */
export function findIn(root: CadNode, id: string) { return findNode([root], id); }

/**
 * The render-frame matrix of a node's parent frame inside the object: the
 * product of its ancestors' transforms, EXCLUDING the root's own (the object's
 * TRS replaces it). Identity for the root and its direct children.
 */
export function parentFrameMatrix(root: CadNode, id: string): Mat4 {
  return computeAncestorMatrix([{ ...root, transform: undefined }], id) ?? mat4Identity();
}

/** Replace the node `id` with `fn(node)`; returns the new root. Throws when missing. */
export function mapNode(root: CadNode, id: string, fn: (n: CadNode) => CadNode): CadNode {
  if (!findIn(root, id)) throw new CadEditError(`No node "${id}" in this object.`);
  return updateNode(root, id, fn);
}

/** Remove node `id`; null when it is the root. */
export function removeNodeFrom(root: CadNode, id: string): CadNode | null {
  if (!findIn(root, id)) throw new CadEditError(`No node "${id}" in this object.`);
  return removeNode(root, id);
}

/** Deep copy with fresh ids everywhere (so a pasted / grouped copy never shares ids). */
export function withFreshIds(n: CadNode): CadNode {
  return cloneCadNode(n, { freshIds: true });
}

export function allIds(root: CadNode): Set<string> {
  const s = new Set<string>();
  walkCadNodes(root, (n) => s.add(n.id));
  return s;
}

// ---- what the tree shows ------------------------------------------------------------------

/**
 * The CubbyCAD-only original a baked stand-in carries (cad_to_slicer: a `mesh`
 * primitive with the original under `cubbyOriginal`, @cubby/shared/cad transfer).
 */
export function bakedOriginal(n: CadNode): CadNode | null {
  return isCadStandIn(n) ? n[CUBBY_ORIGINAL_KEY] as CadNode : null;
}

const KIND_LABELS: Record<string, string> = { sdf: 'Blended group', loft: 'Loft group', hull: 'Skin group', skin: 'Skin group' };
const SHAPE_LABELS: Record<string, string> = {
  user: 'Script part', text: 'Text', 'sketch-extrude': 'Sketch extrude', 'sketch-revolve': 'Sketch revolve', 'sketch-sweep': 'Sketch sweep',
  sdfSculpt: 'Sculpt', imported: 'Imported mesh', 'part-ref': 'Part reference', referenceImage: 'Reference image', mesh: 'Mesh',
};

/** What kind of node this is, in words ("Box", "Group", "Blended group", "Script part", …). */
export function nodeKindLabel(n: CadNode): string {
  const o = bakedOriginal(n);
  if (o) return nodeKindLabel(o);
  if (isCadGroup(n)) return KIND_LABELS[n.csgMode ?? 'manifold'] ?? 'Group';
  if (isCadPrimitive(n)) return getSharedShape(n.geometry.type)?.label ?? SHAPE_LABELS[n.geometry.type] ?? n.geometry.type;
  return n.type;
}

export function nodeName(n: CadNode): string {
  return (typeof n.name === 'string' && n.name) || bakedOriginal(n)?.name || nodeKindLabel(n);
}

/** Icon for a node row (the shape's palette icon where there is one). */
export function nodeIcon(n: CadNode): string {
  const o = bakedOriginal(n);
  if (o) return nodeIcon(o);
  if (isCadGroup(n)) return (n.csgMode ?? 'manifold') === 'manifold' ? 'i-lucide-folder' : 'i-lucide-blend';
  if (isCadPrimitive(n)) {
    const s = getSharedShape(n.geometry.type);
    if (s) return s.icon;
    if (n.geometry.type === 'user') return 'i-lucide-code';
    if (n.geometry.type === 'text') return 'i-lucide-type';
    if (n.geometry.type.startsWith('sketch')) return 'i-lucide-pen-tool';
    if (n.geometry.type === 'sdfSculpt') return 'i-lucide-brush';
    return 'i-lucide-shapes';
  }
  return 'i-lucide-circle-help';
}

export interface NodeSupport {
  /** The shared code can edit this node (params, transform, hole, colour, …). */
  editable: boolean;
  /** Why not, for the badge. */
  reason?: string;
  /**
   * A baked stand-in for CubbyCAD-only content (cad_to_slicer): it moves,
   * hides, recolours, groups and cuts like any part, but its own settings
   * (blend, script, sculpt, …) are CubbyCAD's; `reason` says so.
   */
  baked?: boolean;
}

/** Support per node id: unsupported nodes (and everything inside them) are read-only. */
export function supportMap(root: CadNode, issues: Map<string, EvalIssue>): Map<string, NodeSupport> {
  const out = new Map<string, NodeSupport>();
  const visit = (n: CadNode, inherited: NodeSupport | null) => {
    const o = bakedOriginal(n);
    let s: NodeSupport;
    if (inherited) s = inherited;
    else if (o) {
      const why = unsupportedReason(o) ?? 'CubbyCAD-only content.';
      s = { editable: true, baked: true, reason: `${why} Shown as a baked mesh: move, hide, recolour or group it here; change its shape in CubbyCAD.` };
    } else if (issues.has(n.id)) s = { editable: false, reason: `${issues.get(n.id)!.message} It is kept in the file but not shown; edit it in CubbyCAD.` };
    else s = { editable: true };
    out.set(n.id, s);
    if (isCadGroup(n)) for (const c of n.children) visit(c, s.editable ? null : s);
  };
  visit(root, null);
  return out;
}

/** Why a (baked) original can't be edited here, from its own shape. */
function unsupportedReason(n: CadNode): string | null {
  if (n.modifiers?.length) return 'Modifier stacks are CubbyCAD-only.';
  if (isCadGroup(n) && (n.csgMode ?? 'manifold') !== 'manifold') return `${nodeKindLabel(n)}s are CubbyCAD-only.`;
  if (isCadPrimitive(n) && !getSharedShape(n.geometry.type)) return `${nodeKindLabel(n)} nodes are CubbyCAD-only.`;
  return null;
}

// ---- settings (CubbyCAD bridge set_node / the properties panel) -------------------------------

export interface NodeSettingsArgs {
  id: string;
  name?: string;
  hidden?: boolean;
  locked?: boolean;
  hole?: boolean;
  color?: string;
  params?: Record<string, unknown>;
}

/**
 * Apply any mix of settings to one node (validated first, so a bad field
 * changes nothing). Mirrors CubbyCAD's applyNodeSettings for the fields the
 * slicer supports; returns the new root.
 */
export function applyNodeSettings(root: CadNode, args: NodeSettingsArgs, support?: Map<string, NodeSupport>): { root: CadNode; changed: boolean } {
  const f = findIn(root, args.id);
  if (!f) throw new CadEditError(`No node "${args.id}" in this object.`);
  const node = f.node;
  const label = nodeName(node);
  // Slicer rules first: CubbyCAD-only nodes are read-only here; params must be the shape's own, clamped to its schema.
  const s = support?.get(node.id);
  if (s && !s.editable && (Object.keys(args) as Array<keyof NodeSettingsArgs>).some((k) => k !== 'id' && args[k] !== undefined)) {
    throw new CadEditError(`“${label}” can’t be edited in the slicer: ${s.reason ?? 'CubbyCAD-only content.'}`);
  }
  let params = args.params;
  if (params !== undefined && isCadPrimitive(node)) {
    const shape = getSharedShape(node.geometry.type);
    if (shape && params && typeof params === 'object') {
      const known = new Set([...Object.keys(shape.defaults), ...Object.keys(shape.schema?.properties ?? {})]);
      const unknown = Object.keys(params).filter((k) => !known.has(k));
      if (unknown.length) throw new CadEditError(`Unknown ${shape.label.toLowerCase()} parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Parameters: ${[...known].join(', ')}.`);
      params = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, shape.schema?.properties[k] ? coerceParam(v, shape.schema.properties[k] as never, k) : v]));
    }
  }
  // CubbyCAD's own set_node validation and application (@cubby/shared/cad).
  try {
    const r = applyCadNodeSettings(root, { ...args, params, ...(args.name !== undefined ? { name: String(args.name).slice(0, 200) } : {}) });
    return { root: r.root, changed: r.changed };
  } catch (e) {
    throw new CadEditError((e as Error).message);
  }
}

/** Clamp / round a parameter value to its schema (CubbyCAD's form does the same). */
export function coerceParam(v: unknown, p: { type: string; min?: number; max?: number; options?: Array<{ value: string }> }, key = 'value'): unknown {
  if (p.type === 'number' || p.type === 'integer') {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new CadEditError(`${key} must be a number.`);
    let x = p.type === 'integer' ? Math.round(n) : n;
    if (p.min !== undefined) x = Math.max(p.min, x);
    if (p.max !== undefined) x = Math.min(p.max, x);
    return x;
  }
  if (p.type === 'boolean') { if (typeof v !== 'boolean') throw new CadEditError(`${key} must be true or false.`); return v; }
  if (p.type === 'enum') {
    if (p.options && !p.options.some((o) => o.value === v)) throw new CadEditError(`${key} must be one of ${p.options.map((o) => o.value).join(', ')}.`);
    return v;
  }
  return String(v);
}

/** CubbyCAD's transform_node semantics (shared), float noise rounded away. */
export function applyTransformArgs(t: CadTransform | undefined, a: TransformArgs): CadTransform {
  return cleanTransform(sharedTransformArgs(t, a));
}

// ---- baked meshes (CubbyCAD's `mesh` geometry) ----------------------------------------------

/**
 * A slicer mesh as CubbyCAD `mesh` geometry (shared codec). Positions are in
 * the render frame (Y-up), as CubbyCAD stores baked meshes.
 */
export function encodeMesh(positions: Float32Array, indices: Uint32Array, name?: string): CadGeometry {
  return encodeMeshGeometry({ positions, indices, name }) as unknown as CadGeometry;
}

/** Decode CubbyCAD `mesh` geometry (render frame); non-indexed payloads get an index. Null when malformed. */
export function decodeMesh(g: CadGeometry): { positions: Float32Array; indices: Uint32Array } | null {
  const d = decodeMeshGeometry(g);
  if (!d) return null;
  return { positions: d.positions, indices: d.indices ?? Uint32Array.from({ length: d.positions.length / 3 }, (_, i) => i) };
}

/** A plain (not stand-in) baked mesh node: ungrouping turns it back into a mesh object. */
export function isPlainMeshNode(n: CadNode): boolean {
  return isCadPrimitive(n) && n.geometry.type === 'mesh' && !bakedOriginal(n) && !n.modifiers?.length;
}

/** Positions in place: render frame → Z-up (x, y, z) → (x, -z, y). */
export function renderToZupPositions(p: Float32Array): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) { out[i] = p[i]; out[i + 1] = -p[i + 2]; out[i + 2] = p[i + 1]; }
  return out;
}
/** Z-up → render frame (x, y, z) → (x, z, -y). */
export function zupToRenderPositions(p: Float32Array): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) { out[i] = p[i]; out[i + 1] = p[i + 2]; out[i + 2] = -p[i + 1]; }
  return out;
}

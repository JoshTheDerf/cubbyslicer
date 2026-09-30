/**
 * CubbyCAD scenes in and out of the slicer.
 *
 * - Import (`.cubby` files, the bridge's slicer_import_cad / cad_to_slicer):
 *   one slicer object per top-level node. The root's render-frame transform
 *   becomes the object's TRS (Y-up → Z-up) around the plate
 *   centre; the tree itself is kept verbatim (minus that root transform).
 *   CubbyCAD geometry is always mm (a scene's `unit` is for display).
 * - Export (.cubby): the objects' trees back into a scene, each root getting
 *   its object's TRS (bed → CAD frame, relative to its plate's centre).
 */
import { ImportError } from '../project/mesh';
import { isCadGroup, isCadStandIn, restoreCadOriginals, type CadNode } from './api';
import { CadEvalError, warmCadMesh } from './build';
import { UNIT_TO_MM, cadTransformToTrs, trsToCadTransform } from './frames';
import { walkNodes } from './tree';
import type { ProjectObject } from '../project/types';
import type { Vec3 } from '../project/math';

export const CUBBY_EXT = '.cubby';
export const isCubbyName = (name: string) => /\.cubby(\.json)?$/i.test(name);

const MAX_NODES = 20000;
const MAX_DEPTH = 64;

/** Validate untrusted nodes (shape only: every node needs an id and a type; the rest is carried through verbatim). */
export function sanitizeCadNodes(raw: unknown, what = 'The scene'): CadNode[] {
  if (!Array.isArray(raw)) throw new ImportError(`${what} has no node list.`);
  let count = 0;
  const ids = new Set<string>();
  const check = (n: unknown, depth: number): n is CadNode => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return false;
    const o = n as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id || typeof o.type !== 'string') return false;
    if (++count > MAX_NODES) throw new ImportError(`${what} has more than ${MAX_NODES} nodes.`);
    if (depth > MAX_DEPTH) throw new ImportError(`${what} is nested too deeply.`);
    if (ids.has(o.id)) throw new ImportError(`${what} uses the node id “${o.id}” twice.`);
    ids.add(o.id);
    if (o.type === 'group') {
      if (!Array.isArray(o.children)) return false;
      o.children = o.children.filter((c) => check(c, depth + 1));
    } else if (o.type === 'primitive' && (!o.geometry || typeof o.geometry !== 'object' || typeof (o.geometry as { type?: unknown }).type !== 'string')) return false;
    return true;
  };
  return raw.filter((n) => check(n, 0));
}

export interface CadImportItem {
  name: string;
  node: CadNode;
  position: Vec3;
  rotation: [number, number, number, number];
  scale: Vec3;
  visible: boolean;
}

export interface CadImportPlan { items: CadImportItem[]; warnings: string[] }

/**
 * Turn top-level nodes into objects to add: evaluate each (skipping ones that
 * can't be shown at all) and convert the root transform. `origin` is the bed
 * point the CAD origin maps to (the plate centre).
 */
export async function planCadImport(nodes: CadNode[], opts: { unit?: string; origin: Vec3 }): Promise<CadImportPlan> {
  const unit = opts.unit ?? 'mm';
  const k = UNIT_TO_MM[unit];
  if (!k) throw new ImportError(`Unknown unit “${unit}” (mm, cm, m or in).`);
  const items: CadImportItem[] = [];
  const warnings: string[] = [];
  for (const raw of nodes) {
    const t = cadTransformToTrs(raw.transform, k);
    const node: CadNode = { ...raw };
    delete node.transform;
    delete node.hidden;
    const label = (typeof raw.name === 'string' && raw.name) || (isCadGroup(raw) ? 'Group' : 'Shape');
    let wrapped = node;
    let trs = t;
    if (!t.exact) {
      // Shear at the root: keep the exact matrix inside a one-child group.
      wrapped = { id: `${raw.id}-wrap`, type: 'group', name: label, children: [{ ...raw, hidden: undefined }] } as CadNode;
      trs = { ...cadTransformToTrs(undefined, k), exact: true };
    }
    try { await warmCadMesh(wrapped); } catch (e) {
      warnings.push(`Skipped “${label}”: ${e instanceof CadEvalError ? e.message.replace(/^Nothing to show: /, '') : (e as Error).message} Send it with cad_to_slicer (it bakes CubbyCAD-only content) or bake it in CubbyCAD.`);
      continue;
    }
    items.push({
      name: label, node: wrapped,
      position: [trs.position[0] + opts.origin[0], trs.position[1] + opts.origin[1], trs.position[2] + opts.origin[2]],
      rotation: trs.rotation, scale: trs.scale, visible: !raw.hidden,
    });
  }
  const unsupported = new Map<string, number>();
  for (const it of items) walkNodes(it.node, (n) => {
    if (isCadStandIn(n)) unsupported.set('baked', (unsupported.get('baked') ?? 0) + 1);
  });
  if (unsupported.get('baked')) warnings.push(`${unsupported.get('baked')} CubbyCAD-only part${unsupported.get('baked') === 1 ? ' is' : 's are'} shown as baked meshes (their shape is edited in CubbyCAD).`);
  return { items, warnings };
}

/** Parse a .cubby file (CubbyCAD scene JSON). */
export function parseCubbyScene(text: string): { name?: string; nodes: CadNode[] } {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new ImportError('This .cubby file is not valid JSON.'); }
  if (!json || typeof json !== 'object') throw new ImportError('This is not a CubbyCAD scene.');
  const o = json as Record<string, unknown>;
  // A whole scene, or (cad_to_slicer / clipboard) a bare node list.
  const children = Array.isArray(json) ? json : o.children;
  if (!Array.isArray(children)) throw new ImportError('This is not a CubbyCAD scene (no children).');
  // `unit` is display-only in CubbyCAD: geometry is always mm.
  return { name: typeof o.name === 'string' ? o.name : undefined, nodes: sanitizeCadNodes(children) };
}

/**
 * The CAD objects as a CubbyCAD scene. Each root gets its object's placement:
 * bed → render frame, relative to the centre of the object's plate (CubbyCAD's
 * origin), unit mm. Hidden objects are hidden nodes.
 */
export function buildCubbyScene(list: ProjectObject[], plateCentre: (o: ProjectObject) => Vec3, name?: string): { version: 1; unit: 'mm'; name?: string; children: CadNode[] } {
  const children: CadNode[] = [];
  for (const o of list) {
    if (!o.cad) continue;
    const c = plateCentre(o);
    children.push({
      ...restoreCadOriginals(o.cad.node),
      ...(o.name && o.name !== o.cad.node.name ? { name: o.name } : {}),
      transform: trsToCadTransform({ position: o.position, rotation: o.rotation, scale: o.scale }, [c[0], c[1], 0]),
      ...(o.visible ? {} : { hidden: true }),
    });
  }
  return { version: 1, unit: 'mm', ...(name ? { name } : {}), children };
}

/** For export to CubbyCAD: baked stand-ins go back to the CubbyCAD-only originals they carry (keeping edits made here). */
export { restoreCadOriginals as restoreOriginals } from './api';

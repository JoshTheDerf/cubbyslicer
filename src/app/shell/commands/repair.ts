/**
 * Desktop Orca 2.5 "Fix model" (object list) and "Fix All" / "Fix All Plates"
 * (plate menu): libslic3r's CGAL repair through the engine's `repair_mesh` op
 * (docs/ENGINE-CONTRACT.md "Mesh repair"), one call per model part, paint
 * re-projected onto the repaired triangles, one undo step per command, then a
 * summary of what was fixed and what couldn't be.
 */
import { engineTool } from '../../../engine/client';
import type { ToolMesh } from '../../../engine/types';
import type { RepairMeshArgs, RepairMeshResult, RepairMeshStats } from '../../../engine/tools';
import { isHoleObject } from '../../../cad/build';
import {
  activePlate, commitMeshRepairs, getMesh, getMeshPaint, objects, objectsOnPlate, selectedIds, type MeshRepair,
} from '../../../project/store';
import type { ProjectObject } from '../../../project/types';
import { dismissToast, toast } from '../../../ui';
import { ui } from '../uiState';

export type RepairScope = 'selection' | 'plate' | 'all';

/** The model-part meshes of `objs` (the object's own mesh and its `part` volumes), each once, with the objects using it. */
export function repairTargets(objs: readonly ProjectObject[]): Array<{ meshId: string; objects: string[] }> {
  const byMesh = new Map<string, Set<string>>();
  const add = (meshId: string, name: string) => { let s = byMesh.get(meshId); if (!s) byMesh.set(meshId, (s = new Set())); s.add(name); };
  for (const o of objs) {
    if (isHoleObject(o.cad?.node)) continue;
    add(o.meshId, o.name);
    for (const p of o.parts ?? []) if (p.type === 'part') add(p.meshId, o.name);
  }
  return [...byMesh].map(([meshId, s]) => ({ meshId, objects: [...s] }));
}

export interface RepairOutcome {
  /** Meshes that changed. */
  fixed: Array<{ meshId: string; objects: string[]; stats: RepairMeshStats }>;
  /** Meshes no solid could be built from (left as they were). */
  failed: Array<{ objects: string[]; error: string }>;
  /** Meshes that already were clean. */
  clean: number;
}

const STAT_LABELS: Array<[keyof RepairMeshStats, string, string]> = [
  ['weldedVertices', 'vertex welded', 'vertices welded'],
  ['removedTriangles', 'degenerate face removed', 'degenerate faces removed'],
  ['reversedShells', 'shell reoriented', 'shells reoriented'],
  ['filledHoles', 'hole filled', 'holes filled'],
  ['removedShells', 'loose shell removed', 'loose shells removed'],
  ['selfIntersections', 'self-intersection removed', 'self-intersections removed'],
];

/** The toast for an outcome: title + detail lines. */
export function repairSummary(out: RepairOutcome): { kind: 'success' | 'info' | 'warn'; title: string; detail?: string } {
  const objs = (list: string[][]) => [...new Set(list.flat())];
  const fixedObjs = objs(out.fixed.map((f) => f.objects));
  const total: RepairMeshStats = { weldedVertices: 0, removedTriangles: 0, reversedShells: 0, filledHoles: 0, removedShells: 0, selfIntersections: 0 };
  for (const f of out.fixed) for (const k of Object.keys(total) as Array<keyof RepairMeshStats>) total[k] += f.stats[k] ?? 0;
  const what = STAT_LABELS.filter(([k]) => total[k] > 0).map(([k, one, many]) => `${total[k]} ${total[k] === 1 ? one : many}`);
  const lines: string[] = [];
  if (fixedObjs.length) lines.push(`Repaired: ${fixedObjs.join(', ')}${what.length ? ` (${what.join(', ')})` : ''}.`);
  for (const f of out.failed) lines.push(`Couldn’t repair ${f.objects.join(', ')}: ${f.error}`);
  const detail = lines.join('\n') || undefined;
  if (out.failed.length) {
    return { kind: 'warn', title: fixedObjs.length ? `Repaired ${count(fixedObjs.length)}; ${count(objs(out.failed.map((f) => f.objects)).length)} couldn’t be repaired.` : 'The model couldn’t be repaired.', detail };
  }
  if (!fixedObjs.length) return { kind: 'info', title: out.clean ? 'No errors found: the model is already a clean solid.' : 'Nothing to repair.' };
  return { kind: 'success', title: `Repaired ${count(fixedObjs.length)}.`, detail };
}

const count = (n: number) => `${n} object${n === 1 ? '' : 's'}`;

export type RepairCall = (mesh: ToolMesh, args: RepairMeshArgs) => Promise<{ result: RepairMeshResult; mesh: ToolMesh | undefined }>;

const engineRepair: RepairCall = async (mesh, args) => {
  const r = await engineTool('repair_mesh', args, [mesh]);
  return { result: r.result, mesh: r.meshes[0] };
};

/** Repair `objs`' model parts and commit the changed ones as one undo step `label`. */
export async function repairObjects(objs: readonly ProjectObject[], label: string, call: RepairCall = engineRepair,
                                    onProgress?: (done: number, total: number) => void): Promise<RepairOutcome> {
  const targets = repairTargets(objs);
  const out: RepairOutcome = { fixed: [], failed: [], clean: 0 };
  const repairs: MeshRepair[] = [];
  for (const [i, t] of targets.entries()) {
    onProgress?.(i, targets.length);
    const mesh = getMesh(t.meshId);
    if (!mesh) continue;
    const paint = getMeshPaint(t.meshId);
    try {
      const r = await call({ positions: mesh.positions, indices: mesh.indices }, { ...(Object.keys(paint).length ? { paint } : {}), keepPainting: true });
      if (!r.result.repaired) { out.failed.push({ objects: t.objects, error: r.result.error ?? 'no solid could be built' }); continue; }
      if (!r.result.modified || !r.mesh) { out.clean++; continue; }
      repairs.push({ from: t.meshId, mesh: r.mesh, paint: r.result.paint });
      out.fixed.push({ meshId: t.meshId, objects: t.objects, stats: r.result.stats });
    } catch (e) {
      out.failed.push({ objects: t.objects, error: (e as Error)?.message ?? String(e) });
    }
  }
  commitMeshRepairs(label, repairs);
  return out;
}

let running = false;

/** Fix model (the selection), Fix All (the active plate), Fix All Plates (every plate). */
export async function repairMeshesCmd(scope: RepairScope): Promise<RepairOutcome | null> {
  if (running) return null;
  const objs = scope === 'selection' ? objects.value.filter((o) => selectedIds.value.includes(o.id))
    : scope === 'plate' ? objectsOnPlate(activePlate.value)
      : objects.value.slice();
  if (!objs.length) { toast.info('Nothing to repair.'); return null; }
  const label = scope === 'selection' ? 'Fix model' : scope === 'plate' ? 'Fix all' : 'Fix all plates';
  running = true;
  const prevBusy = ui.busy;
  const progressId = 'repair-mesh';
  try {
    const out = await repairObjects(objs, label, engineRepair, (done, total) => {
      ui.busy = total > 1 ? `Repairing ${done + 1} of ${total}…` : 'Repairing…';
    });
    const s = repairSummary(out);
    toast[s.kind](s.title, { id: progressId, ...(s.detail ? { detail: s.detail } : {}) });
    return out;
  } catch (e) {
    dismissToast(progressId);
    toast.error('Couldn’t repair the model.', { detail: (e as Error)?.message ?? String(e) });
    return null;
  } finally {
    ui.busy = prevBusy;
    running = false;
  }
}

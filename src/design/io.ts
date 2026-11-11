/**
 * Geometry in and out of the design (Orca's Document group: Import STEP, Import mesh, Export STEP).
 *
 * - STEP import: `import_step` (blob) makes one Import feature per solid — an exact B-rep body,
 *   faces and edges pickable like any other. The app's own STEP import (Prepare, occt-import-js,
 *   tessellated) stays as is; its options dialog offers "Open in Design" for this path.
 * - Mesh import: `import_mesh` (McpControl's mesh → B-rep conversion: planar regions merged into
 *   faces) of an STL / OBJ / 3MF mesh or a plate object; a mesh-backed body (no exact curves).
 * - STEP export: `export_step` (AP214, native B-rep) of every / the visible / given bodies.
 *
 * Each import is one `runEdit`: one rebuild, one undo step. Feature names follow the file.
 */
import { activeView } from '../app/state';
import { downloadBytes, safeFileName } from '../app/shell/download';
import { getMesh, getObject, objects } from '../project/store';
import { composeTRS, type Mat4 } from '../project/math';
import type { ImportMeshResult, ImportStepResult } from './kernel/types';
import { activateDesign, design, designReady, DesignEditError, editBlocker, readDesign, runEdit, type EditOutcome } from './session';
import { designUi } from './state';

const base = (name: string) => name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Import';

/** Open the Design tab and wait for its document (imports into a project without a design start one). */
async function ready(): Promise<void> {
  activateDesign();
  await designReady();
  const b = editBlocker();
  if (b) throw new DesignEditError(b);
}

/** STEP file → exact bodies (one Import feature per solid). */
export async function importStepToDesign(name: string, bytes: Uint8Array, opts: { show?: boolean } = {}): Promise<EditOutcome & { features: number[] }> {
  if (opts.show !== false) activeView.value = 'design';
  await ready();
  const label = base(name);
  let made: number[] = [];
  const r = await runEdit(`Import ${label}`, async (c, doc) => {
    const res = (await c.call<ImportStepResult>('import_step', { doc }, bytes)).result;
    if (res.ok && (res.imported ?? 0) > 0 && res.first_feature !== undefined && res.first_feature >= 0) {
      const n = res.imported ?? 1;
      made = Array.from({ length: n }, (_, k) => res.first_feature! + k);
      for (const [k, i] of made.entries()) await c.call('rename_feature', { doc, index: i, name: n > 1 ? `${label} ${k + 1}` : label });
    }
    if (res.ok && !(res.imported ?? 0)) return { ok: false, error: 'The STEP file has no solids.' };
    return res;
  }, { done: (res) => { const n = (res as ImportStepResult).imported ?? 1; return `Imported ${label}: ${n} solid${n === 1 ? '' : 's'} as exact bodies`; } });
  if (r.ok && made.length) designUi.selected = [made[made.length - 1]];
  return { ...r, features: made };
}

/** Pack positions + indices into one blob with the layout `import_mesh` takes. */
export function meshBlob(positions: Float32Array, indices: Uint32Array): { blob: Uint8Array; layout: { positions: { offset: number; count: number }; indices: { offset: number; count: number } } } {
  const blob = new Uint8Array(positions.byteLength + indices.byteLength);
  blob.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), 0);
  blob.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), positions.byteLength);
  return { blob, layout: { positions: { offset: 0, count: positions.length }, indices: { offset: positions.byteLength, count: indices.length } } };
}

/** Positions transformed by a column-major matrix (a copy). */
export function transformed(p: Float32Array, m: Mat4): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

export interface MeshImportReport { ok: boolean; error: string; feature: number; watertight: boolean; solid: boolean; faces: number }

/**
 * A triangle mesh → a mesh-backed body (`import_mesh`, McpControl's conversion: coplanar
 * triangles merged into faces). Positions are design (bed) coordinates.
 */
export async function importMeshToDesign(name: string, positions: Float32Array, indices: Uint32Array, opts: { show?: boolean; tolerance?: number } = {}): Promise<MeshImportReport> {
  if (opts.show !== false) activeView.value = 'design';
  await ready();
  const { blob, layout } = meshBlob(positions, indices);
  const label = base(name);
  let rep: ImportMeshResult | null = null;
  const r = await runEdit(`Import ${label}`, async (c, doc) => {
    const res = (await c.call<ImportMeshResult>('import_mesh', { doc, ...layout, ...(opts.tolerance ? { tolerance: opts.tolerance } : {}) }, blob)).result;
    rep = res;
    if (res.ok && res.first_feature !== undefined && res.first_feature >= 0) await c.call('rename_feature', { doc, index: res.first_feature, name: label });
    return res;
  }, { done: () => `Imported ${label} as a mesh body${rep && !(rep as ImportMeshResult).watertight ? ' (not watertight)' : ''}` });
  const res = rep as ImportMeshResult | null;
  return { ok: r.ok, error: r.error, feature: res?.first_feature ?? -1, watertight: !!res?.watertight, solid: !!res?.is_solid, faces: res?.faces_final ?? 0 };
}

/** A plate object's mesh (its parts merged, world coordinates) → a mesh-backed design body. */
export async function importObjectMesh(objectId: string, opts: { show?: boolean } = {}): Promise<MeshImportReport> {
  const o = getObject(objectId);
  if (!o) throw new DesignEditError(`No object "${objectId}".`);
  const m = getMesh(o.meshId);
  if (!m) throw new DesignEditError(`${o.name} has no mesh.`);
  const M = composeTRS(o.position, o.rotation, o.scale);
  const pos: Float32Array[] = [transformed(m.positions, M)], idx: Uint32Array[] = [m.indices];
  for (const p of o.parts ?? []) {
    if (p.type !== 'part') continue;
    const pm = getMesh(p.meshId);
    if (!pm) continue;
    const PM = composeTRS(p.position, p.rotation, p.scale);
    const W = [0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => M[r] * PM[c * 4] + M[4 + r] * PM[c * 4 + 1] + M[8 + r] * PM[c * 4 + 2] + M[12 + r] * PM[c * 4 + 3]));
    pos.push(transformed(pm.positions, W)); idx.push(pm.indices);
  }
  let nv = 0;
  const P = new Float32Array(pos.reduce((n, a) => n + a.length, 0)), I = new Uint32Array(idx.reduce((n, a) => n + a.length, 0));
  let po = 0, io = 0;
  for (let k = 0; k < pos.length; k++) {
    P.set(pos[k], po);
    for (let i = 0; i < idx[k].length; i++) I[io + i] = idx[k][i] + nv;
    nv += pos[k].length / 3; po += pos[k].length; io += idx[k].length;
  }
  return importMeshToDesign(o.name, P, I, opts);
}

/** STEP of the design's bodies (default: the visible ones with faces). */
export async function exportStepBytes(bodies?: number[]): Promise<{ bytes: Uint8Array; bodies: number[] }> {
  activateDesign();
  await designReady();
  const list = bodies ?? design.bodies.filter((b) => b.face_count > 0 && !designUi.hiddenBodies.includes(b.index)).map((b) => b.index);
  if (!list.length) throw new DesignEditError('Nothing to export — the design has no visible bodies.');
  const r = await readDesign(async (c, doc) => c.call<{ bytes: number }>('export_step', { doc, bodies: list }), 'Exporting STEP');
  return { bytes: r.blob ?? new Uint8Array(0), bodies: list };
}

/** File → Export → STEP (Design): download the bodies as one STEP file. */
export async function exportStepFile(name?: string): Promise<string> {
  const { bytes, bodies } = await exportStepBytes();
  const file = `${safeFileName(name ?? (objects.value[0]?.name || 'design'), 'design')}.step`;
  downloadBytes(bytes, file, 'model/step');
  return `${file}: ${bodies.length} bod${bodies.length === 1 ? 'y' : 'ies'}`;
}

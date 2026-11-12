/**
 * Texture displacement bake / preview runs (desktop TextureDisplacementBakeJob
 * and TextureDisplacementPreviewJob): one engine call (`cs_tool
 * texture_displacement`) per painted model part, in the object's volume
 * order, with the object's layer stack, the part's own masks, its world
 * matrix, the object's texture anchor and the part's resting drop.
 */
import { Matrix4 } from 'three';
import { engineTool } from '../engine/client';
import type { TextureDisplacementArgs } from '../engine/tools';
import { composeTRS, type Quat, type Vec3 } from '../project/math';
import { getMesh, getMeshTexture, getObject, textureOwner } from '../project/store';
import type { MeshData, MeshTexture, ProjectObject, TextureStack } from '../project/types';
import { defaultLayerJson, defaultOptions, layerSlot, paintedSlots } from './model';

export interface TexturePart {
  /** null = the object's own mesh. */
  partId: string | null;
  mesh: MeshData;
  /** Column-major mesh → world (bed) matrix. */
  matrix: number[];
  texture: MeshTexture;
}

/** The object's model parts (texture_parts(): its own mesh, then its 'part' volumes). */
export function textureParts(o: ProjectObject): TexturePart[] {
  const om = composeTRS([...o.position] as Vec3, [...o.rotation] as Quat, [...o.scale] as Vec3);
  const out: TexturePart[] = [];
  const own = getMesh(o.meshId);
  if (own) out.push({ partId: null, mesh: own, matrix: om, texture: getMeshTexture(o.meshId) });
  for (const p of o.parts ?? []) {
    if (p.type !== 'part') continue;
    const m = getMesh(p.meshId);
    if (!m) continue;
    const pm = new Matrix4().fromArray(om).multiply(new Matrix4().fromArray(composeTRS([...p.position] as Vec3, [...p.rotation] as Quat, [...p.scale] as Vec3))).toArray();
    out.push({ partId: p.id, mesh: m, matrix: pm, texture: getMeshTexture(p.meshId) });
  }
  return out;
}

/** is_texture_displacement_painted: any slot's mask has facets. */
export const isPainted = (t: MeshTexture | undefined) => paintedSlots(t).size > 0;

function minWorldZ(mesh: MeshData, m: number[]): number {
  const p = mesh.positions;
  let z = Infinity;
  for (let i = 0; i < p.length; i += 3) z = Math.min(z, m[2] * p[i] + m[6] * p[i + 1] + m[10] * p[i + 2] + m[14]);
  return z;
}

/**
 * The engine arguments for each painted part. `preview`: skip the
 * simplification (desktop's preview sets v2_max_triangles_k = 0), as it is
 * looked at, not printed.
 */
export function bakeRequests(o: ProjectObject, opts: { preview?: boolean } = {}): Array<{ part: TexturePart; args: TextureDisplacementArgs }> {
  const stack: TextureStack | undefined = getMeshTexture(textureOwner(o)).stack;
  if (!stack?.layers.length) return [];
  const parts = textureParts(o);
  const owner = parts[0];
  if (!owner) return [];
  const anchor: [number, number, number] = [owner.matrix[12], owner.matrix[13], owner.matrix[14]];
  // resting_drops(): each part's bottom against the object's lowest part.
  const bottoms = parts.map((p) => minWorldZ(p.mesh, p.matrix));
  const objectBottom = Math.min(...bottoms);
  const options = { ...defaultOptions(), ...stack.options };
  if (opts.preview && options.pipeline_v2 !== false) options.v2_max_triangles_k = 0;
  const images: Record<string, Uint8Array> = {};
  for (const l of stack.layers) if (l.image?.length) images[String(layerSlot(l))] = l.image;
  const out: Array<{ part: TexturePart; args: TextureDisplacementArgs }> = [];
  parts.forEach((part, i) => {
    if (!isPainted(part.texture)) return;
    // layers_for_part(): UV editing data belongs to the owner's own patch only.
    const layers = stack.layers.map((l) => {
      const j: Record<string, unknown> = { ...defaultLayerJson(layerSlot(l)), ...l.json, path_in_3mf: '' };
      if (i > 0) { j.lscm_seam_edges = []; j.islands = []; j.island_groups = []; j.lscm_uv_overrides = []; }
      return j;
    });
    out.push({
      part,
      args: {
        layers: { version: 1, options, layers }, images,
        paint: { ...(part.texture.masks ?? {}) },
        transform: part.matrix, anchor, restingDrop: bottoms[i] - objectBottom,
      },
    });
  });
  return out;
}

/** The finalize() check: did the bake move anything (a different mesh, or a vertex moved > 1e-5)? */
export function meshMoved(base: MeshData, positions: Float32Array, indices: Uint32Array): boolean {
  if (!indices.length) return false;
  if (indices.length !== base.indices.length || positions.length !== base.positions.length) return true;
  for (let i = 0; i < positions.length; i++) if (Math.abs(positions[i] - base.positions[i]) >= 1e-5) return true;
  return false;
}

export interface PartResult { part: TexturePart; positions: Float32Array; indices: Uint32Array; budgetLimited: boolean }

export interface RunOptions {
  preview?: boolean;
  /** Stops between parts (a newer preview superseded this one). */
  stale?: () => boolean;
  /** Cancels the part running now (terminates the background engine lane: rejects with SliceCancelled). */
  signal?: AbortSignal;
  /** Called before each part: `index` of `count` painted parts. */
  onPart?: (index: number, count: number) => void;
}

/**
 * Run the requests one part after another on the engine's background lane
 * (desktop runs them as a background job), so slicing and painting don't
 * wait behind a 10-20 s run.
 */
export async function runBake(objectId: string, opts: RunOptions = {}): Promise<PartResult[] | null> {
  const o = getObject(objectId);
  if (!o) return null;
  const out: PartResult[] = [];
  const reqs = bakeRequests(o, opts);
  for (const [i, { part, args }] of reqs.entries()) {
    if (opts.stale?.() || opts.signal?.aborted) return null;
    opts.onPart?.(i, reqs.length);
    const r = await engineTool('texture_displacement', args, [{ positions: part.mesh.positions, indices: part.mesh.indices }], opts.signal, 'background');
    const m = r.meshes[0];
    if (m) out.push({ part, positions: m.positions, indices: m.indices, budgetLimited: !!r.result.budgetLimited });
  }
  return out;
}

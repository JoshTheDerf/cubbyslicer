/**
 * Mesh packing for the engine: every mesh array goes into one blob (each
 * distinct array once, so instances sharing a mesh cost nothing extra) and the
 * job JSON refers to it by byte offsets (docs/ENGINE-CONTRACT.md "Job JSON").
 */
import type { SliceJob, ToolMesh } from '../types';
import { enc } from './heap';

export interface MeshRef { vertexOffset: number; vertexCount: number; indexOffset: number; triangleCount: number }

export class BlobPacker {
  private size = 0;
  private readonly offsets = new Map<ArrayBufferView, number>();
  private readonly chunks: ArrayBufferView[] = [];

  private place(a: Float32Array | Uint32Array): number {
    let off = this.offsets.get(a);
    if (off === undefined) { off = this.size; this.size += a.byteLength; this.offsets.set(a, off); this.chunks.push(a); }
    return off;
  }

  mesh(positions: Float32Array, indices: Uint32Array, name = 'mesh'): MeshRef {
    if (positions.length % 3 !== 0 || indices.length % 3 !== 0) throw new Error(`${name}: malformed mesh arrays`);
    return { vertexOffset: this.place(positions), vertexCount: positions.length / 3, indexOffset: this.place(indices), triangleCount: indices.length / 3 };
  }

  blob(): Uint8Array {
    const out = new Uint8Array(this.size);
    for (const a of this.chunks) out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), this.offsets.get(a)!);
    return out;
  }
}

/** Slice-job payload (config, options, objects with mesh offsets) + its blob. */
export function packPayload(job: SliceJob): { payload: Record<string, unknown>; blob: Uint8Array } {
  const pk = new BlobPacker();
  const entry = (name: string, positions: Float32Array, indices: Uint32Array, transform: number[]) => ({ name, ...pk.mesh(positions, indices, name), transform });
  const objects = job.objects.map((o) => ({
    ...entry(o.name, o.positions, o.indices, o.transform),
    config: o.config ?? {},
    ...(o.parts?.length ? {
      parts: o.parts.map((p) => ({
        ...entry(p.name, p.positions, p.indices, p.transform), type: p.type, config: p.config ?? {}, ...(p.paint ? { paint: p.paint } : {}),
      })),
    } : {}),
    ...(o.paint ? { paint: o.paint } : {}),
    ...(o.layerHeightProfile?.length ? { layerHeightProfile: o.layerHeightProfile } : {}),
    ...(o.layerRanges?.length ? { layerRanges: o.layerRanges } : {}),
    ...(o.brimPoints?.length ? { brimPoints: o.brimPoints } : {}),
  }));
  const payload = { config: job.config, options: { validate: true, dropToBed: true, ...job.options }, objects };
  return { payload, blob: pk.blob() };
}

export function packJob(job: SliceJob): { json: Uint8Array; blob: Uint8Array } {
  const { payload, blob } = packPayload(job);
  return { json: enc.encode(JSON.stringify(payload)), blob };
}

/** Tool request `{op, args, meshes}` + blob. */
export function packTool(op: string, args: unknown, meshes: ToolMesh[]): { json: Uint8Array; blob: Uint8Array } {
  const pk = new BlobPacker();
  const refs = meshes.map((m) => pk.mesh(m.positions, m.indices));
  return { json: enc.encode(JSON.stringify({ op, args, meshes: refs })), blob: pk.blob() };
}

/** Meshes from a tool reply: `refs` index into `bytes` (bounds-checked). */
export function unpackMeshes(refs: unknown, bytes: Uint8Array | null): ToolMesh[] {
  if (!Array.isArray(refs) || !refs.length) return [];
  const b = bytes ?? new Uint8Array(0);
  return refs.map((r: Partial<MeshRef>) => {
    const vo = Number(r?.vertexOffset), vc = Number(r?.vertexCount), io = Number(r?.indexOffset), tc = Number(r?.triangleCount);
    if (![vo, vc, io, tc].every((x) => Number.isInteger(x) && x >= 0) || vo + vc * 12 > b.byteLength || io + tc * 12 > b.byteLength) {
      throw new Error('engine returned an out-of-bounds mesh');
    }
    const positions = new Float32Array(vc * 3);
    new Uint8Array(positions.buffer).set(b.subarray(vo, vo + vc * 12));
    const indices = new Uint32Array(tc * 3);
    new Uint8Array(indices.buffer).set(b.subarray(io, io + tc * 12));
    return { positions, indices };
  });
}

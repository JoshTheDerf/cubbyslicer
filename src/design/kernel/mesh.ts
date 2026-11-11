/**
 * Decode the kernel's mesh blobs (contract "Mesh blob layout") into typed arrays the app owns
 * (copies: the blob is dropped right after).
 */
import type { BlobArray, DisplayMeshLayout, PlateMeshLayout } from './types';

/** One body's display mesh: unshared vertices per face (crisp B-rep edges), face id per triangle, edge polylines by id. */
export interface DisplayBody {
  body: number;
  faceCount: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Face id of each triangle. */
  triFace: Int32Array;
  /** Edge polylines: edge k is `edgeIds[k]`, points [edgeStarts[k], edgeStarts[k+1]) of `edgePoints` (xyz). */
  edgeIds: Int32Array;
  edgeStarts: Uint32Array;
  edgePoints: Float32Array;
  /** Edge ids drawn by nobody (seams, degenerate edges) but still pickable. */
  hiddenEdges: ReadonlySet<number>;
}

/** One body's plate mesh (welded; Orca's Commit to Plate tessellation). */
export interface PlateBody { body: number; positions: Float32Array; indices: Uint32Array }

function view<T extends Float32Array | Uint32Array | Int32Array>(blob: Uint8Array, a: BlobArray, Ctor: { new(b: ArrayBuffer, o: number, n: number): T; BYTES_PER_ELEMENT: number }): T {
  const bytes = a.count * Ctor.BYTES_PER_ELEMENT;
  if (a.count < 0 || a.offset < 0 || a.offset + bytes > blob.byteLength) throw new Error('The CAD kernel returned a malformed mesh.');
  // slice() copies into a fresh, aligned buffer.
  return new Ctor(blob.buffer.slice(blob.byteOffset + a.offset, blob.byteOffset + a.offset + bytes) as ArrayBuffer, 0, a.count);
}

export function decodeDisplayMeshes(layouts: DisplayMeshLayout[], blob: Uint8Array | null): DisplayBody[] {
  const b = blob ?? new Uint8Array(0);
  return layouts.map((m) => ({
    body: m.body,
    faceCount: m.faces,
    positions: view(b, m.positions, Float32Array),
    normals: view(b, m.normals, Float32Array),
    indices: view(b, m.indices, Uint32Array),
    triFace: view(b, m.triFace, Int32Array),
    edgeIds: view(b, m.edgeIds, Int32Array),
    edgeStarts: view(b, m.edgeStarts, Uint32Array),
    edgePoints: view(b, m.edgePoints, Float32Array),
    hiddenEdges: new Set((m.edgeFlags ?? []).filter((f) => f.seam || f.degenerate).map((f) => f.edge)),
  }));
}

export function decodePlateMeshes(layouts: PlateMeshLayout[], blob: Uint8Array | null): PlateBody[] {
  const b = blob ?? new Uint8Array(0);
  return layouts.map((m) => ({ body: m.body, positions: view(b, m.positions, Float32Array), indices: view(b, m.indices, Uint32Array) }));
}

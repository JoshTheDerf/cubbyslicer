/**
 * CubbyCAD tree evaluation off the main thread: the shared evaluator
 * (`@cubby/shared/cad`) on this worker's own manifold-3d instance.
 * Request { id, node, frame } → { id, mesh, issues } (buffers transferred) or { id, error }.
 */
import { evaluateCadNode, type CadNode, type ManifoldWasm } from '@cubby/shared/cad';
import { loadManifold } from '../tools/boolean/boolean';

let wasm: Promise<ManifoldWasm> | null = null;

self.onmessage = async (ev: MessageEvent<{ id: number; node: CadNode; frame: 'zup' | 'render' }>) => {
  const { id, node, frame } = ev.data;
  try {
    wasm ??= loadManifold() as unknown as Promise<ManifoldWasm>;
    const r = evaluateCadNode(await wasm, node, { frame });
    const mesh = r.mesh ? { positions: r.mesh.positions, indices: r.mesh.indices } : null;
    (self as unknown as Worker).postMessage({ id, mesh, issues: r.issues }, mesh ? [mesh.positions.buffer, mesh.indices.buffer] : []);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: (e as Error)?.message ?? String(e) });
  }
};

/**
 * Mesh booleans (Orca GLGizmoMeshBoolean: union / difference / intersection
 * of volumes) with manifold-3d, lazily loaded (wasm). Inputs are welded
 * (Mesh.merge) before building manifolds; non-manifold input is reported.
 */
import type { MeshArrays } from '../geom/extrude';

export type BooleanOp = 'union' | 'difference' | 'intersection';

export const BOOLEAN_LABELS: Record<BooleanOp, string> = { union: 'Union', difference: 'Difference', intersection: 'Intersection' };

type Toplevel = Awaited<ReturnType<typeof import('manifold-3d')['default']>>;
let wasm: Promise<Toplevel> | null = null;

export function loadManifold(): Promise<Toplevel> {
  wasm ??= (async () => {
    const mod = (await import('manifold-3d')).default;
    // In the browser point the loader at the bundled wasm; under node it finds it itself.
    const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';
    const url = isNode ? null : (await import('manifold-3d/manifold.wasm?url')).default;
    const m = await mod(url ? { locateFile: () => url } : undefined);
    m.setup();
    return m;
  })();
  wasm.catch(() => { wasm = null; });
  return wasm;
}

export class BooleanError extends Error { override name = 'BooleanError'; }

/** `a op b1 op b2 …`, all meshes in the same frame. */
export async function meshBoolean(op: BooleanOp, a: MeshArrays, tools: MeshArrays[]): Promise<MeshArrays> {
  const m = await loadManifold();
  const made: Array<{ delete(): void }> = [];
  const toManifold = (x: MeshArrays, label: string) => {
    const mesh = new m.Mesh({ numProp: 3, vertProperties: x.positions, triVerts: x.indices });
    mesh.merge();
    let man;
    try { man = new m.Manifold(mesh); } catch (e) {
      throw new BooleanError(`${label} is not a closed (manifold) mesh, so it can't be used in a boolean. Repair it first.${e instanceof Error && e.message ? ` (${e.message})` : ''}`);
    }
    made.push(man);
    const st = man.status();
    if (st !== 'NoError') throw new BooleanError(`${label} is not a closed (manifold) mesh (${st}).`);
    return man;
  };
  try {
    let acc = toManifold(a, 'The source');
    tools.forEach((t, i) => {
      const b = toManifold(t, tools.length > 1 ? `Tool ${i + 1}` : 'The tool');
      const r = op === 'union' ? acc.add(b) : op === 'difference' ? acc.subtract(b) : acc.intersect(b);
      made.push(r);
      acc = r;
    });
    const out = acc.getMesh();
    if (!out.triVerts.length) throw new BooleanError(op === 'intersection' ? 'The volumes don’t overlap: the intersection is empty.' : 'The result is empty.');
    const np = out.numProp;
    const positions = new Float32Array((out.vertProperties.length / np) * 3);
    for (let v = 0, n = positions.length / 3; v < n; v++) {
      positions[v * 3] = out.vertProperties[v * np];
      positions[v * 3 + 1] = out.vertProperties[v * np + 1];
      positions[v * 3 + 2] = out.vertProperties[v * np + 2];
    }
    return { positions, indices: new Uint32Array(out.triVerts) };
  } finally {
    for (const x of made) { try { x.delete(); } catch { /* already freed */ } }
  }
}

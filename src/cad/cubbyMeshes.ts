/** A .cubby scene as plain meshes (one per top-level node), for importers that want geometry only. */
import type { ParseResult } from '../project/types';
import { composeTRS } from '../project/math';
import { evaluateCadMesh } from './build';
import { parseCubbyScene, planCadImport } from './cubby';

export async function parseCubbyAsMeshes(buffer: ArrayBuffer): Promise<ParseResult> {
  const scene = parseCubbyScene(new TextDecoder().decode(buffer));
  const plan = await planCadImport(scene.nodes, { origin: [0, 0, 0] });
  return {
    objects: plan.items.map((it) => {
      const m = evaluateCadMesh(it.node);
      return { name: it.name, positions: m.positions.slice(), indices: m.indices.slice(), transform: composeTRS(it.position, it.rotation, it.scale) };
    }),
    warnings: plan.warnings,
  };
}

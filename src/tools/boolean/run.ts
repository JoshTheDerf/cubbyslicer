/**
 * Run a mesh boolean between volumes (the Mesh boolean panel and the Claude
 * Code bridge): tool volumes are brought into the source volume's mesh
 * frame, combined, and the result replaces the source (one undo step).
 */
import { Matrix4 } from 'three';
import { commitBoolean } from '../../project/store';
import { volumeMatrix, volumeMesh } from '../overlay';
import { flipped, transformed } from '../geom/meshUtil';
import { BOOLEAN_LABELS, meshBoolean, type BooleanOp } from './boolean';

/** A volume: an object's own mesh (partId null) or one of its parts. */
export interface BooleanVolume { objectId: string; partId: string | null }

export async function runMeshBoolean(op: BooleanOp, src: BooleanVolume, tools: BooleanVolume[], deleteInput: boolean): Promise<void> {
  const sm = volumeMesh(src.objectId, src.partId), sMat = volumeMatrix(src.objectId, src.partId);
  if (!sm || !sMat) throw new Error('The source volume is gone.');
  const inv = new Matrix4().fromArray(sMat).invert();
  const toolMeshes = [];
  for (const t of tools) {
    const m = volumeMesh(t.objectId, t.partId), w = volumeMatrix(t.objectId, t.partId);
    if (!m || !w) continue;
    const rel = inv.clone().multiply(new Matrix4().fromArray(w));
    toolMeshes.push({ positions: transformed(m.positions, rel.elements), indices: rel.determinant() < 0 ? flipped(m.indices) : m.indices });
  }
  if (!toolMeshes.length) throw new Error('No tool volumes to combine with.');
  const res = await meshBoolean(op, { positions: sm.positions, indices: sm.indices }, toolMeshes);
  commitBoolean({
    label: `Mesh boolean: ${BOOLEAN_LABELS[op].toLowerCase()}`,
    objectId: src.objectId, partId: src.partId, mesh: res,
    removeObjects: deleteInput ? tools.filter((t) => !t.partId && t.objectId !== src.objectId).map((t) => t.objectId) : [],
    removeParts: deleteInput ? tools.filter((t) => t.partId).map((t) => ({ objectId: t.objectId, partId: t.partId! })) : [],
  });
}

/** Binary STL writer (world-space, all given objects — and their model parts — merged). */
import { composeTRS, mat4Determinant3, mat4Multiply, type Mat4 } from '../math';
import type { MeshData, ProjectObject } from '../types';

/** An object's printable geometry: its mesh plus its model parts, each with its world matrix. */
export function objectVolumes(o: ProjectObject, getMesh: (id: string) => MeshData | undefined): Array<{ mesh: MeshData; m: Mat4 }> {
  const base = composeTRS(o.position, o.rotation, o.scale);
  const out: Array<{ mesh: MeshData; m: Mat4 }> = [];
  const main = getMesh(o.meshId);
  if (main) out.push({ mesh: main, m: base });
  for (const p of o.parts ?? []) {
    if (p.type !== 'part') continue;
    const pm = getMesh(p.meshId);
    if (pm) out.push({ mesh: pm, m: mat4Multiply(base, composeTRS(p.position, p.rotation, p.scale)) });
  }
  return out;
}

export function buildStl(objects: ProjectObject[], getMesh: (id: string) => MeshData | undefined): Uint8Array {
  const vols = objects.flatMap((o) => objectVolumes(o, getMesh));
  let tris = 0;
  for (const v of vols) tris += v.mesh.triangleCount;
  const out = new Uint8Array(84 + tris * 50);
  const dv = new DataView(out.buffer);
  const header = 'Exported by CubbySlicer';
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  dv.setUint32(80, tris, true);
  let off = 84;
  const v = new Float64Array(9);
  for (const { mesh, m } of vols) {
    const flip = mat4Determinant3(m) < 0;
    const p = mesh.positions, ix = mesh.indices;
    for (let t = 0; t < ix.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = ix[t + (flip && k > 0 ? 3 - k : k)] * 3;
        const x = p[vi], y = p[vi + 1], z = p[vi + 2];
        v[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        v[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        v[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
      const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2];
      const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
      off += 12;
      for (let k = 0; k < 9; k++) { dv.setFloat32(off, v[k], true); off += 4; }
      off += 2;
    }
  }
  return out;
}

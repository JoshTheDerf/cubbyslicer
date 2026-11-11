/**
 * Shared pieces of the two 3MF writers (export/threemf.ts, the plain core-spec
 * file; persistence/orca3mfWriter.ts, the Orca project): number and transform
 * formatting, the package parts, and a chunked writer so big meshes never
 * become one giant string.
 */
import { strToU8 } from 'fflate';
import type { Mat4 } from '../math';
import { escapeAttr } from '../import/xml';
import type { MeshData } from '../types';

/** A number as Orca writes vertices (9 significant digits, no exponent noise for integers). */
export function num(v: number): string {
  if (!Number.isFinite(v)) return '0';
  return Number.isInteger(v) ? String(v) : String(+v.toPrecision(9));
}

/** Column-major 4x4 → 3MF's "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32". */
export function transform3mf(m: Mat4 | number[]): string {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]].map(num).join(' ');
}

export const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const PRODUCTION_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
export const MODEL_REL_TYPE = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

/** [Content_Types].xml with the given extra `Extension → ContentType` defaults. */
export function contentTypesXml(extra: Array<[string, string]> = []): string {
  const rows: Array<[string, string]> = [
    ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
    ['model', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'],
    ...extra,
  ];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
    + rows.map(([e, t]) => ` <Default Extension="${e}" ContentType="${t}"/>\n`).join('') + '</Types>\n';
}

/** A relationships part: `[target, id, type]` per relationship. */
export function relsXml(rels: Array<[string, string, string]>): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
    + rels.map(([target, id, type]) => ` <Relationship Target="${escapeAttr(target)}" Id="${id}" Type="${type}"/>\n`).join('') + '</Relationships>\n';
}

/** Serialise into chunks of bytes (avoids one giant string for big meshes). */
export class ChunkWriter {
  private parts: Uint8Array[] = [];
  private buf: string[] = [];
  private len = 0;
  write(s: string): void {
    this.buf.push(s);
    this.len += s.length;
    if (this.len > 1 << 20) this.flush();
  }
  flush(): void {
    if (!this.buf.length) return;
    this.parts.push(strToU8(this.buf.join('')));
    this.buf = [];
    this.len = 0;
  }
  bytes(): Uint8Array {
    this.flush();
    if (this.parts.length === 1) return this.parts[0];
    const total = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/**
 * `<mesh>` of an object: vertices and triangles, `triangleExtra(t)` adding
 * per-triangle attributes (paint) when given.
 */
export function writeMesh(w: ChunkWriter, m: MeshData, indent: string, triangleExtra?: (t: number) => string): void {
  w.write(`${indent}<mesh>\n${indent} <vertices>\n`);
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) w.write(`${indent}  <vertex x="${num(p[i])}" y="${num(p[i + 1])}" z="${num(p[i + 2])}"/>\n`);
  w.write(`${indent} </vertices>\n${indent} <triangles>\n`);
  const ix = m.indices;
  for (let t = 0; t < ix.length / 3; t++) {
    w.write(`${indent}  <triangle v1="${ix[t * 3]}" v2="${ix[t * 3 + 1]}" v3="${ix[t * 3 + 2]}"${triangleExtra?.(t) ?? ''}/>\n`);
  }
  w.write(`${indent} </triangles>\n${indent}</mesh>\n`);
}

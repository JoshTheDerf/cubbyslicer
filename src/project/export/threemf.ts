/**
 * Minimal, valid core-spec 3MF writer: one <object> per mesh (instances share
 * it), one <item> per project object with its transform.
 */
import { zipSync, strToU8 } from 'fflate';
import { composeTRS } from '../math';
import type { MeshData, ProjectObject } from '../types';
import { escapeXml } from '../import/xml';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const fmt = (n: number) => {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(6);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** Serialise into chunks of bytes (avoids one giant string for big meshes). */
class ChunkWriter {
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
    const total = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

export function build3mf(objects: ProjectObject[], getMesh: (id: string) => MeshData | undefined): Uint8Array {
  const w = new ChunkWriter();
  w.write('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  w.write(' <metadata name="Application">CubbySlicer</metadata>\n <resources>\n');
  const objIds = new Map<string, number>();
  let next = 1;
  const meshList: Array<{ id: string; name: string }> = [];
  for (const o of objects) {
    meshList.push({ id: o.meshId, name: o.name });
    for (const p of o.parts ?? []) if (p.type === 'part') meshList.push({ id: p.meshId, name: p.name });
  }
  for (const { id, name } of meshList) {
    if (objIds.has(id)) continue;
    const m = getMesh(id);
    if (!m) continue;
    const rid = next++;
    objIds.set(id, rid);
    w.write(`  <object id="${rid}" type="model" name="${escapeXml(name)}">\n   <mesh>\n    <vertices>\n`);
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) w.write(`     <vertex x="${fmt(p[i])}" y="${fmt(p[i + 1])}" z="${fmt(p[i + 2])}"/>\n`);
    w.write('    </vertices>\n    <triangles>\n');
    const ix = m.indices;
    for (let i = 0; i < ix.length; i += 3) w.write(`     <triangle v1="${ix[i]}" v2="${ix[i + 1]}" v3="${ix[i + 2]}"/>\n`);
    w.write('    </triangles>\n   </mesh>\n  </object>\n');
  }
  // Objects with model parts become a components object (3MF core): main mesh + parts at their local transforms.
  const itemIds = new Map<ProjectObject, number>();
  const m12 = (t: number[]) => [t[0], t[1], t[2], t[4], t[5], t[6], t[8], t[9], t[10], t[12], t[13], t[14]].map(fmt).join(' ');
  for (const o of objects) {
    const base = objIds.get(o.meshId);
    if (!base) continue;
    const parts = (o.parts ?? []).filter((p) => p.type === 'part' && objIds.has(p.meshId));
    if (!parts.length) { itemIds.set(o, base); continue; }
    const rid = next++;
    itemIds.set(o, rid);
    w.write(`  <object id="${rid}" type="model" name="${escapeXml(o.name)}">\n   <components>\n    <component objectid="${base}"/>\n`);
    for (const p of parts) w.write(`    <component objectid="${objIds.get(p.meshId)}" transform="${m12(composeTRS(p.position, p.rotation, p.scale))}"/>\n`);
    w.write('   </components>\n  </object>\n');
  }
  w.write(' </resources>\n <build>\n');
  for (const o of objects) {
    const rid = itemIds.get(o);
    if (!rid) continue;
    w.write(`  <item objectid="${rid}" transform="${m12(composeTRS(o.position, o.rotation, o.scale))}"${o.printable ? '' : ' printable="0"'}/>\n`);
  }
  w.write(' </build>\n</model>\n');
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': [w.bytes(), { level: 6 }],
  });
}

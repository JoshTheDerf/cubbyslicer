/**
 * Minimal, valid core-spec 3MF writer: one <object> per mesh (instances share
 * it), one <item> per project object with its transform.
 */
import { zipSync, strToU8 } from 'fflate';
import { composeTRS } from '../math';
import type { MeshData, ProjectObject } from '../types';
import { escapeXml } from '../import/xml';
import { CORE_NS, ChunkWriter, MODEL_REL_TYPE, contentTypesXml, relsXml, transform3mf, writeMesh } from './xml3mf';

export function build3mf(objects: ProjectObject[], getMesh: (id: string) => MeshData | undefined): Uint8Array {
  const w = new ChunkWriter();
  w.write(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">\n`);
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
    w.write(`  <object id="${rid}" type="model" name="${escapeXml(name)}">\n`);
    writeMesh(w, m, '   ');
    w.write('  </object>\n');
  }
  // Objects with model parts become a components object (3MF core): main mesh + parts at their local transforms.
  const itemIds = new Map<ProjectObject, number>();
  for (const o of objects) {
    const base = objIds.get(o.meshId);
    if (!base) continue;
    const parts = (o.parts ?? []).filter((p) => p.type === 'part' && objIds.has(p.meshId));
    if (!parts.length) { itemIds.set(o, base); continue; }
    const rid = next++;
    itemIds.set(o, rid);
    w.write(`  <object id="${rid}" type="model" name="${escapeXml(o.name)}">\n   <components>\n    <component objectid="${base}"/>\n`);
    for (const p of parts) w.write(`    <component objectid="${objIds.get(p.meshId)}" transform="${transform3mf(composeTRS(p.position, p.rotation, p.scale))}"/>\n`);
    w.write('   </components>\n  </object>\n');
  }
  w.write(' </resources>\n <build>\n');
  for (const o of objects) {
    const rid = itemIds.get(o);
    if (!rid) continue;
    w.write(`  <item objectid="${rid}" transform="${transform3mf(composeTRS(o.position, o.rotation, o.scale))}"${o.printable ? '' : ' printable="0"'}/>\n`);
  }
  w.write(' </build>\n</model>\n');
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml()),
    '_rels/.rels': strToU8(relsXml([['/3D/3dmodel.model', 'rel0', MODEL_REL_TYPE]])),
    '3D/3dmodel.model': [w.bytes(), { level: 6 }],
  });
}

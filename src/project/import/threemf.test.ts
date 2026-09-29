import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parse3mf, parse3mfTransform } from './threemf';
import { parseModel } from './parse';
import { build3mf } from '../export/threemf';
import { composeTRS, quatFromEuler } from '../math';
import type { MeshData, ProjectObject } from '../types';

const tri = `<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices>
<triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh>`;

function pack(files: Record<string, string>): ArrayBuffer {
  const z: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) z[k] = strToU8(v);
  const u = zipSync(z);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

describe('3MF reader', () => {
  it('reads objects, build transforms and names', () => {
    const buf = pack({
      '3D/3dmodel.model': `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources><object id="1" type="model" name="Tet">${tri}</object></resources>
        <build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 60 0"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 80 60 0" printable="0"/></build></model>`,
    });
    const r = parse3mf(buf);
    expect(r.objects).toHaveLength(2);
    expect(r.objects[0].name).toBe('Tet');
    expect(r.objects[0].transform?.slice(12, 15)).toEqual([50, 60, 0]);
    expect(r.objects[1].printable).toBe(false);
  });

  it('flattens components across model parts (production extension) and applies units', () => {
    const buf = pack({
      '_rels/.rels': `<Relationships><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
      '3D/3dmodel.model': `<model unit="centimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
        <resources><object id="5" type="model"><components>
          <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 1 0 0"/>
          <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
        </components></object></resources>
        <build><item objectid="5"/></build></model>`,
      '3D/Objects/object_1.model': `<model unit="centimeter"><resources><object id="1">${tri}</object></resources></model>`,
      'Metadata/model_settings.config': `<config><object id="5"><metadata key="name" value="Bambu part"/><part id="1"><metadata key="name" value="inner"/></part></object></config>`,
    });
    const r = parse3mf(buf);
    expect(r.objects).toHaveLength(1);
    const o = r.objects[0];
    expect(o.name).toBe('Bambu part');
    expect(o.indices.length / 3).toBe(8);
    // centimetres → mm: tet edge 10cm = 100mm, component offset 1cm = 10mm
    expect(Math.max(...o.positions)).toBeCloseTo(110);
  });

  it('ignores unknown extension elements and survives comments', () => {
    const buf = pack({
      '3D/3dmodel.model': `<model xmlns:m="x"><!-- a > comment --><resources><m:colorgroup id="9"><m:color color="#FF0000"/></m:colorgroup>
        <object id="1" pid="9">${tri}</object></resources><build><item objectid="1"/></build></model>`,
    });
    expect(parse3mf(buf).objects).toHaveLength(1);
  });

  it('rejects malformed input safely', () => {
    expect(() => parse3mf(new ArrayBuffer(10))).toThrow();
    expect(() => parse3mf(pack({ 'foo.txt': 'x' }))).toThrow(/no 3D model/);
    expect(() => parse3mf(pack({ '3D/3dmodel.model': '<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0"' }))).toThrow();
    const cyclic = pack({
      '3D/3dmodel.model': `<model><resources><object id="1"><components><component objectid="2"/></components></object>
        <object id="2"><components><component objectid="1"/></components></object></resources><build><item objectid="1"/></build></model>`,
    });
    expect(() => parse3mf(cyclic)).toThrow(/no printable/);
  });

  it('drops triangles with out-of-range indices', () => {
    const buf = pack({
      '3D/3dmodel.model': `<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="99"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`,
    });
    const r = parse3mf(buf);
    expect(r.objects[0].indices.length).toBe(3);
    expect(r.warnings.join()).toMatch(/invalid vertex indices/);
  });

  it('parses the 12-number transform into column-major', () => {
    expect(parse3mfTransform('1 2 3 4 5 6 7 8 9 10 11 12')).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 1]);
    expect(parse3mfTransform('1 2 x')).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('round-trips through the exporter with world placement preserved', () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
    const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]);
    const mesh: MeshData = { id: 'm1', positions, indices, bbox: { min: [0, 0, 0], max: [10, 10, 10] }, vertexCount: 4, triangleCount: 4 };
    const rot = quatFromEuler(0, 0, Math.PI / 2);
    const obj: ProjectObject = { id: 'a', name: 'A & B', meshId: 'm1', position: [100, 50, 0], rotation: rot, scale: [2, 2, 2], visible: true, printable: true, overrides: {}, color: '' };
    const bytes = build3mf([obj], () => mesh);
    const r = parseModel('x.3mf', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(r.objects[0].name).toBe('A & B');
    const t = r.objects[0].transform!;
    // world position of local vertex (10,0,0) should match the original transform
    const orig = composeTRS(obj.position, obj.rotation, obj.scale);
    const wOrig = [orig[0] * 10 + orig[12], orig[1] * 10 + orig[13]];
    // recentred mesh: find the vertex that was (10,0,0) → centre was (5,5,5)
    const p = r.objects[0].positions;
    let best = 0;
    for (let i = 0; i < p.length; i += 3) if (p[i] > p[best]) best = i;
    const x = p[best], y = p[best + 1], z = p[best + 2];
    const wx = t[0] * x + t[4] * y + t[8] * z + t[12];
    const wy = t[1] * x + t[5] * y + t[9] * z + t[13];
    expect(wx).toBeCloseTo(wOrig[0], 3);
    expect(wy).toBeCloseTo(wOrig[1], 3);
  });
});

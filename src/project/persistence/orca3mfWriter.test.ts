import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolvedConfig } from '../../app/state';
import * as S from '../store';
import { weldVertices, recenter } from '../mesh';
import { cubeSoup } from '../testutil';
import { parseOrca3mf } from '../import/orca3mf';
import { encodePng } from '../thumbnails/encode';
import type { PlateImages } from '../thumbnails';
import { buildOrca3mf } from './orca3mfWriter';

function addCube(name: string): void {
  const w = weldVertices(cubeSoup(20), null);
  recenter(w.positions);
  S.addParsedObjects([{ name, positions: w.positions, indices: w.indices, transform: null }]);
}

const img = (v: number) => encodePng({ width: 2, height: 2, pixels: new Uint8Array(16).fill(v) });
const images = (v: number): PlateImages => ({ plate: img(v), small: img(v + 1), noLight: img(v + 2), top: img(v + 3), pick: img(v + 4) });

beforeEach(() => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  S.resetProject();
});

describe('Orca 3MF plate thumbnails', () => {
  it('writes Metadata/plate_N*.png, top/pick, model_settings keys and the package rels', () => {
    addCube('A');
    S.addPlate();
    const zip = unzipSync(buildOrca3mf({ thumbnails: [images(10), images(20)] }));
    for (const n of [1, 2]) {
      for (const f of [`plate_${n}.png`, `plate_${n}_small.png`, `plate_no_light_${n}.png`, `top_${n}.png`, `pick_${n}.png`]) {
        expect(zip[`Metadata/${f}`], f).toBeDefined();
      }
    }
    expect(zip['Metadata/plate_2.png']).toEqual(img(20));
    expect(zip['Metadata/pick_1.png']).toEqual(img(14));
    const settings = strFromU8(zip['Metadata/model_settings.config']);
    const plate1 = settings.slice(settings.indexOf('<plate>'), settings.indexOf('</plate>'));
    expect(plate1).toContain('<metadata key="thumbnail_file" value="Metadata/plate_1.png"/>\n'
      + '    <metadata key="thumbnail_no_light_file" value="Metadata/plate_no_light_1.png"/>\n'
      + '    <metadata key="top_file" value="Metadata/top_1.png"/>\n'
      + '    <metadata key="pick_file" value="Metadata/pick_1.png"/>\n    <model_instance>');
    expect(settings).toContain('value="Metadata/pick_2.png"');
    const rels = strFromU8(zip['_rels/.rels']);
    expect(rels).toContain('<Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>');
    expect(rels).toContain('<Relationship Target="/Metadata/plate_1_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>');
    expect(strFromU8(zip['[Content_Types].xml'])).toContain('Extension="png" ContentType="image/png"');
  });

  it('without thumbnails: no image entries or references', () => {
    addCube('A');
    const zip = unzipSync(buildOrca3mf());
    expect(Object.keys(zip).filter((k) => k.endsWith('.png'))).toEqual([]);
    expect(strFromU8(zip['Metadata/model_settings.config'])).not.toContain('thumbnail_file');
    expect(strFromU8(zip['_rels/.rels'])).not.toContain('thumbnail');
  });

  it('still reopens as an Orca project', () => {
    addCube('A');
    addCube('B');
    const bytes = buildOrca3mf({ thumbnails: [images(10)] });
    const p = parseOrca3mf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(p.objects.map((o) => o.name).sort()).toEqual(['A', 'B']);
    expect(p.plates.length).toBe(1);
    expect(p.plates[0].config).toEqual({});
  });
});

describe('Orca 3MF header + custom G-code', () => {
  it('carries the OrcaSlicer tag desktop Orca uses to tell its projects from Bambu Studio ones', () => {
    addCube('A');
    const zip = unzipSync(buildOrca3mf());
    const model = strFromU8(zip['3D/3dmodel.model']);
    expect(model).toContain('<metadata name="Application">BambuStudio-02.06.00.51</metadata>');
    expect(model).toContain('<metadata name="OrcaSlicer">2.4.2</metadata>');
    expect(strFromU8(zip['Metadata/slice_info.config'])).not.toMatch(/BambuStudio/);
  });

  it('writes the custom G-code mode the engine slices with', () => {
    addCube('A');
    S.plates.value[0].customGcodes = [{ z: 2, type: 'color_change', extruder: 1, color: '#FF0000' }];
    const mode = () => strFromU8(unzipSync(buildOrca3mf())['Metadata/custom_gcode_per_layer.xml']).match(/<mode value="(\w+)"/)?.[1];
    expect(mode()).toBe('SingleExtruder');
    resolvedConfig.value = { ...resolvedConfig.value, filament_diameter: '1.75,1.75' };
    expect(mode()).toBe('MultiAsSingle');
  });

  it('writes copies ("Box (2)") as instances of one Orca object', () => {
    addCube('Box');
    S.duplicateObjects([S.objects.value[0].id], 2);
    expect(S.objects.value.map((o) => o.name)).toEqual(['Box', 'Box (2)', 'Box (3)']);
    const settings = strFromU8(unzipSync(buildOrca3mf())['Metadata/model_settings.config']);
    expect(settings.match(/<object id=/g)).toHaveLength(1);
    expect(settings.match(/<model_instance>/g)).toHaveLength(3);
  });
});

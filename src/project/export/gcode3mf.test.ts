import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { SliceStats } from '../../engine/types';
import { buildGcode3mf, scanGcode, sanitizeObjectLabel, type Gcode3mfInput, type Gcode3mfPlate } from './gcode3mf';

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
const images = (n: number) => ({ plate: png(n), small: png(n + 1), noLight: png(n + 2), top: png(n + 3), pick: png(n + 4) });

/** A Bambu-style G-code: label id header, T0 model + T1 support, a prime tower purge with T1. */
function gcode(labels: string): Uint8Array {
  return strToU8([
    '; HEADER_BLOCK_START', '; model printing time: 1m 32s; total estimated time: 1m 52s', `; model label id: ${labels}`, '; HEADER_BLOCK_END',
    'M83', 'T0', '; FEATURE: Custom', 'G1 X10 Y10 E2', '; FEATURE: Outer wall', 'G1 X20 Y10 E1.5', 'G1 E-0.8', 'G1 E0.8',
    'M620 S1A', 'T1', 'M621 S1A', '; FEATURE: Prime tower', 'G1 X30 Y10 E3', '; FEATURE: Support interface', 'G1 X40 Y10 E0.2',
    'T255', '',
  ].join('\n'));
}

const stats = (mm: number[], g: number[], t = 3725.9): SliceStats => ({ printTimeSec: t, filamentMm: mm, filamentCm3: [], filamentG: g, filamentCost: [], layers: 10, maxZ: 2 });

const CONFIG = {
  extruder_type: ['Direct Drive'], nozzle_volume_type: ['High Flow'], nozzle_diameter: ['0.4'], timelapse_type: '1',
  has_filament_switcher: '0', filament_map: ['1', '1', '1'], gcode_flavor: 'marlin', exclude_object: '0',
  filament_type: ['PLA', 'PLA', 'PETG'], filament_is_support: ['0', '1', '0'], filament_colour: ['#F2754E', '#FFFFFF', '#00AE42'],
  filament_ids: ['OFzyIxba', 'GFS00', 'custom-id'], enable_support: '0',
};

function input(over: Partial<Gcode3mfInput> = {}, plates?: Gcode3mfPlate[]): Gcode3mfInput {
  return {
    plates: plates ?? [
      { name: 'First', locked: false, config: { curr_bed_type: 'Textured PEI Plate' }, images: images(1),
        sliced: { gcode: gcode('20,24'), stats: stats([1234.567, 89.1, 0], [3.6512, 0.2649, 0]), config: { ...CONFIG, enable_support: '1' },
          objects: [{ name: 'Cube', fallbackId: 1 }, { name: 'Cone (2)', fallbackId: 2 }] } },
      { name: '', locked: true, images: images(10),
        sliced: { gcode: gcode('31'), stats: stats([500, 0, 0], [1.5, 0, 0], 60.2), config: CONFIG, objects: [{ name: 'Lid', fallbackId: 3 }] } },
    ],
    exportPlate: null,
    config: CONFIG,
    printerModelId: 'C12',
    bbl: true,
    modelMetadataXml: ' <metadata name="Application">BambuStudio-02.08.01.55</metadata>\n <metadata name="OrcaSlicer">2.5.0</metadata>\n',
    projectSettings: { name: 'project_settings', layer_height: '0.2' },
    customGcodeXml: null,
    ...over,
  };
}

const unzip = (b: Uint8Array) => unzipSync(b);
const text = (files: Record<string, Uint8Array>, k: string) => strFromU8(files[k]);
const metaOf = (xml: string, key: string) => [...xml.matchAll(new RegExp(`<metadata key="${key}" value="([^"]*)"/>`, 'g'))].map((m) => m[1]);

describe('scanGcode', () => {
  it('reads the label ids and which filaments print model / support (prime tower counts as neither)', () => {
    const s = scanGcode(gcode('20,24'));
    expect(s.labelIds).toEqual([20, 24]);
    expect([...s.modelFilaments]).toEqual([0]);
    expect([...s.supportFilaments]).toEqual([1]);
  });
  it('handles absolute E, G92 resets and a G-code without label ids', () => {
    const s = scanGcode(strToU8('M82\nG92 E0\n;TYPE:Support\nG1 X1 E1\nG1 X2 E0.5\nG92 E0\n;TYPE:External perimeter\nG1 X3 E0\nG1 X3 E1\n'));
    expect(s.labelIds).toBeNull();
    expect([...s.supportFilaments]).toEqual([0]);
    expect([...s.modelFilaments]).toEqual([]); // the last E increase has no XY move: an unretract
  });
});

describe('buildGcode3mf', () => {
  it('lists desktop\'s entries in desktop\'s order (all plates)', () => {
    const files = unzip(buildGcode3mf(input()));
    expect(Object.keys(files)).toEqual([
      '[Content_Types].xml',
      'Metadata/plate_1.png', 'Metadata/plate_1_small.png', 'Metadata/plate_2.png', 'Metadata/plate_2_small.png',
      'Metadata/plate_no_light_1.png', 'Metadata/plate_no_light_2.png',
      'Metadata/top_1.png', 'Metadata/pick_1.png', 'Metadata/top_2.png', 'Metadata/pick_2.png',
      '3D/3dmodel.model', 'Metadata/project_settings.config',
      'Metadata/plate_1.gcode.md5', 'Metadata/plate_2.gcode.md5', 'Metadata/plate_1.gcode', 'Metadata/plate_2.gcode',
      'Metadata/_rels/model_settings.config.rels', 'Metadata/model_settings.config',
      'Metadata/slice_info.config', 'Metadata/filament_sequence.json', '_rels/.rels',
    ]);
    expect(text(files, '[Content_Types].xml')).toContain('<Default Extension="gcode" ContentType="text/x.gcode"/>');
    expect(JSON.parse(text(files, 'Metadata/project_settings.config')).layer_height).toBe('0.2');
    expect(JSON.parse(text(files, 'Metadata/filament_sequence.json'))).toEqual({
      plate_1: { nozzle_sequence: [], optimal_assignment: [], sequence: [] }, plate_2: { nozzle_sequence: [], optimal_assignment: [], sequence: [] },
    });
  });

  it('writes each plate\'s G-code with its uppercase MD5', () => {
    const inp = input();
    const files = unzip(buildGcode3mf(inp));
    inp.plates.forEach((p, i) => {
      expect(files[`Metadata/plate_${i + 1}.gcode`]).toEqual(p.sliced!.gcode);
      expect(text(files, `Metadata/plate_${i + 1}.gcode.md5`)).toBe(createHash('md5').update(p.sliced!.gcode).digest('hex').toUpperCase());
    });
  });

  it('maps plates to their G-code in model_settings.config and its rels', () => {
    const files = unzip(buildGcode3mf(input()));
    const ms = text(files, 'Metadata/model_settings.config');
    expect(metaOf(ms, 'plater_id')).toEqual(['1', '2']);
    expect(metaOf(ms, 'plater_name')).toEqual(['First', '']);
    expect(metaOf(ms, 'locked')).toEqual(['false', 'true']);
    expect(metaOf(ms, 'bed_type')).toEqual(['Textured PEI Plate']);
    expect(metaOf(ms, 'gcode_file')).toEqual(['Metadata/plate_1.gcode', 'Metadata/plate_2.gcode']);
    expect(metaOf(ms, 'thumbnail_file')).toEqual(['Metadata/plate_1.png', 'Metadata/plate_2.png']);
    expect(metaOf(ms, 'pick_file')).toEqual(['Metadata/pick_1.png', 'Metadata/pick_2.png']);
    expect(ms).not.toContain('<object');
    expect(ms).not.toContain('model_instance');
    expect(ms).not.toContain('<assemble');
    const rels = text(files, 'Metadata/_rels/model_settings.config.rels');
    expect(rels).toContain('<Relationship Target="/Metadata/plate_1.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/>');
    expect(rels).toContain('<Relationship Target="/Metadata/plate_2.gcode" Id="rel-2" Type="http://schemas.bambulab.com/package/2021/gcode"/>');
    expect(text(files, '_rels/.rels')).toContain('Target="/Metadata/plate_1.png" Id="rel-2"');
  });

  it('writes slice_info.config as desktop does', () => {
    const si = text(unzip(buildGcode3mf(input())), 'Metadata/slice_info.config');
    expect(si).toContain('<header_item key="X-BBL-Client-Type" value="slicer"/>');
    expect(si).toContain('<header_item key="X-BBL-Client-Version" value="02.08.01.55"/>');
    expect(si).toContain('<header_item key="OrcaSlicer-Version" value="2.5.0"/>');
    expect(metaOf(si, 'index')).toEqual(['1', '2']);
    expect(metaOf(si, 'extruder_type')).toEqual(['0', '0']);
    expect(metaOf(si, 'nozzle_volume_type')).toEqual(['1', '1']);
    expect(metaOf(si, 'printer_model_id')).toEqual(['C12', 'C12']);
    expect(metaOf(si, 'nozzle_diameters')).toEqual(['0.4', '0.4']);
    expect(metaOf(si, 'timelapse_type')).toEqual(['1', '1']);
    expect(metaOf(si, 'prediction')).toEqual(['3725', '60']);
    expect(metaOf(si, 'weight')).toEqual(['3.92', '1.50']);
    expect(metaOf(si, 'support_used')).toEqual(['true', 'false']);
    expect(metaOf(si, 'label_object_enabled')).toEqual(['true', 'true']);
    expect(metaOf(si, 'enable_filament_dynamic_map')).toEqual(['false', 'false']);
    expect(metaOf(si, 'filament_maps')).toEqual(['1 1 1', '1 1 1']);
    // Objects carry the G-code's label ids (Bambu printers skip objects by them) and raw names.
    expect(si).toContain('<object identify_id="20" name="Cube" skipped="false" />');
    expect(si).toContain('<object identify_id="24" name="Cone (2)" skipped="false" />');
    expect(si).toContain('<object identify_id="31" name="Lid" skipped="false" />');
    // Filaments that extruded: Orca ids translated to Bambu's, support PLA → PLA-S.
    expect(si).toContain('<filament id="1" tray_info_idx="GFS04" type="PLA" color="#F2754E" used_m="1.23" used_g="3.65" group_id="0" nozzle_diameter="0.40" volume_type="High Flow" used_for_object="true" used_for_support="false"/>');
    expect(si).toContain('<filament id="2" tray_info_idx="GFS00" type="PLA-S" color="#FFFFFF" used_m="0.09" used_g="0.26" group_id="0" nozzle_diameter="0.40" volume_type="High Flow" used_for_object="false" used_for_support="true"/>');
    expect(si).not.toContain('<filament id="3"');
    expect(si.match(/<nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="High Flow"\/>/g)).toHaveLength(2);
  });

  it('exports one plate: only its G-code, the others listed without one', () => {
    const files = unzip(buildGcode3mf(input({ exportPlate: 1 }, [
      { name: 'A', locked: false, images: images(1) },
      { name: 'B', locked: false, images: images(10), sliced: { gcode: gcode('31'), stats: stats([500], [1.5]), config: CONFIG, objects: [{ name: 'Lid', fallbackId: 3 }] } },
    ])));
    expect(Object.keys(files).filter((k) => k.includes('.gcode'))).toEqual(['Metadata/plate_2.gcode.md5', 'Metadata/plate_2.gcode']);
    expect(metaOf(text(files, 'Metadata/model_settings.config'), 'gcode_file')).toEqual(['', 'Metadata/plate_2.gcode']);
    expect(metaOf(text(files, 'Metadata/slice_info.config'), 'index')).toEqual(['2']);
    const rels = text(files, '_rels/.rels');
    expect(rels).toContain('Target="/Metadata/plate_2.png" Id="rel-2"');
    expect(rels).toContain('Target="/Metadata/plate_2_small.png" Id="rel-5"');
  });

  it('writes a 3D model with the metadata only (SkipModel: no objects, empty build)', () => {
    const model = text(unzip(buildGcode3mf(input())), '3D/3dmodel.model');
    expect(model).toContain('<metadata name="OrcaSlicer">2.5.0</metadata>');
    expect(model).toContain(' <resources>\n </resources>\n <build/>\n</model>\n');
    expect(model).not.toContain('<object');
    expect(model).not.toContain('<item');
    expect(model).not.toContain('xmlns:p=');
  });

  it('names objects as the G-code labels them on Klipper / Marlin / RRF printers, and falls back to its own ids', () => {
    const cfg = { ...CONFIG, gcode_flavor: 'klipper', exclude_object: '1' };
    const si = text(unzip(buildGcode3mf(input({ bbl: false, config: cfg }, [
      { name: 'P', locked: false, sliced: { gcode: strToU8('G1 X1 E1\n'), stats: stats([10], [0.03]), config: cfg,
        objects: [{ name: 'My part (2)', fallbackId: 7 }, { name: 'Box', fallbackId: 8 }] } },
    ]))), 'Metadata/slice_info.config');
    expect(si).toContain('<object identify_id="7" name="My_part_2_id_0_copy_0" skipped="false" />');
    expect(si).toContain('<object identify_id="8" name="Box_id_1_copy_0" skipped="false" />');
    expect(metaOf(si, 'label_object_enabled')).toEqual(['true']);
    expect(si).toContain('tray_info_idx="OFzyIxba"'); // not translated off Bambu printers
    expect(sanitizeObjectLabel(' a,b ')).toBe('a_b');
  });
});

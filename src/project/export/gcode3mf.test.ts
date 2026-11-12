import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { SliceInfo, SliceStats } from '../../engine/types';
import { buildGcode3mf, cFixed6, nlohmannDouble, nlohmannDump, JsonFloat, scanGcode, sanitizeObjectLabel, type Gcode3mfInput, type Gcode3mfPlate } from './gcode3mf';

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

describe('desktop number formats', () => {
  it('cFixed6 is %f of the exact value, ties to even', () => {
    expect(cFixed6(Math.fround(12.3))).toBe('12.300000');
    expect(cFixed6(0)).toBe('0.000000');
    expect(cFixed6(1 / 128)).toBe('0.007812'); // 0.0078125: a tie, to even (toFixed would round up)
    expect(cFixed6(3 / 128)).toBe('0.023438'); // 0.0234375 → even 8
    expect(cFixed6(-1 / 128)).toBe('-0.007812');
    expect(cFixed6(Math.fround(37.25))).toBe('37.250000');
  });
  it('nlohmannDouble matches nlohmann::json dump (format_buffer)', () => {
    expect(nlohmannDouble(1)).toBe('1.0');
    expect(nlohmannDouble(120)).toBe('120.0');
    expect(nlohmannDouble(0)).toBe('0.0');
    expect(nlohmannDouble(-0)).toBe('-0.0');
    expect(nlohmannDouble(12.5)).toBe('12.5');
    expect(nlohmannDouble(Math.fround(0.2))).toBe('0.20000000298023224'); // a float, dumped as its double
    expect(nlohmannDouble(0.001)).toBe('0.001');
    expect(nlohmannDouble(0.0001)).toBe('0.0001');
    expect(nlohmannDouble(0.00001)).toBe('1e-05');
    expect(nlohmannDouble(1.5e-7)).toBe('1.5e-07');
    expect(nlohmannDouble(1e14)).toBe('100000000000000.0');
    expect(nlohmannDouble(1e15)).toBe('1e+15');
    expect(nlohmannDouble(-123.456)).toBe('-123.456');
  });
  it('nlohmannDump sorts object keys and keeps ints as ints', () => {
    expect(nlohmannDump({ b: [1, 2], a: { z: new JsonFloat(2), y: 'x"' }, plate_10: true, plate_2: null })).toBe('{"a":{"y":"x\\"","z":2.0},"b":[1,2],"plate_10":true,"plate_2":null}');
  });
});

describe('buildGcode3mf with the engine\'s slice info', () => {
  const info = (over: Partial<SliceInfo> = {}): SliceInfo => ({
    firstLayerTime: Math.fround(23.7), toolpathOutside: false, labelObjectEnabled: true, supportUsed: false,
    warnings: [], limitFilamentMaps: [], layerFilaments: [], filamentChangeSequence: [], nozzleChangeSequence: [], optimalAssignment: [],
    mixedFilaments: [],
    nozzleGrouping: { dynamic: false, filaments: [{ id: 0, groupIds: [0], diameter: 0.4, volumeType: 'High Flow' }], usedNozzles: [{ id: 0, extruderId: 0, diameter: '0.4', volumeType: 'High Flow' }] },
    firstLayerBBox: {
      firstExtruder: 0, bedType: 'Textured PEI Plate', firstLayerTime: Math.fround(23.7), nozzleDiameter: Math.fround(0.4), bboxAll: [100, 100.5, 135, 130],
      objects: [
        { id: 77, bbox: [100, 100.5, 120, 120.5], area: Math.fround(400.25), layerHeight: Math.fround(0.2), name: 'Cube' },
        { id: null, wipeTower: true, bbox: [125, 110, 135, 130], area: Math.fround(400.25), layerHeight: Math.fround(0.2), name: 'wipe_tower' },
      ],
    },
    ...over,
  });
  const one = (si: SliceInfo, cfg: Record<string, unknown> = CONFIG, mm = [1234.567, 0, 0], g = [3.6512, 0, 0]): Gcode3mfInput => input({ exportPlate: 0, config: cfg as typeof CONFIG }, [
    { name: 'A', locked: false, images: images(1), sliced: { gcode: gcode('20'), stats: { ...stats(mm, g), sliceInfo: si }, config: cfg as typeof CONFIG, objects: [{ name: 'Cube', fallbackId: 1 }] } },
    { name: 'B', locked: false, images: images(10) },
  ]);

  it('writes first_layer_time, support_used, label objects and the grouping\'s nozzles', () => {
    const si = text(unzip(buildGcode3mf(one(info({ supportUsed: true, labelObjectEnabled: false })))), 'Metadata/slice_info.config');
    expect(metaOf(si, 'first_layer_time')).toEqual(['23.700001']); // std::to_string of the float
    expect(metaOf(si, 'outside')).toEqual(['false']);
    expect(metaOf(si, 'support_used')).toEqual(['true']);
    expect(metaOf(si, 'label_object_enabled')).toEqual(['false']);
    expect(si).toContain(' group_id="0" nozzle_diameter="0.40" volume_type="High Flow" ');
    expect(si).toContain('<nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="High Flow"/>');
    expect(si).not.toContain('limit_filament_maps');
    expect(si).not.toContain('layer_filament_lists');
  });

  it('writes the slice warnings (and timelapse_type -1 when no timelapse is made), in desktop\'s order', () => {
    const si = text(unzip(buildGcode3mf(one(info({
      warnings: [{ level: 1, msg: 'not_generate_timelapse', errorCode: '10014001', params: [] }],
      mixedFilaments: [{ id: 4, type: 'PLA', color: '#808080', components: '1,2' }],
      limitFilamentMaps: [0, 2, 0],
      layerFilaments: [{ filaments: [0, 1], ranges: [[0, 3], [7, 9]] }, { filaments: [1], ranges: [[4, 6]] }],
    })))), 'Metadata/slice_info.config');
    expect(metaOf(si, 'timelapse_type')).toEqual(['-1']);
    expect(metaOf(si, 'limit_filament_maps')).toEqual(['0 2 0']);
    expect(si.indexOf('key="filament_maps"')).toBeLessThan(si.indexOf('key="limit_filament_maps"'));
    const tail = si.slice(si.indexOf('<filament id="1"'));
    expect(tail).toContain([
      '    <mixed_filament id="4" type="PLA" color="#808080" components="1,2"/>',
      '    <warning msg="not_generate_timelapse" level="1" error_code ="10014001"  />',
      '    <nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="High Flow"/>',
      '    <layer_filament_lists>',
      '      <layer_filament_list filament_list="0 1" layer_ranges="0 3,7 9" />',
      '      <layer_filament_list filament_list="1" layer_ranges="4 6" />',
      '    </layer_filament_lists>',
      '  </plate>',
    ].join('\n'));
  });

  it('writes an H2D plate\'s grouping: group ids per filament, every used nozzle', () => {
    const h2d = { ...CONFIG, nozzle_diameter: ['0.4', '0.4'], nozzle_volume_type: ['High Flow', 'Standard'], extruder_type: ['Direct Drive', 'Direct Drive'], filament_map: ['1', '2', '1'] };
    const si = text(unzip(buildGcode3mf(one(info({
      nozzleGrouping: { dynamic: false,
        filaments: [{ id: 0, groupIds: [0], diameter: 0.4, volumeType: 'High Flow' }, { id: 1, groupIds: [1], diameter: 0.4, volumeType: 'Standard' }],
        usedNozzles: [{ id: 0, extruderId: 0, diameter: '0.4', volumeType: 'High Flow' }, { id: 1, extruderId: 1, diameter: '0.4', volumeType: 'Standard' }] },
    }), h2d, [1000, 500, 0], [3, 1.5, 0]))), 'Metadata/slice_info.config');
    expect(si).toContain('<filament id="2" tray_info_idx="GFS00" type="PLA-S" color="#FFFFFF" used_m="0.50" used_g="1.50" group_id="1" nozzle_diameter="0.40" volume_type="Standard"');
    expect(si).toContain('<nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="High Flow"/>\n    <nozzle id="1" extruder_id="2" nozzle_diameter="0.4" volume_type="Standard"/>');
  });

  it('keeps the grouping\'s diameters on a printer with a nozzle cluster (H2C), and lists a filament on several nozzles', () => {
    const h2c = { ...CONFIG, nozzle_diameter: ['0.4', '0.4'], extruder_max_nozzle_count: ['1', '6'], filament_map: ['2', '2', '1'] };
    const si = unzip(buildGcode3mf(one(info({
      nozzleGrouping: { dynamic: true,
        filaments: [{ id: 0, groupIds: [1, 2], diameter: 0.2, volumeType: 'Hybrid' }],
        usedNozzles: [{ id: 1, extruderId: 1, diameter: '0.2', volumeType: 'Standard' }, { id: 2, extruderId: 1, diameter: '0.4', volumeType: 'High Flow' }] },
      filamentChangeSequence: [0, 1, 0], nozzleChangeSequence: [1, 2, 1], optimalAssignment: [1, 0, 0],
    }), h2c)));
    const si2 = text(si, 'Metadata/slice_info.config');
    expect(metaOf(si2, 'enable_filament_dynamic_map')).toEqual(['true']);
    expect(si2).toContain(' group_id="1,2" nozzle_diameter="0.20" volume_type="Hybrid" ');
    expect(si2).toContain('<nozzle id="1" extruder_id="2" nozzle_diameter="0.2" volume_type="Standard"/>');
    // A dynamic-map plate keys its sequence "filament_sequence" (1-based filaments).
    expect(text(si, 'Metadata/filament_sequence.json')).toBe(
      '{"plate_1":{"filament_sequence":[1,2,1],"nozzle_sequence":[1,2,1],"optimal_assignment":[1,0,0]},"plate_2":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}}');
  });

  it('writes plate_N.json (PlateBBoxData) after the images, with pattern_bbox_file in model_settings', () => {
    const files = unzip(buildGcode3mf(one(info())));
    const keys = Object.keys(files);
    expect(keys.indexOf('Metadata/plate_1.json')).toBe(keys.indexOf('Metadata/pick_2.png') + 1);
    expect(keys.indexOf('Metadata/plate_1.json') + 1).toBe(keys.indexOf('3D/3dmodel.model'));
    expect(keys).not.toContain('Metadata/plate_2.json');
    expect(text(files, 'Metadata/plate_1.json')).toBe(
      '{"bbox_all":[100.0,100.5,135.0,130.0],"bbox_objects":['
      + '{"area":400.25,"bbox":[100.0,100.5,120.0,120.5],"id":77,"layer_height":0.20000000298023224,"name":"Cube"},'
      + '{"area":400.25,"bbox":[125.0,110.0,135.0,130.0],"id":1000,"layer_height":0.20000000298023224,"name":"wipe_tower"}],'
      + '"bed_type":"Textured PEI Plate","filament_colors":["#F2754E"],"filament_ids":[0],"first_extruder":0,'
      + '"first_layer_time":23.700000762939453,"is_seq_print":false,"nozzle_diameter":0.4000000059604645,"version":2}');
    expect(metaOf(text(files, 'Metadata/model_settings.config'), 'pattern_bbox_file')).toEqual(['Metadata/plate_1.json']);
  });

  it('lists the exported filaments in the current plate\'s plate_N.json only (desktop\'s export loop)', () => {
    const inp = input();
    inp.plates.forEach((p) => { p.sliced!.stats = { ...p.sliced!.stats!, sliceInfo: info() }; });
    const files = unzip(buildGcode3mf({ ...inp, currentPlate: 1 }));
    expect(JSON.parse(text(files, 'Metadata/plate_1.json')).filament_ids).toEqual([]);
    expect(JSON.parse(text(files, 'Metadata/plate_2.json')).filament_ids).toEqual([0, 1, 0]);
    expect(JSON.parse(text(files, 'Metadata/plate_2.json')).bbox_objects[1].id).toBe(1001);
  });
});

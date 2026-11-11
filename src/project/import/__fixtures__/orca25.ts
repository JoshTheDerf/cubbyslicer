// SYNTHETIC OrcaSlicer 2.5.0 project 3MF for tests, hand-built to follow the
// v2.5.0 writer (src/libslic3r/Format/bbs_3mf.cpp `_add_model_config_file_to_archive`
// & co.). It is not a file saved by desktop Orca: no desktop Orca 2.5 was
// available. It exercises what 2.5 added and what CubbySlicer must pass
// through untouched:
// - object `auto_drop` attribute; an object setting the engine may not know;
// - a precise seam volume (modifier_part + precise_seam_type + precise_seam_config:*);
// - a volume with a subtype from the future, holding settings;
// - texture displacement: `paint_texture_0` triangle attributes, the
//   `texture_displacement` volume key, Metadata/texture_displacement/<id>.json + PNG;
// - a text volume's <slic3rpe:text> element and source_* keys;
// - the Design tab document (Metadata/orca_cad.bin), Auxiliaries/, an embedded preset;
// - plate imex_parallel_mode, filament_map_mode / filament_maps / filament_volume_maps,
//   bed type, an unknown plate key;
// - layer heights, height ranges, brim ears, custom G-code, cut information;
// - model metadata (designer, licence) and a slice_info.config with <mixed_filament>.
import { strToU8, zipSync, type Zippable } from 'fflate';

function box(id: number, s: number, paint = false): string {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const extra = (i: number) => (!paint ? '' : i === 2 ? ' paint_color="8" paint_texture_0="4"' : i === 3 ? ' paint_texture_0="C"' : '');
  return `  <object id="${id}" p:UUID="0000000${id}-81cb-4c03-9d28-80fed5dfa1dc" type="model">\n   <mesh>\n    <vertices>\n`
    + v.map((p) => `     <vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>\n`).join('')
    + '    </vertices>\n    <triangles>\n'
    + f.map((t, i) => `     <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"${extra(i)}/>\n`).join('')
    + '    </triangles>\n   </mesh>\n  </object>\n';
}

export const CAD_RECIPE = new Uint8Array([0x4f, 0x43, 0x41, 0x44, 6, 0, 0, 0, 1, 2, 3, 250, 251, 252]);
export const TEXTURE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
export const TEXTURE_JSON = '{"layers":[{"slot":0,"path":"bricks.png","path_in_3mf":"Metadata/texture_displacement/7_0.png","depth":0.4}],"options":{}}';

export function orca25Project3mf(): Uint8Array {
  const P = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
  const header = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="${P}" requiredextensions="p">\n`;
  const objects = `${header} <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n${box(1, 20, true)}${box(2, 10)}${box(3, 6)}${box(4, 4)}${box(5, 12)} </resources>\n <build/>\n</model>\n`;
  const comp = (id: number) => `    <component p:path="/3D/Objects/object_1.model" objectid="${id}" p:UUID="000${id}0000-b206-40ff-9872-83e8017abed1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`;
  const root = `${header}`
    + ' <metadata name="Application">BambuStudio-02.08.01.55</metadata>\n'
    + ' <metadata name="OrcaSlicer">2.5.0</metadata>\n'
    + ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
    + ' <metadata name="Copyright"></metadata>\n'
    + ' <metadata name="CreationDate"></metadata>\n'
    + ' <metadata name="Description">A &lt;test&gt; &amp; project</metadata>\n'
    + ' <metadata name="Designer">Ada</metadata>\n'
    + ' <metadata name="DesignerCover"></metadata>\n'
    + ' <metadata name="DesignerUserId"></metadata>\n'
    + ' <metadata name="License">CC-BY-4.0</metadata>\n'
    + ' <metadata name="MakerLab">Parametric box</metadata>\n'
    + ' <metadata name="ModificationDate"></metadata>\n'
    + ' <metadata name="Origin"></metadata>\n'
    + ' <metadata name="Title">Seam test</metadata>\n'
    + ' <resources>\n'
    + `  <object id="10" p:UUID="0000000a-61cb-4c03-9d28-80fed5dfa1dc" type="model">\n   <components>\n${comp(1)}${comp(2)}${comp(3)}${comp(4)}   </components>\n  </object>\n`
    + `  <object id="11" p:UUID="0000000b-61cb-4c03-9d28-80fed5dfa1dc" type="model">\n   <components>\n${comp(5)}   </components>\n  </object>\n`
    + ' </resources>\n <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">\n'
    + '  <item objectid="10" p:UUID="0000000a-b1ec-4553-aec9-835e5b724bb4" transform="1 0 0 0 1 0 0 0 1 100 100 0" printable="1"/>\n'
    + '  <item objectid="11" p:UUID="0000000b-b1ec-4553-aec9-835e5b724bb4" transform="1 0 0 0 1 0 0 0 1 347.2 40 0" printable="1"/>\n'
    + ' </build>\n</model>\n';
  const settings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="10" auto_drop="0">
    <metadata key="name" value="Seamed box"/>
    <metadata key="extruder" value="1"/>
    <metadata key="wall_loops" value="4"/>
    <metadata key="future_object_setting" value="7"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="Body"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_file" value="box.stl"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <metadata key="source_offset_x" value="10"/>
      <metadata key="source_offset_y" value="10"/>
      <metadata key="source_offset_z" value="10"/>
      <metadata key="extruder" value="2"/>
      <metadata key="texture_displacement" value="Metadata/texture_displacement/7.json"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
    <part id="2" subtype="modifier_part">
      <metadata key="precise_seam_type" value="precise_seam_left"/>
      <metadata key="name" value="Seam left"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="precise_seam_config:seam_gap" value="10%"/>
      <metadata key="precise_seam_config:future_seam_option" value="3"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
    <part id="3" subtype="fancy_future_part">
      <metadata key="name" value="Future volume"/>
      <metadata key="sparse_infill_density" value="90%"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
    <part id="4" subtype="normal_part">
      <metadata key="name" value="Label"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <slic3rpe:text text="Hi &amp; bye" font_descriptor="Noto Sans" style_name="Default" char_gap="0" line_gap="0"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <object id="11" auto_drop="1">
    <metadata key="name" value="Small"/>
    <part id="5" subtype="normal_part">
      <metadata key="name" value="Small"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="IDEX"/>
    <metadata key="locked" value="false"/>
    <metadata key="bed_type" value="Textured PEI Plate"/>
    <metadata key="spiral_mode" value="false"/>
    <metadata key="imex_parallel_mode" value="Copy &amp; mirror&#x9;A"/>
    <metadata key="imex_head_filament_map" value="1:1;2:2"/>
    <metadata key="filament_map_mode" value="Manual"/>
    <metadata key="filament_maps" value="1 2"/>
    <metadata key="filament_volume_maps" value="0 1"/>
    <metadata key="future_plate_key" value="x y"/>
    <metadata key="gcode_file" value=""/>
    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>
    <model_instance>
      <metadata key="object_id" value="10"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="77"/>
    </model_instance>
  </plate>
  <plate>
    <metadata key="plater_id" value="2"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="true"/>
    <model_instance>
      <metadata key="object_id" value="11"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="88"/>
    </model_instance>
  </plate>
</config>
`;
  const project = {
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle',
    print_settings_id: '0.20mm Standard @BBL X1C',
    filament_settings_id: ['Bambu PLA Basic @BBL X1C', 'Bambu PLA Basic @BBL X1C'],
    filament_colour: ['#FFFFFF', '#E4572E'],
    curr_bed_type: 'Textured PEI Plate',
    different_settings_to_system: ['', '', '', ''],
    name: 'project_settings', from: 'project', version: '02.08.01.55',
  };
  const files: Zippable = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="png" ContentType="image/png"/>\n <Default Extension="json" ContentType="application/json"/>\n</Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n'),
    '3D/_rels/3dmodel.model.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n'),
    '3D/3dmodel.model': strToU8(root),
    '3D/Objects/object_1.model': strToU8(objects),
    'Metadata/model_settings.config': strToU8(settings),
    'Metadata/project_settings.config': strToU8(JSON.stringify(project, null, 4)),
    'Metadata/slice_info.config': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="02.08.01.55"/>\n    <header_item key="OrcaSlicer-Version" value="2.5.0"/>\n  </header>\n  <plate>\n    <metadata key="index" value="1"/>\n    <mixed_filament id="3" type="PLA" color="#808080" components="1,2"/>\n  </plate>\n</config>\n'),
    'Metadata/layer_heights_profile.txt': strToU8('object_id=1|0.000000;0.200000;5.000000;0.100000;20.000000;0.100000\n'),
    'Metadata/layer_config_ranges.xml': strToU8('<?xml version="1.0" encoding="utf-8"?>\n<objects>\n <object id="1">\n  <range min_z="2" max_z="6">\n   <option opt_key="layer_height">0.1</option>\n   <option opt_key="extruder">2</option>\n  </range>\n </object>\n</objects>\n'),
    'Metadata/brim_ear_points.txt': strToU8('brim_points_format_version=0\nobject_id=2|1.000000 2.000000 0.000000 3.000000 6.000000 6.000000 0.000000 2.500000\n'),
    'Metadata/custom_gcode_per_layer.xml': strToU8('<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n <plate>\n  <plate_info id="1"/>\n  <layer top_z="2" type="0" extruder="2" color="#FF0000" extra="" gcode="M600"/>\n  <layer top_z="4" type="4" extruder="1" color="" extra="M117 hi" gcode="M117 hi"/>\n  <mode value="MultiAsSingle"/>\n </plate>\n</custom_gcodes_per_layer>\n'),
    'Metadata/cut_information.xml': strToU8('<?xml version="1.0" encoding="utf-8"?>\n<objects>\n <object id="1">\n  <cut_id id="12" check_sum="1" connectors_cnt="0"/>\n </object>\n</objects>\n'),
    'Metadata/orca_cad.bin': CAD_RECIPE,
    'Metadata/texture_displacement/7.json': strToU8(TEXTURE_JSON),
    'Metadata/texture_displacement/7_0.png': [TEXTURE_PNG, { level: 0 }],
    'Metadata/filament_settings_1.config': strToU8('{"name":"My PLA","from":"User","inherits":"Bambu PLA Basic @BBL X1C"}'),
    'Auxiliaries/Model Pictures/front.png': [TEXTURE_PNG, { level: 0 }],
    'Metadata/plate_1.png': [TEXTURE_PNG, { level: 0 }],
    'Metadata/plate_1.gcode': strToU8('; generated by OrcaSlicer 2.5.0\nG28\n'),
    'Metadata/plate_1.gcode.md5': strToU8('0123456789abcdef'),
    'Metadata/filament_sequence.json': strToU8('{"plate_1":{"sequence":[]}}'),
    'Metadata/some_future_file.dat': strToU8('derived'),
  };
  return zipSync(files);
}

/** A "published" 3MF (Orca 2.5 Publish, minimal): no slicer tags, no project_settings.config. */
export function orca25Published3mf(): Uint8Array {
  const payload = 'sparse_infill_density = 33%\nwall_loops = 5\nretraction_length = 0.8,1.2\nnozzle_diameter = 0.6\nfilament_type = PLA;PETG\nfilament_settings_id = "x";"y"\nprintable_area = 0x0,200x0,200x200,0x200\n';
  const meta = (k: string, v: string) => ` <metadata name="${k}">${v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</metadata>\n`;
  const root = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
    + meta('Title', 'Published')
    + meta('orca_published', '1')
    + meta('orca_published_keys', JSON.stringify(['sparse_infill_density', 'wall_loops', 'retraction_length#1', 'nozzle_diameter', 'print_settings_id']))
    + meta('orca_published_material_keys', JSON.stringify([{ slot: 1, keys: ['filament_type'], publish_color: true, color: '#00FF00', full: false }]))
    + meta('orca_published_config', payload)
    + ` <resources>\n${box(1, 10).replace(' p:UUID="00000001-81cb-4c03-9d28-80fed5dfa1dc"', '')} </resources>\n <build>\n  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 50 0" printable="1"/>\n </build>\n</model>\n`;
  const settings = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="1" auto_drop="1">\n    <metadata key="name" value="Cube"/>\n    <part id="1" subtype="normal_part">\n      <metadata key="name" value="Cube"/>\n    </part>\n  </object>\n  <plate>\n    <metadata key="plater_id" value="1"/>\n    <model_instance>\n      <metadata key="object_id" value="1"/>\n      <metadata key="instance_id" value="0"/>\n    </model_instance>\n  </plate>\n</config>\n';
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n'),
    '3D/3dmodel.model': strToU8(root),
    'Metadata/model_settings.config': strToU8(settings),
  });
}

// Opening a published 3MF (Orca 2.5 Publish) through the real preset store: the material pass
// (type gate, de-aliasing, colours, keys, Full entries, mixed relocation + model remap) and the
// process / printer passes (PresetBundle::load_config_file_config, published mode).
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { activeEngine, resolvedConfig } from '../app/state';
import type { ConfigOptionDef, ConfigSchema } from '../engine/types';
import { memoryKv } from '../presets/kv';
import { OrcaCatalog, sysId } from '../presets/orca/catalog';
import { _setEnginePresets, EnginePresets } from '../presets/store';
import { UserPresetStore } from '../presets/userPresets';
import { openOrcaProject } from './orcaOpen';
import * as S from './store';

function opt(type: ConfigOptionDef['type'], scope: ConfigOptionDef['scope'], dflt: string): ConfigOptionDef {
  return { type, label: '', fullLabel: '', category: '', tooltip: '', sidetext: '', mode: 'simple', min: null, max: null, default: dflt, scope };
}
const schema: ConfigSchema = {
  engine: 'orca', version: '2.5.0', options: {
    layer_height: opt('float', 'print', '0.2'),
    wall_loops: opt('int', 'print', '2'),
    extruder: opt('int', 'object', '1'),
    nozzle_diameter: opt('floats', 'machine', '0.4'),
    retraction_length: opt('floats', 'machine', '0.8'),
    z_hop: opt('floats', 'machine', '0.4'),
    nozzle_temperature: opt('ints', 'filament', '200'),
    filament_max_volumetric_speed: opt('floats', 'filament', '10'),
    filament_type: opt('strings', 'filament', 'PLA'),
    filament_settings_id: opt('strings', 'other', ''),
    compatible_printers: opt('strings', 'filament', ''),
    default_filament_colour: opt('strings', 'filament', '""'),
    filament_colour: opt('strings', 'other', '"#F2754E"'),
    filament_multi_colour: opt('strings', 'filament', '""'),
    filament_colour_type: opt('strings', 'filament', '"1"'),
    flush_volumes_matrix: opt('floats', 'other', '0'),
    single_extruder_multi_material: opt('bool', 'machine', '1'),
    printable_area: opt('points', 'machine', '0x0,256x0,256x256,0x256'),
    printable_height: opt('float', 'machine', '250'),
    wipe_tower_x: opt('floats', 'other', '15'),
    wipe_tower_y: opt('floats', 'other', '220'),
    filament_is_mixed: opt('bools', 'other', '0'),
    filament_mixed_components: opt('strings', 'other', '""'),
    filament_mixed_sublayer_ratios: opt('strings', 'other', '""'),
    filament_mixed_gradient: opt('bools', 'other', '0'),
    filament_mixed_gradient_range: opt('strings', 'other', '""'),
    filament_mixed_gradient_curve: opt('strings', 'other', '""'),
    filament_mixed_gradient_per_part: opt('bools', 'other', '0'),
  },
};
const files: Record<string, unknown> = {
  '_index.json': ['V'],
  'V.json': {
    name: 'V', machine_model_list: [],
    machine_list: [{ name: 'P1', sub_path: 'm/P1.json' }],
    process_list: [{ name: '0.2mm', sub_path: 'p/02.json' }],
    filament_list: [{ name: 'PLA', sub_path: 'f/PLA.json' }, { name: 'PETG', sub_path: 'f/PETG.json' }],
  },
  'V/m/P1.json': { type: 'machine', name: 'P1', instantiation: 'true', printer_model: 'M', default_filament_profile: ['PLA'] },
  'V/p/02.json': { type: 'process', name: '0.2mm', instantiation: 'true', layer_height: '0.2', compatible_printers: ['P1'] },
  'V/f/PLA.json': { type: 'filament', name: 'PLA', instantiation: 'true', nozzle_temperature: ['210'], filament_type: ['PLA'], compatible_printers: ['P1'] },
  'V/f/PETG.json': { type: 'filament', name: 'PETG', instantiation: 'true', nozzle_temperature: ['240'], filament_type: ['PETG'], compatible_printers: ['P1'] },
};
const fetcher = async (url: string) => {
  const rel = decodeURIComponent(url.slice('/p/'.length));
  return rel in files ? JSON.parse(JSON.stringify(files[rel])) : null;
};

async function receiver(filaments: number): Promise<EnginePresets> {
  const s = new EnginePresets('orca', {
    schema, catalog: new OrcaCatalog({ base: '/p', fetcher }), users: new UserPresetStore('orca', memoryKv()), evaluate: null, persist: false,
  });
  await s.ready;
  await s.selectPrinter(sysId('V', 'P1'));
  if (filaments > 1) await s.setFilamentCount(filaments);
  _setEnginePresets('orca', s);
  // currentPresets is computed from the active engine: switch away and back so it picks this one up.
  activeEngine.value = 'preflight';
  activeEngine.value = 'orca';
  return s;
}
afterEach(() => { _setEnginePresets('orca', null); S.resetProject(); resolvedConfig.value = {}; });

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A minimal published 3MF: one cube (extruder `extruder`), the given metadata. */
function published(meta: Record<string, unknown>, extruder = 1): ArrayBuffer {
  const m = (k: string, v: unknown) => ` <metadata name="${k}">${esc(typeof v === 'string' ? v : JSON.stringify(v))}</metadata>\n`;
  const v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const mesh = `<object id="1" type="model"><mesh><vertices>${v.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices>`
    + `<triangles>${f.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh></object>`;
  const root = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
    + m('orca_published', '1') + Object.entries(meta).map(([k, val]) => m(k, val)).join('')
    + ` <resources>\n${mesh}\n </resources>\n <build>\n  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 50 0" printable="1"/>\n </build>\n</model>\n`;
  const settings = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="1">\n    <metadata key="name" value="Cube"/>\n    <metadata key="extruder" value="${extruder}"/>\n`
    + '    <part id="1" subtype="normal_part">\n      <metadata key="name" value="Cube"/>\n    </part>\n  </object>\n  <plate>\n    <metadata key="plater_id" value="1"/>\n'
    + '    <model_instance>\n      <metadata key="object_id" value="1"/>\n      <metadata key="instance_id" value="0"/>\n    </model_instance>\n  </plate>\n</config>\n';
  const z = zipSync({ '3D/3dmodel.model': strToU8(root), 'Metadata/model_settings.config': strToU8(settings) });
  return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer;
}

describe('published 3MF: material pass', () => {
  it('a grown slot sharing the last preset is re-pointed to the published filament; colour and keys land on it', async () => {
    const s = await receiver(1);
    const r = await openOrcaProject('pub.3mf', published({
      orca_published_keys: [],
      orca_published_material_keys: [{ slot: 1, keys: ['nozzle_temperature'], publish_color: true, color: '#00FF00', material: { name: 'PETG', filament_type: 'PETG' } }],
      orca_published_config: 'filament_colour = "#111111";"#222222"\nnozzle_temperature = 215,250\nfilament_type = "PLA";"PETG"\n',
    }));
    expect(r.published).toBe(true);
    expect(s.selection.filaments).toEqual([sysId('V', 'PLA'), sysId('V', 'PETG')]);
    expect(s.value('filament', 'nozzle_temperature', 1)).toEqual(['250']);
    expect(s.filamentColour(1)).toBe('#00FF00');
    expect(r.warnings.join('\n')).toContain('slot 1: PLA -> PETG');
  });

  it('a type requirement swaps a mismatched slot for the best match; without a match the keys are reported', async () => {
    const s = await receiver(2);
    await openOrcaProject('pub.3mf', published({
      orca_published_material_keys: [{ slot: 0, keys: ['nozzle_temperature'], publish_type: true, type: 'PETG', material: { filament_type: 'PETG', filament_id: 'X' } }],
      orca_published_config: 'filament_colour = "#111111";"#222222"\nnozzle_temperature = 245,250\n',
    }));
    expect(s.selection.filaments[0]).toBe(sysId('V', 'PETG'));
    expect(s.value('filament', 'nozzle_temperature', 0)).toEqual(['245']);
    const t = await receiver(1);
    const r = await openOrcaProject('pub.3mf', published({
      orca_published_material_keys: [{ slot: 0, keys: ['nozzle_temperature'], publish_type: true, type: 'PA-CF', material: { filament_id: 'GFN03' } }],
      orca_published_config: 'filament_colour = "#111111"\nnozzle_temperature = 280\n',
    }));
    expect(t.selection.filaments[0]).toBe(sysId('V', 'PLA'));
    expect(t.value('filament', 'nozzle_temperature', 0)).toEqual(['210']);
    expect(r.warnings.join('\n')).toContain('material:GFN03 (nozzle_temperature)');
  });

  it('a Full entry becomes a standalone, universal copy of the author’s filament selected on the slot', async () => {
    const s = await receiver(2);
    s.setValue('filament', 'nozzle_temperature', ['199'], 0); // an unsaved edit: not part of the copy's baseline
    const r = await openOrcaProject('pub.3mf', published({
      orca_published_material_keys: [
        { slot: 0, keys: [], full: true, full_keys: ['nozzle_temperature', 'filament_max_volumetric_speed', 'filament_type'], material: { name: 'Author PLA @Printer', setting_id: 'S1' } },
        // The same identity on another slot shares the copy.
        { slot: 1, keys: [], full: true, full_keys: ['nozzle_temperature'], publish_color: true, color: '#00FF00', material: { name: 'Author PLA @Printer', setting_id: 'S1' } },
      ],
      orca_published_config: 'filament_colour = "#123456";"#654321"\nnozzle_temperature = 222,223\nfilament_max_volumetric_speed = 17,18\nfilament_type = "PLA";"PLA"\n',
    }));
    const info = s.selectedInfo('filament', 0);
    expect(info).toMatchObject({ name: 'Author PLA', source: 'user' });
    expect(info.parentId).toBeUndefined();
    expect(s.selection.filaments[1]).toBe(info.id);
    expect(s.dirtyCount('filament', 0)).toBe(0);
    expect(s.value('filament', 'nozzle_temperature', 0)).toEqual(['222']);
    expect(s.value('filament', 'filament_max_volumetric_speed', 0)).toEqual(['17']);
    expect(s.users.get(info.id)!.values.compatible_printers).toEqual([]);
    expect(s.filamentColour(1)).toBe('#00FF00');
    expect(r.warnings.join('\n')).toContain('slot 0: PLA -> Author PLA');
    // A second load clashes with that name: "(Published)".
    const t = await receiver(1);
    t.users.create({ kind: 'filament', name: 'Author PLA', values: {} });
    await openOrcaProject('pub.3mf', published({
      orca_published_material_keys: [{ slot: 0, keys: [], full: true, full_keys: ['nozzle_temperature'], material: { name: 'Author PLA @Printer' } }],
      orca_published_config: 'filament_colour = "#123456"\nnozzle_temperature = 222\n',
    }));
    expect(t.selectedInfo('filament', 0).name).toBe('Author PLA (Published)');
  });

  it('the setting-id tier: a type requirement picks the filament with the author’s setting_id', async () => {
    files['V/f/PETG.json'] = { ...(files['V/f/PETG.json'] as object), setting_id: 'GFSG99' };
    files['V.json'] = { ...(files['V.json'] as { filament_list: unknown[] }), filament_list: [...(files['V.json'] as { filament_list: unknown[] }).filament_list, { name: 'PETG HF', sub_path: 'f/PETGHF.json' }] };
    files['V/f/PETGHF.json'] = { type: 'filament', name: 'PETG HF', instantiation: 'true', filament_type: ['PETG'], compatible_printers: ['P1'] };
    try {
      const s = await receiver(1);
      await openOrcaProject('pub.3mf', published({
        orca_published_material_keys: [{ slot: 0, keys: [], publish_type: true, type: 'PETG', material: { setting_id: 'GFSG99', filament_type: 'PETG' } }],
        orca_published_config: 'filament_colour = "#111111"\n',
      }));
      expect(s.selection.filaments[0]).toBe(sysId('V', 'PETG'));
      // A profile without its own id gets the generated one (generate_preset_setting_id).
      const { generatePresetSettingId } = await import('../presets/settingId');
      const id = await generatePresetSettingId('V', 'filament', 'PETG HF');
      const t = await receiver(1);
      await openOrcaProject('pub.3mf', published({
        orca_published_material_keys: [{ slot: 0, keys: [], publish_type: true, type: 'PETG', material: { setting_id: id, filament_type: 'PETG' } }],
        orca_published_config: 'filament_colour = "#111111"\n',
      }));
      expect(t.selection.filaments[0]).toBe(sysId('V', 'PETG HF'));
    } finally {
      files['V/f/PETG.json'] = { type: 'filament', name: 'PETG', instantiation: 'true', nozzle_temperature: ['240'], filament_type: ['PETG'], compatible_printers: ['P1'] };
      delete files['V/f/PETGHF.json'];
      const v = files['V.json'] as { filament_list: Array<{ name: string }> };
      files['V.json'] = { ...v, filament_list: v.filament_list.filter((f) => f.name !== 'PETG HF') };
    }
  });

  it('an unassigned mixed filament keeps the colour its slot was seeded with', async () => {
    const s = await receiver(1); // single-extruder multi-material: capacity is the slot limit, so set up a 2-nozzle printer
    s.setValue('printer', 'single_extruder_multi_material', '0');
    s.setValue('printer', 'nozzle_diameter', ['0.4', '0.4']);
    await s.setFilamentCount(2);
    s.setValue('filament', 'filament_colour', ['#ABCDEF'], 1);
    await openOrcaProject('pub.3mf', published({
      orca_published_material_keys: [
        { slot: 2, keys: ['nozzle_temperature'], publish_color: true, color: '#00AA00', material: { filament_type: 'PLA' } },
        { slot: 3, keys: ['nozzle_temperature'], material: { filament_type: 'PLA' } },
      ],
      orca_published_config: 'filament_colour = "#111111";"#222222";"#333333";"#444444"\nnozzle_temperature = 1,2,3,4\n',
    }));
    expect(s.selection.filaments).toHaveLength(2);
    expect(s.mixedDefs()).toHaveLength(2);
    expect(s.mixedDefs()[0].components).toEqual([]);
    const colours = s.filamentColours();
    expect(colours[2]).toBe('#00AA00');
    // No published colour: the receiver's last filament's preset colour.
    expect(colours[3]).toBe('#ABCDEF');
  });

  it('a mixed filament authored on a real slot moves to the tail and the model’s references follow', async () => {
    const s = await receiver(2);
    await openOrcaProject('pub.3mf', published({
      orca_published_material_keys: [{ slot: 1, keys: ['filament_is_mixed', 'filament_mixed_components', 'filament_mixed_sublayer_ratios'] }],
      orca_published_config: 'filament_colour = "#111111";"#222222";"#333333"\nfilament_is_mixed = 0,1,0\n'
        + 'filament_mixed_components = "";"1,2";""\nfilament_mixed_sublayer_ratios = "";"0.7000,0.3000";""\n',
    }, 2));
    expect(s.selection.filaments).toHaveLength(2);
    expect(s.mixedDefs()).toMatchObject([{ components: [1, 2], ratios: [70, 30] }]);
    expect(S.objects.value[0].overrides.extruder).toBe('3');
  });

  it('process keys apply; printer keys only from the retraction / z-hop groups; per-extruder keys collapse', async () => {
    const s = await receiver(1);
    const r = await openOrcaProject('pub.3mf', published({
      orca_published_keys: ['wall_loops', 'retraction_length#1', 'nozzle_diameter', 'print_settings_id', 'layer_height#0'],
      orca_published_config: 'filament_colour = "#111111"\nwall_loops = 5\nretraction_length = 0.8,1.6\nnozzle_diameter = 0.6\nlayer_height = 0.1\nwipe_tower_x = 99\n',
    }));
    expect(s.value('process', 'wall_loops')).toBe('5');
    expect(s.value('printer', 'retraction_length')).toEqual(['1.6']);
    expect(s.value('printer', 'nozzle_diameter')).toEqual(['0.4']);
    expect(s.project.wipe_tower_x).toEqual(['99']);
    // A scalar with a "#N" suffix can't apply; structural and non-publishable printer keys are silent.
    expect(r.warnings.join('\n')).toContain('could not be applied: layer_height#0.');
  });
});

describe('project-embedded presets', () => {
  it('an older project’s INI process preset is loaded and selected; a preset whose parent is missing is not', async () => {
    const s = await receiver(1);
    const z = new Uint8Array(published({}));
    const { unzipSync } = await import('fflate');
    const entries = unzipSync(z);
    // An ordinary (not published) project.
    entries['3D/3dmodel.model'] = strToU8(new TextDecoder().decode(entries['3D/3dmodel.model']).replace(/ <metadata name="orca_published">1<\/metadata>\n/, ''));
    entries['Metadata/project_settings.config'] = strToU8(JSON.stringify({
      printer_settings_id: 'P1', print_settings_id: 'My 0.2mm', filament_settings_id: ['My PLA'], filament_colour: ['#111111'],
    }));
    entries['Metadata/print_setting_1.config'] = strToU8('# generated by BambuStudio\nprint_settings_id = My 0.2mm\ninherits = 0.2mm\nwall_loops = 7\n');
    entries['Metadata/filament_settings_1.config'] = strToU8(JSON.stringify({ name: 'My PLA', filament_settings_id: ['My PLA'], inherits: 'Gone PLA', nozzle_temperature: ['199'] }));
    const bytes = zipSync(entries);
    const r = await openOrcaProject('old.3mf', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(s.selectedInfo('process').name).toBe('My 0.2mm');
    expect(s.value('process', 'wall_loops')).toBe('7');
    expect(s.users.findByName('filament', 'My PLA')).toBeUndefined();
    expect(r.warnings.join('\n')).toContain('Not loaded (their parent preset isn’t available): My PLA.');
  });
});

import { describe, expect, it } from 'vitest';
import type { ConfigOptionDef, ConfigSchema } from '../engine/types';
import { memoryKv } from './kv';
import { OrcaCatalog, sysId } from './orca/catalog';
import { EnginePresets } from './store';
import { DEFAULT_PRESET_ID } from './types';
import { UserPresetStore } from './userPresets';

function opt(type: ConfigOptionDef['type'], scope: ConfigOptionDef['scope'], dflt: string): ConfigOptionDef {
  return { type, label: '', fullLabel: '', category: '', tooltip: '', sidetext: '', mode: 'simple', min: null, max: null, default: dflt, scope };
}
const schema: ConfigSchema = {
  engine: 'orca', version: 't',
  options: {
    layer_height: opt('float', 'object', '0.2'),
    wall_loops: opt('int', 'object', '2'),
    nozzle_diameter: opt('floats', 'machine', '0.4'),
    printable_height: opt('float', 'machine', '100'),
    nozzle_temperature: opt('ints', 'filament', '200'),
    filament_type: opt('strings', 'filament', 'PLA'),
    compatible_printers: opt('strings', 'filament', ''),
    print_settings_id: opt('string', 'other', ''),
    default_filament_colour: opt('strings', 'filament', '""'),
    filament_colour: opt('strings', 'other', '"#F2754E"'),
    single_extruder_multi_material: opt('bool', 'machine', '1'),
    default_bed_type: opt('string', 'machine', ''),
    curr_bed_type: { ...opt('enum', 'other', 'Cool Plate'), enumValues: ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Textured PEI Plate'] },
  },
};

const files: Record<string, unknown> = {
  '_index.json': ['V'],
  'V.json': {
    name: 'V',
    machine_model_list: [],
    machine_list: [{ name: 'P1', sub_path: 'm/P1.json' }, { name: 'P2', sub_path: 'm/P2.json' }],
    process_list: [{ name: 'Std', sub_path: 'p/Std.json' }, { name: 'Fine', sub_path: 'p/Fine.json' }],
    filament_list: [{ name: 'PLA', sub_path: 'f/PLA.json' }, { name: 'PETG', sub_path: 'f/PETG.json' }],
  },
  'V/m/P1.json': { type: 'machine', name: 'P1', instantiation: 'true', printer_model: 'M', printable_height: '250', default_bed_type: '4', default_print_profile: 'Fine', default_filament_profile: ['PETG'] },
  'V/m/P2.json': { type: 'machine', name: 'P2', instantiation: 'true', printer_model: 'M', nozzle_diameter: ['0.4', '0.4'] },
  'V/p/Std.json': { type: 'process', name: 'Std', instantiation: 'true', layer_height: '0.2', compatible_printers: ['P1', 'P2'] },
  'V/p/Fine.json': { type: 'process', name: 'Fine', instantiation: 'true', layer_height: '0.1', wall_loops: '3', compatible_printers: ['P1'] },
  'V/f/PLA.json': { type: 'filament', name: 'PLA', instantiation: 'true', nozzle_temperature: ['210'], default_filament_colour: ['#00AE42'], compatible_printers: ['P1', 'P2'] },
  'V/f/PETG.json': { type: 'filament', name: 'PETG', instantiation: 'true', nozzle_temperature: ['240'], filament_type: ['PETG'], compatible_printers: ['P1', 'P2'] },
};
const fetcher = async (url: string) => {
  const rel = decodeURIComponent(url.slice('/p/'.length));
  return rel in files ? JSON.parse(JSON.stringify(files[rel])) : null;
};

async function make() {
  const s = new EnginePresets('orca', {
    schema, catalog: new OrcaCatalog({ base: '/p', fetcher }), users: new UserPresetStore('orca', memoryKv()), evaluate: null, persist: false,
  });
  await s.ready;
  return s;
}

describe('EnginePresets', () => {
  it('starts from engine defaults', async () => {
    const s = await make();
    expect(s.selection.printer).toBe(DEFAULT_PRESET_ID);
    const cfg = s.resolve();
    expect(cfg.layer_height).toBe('0.2');
    expect(cfg.nozzle_diameter).toEqual(['0.4']);
  });

  it('selecting a printer applies its default process / filament and resolves', async () => {
    const s = await make();
    await s.selectPrinter(sysId('V', 'P1'));
    expect(s.infos.value.process.name).toBe('Fine');
    expect(s.infos.value.filaments.map((f) => f.name)).toEqual(['PETG']);
    const cfg = s.resolve();
    expect(cfg).toMatchObject({ printable_height: '250', layer_height: '0.1', wall_loops: '3', nozzle_temperature: ['240'], print_settings_id: 'Fine' });
    expect(s.installedPrinters.value).toContain(sysId('V', 'P1'));
  });

  it('drops incompatible selections and sizes filament slots by extruder count', async () => {
    const s = await make();
    await s.selectPrinter(sysId('V', 'P1'));
    await s.selectPrinter(sysId('V', 'P2'));
    expect(s.infos.value.process.name).toBe('Std'); // Fine is P1-only
    expect(s.selection.filaments).toHaveLength(2);
    await s.selectFilament(1, sysId('V', 'PLA'));
    expect(s.resolve().nozzle_temperature).toEqual(['240', '210']);
  });

  it('tracks modified values against the preset and reverts', async () => {
    const s = await make();
    await s.selectPrinter(sysId('V', 'P1'));
    s.setValue('process', 'wall_loops', '5');
    expect(s.isModified('process', 'wall_loops')).toBe(true);
    expect(s.value('process', 'wall_loops')).toBe('5');
    s.setValue('process', 'wall_loops', '3'); // back to preset value → not an override
    expect(s.isModified('process', 'wall_loops')).toBe(false);
    s.setValue('filament', 'nozzle_temperature', ['250'], 0);
    expect(s.dirtyCount('filament', 0)).toBe(1);
    s.revert('filament', 'nozzle_temperature', 0);
    expect(s.dirtyCount('filament', 0)).toBe(0);
  });

  it('save as → user preset storing the diff against its system parent; save / rename / delete', async () => {
    const s = await make();
    await s.selectPrinter(sysId('V', 'P1'));
    s.setValue('process', 'wall_loops', '6');
    const u = await s.saveAs('process', 'My fine');
    expect(u.parentId).toBe(sysId('V', 'Fine'));
    expect(u.inherits).toBe('Fine');
    expect(u.values).toEqual({ wall_loops: '6' });
    expect(s.selection.process).toBe(u.id);
    expect(s.dirtyCount('process')).toBe(0);
    expect(s.resolve()).toMatchObject({ wall_loops: '6', layer_height: '0.1', print_settings_id: 'My fine' });
    expect(s.compatible.value.process.map((p) => p.name)).toContain('My fine');

    s.setValue('process', 'layer_height', '0.12');
    expect(await s.save('process')).toBe(true);
    expect(s.users.get(u.id)?.values).toEqual({ wall_loops: '6', layer_height: '0.12' });

    await s.renamePreset(u.id, 'Renamed');
    const exp = await s.exportPreset('process');
    expect(exp.json).toMatchObject({ name: 'Renamed', inherits: 'Fine', type: 'process', layer_height: '0.12', wall_loops: '6' });

    await s.deletePreset(u.id);
    expect(s.selection.process).toBe(sysId('V', 'Fine'));
  });

  it('imports Orca preset JSON with a system parent', async () => {
    const s = await make();
    const data = new TextEncoder().encode(JSON.stringify({ type: 'filament', name: 'Imported PETG', inherits: 'PETG', from: 'User', nozzle_temperature: ['245'] }));
    const r = await s.importFiles([{ name: 'x.json', data }]);
    expect(r.warnings).toEqual([]);
    expect(r.imported[0]).toMatchObject({ name: 'Imported PETG', parentId: sysId('V', 'PETG'), values: { nozzle_temperature: ['245'] } });
  });

  it('snapshot / load round-trips selection and unsaved overrides', async () => {
    const s = await make();
    await s.selectPrinter(sysId('V', 'P1'));
    s.setValue('process', 'wall_loops', '9');
    const snap = s.snapshot();
    const t = await make();
    await t.load(snap);
    expect(t.selection.printer).toBe(sysId('V', 'P1'));
    expect(t.value('process', 'wall_loops')).toBe('9');
    expect(t.resolve().wall_loops).toBe('9');
  });

  it('filament colours are project values: editable without dirtying the preset, reset on preset change, persisted', async () => {
    const s = await make();
    await s.selectPrinter(sysId('V', 'P1'));
    await s.selectFilament(0, sysId('V', 'PLA'));
    expect(s.filamentColour(0)).toBe('#00AE42');
    s.setFilamentColour(0, '#123456');
    expect(s.filamentColour(0)).toBe('#123456');
    expect(s.dirtyCount('filament', 0)).toBe(0);
    expect(s.resolve().filament_colour).toEqual(['#123456']);
    const t = await make();
    await t.load(s.snapshot());
    expect(t.filamentColour(0)).toBe('#123456');
    await s.selectFilament(0, sysId('V', 'PETG'));
    expect(s.filamentColour(0)).toBe('#F2754E'); // PETG has no colour of its own → schema default
    s.setFilamentColour(0, '');
    expect(s.project.filament_colour).toBeUndefined();
  });

  it('adds filaments with fresh colours and removes a slot keeping the others', async () => {
    const s = await make();
    await s.selectPrinter(sysId('V', 'P1'));
    await s.selectFilament(0, sysId('V', 'PLA'));
    await s.setFilamentCount(3);
    expect(s.selection.filaments).toHaveLength(3);
    const cols = [0, 1, 2].map((i) => s.filamentColour(i));
    expect(new Set(cols).size).toBe(3);
    await s.selectFilament(2, sysId('V', 'PETG'));
    s.setValue('filament', 'nozzle_temperature', ['260'], 2);
    await s.removeFilament(1);
    expect(s.selection.filaments).toEqual([sysId('V', 'PLA'), sysId('V', 'PETG')]);
    expect(s.value('filament', 'nozzle_temperature', 1)).toEqual(['260']);
    expect(s.resolve().filament_colour).toHaveLength(2);
  });

  it('plate type follows the printer default_bed_type unless the project picks one', async () => {
    const s = await make();
    expect(s.bedType()).toBe('Cool Plate');
    await s.selectPrinter(sysId('V', 'P1'));
    expect(s.bedType()).toBe('Textured PEI Plate'); // numeric BedType 4
    expect(s.resolve().curr_bed_type).toBe('Textured PEI Plate');
    s.setBedType('Engineering Plate');
    expect(s.resolve().curr_bed_type).toBe('Engineering Plate');
    expect(s.dirtyCount('printer')).toBe(0);
    s.setBedType(null);
    expect(s.bedType()).toBe('Textured PEI Plate');
  });
});

/**
 * Mixed filament slots in the presets store (Orca 2.5 native colour mixing)
 * and stored state that names a retired engine.
 */
import { describe, expect, it } from 'vitest';
import { activeEngine } from '../app/state';
import type { ConfigOptionDef, ConfigSchema } from '../engine/types';
import { sanitizePreferences } from '../app/preferences';
import { memoryKv } from './kv';
import { OrcaCatalog, sysId } from './orca/catalog';
import { _setEnginePresets, EnginePresets, presetsAutosaveData, presetsProjectSection } from './store';
import { UserPresetStore } from './userPresets';

function opt(type: ConfigOptionDef['type'], scope: ConfigOptionDef['scope'], dflt: string): ConfigOptionDef {
  return { type, label: '', fullLabel: '', category: '', tooltip: '', sidetext: '', mode: 'simple', min: null, max: null, default: dflt, scope };
}
const base: ConfigSchema['options'] = {
  layer_height: opt('float', 'object', '0.2'),
  nozzle_diameter: opt('floats', 'machine', '0.4'),
  nozzle_temperature: opt('ints', 'filament', '200'),
  filament_type: opt('strings', 'filament', 'PLA'),
  filament_settings_id: opt('strings', 'other', ''),
  default_filament_colour: opt('strings', 'filament', '""'),
  filament_colour: opt('strings', 'other', '"#F2754E"'),
  filament_multi_colour: opt('strings', 'filament', '""'),
  filament_colour_type: opt('strings', 'filament', '"1"'),
  flush_volumes_matrix: opt('floats', 'other', '0'),
  single_extruder_multi_material: opt('bool', 'machine', '1'),
};
const mixedKeys: ConfigSchema['options'] = {
  filament_is_mixed: opt('bools', 'other', '0'),
  filament_mixed_components: opt('strings', 'other', '""'),
  filament_mixed_sublayer_ratios: opt('strings', 'other', '""'),
  filament_mixed_gradient: opt('bools', 'other', '0'),
  filament_mixed_gradient_range: opt('strings', 'other', '""'),
  filament_mixed_gradient_curve: opt('strings', 'other', '""'),
  filament_mixed_gradient_per_part: opt('bools', 'other', '0'),
  enable_mixed_color_sublayer: opt('bool', 'object', '0'),
};
const schema25: ConfigSchema = { engine: 'orca', version: '2.5.0', options: { ...base, ...mixedKeys } };
const schema24: ConfigSchema = { engine: 'orca', version: '2.4.2', options: base };

const files: Record<string, unknown> = {
  '_index.json': ['V'],
  'V.json': {
    name: 'V', machine_model_list: [],
    machine_list: [{ name: 'P1', sub_path: 'm/P1.json' }],
    process_list: [],
    filament_list: [{ name: 'PLA', sub_path: 'f/PLA.json' }, { name: 'PETG', sub_path: 'f/PETG.json' }],
  },
  'V/m/P1.json': { type: 'machine', name: 'P1', instantiation: 'true', printer_model: 'M', default_filament_profile: ['PLA'] },
  'V/f/PLA.json': { type: 'filament', name: 'PLA', instantiation: 'true', nozzle_temperature: ['210'], default_filament_colour: ['#002185'], compatible_printers: ['P1'] },
  'V/f/PETG.json': { type: 'filament', name: 'PETG', instantiation: 'true', nozzle_temperature: ['240'], filament_type: ['PETG'], compatible_printers: ['P1'] },
};
const fetcher = async (url: string) => {
  const rel = decodeURIComponent(url.slice('/p/'.length));
  return rel in files ? JSON.parse(JSON.stringify(files[rel])) : null;
};

async function make(schema = schema25) {
  const s = new EnginePresets('orca', {
    schema, catalog: new OrcaCatalog({ base: '/p', fetcher }), users: new UserPresetStore('orca', memoryKv()), evaluate: null, persist: false,
  });
  await s.ready;
  await s.selectPrinter(sysId('V', 'P1'));
  await s.setFilamentCount(2);
  s.setFilamentColour(1, '#FCD300');
  return s;
}

const mix = { components: [1, 2], ratios: [50, 50], gradient: false, direction: 'ab' as const, curve: [], perPart: false };

describe('mixed filament slots', () => {
  it('are filament slots after the physical ones in the slice config', async () => {
    const s = await make();
    expect(s.mixedSupported()).toBe(true);
    s.project.flush_volumes_matrix = ['0', '100', '200', '0'];
    expect(s.setMixed([mix])).toBe(3);
    expect(s.filamentSlotCount()).toBe(3);
    expect(s.mixedFilaments()).toMatchObject([{ id: 3, components: [1, 2], ratios: [50, 50], color: '#2F8D38' }]);
    expect(s.filamentColour(2)).toBe('#2F8D38');

    const cfg = s.resolve();
    // The mixed slot carries a copy of its first component's preset.
    expect(cfg.nozzle_temperature).toEqual(['210', '210', '210']);
    expect(cfg.filament_settings_id).toEqual(['PLA', 'PLA', 'PLA']);
    expect(cfg.filament_colour).toEqual(['#002185', '#FCD300', '#2F8D38']);
    expect(cfg.filament_is_mixed).toEqual(['0', '0', '1']);
    expect(cfg.filament_mixed_components).toEqual(['', '', '1,2']);
    expect(cfg.filament_mixed_sublayer_ratios).toEqual(['', '', '0.5000,0.5000']);
    // Mixed slots never flush: zero rows / columns.
    expect(cfg.flush_volumes_matrix).toEqual(['0', '100', '0', '200', '0', '0', '0', '0', '0']);
    expect(cfg.nozzle_diameter).toEqual(['0.4']);
  });

  it('send a flush matrix sized for the physical filaments when the project has none', async () => {
    const s = await make();
    delete s.project.flush_volumes_matrix;
    expect(s.resolve().flush_volumes_matrix).toEqual(['0', '280', '280', '0']);
    s.project.flush_volumes_matrix = ['0', '100', '200', '0'];
    expect(s.resolve().flush_volumes_matrix).toEqual(['0', '100', '200', '0']);
  });

  it('stay at the tail when physical filaments are added, recoloured or removed', async () => {
    const s = await make();
    s.setMixed([mix, { ...mix, components: [2, 1], ratios: [30, 70] }]);
    await s.setFilamentCount(3);
    expect(s.selection.filaments).toHaveLength(3);
    expect(s.project.filament_is_mixed).toEqual(['0', '0', '0', '1', '1']);
    expect(s.mixedFilaments().map((m) => m.id)).toEqual([4, 5]);
    s.setFilamentColour(0, '#FF0000');
    expect(s.filamentColour(0)).toBe('#FF0000');
    expect(s.project.filament_is_mixed).toEqual(['0', '0', '0', '1', '1']);
    expect(s.mixedFilaments()[0].color).not.toBe('#2F8D38');
    // Deleting physical filament 1: mixes lose that component, later ones shift.
    await s.removeFilament(0);
    expect(s.mixedFilaments().map((m) => [m.id, m.components])).toEqual([[3, [0, 1]], [4, [1, 0]]]);
    expect(s.filamentColour(0)).toBe('#FCD300');
  });

  it('persist in the engine snapshot (autosave / project section) and load back', async () => {
    const a = await make();
    a.setMixed([{ ...mix, gradient: true, direction: 'ba', perPart: true }]);
    const snap = a.snapshot();
    expect(snap.project?.filament_mixed_gradient_range).toEqual(['', '', '0.1000,0.9000']);
    const b = new EnginePresets('orca', { schema: schema25, catalog: new OrcaCatalog({ base: '/p', fetcher }), users: new UserPresetStore('orca', memoryKv()), evaluate: null, persist: false });
    await b.load(snap);
    expect(b.mixedFilaments()).toMatchObject([{ id: 3, components: [1, 2], gradient: true, direction: 'ba', perPart: true }]);
    expect(b.resolve().filament_mixed_gradient_per_part).toEqual(['0', '0', '1']);
  });

  it('stay inert with an engine that has no mixed filaments (Orca 2.4 schema)', async () => {
    const s = await make(schema24);
    s.setMixed([mix]);
    expect(s.mixedSupported()).toBe(false);
    expect(s.mixedFilaments()).toEqual([]);
    expect(s.filamentSlotCount()).toBe(2);
    const cfg = s.resolve();
    expect(cfg.filament_colour).toEqual(['#002185', '#FCD300']);
    expect(cfg.filament_is_mixed).toBeUndefined();
    expect(cfg.nozzle_temperature).toEqual(['210', '210']);
  });

  it('cap physical + mixed slots at 32', async () => {
    const s = await make();
    s.setMixed([mix, mix]);
    await s.setFilamentCount(40);
    expect(s.selection.filaments).toHaveLength(30);
    expect(s.setMixed([mix, mix, mix])).toBe(32);
    expect(s.mixedDefs()).toHaveLength(2);
  });
});

describe('multi-colour / gradient filament colours (Orca 2.5 colour picker)', () => {
  it('stores colours, opacity and blending per slot and survives slot changes', async () => {
    const s = await make();
    const red = { r: 255, g: 0, b: 0, a: 128 }, blue = { r: 0, g: 0, b: 255, a: 255 };
    s.setFilamentColourSpec(0, { colours: [red, blue], gradient: true });
    expect(s.filamentColourSpec(0)).toEqual({ colours: [red, blue], gradient: true });
    expect(s.filamentColour(0)).toBe('#FF000080');
    expect(s.project.filament_multi_colour).toEqual(['#FF000080 #0000FF', '']);
    expect(s.project.filament_colour_type).toEqual(['0', '']);
    let cfg = s.resolve();
    expect(cfg.filament_colour).toEqual(['#FF000080', '#FCD300']);
    expect(cfg.filament_multi_colour).toEqual(['#FF000080 #0000FF', '#FCD300']);
    expect(cfg.filament_colour_type).toEqual(['0', '1']);
    // A mixed slot at the tail and a new physical slot keep the lists aligned.
    s.setMixed([mix]);
    await s.setFilamentCount(3);
    expect(s.filamentColourSpec(0).gradient).toBe(true);
    cfg = s.resolve();
    expect((cfg.filament_multi_colour as string[]).slice(0, 2)).toEqual(['#FF000080 #0000FF', '#FCD300']);
    expect((cfg.filament_colour_type as string[])[0]).toBe('0');
    // Back to the preset's colour.
    s.setFilamentColourSpec(0, null);
    expect(s.filamentColourSpec(0)).toEqual({ colours: [{ r: 0, g: 0x21, b: 0x85, a: 255 }], gradient: false });
    expect(s.project.filament_multi_colour).toBeUndefined();
  });
});

describe('stored state naming the removed Full Spectrum engine', () => {
  it('opens a project / autosave on Orca and drops the Full Spectrum section', async () => {
    const orca = await make();
    _setEnginePresets('orca', orca);
    try {
      activeEngine.value = 'preflight';
      const fsState = { selection: { printer: 'sys:Snapmaker/Snapmaker U1 (0.4 nozzle)', process: 'default', filaments: ['default'] }, overrides: { printer: {}, process: {}, filaments: [{}] }, installedPrinters: [], project: { mixed_filament_definitions: '1,2,1,0,50' } };
      await expect(presetsProjectSection.load({ version: 1, activeEngine: 'fullspectrum', engines: { fullspectrum: fsState } })).resolves.toBeUndefined();
      expect(activeEngine.value).toBe('orca');
      expect(orca.selection.printer).toBe(sysId('V', 'P1'));
      expect(orca.project.mixed_filament_definitions).toBeUndefined();

      const saved = presetsAutosaveData({ version: 1, activeEngine: 'fullspectrum', engines: { fullspectrum: fsState } });
      expect(saved.activeEngine).toBe('orca');
      expect(Object.keys(saved.engines)).toEqual(['orca']);
    } finally {
      _setEnginePresets('orca', null);
      activeEngine.value = 'orca';
    }
  });

  it('turns a Full Spectrum default-engine preference into Orca', () => {
    expect(sanitizePreferences({ defaultEngine: 'fullspectrum' }).defaultEngine).toBe('orca');
    expect(sanitizePreferences({ defaultEngine: 'last' }).defaultEngine).toBe('last');
    expect(sanitizePreferences({ defaultEngine: 'preflight' }).defaultEngine).toBe('preflight');
    expect(sanitizePreferences({ defaultEngine: 7 }).defaultEngine).toBe('last');
  });
});

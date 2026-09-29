import { describe, expect, it, vi } from 'vitest';
import { clearCompatCache, filterCompatible, type ConditionEvaluator } from './compat';
import { OrcaCatalog, sysId } from './orca/catalog';
import { PreflightCatalog } from './preflight/catalog';
import type { PresetInfo } from './types';

const tree: Record<string, unknown> = {
  '_index.json': ['Acme', 'OrcaFilamentLibrary'],
  'Acme.json': {
    name: 'Acme', version: '1',
    machine_model_list: [{ name: 'Acme One', sub_path: 'machine/Acme One.json' }],
    machine_list: [
      { name: 'fdm_machine_common', sub_path: 'machine/fdm_machine_common.json' },
      { name: 'Acme One 0.4 nozzle', sub_path: 'machine/Acme One 0.4 nozzle.json' },
      { name: 'Acme One 0.6 nozzle', sub_path: 'machine/Acme One 0.6 nozzle.json' },
    ],
    process_list: [
      { name: 'fdm_process_common', sub_path: 'process/fdm_process_common.json' },
      { name: '0.20mm Standard @Acme', sub_path: 'process/0.20mm Standard @Acme.json' },
      { name: '0.30mm Draft @Acme 0.6', sub_path: 'process/0.30mm Draft @Acme 0.6.json' },
      { name: '0.10mm Fine @Other', sub_path: 'process/0.10mm Fine @Other.json' },
    ],
    filament_list: [
      { name: 'Acme PLA @Acme One', sub_path: 'filament/Acme PLA @Acme One.json' },
      { name: 'Acme Generic PLA @Acme One', sub_path: 'filament/Acme Generic PLA @Acme One.json' },
    ],
  },
  'Acme/machine/Acme One.json': { type: 'machine_model', name: 'Acme One', nozzle_diameter: '0.4;0.6', family: 'Acme' },
  'Acme/machine/fdm_machine_common.json': { type: 'machine', name: 'fdm_machine_common', instantiation: 'false', printable_height: '250', nozzle_diameter: ['0.4'] },
  'Acme/machine/Acme One 0.4 nozzle.json': {
    type: 'machine', name: 'Acme One 0.4 nozzle', inherits: 'fdm_machine_common', instantiation: 'true',
    printer_model: 'Acme One', printer_variant: '0.4', default_print_profile: '0.20mm Standard @Acme', default_filament_profile: ['Acme PLA @Acme One'],
  },
  'Acme/machine/Acme One 0.6 nozzle.json': {
    type: 'machine', name: 'Acme One 0.6 nozzle', inherits: 'fdm_machine_common', instantiation: 'true',
    printer_model: 'Acme One', printer_variant: '0.6', nozzle_diameter: ['0.6'],
  },
  'Acme/process/fdm_process_common.json': { type: 'process', name: 'fdm_process_common', instantiation: 'false', layer_height: '0.2', wall_loops: '2' },
  'Acme/process/0.20mm Standard @Acme.json': {
    type: 'process', name: '0.20mm Standard @Acme', inherits: 'fdm_process_common', instantiation: 'true',
    compatible_printers: ['Acme One 0.4 nozzle', 'Acme One 0.6 nozzle'],
  },
  'Acme/process/0.30mm Draft @Acme 0.6.json': {
    type: 'process', name: '0.30mm Draft @Acme 0.6', inherits: 'fdm_process_common', instantiation: 'true', layer_height: '0.3',
    compatible_printers: [], compatible_printers_condition: 'nozzle_diameter[0]==0.6',
  },
  'Acme/process/0.10mm Fine @Other.json': {
    type: 'process', name: '0.10mm Fine @Other', inherits: 'fdm_process_common', instantiation: 'true', compatible_printers: ['Other Printer'],
  },
  'Acme/filament/Acme PLA @Acme One.json': {
    type: 'filament', name: 'Acme PLA @Acme One', inherits: 'fdm_filament_pla', instantiation: 'true', filament_vendor: ['Acme'],
    compatible_printers: ['Acme One 0.4 nozzle'], nozzle_temperature: ['215'],
  },
  'Acme/filament/Acme Generic PLA @Acme One.json': {
    type: 'filament', name: 'Acme Generic PLA @Acme One', inherits: 'fdm_filament_pla', instantiation: 'true',
    compatible_printers: ['Acme One 0.4 nozzle'],
  },
  'OrcaFilamentLibrary.json': {
    name: 'OrcaFilamentLibrary',
    machine_model_list: [], machine_list: [], process_list: [],
    filament_list: [
      { name: 'fdm_filament_common', sub_path: 'filament/base/fdm_filament_common.json' },
      { name: 'fdm_filament_pla', sub_path: 'filament/base/fdm_filament_pla.json' },
      { name: 'Generic PLA @System', sub_path: 'filament/Generic PLA @System.json' },
      { name: 'Acme Generic PLA @System', sub_path: 'filament/Acme Generic PLA @System.json' },
    ],
  },
  'OrcaFilamentLibrary/filament/base/fdm_filament_common.json': { type: 'filament', name: 'fdm_filament_common', instantiation: 'false', nozzle_temperature: ['200'], filament_type: ['PLA'] },
  'OrcaFilamentLibrary/filament/base/fdm_filament_pla.json': { type: 'filament', name: 'fdm_filament_pla', inherits: 'fdm_filament_common', instantiation: 'false', nozzle_temperature: ['210'] },
  'OrcaFilamentLibrary/filament/Generic PLA @System.json': { type: 'filament', name: 'Generic PLA @System', inherits: 'fdm_filament_pla', instantiation: 'true', filament_vendor: ['Generic'], compatible_printers: [] },
  'OrcaFilamentLibrary/filament/Acme Generic PLA @System.json': { type: 'filament', name: 'Acme Generic PLA @System', inherits: 'fdm_filament_pla', instantiation: 'true', compatible_printers: [] },
};

function fetcherFor(files: Record<string, unknown>, base = '/p') {
  const fn = vi.fn(async (url: string) => {
    const rel = decodeURIComponent(url.slice(base.length + 1));
    return rel in files ? JSON.parse(JSON.stringify(files[rel])) : null;
  });
  return fn;
}

describe('OrcaCatalog', () => {
  const make = () => new OrcaCatalog({ base: '/p', fetcher: fetcherFor(tree) });

  it('lists printer vendors (not the filament library) and models with nozzle variants', async () => {
    const c = make();
    expect((await c.vendors()).map((v) => v.id)).toEqual(['Acme']);
    const models = await c.models('Acme');
    expect(models).toHaveLength(1);
    expect(models[0].nozzles).toEqual(['0.4', '0.6']);
    expect(models[0].variants.map((v) => v.variant)).toEqual(['0.4', '0.6']);
    expect(models[0].variants.map((v) => v.preset.name)).not.toContain('fdm_machine_common');
  });

  it('resolves inherits within the vendor and falls back to the filament library', async () => {
    const c = make();
    const pla = await c.resolve(sysId('Acme', 'Acme PLA @Acme One'), 'filament');
    expect(pla).toMatchObject({ nozzle_temperature: ['215'], filament_type: ['PLA'], filament_vendor: ['Acme'] });
    expect(pla).not.toHaveProperty('inherits');
    const printer = await c.resolve(sysId('Acme', 'Acme One 0.6 nozzle'), 'printer');
    expect(printer).toMatchObject({ printable_height: '250', nozzle_diameter: ['0.6'] });
    const info = await c.info(sysId('Acme', 'Acme One 0.4 nozzle'), 'printer');
    expect(info).toMatchObject({ printerModel: 'Acme One', defaultProcess: '0.20mm Standard @Acme', defaultFilaments: ['Acme PLA @Acme One'] });
  });

  it('skips templates and marks library presets shadowed by a vendor alias', async () => {
    const c = make();
    const printer = (await c.info(sysId('Acme', 'Acme One 0.4 nozzle'), 'printer'))!;
    const fils = await c.candidates('filament', printer);
    const names = fils.map((f) => f.name);
    expect(names).not.toContain('fdm_filament_pla');
    expect(names).toEqual(expect.arrayContaining(['Acme PLA @Acme One', 'Generic PLA @System', 'Acme Generic PLA @System']));
    const shadowed = fils.find((f) => f.name === 'Acme Generic PLA @System')!;
    expect(shadowed.excludedPrinters).toEqual(['Acme One 0.4 nozzle']);
  });

  it('finds presets by name across vendors', async () => {
    const c = make();
    expect((await c.findByName('filament', 'Generic PLA @System'))?.id).toBe(sysId('OrcaFilamentLibrary', 'Generic PLA @System'));
    expect(await c.findByName('process', 'nope')).toBeNull();
  });
});

describe('compatibility filtering', () => {
  const c = new OrcaCatalog({ base: '/p', fetcher: fetcherFor(tree) });

  it('filters by compatible_printers lists, library exclusions and conditions', async () => {
    clearCompatCache();
    const p04 = (await c.info(sysId('Acme', 'Acme One 0.4 nozzle'), 'printer'))!;
    const p06 = (await c.info(sysId('Acme', 'Acme One 0.6 nozzle'), 'printer'))!;
    const evaluate = vi.fn<ConditionEvaluator>(async (expr, cfg) => {
      expect(expr).toBe('nozzle_diameter[0]==0.6');
      return (cfg.nozzle_diameter as string[])[0] === '0.6';
    });

    const procs04 = await filterCompatible(await c.candidates('process', p04), { printerName: p04.name, printerConfig: { nozzle_diameter: ['0.4'] }, evaluate });
    expect(procs04.map((p) => p.name)).toEqual(['0.20mm Standard @Acme']);
    const procs06 = await filterCompatible(await c.candidates('process', p06), { printerName: p06.name, printerConfig: { nozzle_diameter: ['0.6'] }, evaluate });
    expect(procs06.map((p) => p.name).sort()).toEqual(['0.20mm Standard @Acme', '0.30mm Draft @Acme 0.6']);

    const fils04 = await filterCompatible(await c.candidates('filament', p04), { printerName: p04.name, printerConfig: {}, evaluate });
    expect(fils04.map((f) => f.name).sort()).toEqual(['Acme Generic PLA @Acme One', 'Acme PLA @Acme One', 'Generic PLA @System']);
    const fils06 = await filterCompatible(await c.candidates('filament', p06), { printerName: p06.name, printerConfig: {}, evaluate });
    expect(fils06.map((f) => f.name).sort()).toEqual(['Acme Generic PLA @System', 'Generic PLA @System']);
  });

  it('evaluates each distinct condition once per config and treats null as compatible', async () => {
    clearCompatCache();
    const mk = (i: number, cond: string): PresetInfo => ({ id: `x${i}`, kind: 'process', name: `x${i}`, source: 'system', compatiblePrintersCondition: cond });
    const list = [mk(1, 'a'), mk(2, 'a'), mk(3, 'b'), mk(4, 'c')];
    const evaluate = vi.fn<ConditionEvaluator>(async (expr) => (expr === 'a' ? false : expr === 'b' ? true : null));
    const out = await filterCompatible(list, { printerName: 'P', printerConfig: {}, evaluate });
    expect(out.map((p) => p.id)).toEqual(['x3', 'x4']);
    expect(evaluate).toHaveBeenCalledTimes(3);
    await filterCompatible(list, { printerName: 'P', printerConfig: {}, evaluate });
    expect(evaluate).toHaveBeenCalledTimes(3); // cached
    // no evaluator (engine unavailable) → everything with a condition stays
    expect((await filterCompatible(list, { printerName: 'P', printerConfig: {}, evaluate: null })).length).toBe(4);
  });

  it('honours user printers through their system parent and compatible_prints', async () => {
    const f: PresetInfo = { id: 'f', kind: 'filament', name: 'f', source: 'system', compatiblePrinters: ['Sys'], compatiblePrints: ['Q'] };
    const ctx = { printerName: 'My printer', printerParentName: 'Sys', printerConfig: {}, evaluate: null };
    expect(await filterCompatible([f], { ...ctx, printName: 'Q' })).toHaveLength(1);
    expect(await filterCompatible([f], { ...ctx, printName: 'R' })).toHaveLength(0);
    expect(await filterCompatible([f], { ...ctx, printerParentName: undefined, printName: 'Q' })).toHaveLength(0);
  });
});

describe('PreflightCatalog', () => {
  const bundle = {
    fdm_filament_common: { type: 'filament', instantiation: 'false', nozzle_temperature: ['200'], hot_plate_temp: ['60'], filament_type: ['PLA'] },
    fdm_filament_pla: { type: 'filament', inherits: 'fdm_filament_common', instantiation: 'false', fan_max_speed: ['100'] },
    'Generic PLA': { type: 'filament', inherits: 'fdm_filament_pla', instantiation: 'true', name: 'Generic PLA', filament_flow_ratio: ['0.98'] },
  };
  const native = new Set(['temperature', 'bed_temperature', 'first_layer_bed_temperature', 'max_fan_speed', 'extrusion_multiplier', 'filament_type']);

  it('reads the flat Orca-format bundle and converts keys to preFlight', async () => {
    const c = new PreflightCatalog({ base: '/p', fetcher: fetcherFor({ 'orca_system_profiles.json': bundle }), isNativeKey: (k) => native.has(k) });
    expect(await c.vendors()).toEqual([]);
    const fils = await c.candidates('filament', null);
    expect(fils.map((f) => f.name)).toEqual(['Generic PLA']);
    expect(await c.candidates('process', null)).toEqual([]);
    const v = await c.resolve(fils[0].id, 'filament');
    expect(v).toEqual({ temperature: ['200'], bed_temperature: ['60'], max_fan_speed: ['100'], extrusion_multiplier: ['0.98'], filament_type: ['PLA'] });
  });
});

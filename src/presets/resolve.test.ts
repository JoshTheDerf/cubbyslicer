import { describe, expect, it } from 'vitest';
import type { ConfigOptionDef, ConfigSchema } from '../engine/types';
import { flattenInherits, flattenInheritsSync, type RawPreset } from './inherit';
import { bedTypeOf, resolveConfig, shapeValues, type ResolveInput } from './resolve';

function opt(type: ConfigOptionDef['type'], scope: ConfigOptionDef['scope'], dflt: string): ConfigOptionDef {
  return { type, label: '', fullLabel: '', category: '', tooltip: '', sidetext: '', mode: 'simple', min: null, max: null, default: dflt, scope };
}

const schema: ConfigSchema = {
  engine: 'orca', version: 'test',
  options: {
    layer_height: opt('float', 'object', '0.2'),
    wall_loops: opt('int', 'object', '2'),
    nozzle_diameter: opt('floats', 'machine', '0.4'),
    printable_area: opt('points', 'machine', '0x0,200x0,200x200,0x200'),
    retraction_length: opt('floats', 'machine', '0.8'),
    nozzle_temperature: opt('ints', 'filament', '200'),
    filament_type: opt('strings', 'filament', 'PLA'),
    default_filament_colour: opt('strings', 'filament', '""'),
    filament_colour: opt('strings', 'other', '"#F2754E"'),
    filament_settings_id: opt('strings', 'other', '""'),
    print_settings_id: opt('string', 'other', ''),
    printer_settings_id: opt('string', 'other', ''),
    current_layer: opt('int', 'other', '0'),
    inherits: opt('string', 'print', ''),
  },
};

describe('inheritance', () => {
  const bundle: Record<string, RawPreset> = {
    root: { name: 'root', instantiation: 'false', a: '1', b: '1', c: ['1'] },
    mid: { name: 'mid', inherits: 'root', instantiation: 'false', b: '2' },
    leaf: { name: 'leaf', inherits: 'mid', instantiation: 'true', c: ['3', '3'], from: 'system' },
    loopA: { name: 'loopA', inherits: 'loopB', x: 'a' },
    loopB: { name: 'loopB', inherits: 'loopA', x: 'b', y: 'b' },
    orphan: { name: 'orphan', inherits: 'nope', z: '1' },
  };
  it('flattens root → leaf with the child winning', async () => {
    const r = await flattenInherits(bundle.leaf, (n) => bundle[n]);
    expect(r.chain).toEqual(['leaf', 'mid', 'root']);
    expect(r.values).toEqual({ a: '1', b: '2', c: ['3', '3'] }); // structural keys dropped
  });
  it('guards against cycles and reports missing parents', () => {
    const cyc = flattenInheritsSync(bundle.loopA, (n) => bundle[n]);
    expect(cyc.values).toEqual({ x: 'a', y: 'b' });
    const miss = flattenInheritsSync(bundle.orphan, (n) => bundle[n]);
    expect(miss.missing).toBe('nope');
    expect(miss.values).toEqual({ z: '1' });
  });
});

describe('resolveConfig', () => {
  it('layers defaults ← printer ← process ← filament ← overrides', () => {
    const cfg = resolveConfig({
      schema,
      printer: { nozzle_diameter: ['0.6'] },
      process: { layer_height: '0.28', wall_loops: '3' },
      filaments: [{ nozzle_temperature: ['215'], filament_type: ['PETG'] }],
      overrides: { process: { wall_loops: '4' }, filaments: [{ nozzle_temperature: ['220'] }] },
      names: { printer: 'P', process: 'Q', filaments: ['F'] },
    });
    expect(cfg.layer_height).toBe('0.28');
    expect(cfg.wall_loops).toBe('4');
    expect(cfg.nozzle_diameter).toEqual(['0.6']);
    expect(cfg.printable_area).toEqual(['0x0', '200x0', '200x200', '0x200']);
    expect(cfg.nozzle_temperature).toEqual(['220']);
    expect(cfg.filament_type).toEqual(['PETG']);
    expect(cfg.print_settings_id).toBe('Q');
    expect(cfg.filament_settings_id).toEqual(['F']);
    expect(cfg).not.toHaveProperty('current_layer'); // placeholders are not config
    expect(cfg).not.toHaveProperty('inherits');
  });

  it('merges multiple filaments element-wise (per-extruder vectors)', () => {
    const cfg = resolveConfig({
      schema,
      printer: { nozzle_diameter: ['0.4', '0.4'], retraction_length: ['0.8', '1.2'] },
      process: {},
      filaments: [
        { nozzle_temperature: ['210'], filament_type: ['PLA'], default_filament_colour: ['#FF0000'] },
        { filament_type: ['TPU'] },
      ],
      overrides: { filaments: [{}, { nozzle_temperature: ['230'] }] },
    });
    expect(cfg.nozzle_temperature).toEqual(['210', '230']);
    expect(cfg.filament_type).toEqual(['PLA', 'TPU']);
    expect(cfg.retraction_length).toEqual(['0.8', '1.2']); // printer vectors untouched
    expect(cfg.filament_colour).toEqual(['#FF0000', '#F2754E']);
  });

  it('fills missing filament values from the default for each slot', () => {
    const cfg = resolveConfig({ schema, printer: {}, process: {}, filaments: [{}, {}, { nozzle_temperature: ['250'] }] });
    expect(cfg.nozzle_temperature).toEqual(['200', '200', '250']);
  });

  it('passes a single filament vector through unchanged', () => {
    const cfg = resolveConfig({ schema, printer: {}, process: {}, filaments: [{ nozzle_temperature: ['220', '225'] }] });
    expect(cfg.nozzle_temperature).toEqual(['220', '225']);
  });

  it('shapes raw preset values to the schema', () => {
    expect(shapeValues(schema, { layer_height: ['0.1'], nozzle_diameter: '0.4', unknown_key: '1' }))
      .toEqual({ layer_height: '0.1', nozzle_diameter: ['0.4'] });
  });
});

describe('project-level values', () => {
  const bedSchema: ConfigSchema = {
    ...schema,
    options: { ...schema.options, default_bed_type: opt('string', 'machine', ''), curr_bed_type: { ...opt('enum', 'other', 'Cool Plate'), enumValues: ['Cool Plate', 'Engineering Plate', 'High Temp Plate'] } },
  };
  it('maps default_bed_type names and 1-based numbers', () => {
    expect(bedTypeOf(bedSchema, 'High Temp Plate')).toBe('High Temp Plate');
    expect(bedTypeOf(bedSchema, '2')).toBe('Engineering Plate');
    expect(bedTypeOf(bedSchema, '9')).toBeNull();
    expect(bedTypeOf(bedSchema, '')).toBeNull();
  });
  it('applies the plate type and per-slot colours from the project', () => {
    const base: ResolveInput = { schema: bedSchema, printer: { default_bed_type: '3' }, process: {}, filaments: [{ default_filament_colour: ['#111111'] }, {}] };
    expect(resolveConfig(base).curr_bed_type).toBe('High Temp Plate');
    const cfg = resolveConfig({ ...base, project: { curr_bed_type: 'Cool Plate', filament_colour: ['', '#222222'] } });
    expect(cfg.curr_bed_type).toBe('Cool Plate');
    expect(cfg.filament_colour).toEqual(['#111111', '#222222']);
  });
});

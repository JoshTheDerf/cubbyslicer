/**
 * Extruder variants against real OrcaSlicer 2.5.0 profiles (BBL H2D / H2C /
 * X2D / A2L, copied from resources/profiles/BBL at tag v2.5.0 into
 * __fixtures__/orca25 with the `include` templates they name), resolved by
 * the catalog as desktop does (inherits, then include, then own keys).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigSchema, FlatConfig } from '../engine/types';
import { filamentVariantValue, variantColumn, variantIndex, variantSelector, variantValue } from '../lib/configValue';
import schemaJson from '../settings/__fixtures__/orca-schema.sample.json';
import { OrcaCatalog, sysId } from './orca/catalog';
import { resolveConfig, shapeValues } from './resolve';
import type { PresetKind, PresetValues } from './types';
import {
  applyChildOverParent, extruderVariants, findVariantIndex, hasVariants, mapVariantIndices, normalizeVariantLengths, variantKey, withVariantLayout,
} from './variants';

const schema = schemaJson as unknown as ConfigSchema;
const DIR = join(__dirname, '__fixtures__', 'orca25');
const DIRS: Record<PresetKind, string> = { printer: 'machine', process: 'process', filament: 'filament' };

// The fixtures as a one-vendor tree, resolved by the real catalog (inherits + include).
const list = (sub: string) => readdirSync(join(DIR, sub)).map((f) => ({ name: f.replace(/\.json$/, ''), sub_path: `${sub}/${f}` }));
const files: Record<string, unknown> = {
  '_index.json': ['BBL'],
  'BBL.json': { name: 'BBL', machine_model_list: [], machine_list: list('machine'), process_list: list('process'), filament_list: list('filament') },
};
for (const sub of Object.values(DIRS)) for (const f of readdirSync(join(DIR, sub))) files[`BBL/${sub}/${f}`] = JSON.parse(readFileSync(join(DIR, sub, f), 'utf8'));
const catalog = new OrcaCatalog({ base: '/p', bundles: false, fetcher: async (url) => {
  const rel = decodeURIComponent(url.slice('/p/'.length));
  return rel in files ? JSON.parse(JSON.stringify(files[rel])) : null;
} });
const resolved = new Map<string, PresetValues>();
for (const kind of Object.keys(DIRS) as PresetKind[]) {
  for (const { name } of list(DIRS[kind])) {
    const v = await catalog.resolve(sysId('BBL', name), kind);
    if (v) resolved.set(`${kind}|${name}`, v);
  }
}

function load(kind: PresetKind, name: string): PresetValues {
  const v = resolved.get(`${kind}|${name}`);
  expect(v, name).toBeDefined();
  return normalizeVariantLengths(shapeValues(schema, v!), schema);
}

/** A slice config of printer + process + one filament per extruder (what the store resolves). */
function config(printer: string, process: string, filaments: string[], project: PresetValues = {}): FlatConfig {
  return resolveConfig({ schema, printer: load('printer', printer), process: load('process', process), filaments: filaments.map((f) => load('filament', f)), project });
}

describe('variant keys', () => {
  it('come from Orca\'s lists when the schema has no `variant` field (vectors only)', () => {
    expect(variantKey(schema, 'outer_wall_speed')).toEqual({ family: 'print', stride: 1 });
    expect(variantKey(schema, 'machine_max_speed_x')).toEqual({ family: 'printer', stride: 2 });
    expect(variantKey(schema, 'nozzle_temperature')).toEqual({ family: 'filament', stride: 1 });
    expect(variantKey(schema, 'layer_height')).toBeNull();
    // A 2.4 schema has the process speeds as scalars: not per-variant.
    const old = { ...schema, options: { ...schema.options, outer_wall_speed: { ...schema.options.outer_wall_speed, type: 'float' as const } } };
    expect(variantKey(old, 'outer_wall_speed')).toBeNull();
  });
  it('follow the schema once the engine tags them', () => {
    const tagged = { ...schema, options: { ...schema.options, outer_wall_speed: { ...schema.options.outer_wall_speed, variant: 'print' as const } } };
    expect(variantKey(tagged, 'outer_wall_speed')).toEqual({ family: 'print', stride: 1 });
    expect(variantKey(tagged, 'inner_wall_speed')).toBeNull();
  });
});

describe('Bambu Lab H2D (2 extruders, 3 + 4 variants)', () => {
  const printer = load('printer', 'Bambu Lab H2D 0.4 nozzle');
  const process = load('process', '0.20mm Standard @BBL H2D');

  it('sizes inherited vectors to the variant table (extend_default_config_length)', () => {
    // fdm_process_dual_common has 4 columns; the H2D process 7 (and restates every per-variant key).
    expect(process.print_extruder_variant).toHaveLength(7);
    expect(process.travel_speed).toEqual(new Array(7).fill('1000'));
    // A key left at a parent's width is padded with its first value; a longer one is cut.
    const short = normalizeVariantLengths({ ...process, bridge_speed: ['40', '41', '42', '43'], gap_infill_speed: new Array(9).fill('9') }, schema);
    expect(short.bridge_speed).toEqual(['40', '41', '42', '43', '40', '40', '40']);
    expect(short.gap_infill_speed).toHaveLength(7);
    expect(process.outer_wall_speed).toEqual(['200', '500', '500', '200', '500', '500', '500']);
    // Printer: 7 columns; machine limits two values per column.
    expect(printer.retraction_length).toHaveLength(7);
    expect(printer.machine_max_speed_x).toHaveLength(14);
  });

  it('lists each extruder\'s flow types', () => {
    expect(extruderVariants(printer)).toEqual([
      { type: 'Direct Drive', volumeTypes: ['Standard', 'High Flow', 'E3D High Flow'], multiNozzle: false },
      { type: 'Direct Drive', volumeTypes: ['Standard', 'High Flow', 'TPU High Flow', 'E3D High Flow'], multiNozzle: false },
    ]);
    expect(hasVariants(printer)).toBe(true);
  });

  it('variantIndex / variantValue pick the active variant per extruder', () => {
    const cfg = config('Bambu Lab H2D 0.4 nozzle', '0.20mm Standard @BBL H2D', ['Bambu PLA Basic @BBL H2D', 'Bambu PLA Basic @BBL H2D'],
      { nozzle_volume_type: ['High Flow', 'TPU High Flow'] });
    expect(variantIndex(cfg, 'print', variantSelector(cfg, 0))).toBe(1);
    expect(variantIndex(cfg, 'print', variantSelector(cfg, 1))).toBe(5);
    expect(variantValue(cfg, 'inner_wall_speed', 'print', 0)).toBe('600');
    expect(variantIndex(cfg, 'printer', variantSelector(cfg, 1))).toBe(5);
    expect(variantIndex(cfg, 'printer', variantSelector(cfg, 1), 2)).toBe(10);
    expect(variantValue(cfg, 'nozzle_volume', 'printer', 1)).toBe('148');
    const std = config('Bambu Lab H2D 0.4 nozzle', '0.20mm Standard @BBL H2D', ['Bambu PLA Basic @BBL H2D']);
    expect(variantValue(std, 'outer_wall_speed', 'print', 0)).toBe('200');
    expect(variantValue(std, 'outer_wall_speed', 'print', 1)).toBe('200');
    expect(variantValue(std, 'nozzle_volume', 'printer', 1)).toBe('145');
  });

  it('a variant the extruder lacks falls back to its first column, not column 0 of extruder 1', () => {
    const cfg = config('Bambu Lab H2D 0.4 nozzle', '0.20mm Standard @BBL H2D', ['Bambu PLA Basic @BBL H2D'], { nozzle_volume_type: ['TPU High Flow', 'Standard'] });
    expect(variantIndex(cfg, 'print', variantSelector(cfg, 0))).toBe(-1);
    expect(variantColumn(cfg, 'print', variantSelector(cfg, 0))).toBe(0);
    const right = { ...cfg, nozzle_volume_type: ['Standard', 'Extra High Flow'] };
    expect(variantColumn(right, 'print', variantSelector(right, 1))).toBe(3);
  });

  it('filament vectors are concatenated per filament with filament_self_index', () => {
    const cfg = config('Bambu Lab H2D 0.4 nozzle', '0.20mm Standard @BBL H2D', ['Bambu PLA Basic @BBL H2D', 'Bambu TPU 85A @BBL H2D'],
      { nozzle_volume_type: ['Standard', 'TPU High Flow'], filament_map: ['1', '2'] });
    // PLA Basic: 3 columns from its include template (fdm_filament_template_direct_dual_e3d). TPU 85A has 4.
    expect(cfg.filament_extruder_variant).toEqual(['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive E3D High Flow',
      'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU High Flow', 'Direct Drive E3D High Flow']);
    expect(cfg.filament_self_index).toEqual(['1', '1', '1', '2', '2', '2', '2']);
    expect(cfg.nozzle_temperature).toEqual(['220', '220', '220', '225', '225', '235', '225']);
    expect(cfg.filament_max_volumetric_speed).toEqual(['25', '40', '25', ...cfg.filament_max_volumetric_speed!.slice(3)]);
    expect(cfg.filament_max_volumetric_speed).toHaveLength(7);
    expect(filamentVariantValue(cfg, 'nozzle_temperature', 1)).toBe('235');
    expect(filamentVariantValue(cfg, 'nozzle_temperature', 0)).toBe('220');
    // Non-variant filament keys stay one per filament.
    expect(cfg.filament_type).toEqual(['PLA', 'TPU']);
  });
});

describe('Bambu Lab H2C (nozzle rack on the right extruder)', () => {
  const printer = load('printer', 'Bambu Lab H2C 0.4 nozzle');
  it('offers Hybrid on the multi-nozzle extruder; Hybrid reads the Standard column', () => {
    const ex = extruderVariants(printer);
    expect(ex[1]).toEqual({ type: 'Direct Drive', volumeTypes: ['Standard', 'High Flow'], multiNozzle: true });
    expect(ex[0].multiNozzle).toBe(false);
    const cfg = config('Bambu Lab H2C 0.4 nozzle', '0.20mm Standard @BBL H2C', ['Bambu PLA Basic @BBL H2D'], { nozzle_volume_type: ['Standard', 'Hybrid'] });
    expect(variantIndex(cfg, 'print', variantSelector(cfg, 1))).toBe(3);
    expect(variantValue(cfg, 'outer_wall_speed', 'print', 1)).toBe('200');
  });
  it('a Hybrid extruder takes each filament\'s own flow type (filament_volume_map)', () => {
    const cfg = config('Bambu Lab H2C 0.4 nozzle', '0.20mm Standard @BBL H2C', ['Bambu TPU 85A @BBL H2D'],
      { nozzle_volume_type: ['Standard', 'Hybrid'], filament_map: ['2'], filament_volume_map: ['1'] });
    expect(filamentVariantValue(cfg, 'nozzle_temperature', 0)).toBe('225');
    expect(filamentVariantValue({ ...cfg, filament_volume_map: ['3'] }, 'nozzle_temperature', 0)).toBe('235');
  });
});

describe('include templates (PresetBundle::resolve_vendor_preset)', () => {
  const raw = (sub: string, name: string) => files[`BBL/${sub}/${name}.json`] as Record<string, unknown>;
  it('an H2C PLA Basic filament gets its variant names from fdm_filament_template_direct_dual_e3d', () => {
    const f = load('filament', 'Bambu PLA Basic @BBL H2C');
    expect(f.filament_extruder_variant).toEqual(['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive E3D High Flow']);
    // Own keys stay on top of the template; template-only keys come through; every variant vector is 3 wide.
    expect(f.filament_max_volumetric_speed).toEqual(['25', '40', '25']);
    expect(f.filament_flush_temp).toEqual(['0', '0', '0']);
    for (const [k, v] of Object.entries(f)) if (variantKey(schema, k)?.family === 'filament') expect(v, k).toHaveLength(3);
    expect(f.include).toBeUndefined();
  });
  it('three H2C PLA filaments read their own columns (filament 3 on High Flow)', () => {
    const cfg = config('Bambu Lab H2C 0.4 nozzle', '0.20mm Standard @BBL H2C', Array(3).fill('Bambu PLA Basic @BBL H2C'),
      { nozzle_volume_type: ['Standard', 'Hybrid'], filament_map: ['1', '2', '2'], filament_volume_map: ['0', '0', '1'] });
    expect(cfg.filament_extruder_variant).toHaveLength(9);
    expect(cfg.filament_self_index).toEqual(['1', '1', '1', '2', '2', '2', '3', '3', '3']);
    expect([0, 1, 2].map((i) => filamentVariantValue(cfg, 'filament_max_volumetric_speed', i))).toEqual(['25', '25', '40']);
  });
  it.each(['Bambu Lab H2C 0.4 nozzle', 'Bambu Lab X1 Carbon 0.4 nozzle'])('%s resolves its own machine G-code, not fdm_machine_common\'s', (name) => {
    const p = load('printer', name);
    for (const key of ['machine_start_gcode', 'machine_end_gcode', 'change_filament_gcode', 'time_lapse_gcode', 'layer_change_gcode']) {
      expect(p[key], key).toBe(raw('machine', `${name} template ${key}`)[key]);
      expect(p[key], key).not.toBe(raw('machine', 'fdm_machine_common')[key]);
    }
    expect(p.include).toBeUndefined();
  });
  it('templates are not offered as printers or filaments', async () => {
    const printers = (await catalog.models('BBL')).flatMap((m) => m.variants.map((v) => v.preset.name));
    expect(printers.some((n) => n.includes('template'))).toBe(false);
    const fil = await catalog.candidates('filament', await catalog.info(sysId('BBL', 'Bambu Lab H2C 0.4 nozzle'), 'printer'));
    expect(fil.some((p) => p.name.startsWith('fdm_filament_template'))).toBe(false);
  });
  it('a parent is padded before a child includes more columns; a missing include is skipped', async () => {
    const tree: Record<string, unknown> = {
      '_index.json': ['V'],
      'V.json': { name: 'V', machine_model_list: [], machine_list: [], process_list: [], filament_list: [
        { name: 'base', sub_path: 'f/base.json' }, { name: 'tpl', sub_path: 'f/tpl.json' }, { name: 'leaf', sub_path: 'f/leaf.json' },
      ] },
      'V/f/base.json': { name: 'base', instantiation: 'false', filament_extruder_variant: ['Direct Drive Standard'], nozzle_temperature: ['200', '210'], fan_max_speed: ['50', '60'] },
      'V/f/tpl.json': { name: 'tpl', instantiation: 'false', filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'], fan_max_speed: ['70', '80'] },
      'V/f/leaf.json': { name: 'leaf', inherits: 'base', include: ['tpl', 'nope'], instantiation: 'true', filament_type: ['PLA'] },
    };
    const c = new OrcaCatalog({ base: '/v', bundles: false, fetcher: async (url) => tree[decodeURIComponent(url.slice(3))] ?? null });
    const v = await c.resolve(sysId('V', 'leaf'), 'filament');
    // base is cut to its single column first (desktop's retained parent), then padded with that value.
    expect(v?.nozzle_temperature).toEqual(['200', '200']);
    expect(v?.fan_max_speed).toEqual(['70', '80']);
    expect(v?.filament_type).toEqual(['PLA']);
  });
});

describe('Bambu Lab X2D (Direct Drive + Bowden)', () => {
  it('matches the extruder type as well as the flow type', () => {
    const cfg = config('Bambu Lab X2D 0.4 nozzle', '0.20mm Standard @BBL X2D', ['Bambu PLA Basic @BBL H2D']);
    expect(cfg.extruder_type).toEqual(['Direct Drive', 'Bowden']);
    expect(variantIndex(cfg, 'print', variantSelector(cfg, 1))).toBe(3);
    expect(variantValue(cfg, 'outer_wall_speed', 'print', 1)).toBe('50');
    expect(variantValue(cfg, 'outer_wall_speed', 'print', 0)).toBe('200');
  });
});

describe('Bambu Lab A2L and 2.4-era single-extruder profiles', () => {
  it('a single-variant printer keeps single values', () => {
    const p = load('printer', 'Bambu Lab A2L 0.4 nozzle');
    expect(hasVariants(p)).toBe(false);
    expect(p.retraction_length).toHaveLength(1);
    expect(extruderVariants(p)).toHaveLength(1);
  });
  it('no variant table: the extruder element (unchanged behaviour)', () => {
    const cfg: FlatConfig = { outer_wall_speed: ['120'], retraction_length: ['0.8', '1.2'], nozzle_diameter: ['0.4', '0.4'] };
    expect(variantValue(cfg, 'retraction_length', 'printer', 1)).toBe('1.2');
    expect(variantValue(cfg, 'outer_wall_speed', 'print', 1)).toBe('120');
    const r = resolveConfig({ schema, printer: {}, process: {}, filaments: [{ nozzle_temperature: ['210'] }] });
    expect(r.filament_self_index).toEqual(['1']);
    expect(r.nozzle_temperature).toEqual(['210']);
  });
});

describe('user presets over their parent (update_diff_values_to_child_config)', () => {
  const parent = load('process', '0.20mm Standard @BBL H2D');
  it('a 2.4-era user preset with one value keeps it on its own extruder\'s first variant; other columns inherit', () => {
    const child = shapeValues(schema, { outer_wall_speed: ['150'] });
    const merged = applyChildOverParent(parent, child, schema, 'process');
    // No variant layout in the child: its single column belongs to extruder 1's first variant… and only maps there.
    expect(merged.outer_wall_speed).toEqual(['150', '150', '150', '200', '500', '500', '500']);
    expect(merged.print_extruder_variant).toEqual(parent.print_extruder_variant);
  });
  it('a user preset saved with fewer variants keeps its values on the variants it listed; new ones take its first value of the same extruder', () => {
    const child = shapeValues(schema, {
      print_extruder_id: ['1', '1', '2', '2'],
      print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
      outer_wall_speed: ['100', '300', '110', '310'],
    });
    const merged = applyChildOverParent(parent, child, schema, 'process');
    expect(merged.outer_wall_speed).toEqual(['100', '300', '100', '110', '310', '110', '110']);
    expect(merged.print_extruder_variant).toHaveLength(7);
  });
  it('non-variant keys are a plain overlay', () => {
    const merged = applyChildOverParent(parent, { layer_height: '0.16' }, schema, 'process');
    expect(merged.layer_height).toBe('0.16');
  });
  it('saving writes the variant layout with per-variant values', () => {
    const diff = withVariantLayout({ outer_wall_speed: ['1', '2', '3', '4', '5', '6', '7'] }, parent, schema, 'process');
    expect(diff.print_extruder_id).toEqual(parent.print_extruder_id);
    expect(diff.print_extruder_variant).toEqual(parent.print_extruder_variant);
    expect(withVariantLayout({ layer_height: '0.1' }, parent, schema, 'process')).toEqual({ layer_height: '0.1' });
  });
  it('find_variant_index / map_variant_indices', () => {
    expect(findVariantIndex('Direct Drive High Flow', 2, ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard'], [1, 1, 2])).toBe(2);
    expect(findVariantIndex('x', 1, [], [])).toBe(0);
    expect(mapVariantIndices(['A', 'B'], [1, 2], ['B', 'A'], [2, 1])).toEqual([1, 0]);
  });
});

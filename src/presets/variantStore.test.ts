/**
 * The presets store on a real 2.5.0 dual-nozzle profile (Bambu Lab H2D, from
 * __fixtures__/orca25): nozzle flow types, per-variant editing, user presets
 * keeping their columns, and the slice config's variant shape.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigSchema } from '../engine/types';
import { asList, variantValue } from '../lib/configValue';
import schemaJson from '../settings/__fixtures__/orca-schema.sample.json';
import { memoryKv } from './kv';
import { OrcaCatalog, sysId } from './orca/catalog';
import { EnginePresets, variantEdit } from './store';
import { UserPresetStore } from './userPresets';

const schema = schemaJson as unknown as ConfigSchema;
const DIR = join(__dirname, '__fixtures__', 'orca25');
const list = (sub: string) => readdirSync(join(DIR, sub)).map((f) => ({ name: f.replace(/\.json$/, ''), sub_path: `${sub}/${f}` }));
const files: Record<string, unknown> = {
  '_index.json': ['BBL'],
  'BBL.json': { name: 'BBL', machine_model_list: [], machine_list: list('machine'), process_list: list('process'), filament_list: list('filament') },
};
for (const sub of ['machine', 'process', 'filament']) {
  for (const f of readdirSync(join(DIR, sub))) {
    const raw = JSON.parse(readFileSync(join(DIR, sub, f), 'utf8'));
    // Fixtures are a slice of the vendor: keep the H2D / H2C presets compatible with each other only.
    if (sub !== 'machine' && raw.instantiation === 'true') raw.compatible_printers = ['Bambu Lab H2D 0.4 nozzle', 'Bambu Lab H2C 0.4 nozzle'];
    files[`BBL/${sub}/${f}`] = raw;
  }
}
const fetcher = async (url: string) => {
  const rel = decodeURIComponent(url.slice('/p/'.length));
  return rel in files ? JSON.parse(JSON.stringify(files[rel])) : null;
};

async function make() {
  const s = new EnginePresets('orca', {
    schema, catalog: new OrcaCatalog({ base: '/p', fetcher, bundles: false }), users: new UserPresetStore('orca', memoryKv()), evaluate: null, persist: false,
  });
  await s.ready;
  s.selection.process = sysId('BBL', '0.20mm Standard @BBL H2D');
  s.selection.filaments = [sysId('BBL', 'Bambu PLA Basic @BBL H2D'), sysId('BBL', 'Bambu TPU 85A @BBL H2D')];
  await s.selectPrinter(sysId('BBL', 'Bambu Lab H2D 0.4 nozzle'));
  s.selection.process = sysId('BBL', '0.20mm Standard @BBL H2D');
  s.selection.filaments = [sysId('BBL', 'Bambu PLA Basic @BBL H2D'), sysId('BBL', 'Bambu TPU 85A @BBL H2D')];
  await s.refresh();
  return s;
}

describe('presets store with extruder variants (H2D)', () => {
  it('starts each extruder on the printer\'s default flow type and sends the variant shape to the engine', async () => {
    const s = await make();
    expect(s.infos.value.printer.name).toBe('Bambu Lab H2D 0.4 nozzle');
    expect(s.infos.value.process.name).toBe('0.20mm Standard @BBL H2D');
    expect(s.nozzleVolumeTypes()).toEqual(['Standard', 'Standard']);
    const cfg = s.resolve();
    expect(cfg.nozzle_volume_type).toEqual(['Standard', 'Standard']);
    expect(cfg.print_extruder_variant).toHaveLength(7);
    expect(cfg.outer_wall_speed).toHaveLength(7);
    expect(cfg.machine_max_speed_x).toHaveLength(14);
    // PLA Basic: 3 columns (its include template), TPU 85A: 4.
    expect(cfg.filament_self_index).toEqual(['1', '1', '1', '2', '2', '2', '2']);
    s.setNozzleVolumeType(0, 'High Flow');
    expect(variantValue(s.resolve(), 'outer_wall_speed', 'print', 0)).toBe('500');
  });

  it('edits the selected extruder\'s variant column only, with a per-column modified marker', async () => {
    const s = await make();
    variantEdit.extruder = 1;
    s.setNozzleVolumeType(1, 'High Flow');
    const el = s.variantElement('process', 'outer_wall_speed')!;
    expect(el).toBe(4);
    s.setVariantElement('process', 'outer_wall_speed', 0, el, '444');
    expect(s.value('process', 'outer_wall_speed')).toEqual(['200', '500', '500', '200', '444', '500', '500']);
    expect(s.isModified('process', 'outer_wall_speed', 0, 4)).toBe(true);
    expect(s.isModified('process', 'outer_wall_speed', 0, 1)).toBe(false);
    expect(s.variantTags('process').map((t) => [t.label, t.modified])).toEqual([['Left SF', false], ['Right HF', true]]);
    // Sync copies the right nozzle's change to the left one's High Flow column.
    variantEdit.extruder = 1;
    expect(s.syncVariantColumns('process')).toBe(1);
    expect(s.value('process', 'outer_wall_speed')).toEqual(['200', '444', '500', '200', '444', '500', '500']);
    s.revertVariantElement('process', 'outer_wall_speed', 0, 4);
    s.revertVariantElement('process', 'outer_wall_speed', 0, 1);
    expect(s.isModified('process', 'outer_wall_speed')).toBe(false);
    variantEdit.extruder = 0;
  });

  it('a single value applies to every variant', async () => {
    const s = await make();
    s.setValue('process', 'travel_speed', '300');
    expect(s.value('process', 'travel_speed')).toEqual(new Array(7).fill('300'));
  });

  it('a saved user preset keeps its per-variant values and layout', async () => {
    const s = await make();
    s.setVariantElement('process', 'inner_wall_speed', 0, 3, '123');
    const u = await s.saveAs('process', 'My H2D');
    expect(u.values.print_extruder_variant).toHaveLength(7);
    expect(u.values.inner_wall_speed).toEqual(['300', '600', '600', '123', '600', '600', '600']);
    const r = await s.resolvePreset('process', u.id);
    expect(r?.values.inner_wall_speed).toEqual(['300', '600', '600', '123', '600', '600', '600']);
    expect(r?.values.outer_wall_speed).toHaveLength(7);
  });

  it('filament tab: switch over the filament\'s own variant columns', async () => {
    const s = await make();
    expect(s.variantTags('filament', 1).map((t) => t.label)).toEqual(['Direct Drive SF', 'Direct Drive HF', 'Direct Drive TPU HF', 'Direct Drive E3D HF']);
    expect(s.variantTags('filament', 0).map((t) => t.label)).toEqual(['Direct Drive SF', 'Direct Drive HF', 'Direct Drive E3D HF']);
    variantEdit.filamentColumn = 2;
    expect(s.variantElement('filament', 'nozzle_temperature', 1)).toBe(2);
    variantEdit.filamentColumn = -1;
    expect(s.variantElement('filament', 'nozzle_temperature', 1)).toBe(0);
  });
});

describe('presets store on a nozzle rack (H2C)', () => {
  async function h2c() {
    const s = await make();
    await s.selectPrinter(sysId('BBL', 'Bambu Lab H2C 0.4 nozzle'));
    s.selection.process = sysId('BBL', '0.20mm Standard @BBL H2C');
    s.selection.filaments = Array(3).fill(sysId('BBL', 'Bambu PLA Basic @BBL H2C'));
    await s.refresh();
    return s;
  }
  it('seeds extruder_nozzle_stats and sends it with filament_volume_map and per-extruder flush multipliers', async () => {
    const s = await h2c();
    expect(s.nozzleStats()).toEqual(['Standard#1', 'Standard#6']);
    s.project.filament_map_mode = 'Manual';
    s.project.filament_map = ['1', '2', '2'];
    s.setNozzleVolumeType(1, 'Hybrid');
    s.setNozzleCount(1, 'Standard', 3);
    s.setNozzleCount(1, 'High Flow', 5);
    expect(s.nozzleStats()).toEqual(['Standard#1', 'Standard#3|High Flow#3']);
    s.project.filament_volume_map = ['0', '0', '1'];
    const cfg = s.resolve();
    expect(cfg.extruder_nozzle_stats).toEqual(['Standard#1', 'Standard#3|High Flow#3']);
    expect(cfg.filament_volume_map).toEqual(['0', '0', '1']);
    expect(cfg.filament_extruder_variant).toHaveLength(9);
    // Each filament's filament_id (inherited from "Bambu PLA Basic @base"): vendor start G-code reads filament_ids.
    expect(cfg.filament_ids).toEqual(['OFoiVqVM', 'OFoiVqVM', 'OFoiVqVM']);
    expect(asList(cfg.flush_multiplier)).toHaveLength(2);
    expect(asList(cfg.flush_volumes_matrix)).toHaveLength(18);
    // Switching the rack to one flow type moves every nozzle to it; a new printer reseeds.
    s.setNozzleVolumeType(1, 'High Flow');
    expect(s.nozzleStats()).toEqual(['Standard#1', 'High Flow#6']);
    await s.selectPrinter(sysId('BBL', 'Bambu Lab H2D 0.4 nozzle'));
    expect(s.project.extruder_nozzle_stats).toBeUndefined();
    expect(s.nozzleStats()).toBeNull();
  });
});

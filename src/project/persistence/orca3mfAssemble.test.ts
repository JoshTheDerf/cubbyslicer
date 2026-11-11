// Orca 3MF leftovers: the model_settings.config <assemble> section, height-range settings the
// engine doesn't know, project-embedded presets (JSON and older INI), published-file slot remaps.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolvedConfig } from '../../app/state';
import type { ConfigOptionDef, ConfigSchema } from '../../engine/types';
import { ensureCadWasm } from '../../cad/build';
import { layerSliceFields } from '../../layers/sliceFields';
import { remapPaintString } from '../../presets/filamentRefs';
import * as S from '../store';
import { parseOrca3mf } from '../import/orca3mf';
import { orca25Project3mf } from '../import/__fixtures__/orca25';
import { orcaProjectData, readEmbeddedPreset, remapModelFilamentSlots } from '../orcaOpen';
import { buildOrca3mf, formatG17 } from './orca3mfWriter';
import { setProjectPassthrough } from './passthrough';
import { sanitizeObjects } from './format';

const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const fixture = (f: string) => new Uint8Array(readFileSync(resolve(__dirname, '../import/__fixtures__', f)));
const def = (type: ConfigOptionDef['type'], scope: ConfigOptionDef['scope'] = 'print'): ConfigOptionDef => ({
  type, label: '', fullLabel: '', category: '', tooltip: '', sidetext: '', mode: 'simple', min: null, max: null, default: '', scope,
});
const SCHEMA: ConfigSchema = {
  engine: 'orca', version: 'test',
  options: {
    layer_height: def('float'), extruder: def('int', 'object'), wall_loops: def('int'), nozzle_diameter: def('floats', 'machine'),
    print_settings_id: def('string'), inherits: def('string'),
  },
};

function open(bytes: Uint8Array, schema: ConfigSchema | null = null) {
  const proj = parseOrca3mf(buf(bytes));
  const conv = orcaProjectData(proj, { name: 'test', schema, bed: S.bed.value });
  S.loadProjectData(conv.data);
  setProjectPassthrough(conv.passthrough);
  return proj;
}

const ITEM = /<assemble_item object_id="(\d+)" instance_id="(\d+)" transform="([^"]*)" offset="([^"]*)" \/>/g;
const items = (settings: string) => [...settings.matchAll(ITEM)].map((m) => ({ object: m[1], instance: m[2], transform: m[3], offset: m[4] }));
const buildOrder = (model: string) => [...model.matchAll(/<item objectid="(\d+)"/g)].map((m) => m[1]);

beforeAll(async () => { await ensureCadWasm(); });
beforeEach(() => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  S.resetProject();
});

describe('formatG17 (Orca stream precision max_digits10)', () => {
  it('writes doubles like printf %.17g', () => {
    expect([112.3511962890625, 0.80000000447034836, 1.2222222228191226, 0.1, 100, 1, -0, 0, 1e-5, 1e20, -48.600009918212891].map(formatG17)).toEqual([
      '112.3511962890625', '0.80000000447034836', '1.2222222228191226', '0.10000000000000001', '100', '1', '-0', '0',
      '1.0000000000000001e-05', '1e+20', '-48.600009918212891',
    ]);
  });
});

describe('<assemble> (bbs_3mf.cpp _handle_start_assemble_item / _add_model_config_file_to_archive)', () => {
  for (const f of ['orca-2.5.0-dev-badge.3mf', 'bambu-studio-2.0-pa-line-dual.3mf']) {
    it(`${f}: every instance's assemble transform and offset are written back byte for byte`, () => {
      const src = unzipSync(fixture(f));
      const before = items(strFromU8(src['Metadata/model_settings.config']));
      const order = buildOrder(strFromU8(src['3D/3dmodel.model']));
      expect(before.length).toBe(order.length);
      open(fixture(f));
      const out = unzipSync(buildOrca3mf());
      const settings = strFromU8(out['Metadata/model_settings.config']);
      const after = items(settings);
      const savedOrder = buildOrder(strFromU8(out['3D/3dmodel.model']));
      expect(after.length).toBe(before.length);
      order.forEach((id, i) => {
        const a = before.find((x) => x.object === id)!;
        const b = after.find((x) => x.object === savedOrder[i] && x.instance === a.instance)!;
        expect(b, id).toBeDefined();
        expect([b.transform, b.offset]).toEqual([a.transform, a.offset]);
      });
      // After the plates, as desktop writes it; and it reads back.
      expect(settings).toMatch(/<\/plate>\n {2}<assemble>\n( {3}<assemble_item [^\n]+ \/>\n)+ {2}<\/assemble>\n<\/config>\n$/);
      const again = parseOrca3mf(buf(buildOrca3mf()));
      expect(again.objects.flatMap((o) => o.instances.map((x) => x.assemble))).toEqual(parseOrca3mf(buf(fixture(f))).objects.flatMap((o) => o.instances.map((x) => x.assemble)));
    }, 120_000);
  }

  it('an assembled pose that differs from the placement shows in Assembly view (cut / arranged files)', () => {
    open(fixture('bambu-studio-2.0-pa-line-dual.3mf'));
    expect(S.objects.value.every((o) => o.assembly && o.assemble)).toBe(true);
    S.resetProject();
    open(fixture('orca-2.5.0-dev-badge.3mf'));
    // 112.351196 (placement) vs 112.3511962890625 (assembled): the same pose.
    expect(S.objects.value.some((o) => o.assembly)).toBe(false);
  });

  it('a file without one: desktop initialises each instance from its placement; new objects get theirs', () => {
    open(orca25Project3mf());
    const settings = strFromU8(unzipSync(buildOrca3mf())['Metadata/model_settings.config']);
    const list = items(settings);
    const insts = parseOrca3mf(buf(orca25Project3mf())).objects.flatMap((o) => o.instances);
    expect(list).toHaveLength(insts.length);
    const t = insts[0].transform;
    expect(list[0].transform).toBe([t[0], t[1], t[2], t[4], t[5], t[6], t[8], t[9], t[10], t[12], t[13], t[14]].map(formatG17).join(' '));
    expect(list.every((x) => x.offset === '0 0 0')).toBe(true);
  });

  it('a cut piece (assembly pose, no file state) writes its assembled pose; autosave keeps the state', () => {
    open(fixture('orca-2.5.0-dev-badge.3mf'));
    const o = S.objects.value[0];
    const stored = sanitizeObjects(JSON.parse(JSON.stringify(S.serializeObjects())), new Set(S.liveMeshes().map((m) => m.id)));
    expect(stored[0].assemble).toEqual(o.assemble);
    S.mutate('cut', () => {
      const x = S.getObject(o.id)!;
      delete x.assemble;
      x.assembly = { position: [5, 6, 7], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    });
    const list = items(strFromU8(unzipSync(buildOrca3mf())['Metadata/model_settings.config']));
    expect(list[0].transform).toBe('1 0 0 0 1 0 0 0 1 5 6 7');
  });
});

describe('height ranges: settings the engine doesn’t know', () => {
  const withFutureRange = () => {
    const z = unzipSync(orca25Project3mf());
    z['Metadata/layer_config_ranges.xml'] = strToU8('<?xml version="1.0" encoding="utf-8"?>\n<objects>\n <object id="1">\n  <range min_z="2" max_z="6">\n'
      + '   <option opt_key="layer_height">0.1</option>\n   <option opt_key="future_range_key">a &amp; b</option>\n   <option opt_key="wall_loops">3</option>\n  </range>\n </object>\n</objects>\n');
    return zipSync(z);
  };

  it('stay with the range, never reach the slice job, and are written back', () => {
    open(withFutureRange(), SCHEMA);
    const o = S.objects.value.find((x) => x.layerRanges?.length)!;
    expect(o.layerRanges![0].overrides).toEqual({ layer_height: '0.1', wall_loops: '3' });
    expect(o.layerRanges![0].passthrough).toEqual([['future_range_key', 'a & b']]);
    const job = layerSliceFields(o, 20, resolvedConfig.value);
    expect(job.layerRanges?.[0].config).not.toHaveProperty('future_range_key');
    const after = parseOrca3mf(buf(buildOrca3mf()));
    expect(after.objects.find((x) => x.layerRanges)?.layerRanges).toEqual([{ min: 2, max: 6, config: { layer_height: '0.1', wall_loops: '3', future_range_key: 'a & b' } }]);
    // Undo snapshots / autosave carry them.
    const stored = sanitizeObjects(JSON.parse(JSON.stringify(S.serializeObjects())), new Set(S.liveMeshes().map((m) => m.id)));
    expect(stored.find((x) => x.layerRanges)?.layerRanges?.[0].passthrough).toEqual([['future_range_key', 'a & b']]);
  });
});

describe('project-embedded presets', () => {
  const enc = (s: string) => strToU8(s);
  it('older INI process presets (Metadata/print_setting_N.config) read like desktop', () => {
    const ini = '# generated by BambuStudio\nprint_settings_id = My 0.2mm\ninherits = 0.20mm Standard @BBL X1C\nwall_loops = 4\nnozzle_diameter = 0.4,0.6\nfuture_key = x\n';
    expect(readEmbeddedPreset('Metadata/print_setting_1.config', enc(ini), SCHEMA)).toEqual({
      kind: 'process', name: 'My 0.2mm',
      raw: { print_settings_id: 'My 0.2mm', inherits: '0.20mm Standard @BBL X1C', wall_loops: '4', nozzle_diameter: ['0.4', '0.6'], future_key: 'x', name: 'My 0.2mm', type: 'process' },
    });
    // No name, or not readable as INI: desktop skips the file.
    expect(readEmbeddedPreset('Metadata/print_setting_2.config', enc('wall_loops = 4\n'), SCHEMA)).toBeNull();
    expect(readEmbeddedPreset('Metadata/print_setting_3.config', enc('print_settings_id = a\nbroken line\n'), SCHEMA)).toBeNull();
  });

  it('JSON presets are named by their *_settings_id (a filament by the first), else "name"', () => {
    expect(readEmbeddedPreset('Metadata/filament_settings_1.config', enc('{"name":"x","filament_settings_id":["My PLA"],"inherits":"Generic PLA"}'), null)?.name).toBe('My PLA');
    expect(readEmbeddedPreset('Metadata/machine_settings_1.config', enc('{"name":"My printer"}'), null)).toMatchObject({ kind: 'printer', name: 'My printer', raw: { type: 'machine' } });
    expect(readEmbeddedPreset('Metadata/process_settings_1.config', enc('not json'), null)).toBeNull();
    expect(readEmbeddedPreset('Metadata/something_else.config', enc('{"name":"x"}'), null)).toBeNull();
  });
});

describe('published files: relocated filament slots', () => {
  it('object / part extruders and colour paint follow (remap_model_filament_slots)', () => {
    const data = {
      name: 't', meshes: [],
      objects: [{ overrides: { extruder: '2' }, parts: [{ overrides: { extruder: '3' } }, { overrides: {} }] }],
      paint: { m1: { color: [[0, '8'], [1, '4']] as Array<[number, string]> } },
    } as unknown as Parameters<typeof remapModelFilamentSlots>[0];
    remapModelFilamentSlots(data, new Map([[1, 4]]));
    expect(data.objects[0].overrides.extruder).toBe('5');
    expect(data.objects[0].parts!.map((p) => p.overrides.extruder)).toEqual(['3', undefined]);
    // Paint state 2 ("8", slot 1) → 5; state 1 ("4") stays.
    expect(data.paint!.m1.color).toEqual([[0, remapPaintString('8', (s) => (s === 2 ? 5 : s))], [1, '4']]);
    expect(data.paint!.m1.color![0][1]).not.toBe('8');
  });
});

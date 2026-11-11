// Open → save → open round trips of Orca / Bambu project 3MFs, and passthrough
// of what CubbySlicer doesn't model. Fixtures: __fixtures__/orca25.ts is
// SYNTHETIC (hand-built after bbs_3mf.cpp v2.5.0); the two .3mf files are real
// desktop saves shipped in the OrcaSlicer v2.5.0 tree (resources/handy_models/
// OrcaBadge.3mf: Orca 2.5.0-dev, 2.4.x layout; resources/calib/pressure_advance/
// auto_pa_line_dual.3mf: Bambu Studio 02.00.02.01).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolvedConfig } from '../../app/state';
import type { ConfigOptionDef, ConfigSchema } from '../../engine/types';
import * as S from '../store';
import { parseOrca3mf, type OrcaProject } from '../import/orca3mf';
import { CAD_RECIPE, TEXTURE_JSON, orca25Project3mf, orca25Published3mf } from '../import/__fixtures__/orca25';
import { orcaProjectData, openOrcaProject } from '../orcaOpen';
import { buildOrca3mf } from './orca3mfWriter';
import { getOrcaCadRecipe, projectPassthrough, sanitizeProjectPassthrough, setOrcaCadRecipe, setProjectPassthrough } from './passthrough';
import { sanitizeObjects, sanitizePlates } from './format';
import { createPrimitiveNode, type CadNode } from '../../cad/api';
import { ensureCadWasm } from '../../cad/build';
import { platesMayOverrideBedType, resetPlateBedTypes } from '../plates';
import { MIXED_SLOT_KEYS, slotValues, splitProjectSlots, type MixedDef } from '../../mixed/model';

const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const fixture = (f: string) => new Uint8Array(readFileSync(resolve(__dirname, '../import/__fixtures__', f)));

const def = (type: ConfigOptionDef['type'], scope: ConfigOptionDef['scope'] = 'print'): ConfigOptionDef => ({
  type, label: '', fullLabel: '', category: '', tooltip: '', sidetext: '', mode: 'simple', min: null, max: null, default: '', scope,
});
/** A few keys an engine schema would know (everything else is passthrough). */
const SCHEMA: ConfigSchema = {
  engine: 'orca', version: 'test',
  options: {
    wall_loops: def('int'), extruder: def('int', 'object'), sparse_infill_density: def('percent'), layer_height: def('float'),
    seam_gap: def('floatOrPercent'), curr_bed_type: def('enum', 'other'), spiral_mode: def('bool'), filament_map_mode: def('enum'), filament_map: def('ints'),
  },
};

/** What desktop Orca would open, minus placements (our plate grid differs) and the per-object default extruder our writer adds. */
function summary(p: OrcaProject) {
  return {
    objects: p.objects.map((o) => ({
      // Orca 2.5 writes auto_drop on every object; absent means on.
      name: o.name, config: o.config, keep: { ...o.keep, attrs: o.keep.attrs.filter(([k, v]) => !(k === 'auto_drop' && v === '1')) }, plates: o.instances.map((i) => [i.plate, i.printable]),
      layerHeightProfile: o.layerHeightProfile, layerRanges: o.layerRanges, brimPoints: o.brimPoints, cutInfo: o.cutInfo,
      volumes: o.volumes.map((v) => ({
        name: v.name, type: v.type, preciseSeam: v.preciseSeam, triangles: v.indices.length / 3, paint: v.paint,
        triangleAttrs: v.triangleAttrs, config: v.config, keep: v.keep,
      })),
    })),
    plates: p.plates.map((pl) => ({ name: pl.name, locked: pl.locked, config: pl.config, keep: pl.keep, customGcodes: pl.customGcodes })),
    modelMetadata: p.modelMetadata,
    keptFiles: p.keptFiles,
  };
}

/** openOrcaProject without the preset step (no engine in tests). */
function openForeign(bytes: Uint8Array, schema: ConfigSchema | null = null): OrcaProject {
  const proj = parseOrca3mf(buf(bytes));
  const conv = orcaProjectData(proj, { name: 'test', schema, bed: S.bed.value });
  S.loadProjectData(conv.data);
  setProjectPassthrough(conv.passthrough);
  return proj;
}

const withoutDefaultExtruder = (s: ReturnType<typeof summary>, names: string[]) => {
  for (const o of s.objects) if (names.includes(o.name) && o.config.extruder === '1') delete (o.config as Record<string, string>).extruder;
  return s;
};

beforeAll(async () => { await ensureCadWasm(); });
beforeEach(() => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  S.resetProject();
});

describe('Orca 2.5 project 3MF (synthetic fixture)', () => {
  it('reads 2.5 additions: precise seams, unknown subtypes, auto_drop, plate maps, texture layers, design recipe', () => {
    const p = parseOrca3mf(buf(orca25Project3mf()));
    expect(p.version).toEqual({ orca: '2.5.0', application: 'BambuStudio-02.08.01.55' });
    const [a, b] = p.objects;
    expect(a.keep.attrs).toEqual([['auto_drop', '0']]);
    expect(b.keep.attrs).toEqual([['auto_drop', '1']]);
    expect(a.volumes.map((v) => [v.name, v.type])).toEqual([['Body', 'part'], ['Seam left', 'modifier'], ['Future volume', 'modifier'], ['Label', 'part']]);
    expect(a.volumes[1].preciseSeam).toEqual({ type: 'precise_seam_left', config: { seam_gap: '10%', future_seam_option: '3' } });
    expect(a.volumes[1].config).toEqual({});
    // A subtype from the future opens as an inert modifier: its settings don't become active overrides.
    expect(a.volumes[2].keep.subtype).toBe('fancy_future_part');
    expect(a.volumes[2].config).toEqual({});
    expect(a.volumes[2].keep.metadata).toEqual([['sparse_infill_density', '90%']]);
    expect(a.volumes[0].keep.meshMetadata.map(([k]) => k)).toContain('texture_displacement');
    expect(a.volumes[0].triangleAttrs).toEqual({ paint_texture_0: [[2, '4'], [3, 'C']] });
    expect(a.volumes[0].paint).toEqual({ color: [[2, '8']] });
    expect(a.volumes[3].keep.elements).toEqual(['<slic3rpe:text text="Hi &amp; bye" font_descriptor="Noto Sans" style_name="Default" char_gap="0" line_gap="0"/>']);
    expect(p.plates[0].config).toMatchObject({
      curr_bed_type: 'Textured PEI Plate', spiral_mode: '0', imex_parallel_mode: 'Copy & mirror\tA', imex_head_filament_map: '1:1;2:2',
      filament_map_mode: 'Manual', filament_map: '1,2', filament_volume_map: '0,1',
    });
    expect(p.plates[0].keep.metadata).toEqual([['future_plate_key', 'x y']]);
    expect(p.plates[0].customGcodes).toEqual([{ z: 2, type: 'color_change', extruder: 2, color: '#FF0000' }, { z: 4, type: 'custom', extruder: 1, extra: 'M117 hi' }]);
    expect(a.layerHeightProfile).toEqual([0, 0.2, 5, 0.1, 20, 0.1]);
    expect(a.layerRanges).toEqual([{ min: 2, max: 6, config: { layer_height: '0.1', extruder: '2' } }]);
    expect(b.brimPoints).toEqual([{ pos: [1, 2, 0], radius: 3 }, { pos: [6, 6, 0], radius: 2.5 }]);
    expect(a.cutInfo).toBe('<cut_id id="12" check_sum="1" connectors_cnt="0"/>');
    expect(Object.keys(p.keptFiles).sort()).toEqual([
      'Auxiliaries/Model Pictures/front.png', 'Metadata/filament_settings_1.config', 'Metadata/orca_cad.bin',
      'Metadata/texture_displacement/7.json', 'Metadata/texture_displacement/7_0.png',
    ]);
    expect(p.keptFiles['Metadata/orca_cad.bin']).toEqual(CAD_RECIPE);
    expect(p.modelMetadata).toContainEqual(['Description', 'A <test> & project']);
    expect(p.modelMetadata).toContainEqual(['MakerLab', 'Parametric box']);
    expect(p.published).toBeNull();
  });

  it('open → save → open keeps everything desktop Orca would read (settings unknown to the engine pass through)', () => {
    const before = openForeign(orca25Project3mf());
    const saved = buildOrca3mf();
    const after = parseOrca3mf(buf(saved));
    expect(after.version).toEqual({ orca: '2.5.0', application: 'BambuStudio-02.08.01.55' });
    expect(withoutDefaultExtruder(summary(after), ['Small'])).toEqual(summary(before));
    // Derived files are not carried over; the recipe is byte-identical.
    const zip = unzipSync(saved);
    expect(Object.keys(zip).filter((k) => /plate_\d+\.gcode|filament_sequence|some_future_file|plate_1\.png/.test(k))).toEqual([]);
    expect(zip['Metadata/orca_cad.bin']).toEqual(CAD_RECIPE);
    expect(strFromU8(zip['Metadata/texture_displacement/7.json'])).toBe(TEXTURE_JSON);
    // 2.5 layout: auto_drop on the object, not the build item; seam as modifier + type key.
    const settings = strFromU8(zip['Metadata/model_settings.config']);
    expect(settings).toMatch(/<object id="\d+" auto_drop="0">/);
    expect(strFromU8(zip['3D/3dmodel.model'])).not.toContain('auto_drop');
    expect(settings).toMatch(/<part id="\d+" subtype="modifier_part">\n {6}<metadata key="precise_seam_type" value="precise_seam_left"\/>/);
    expect(settings).toContain('<metadata key="precise_seam_config:seam_gap" value="10%"/>');
    expect(settings).toContain('subtype="fancy_future_part"');
    expect(settings).toContain('<metadata key="imex_parallel_mode" value="Copy &amp; mirror&#x9;A"/>');
  });

  it('settings the engine knows become overrides and are written back', () => {
    openForeign(orca25Project3mf(), SCHEMA);
    const o = S.objects.value.find((x) => x.name === 'Seamed box')!;
    // The main volume's settings beat the object's (Orca), and live on the object here.
    expect(o.overrides).toEqual({ extruder: '2', wall_loops: '4' });
    expect(o.passthrough?.object?.metadata).toEqual([['future_object_setting', '7']]);
    const seam = o.parts!.find((p) => p.preciseSeam)!;
    expect(seam.type).toBe('modifier');
    expect(seam.overrides).toEqual({});
    expect(seam.preciseSeam).toEqual({ type: 'precise_seam_left', config: { seam_gap: '10%' } });
    expect(S.plates.value[0].config).toMatchObject({ curr_bed_type: 'Textured PEI Plate', spiral_mode: '0', filament_map_mode: 'Manual', filament_map: ['1', '2'] });
    expect(o.layerRanges?.[0].overrides).toEqual({ layer_height: '0.1', extruder: '2' });

    const after = parseOrca3mf(buf(buildOrca3mf()));
    const a = after.objects.find((x) => x.name === 'Seamed box')!;
    expect(a.config).toMatchObject({ extruder: '2', wall_loops: '4', future_object_setting: '7' });
    expect(a.volumes[1].preciseSeam).toEqual({ type: 'precise_seam_left', config: { seam_gap: '10%', future_seam_option: '3' } });
    expect(after.plates[0].config).toMatchObject({ curr_bed_type: 'Textured PEI Plate', filament_map: '1,2', filament_volume_map: '0,1', imex_parallel_mode: 'Copy & mirror\tA' });
    expect(after.plates[0].keep.metadata).toEqual([['future_plate_key', 'x y']]);
  });

  it('a saved project reopens with its passthrough and saves byte-identical model settings', async () => {
    openForeign(orca25Project3mf());
    const first = buildOrca3mf();
    S.resetProject();
    expect(getOrcaCadRecipe()).toBeNull();
    const r = await openOrcaProject('again.3mf', buf(first));
    expect(r.own).toBe(true);
    expect(getOrcaCadRecipe()).toEqual(CAD_RECIPE);
    expect(Object.values(projectPassthrough.value.triangleAttrs)).toEqual([{ paint_texture_0: [[2, '4'], [3, 'C']] }]);
    const second = unzipSync(buildOrca3mf());
    const one = unzipSync(first);
    for (const f of ['Metadata/model_settings.config', '3D/3dmodel.model', '3D/Objects/object_1.model', 'Metadata/orca_cad.bin', 'Metadata/texture_displacement/7_0.png', 'Metadata/layer_config_ranges.xml']) {
      expect(second[f], f).toEqual(one[f]);
    }
  });

  it('undo, copies and the autosave records carry the passthrough', () => {
    openForeign(orca25Project3mf());
    const id = S.objects.value[0].id;
    const keep = S.objects.value[0].passthrough;
    expect(keep?.object?.attrs).toEqual([['auto_drop', '0']]);
    S.renameObject(id, 'Renamed');
    S.undo();
    expect(S.getObject(id)!.passthrough).toEqual(keep);
    S.duplicateObjects([id], 1);
    expect(S.objects.value.filter((o) => o.passthrough?.object?.attrs?.[0]?.[1] === '0')).toHaveLength(2);
    // Autosave / project JSON: objects and plates survive serialisation + sanitising.
    const objs = JSON.parse(JSON.stringify(S.serializeObjects()));
    const meshIds = new Set(S.liveMeshes().map((m) => m.id));
    expect(sanitizeObjects(objs, meshIds).map((o) => o.passthrough)).toEqual(S.objects.value.map((o) => o.passthrough));
    expect(sanitizeObjects(objs, meshIds)[0].parts!.map((p) => p.preciseSeam ?? p.passthrough?.subtype ?? null)).toEqual([
      { type: 'precise_seam_left', config: {} }, 'fancy_future_part', null,
    ]);
    expect(sanitizePlates(JSON.parse(JSON.stringify(S.serializePlates())))![0].passthrough).toEqual(S.plates.value[0].passthrough);
    const stored = sanitizeProjectPassthrough(structuredClone(projectPassthrough.value), meshIds);
    expect(stored?.files['Metadata/orca_cad.bin']).toEqual(CAD_RECIPE);
    expect(stored?.triangleAttrs).toEqual(projectPassthrough.value.triangleAttrs);
  });

  it('drops mesh-bound passthrough once a volume’s mesh is replaced', () => {
    openForeign(orca25Project3mf());
    const o = S.objects.value[0];
    // A tool replacing the mesh gives it a new id: the texture key and source file no longer apply.
    const m = S.getMesh(o.meshId)!;
    S.replaceVolumeMesh(o.id, null, { positions: m.positions.slice(), indices: m.indices.slice() }, { label: 'Simplify' });
    const settings = strFromU8(unzipSync(buildOrca3mf())['Metadata/model_settings.config']);
    expect(settings).not.toContain('texture_displacement');
    expect(settings).not.toContain('source_file');
    expect(strFromU8(unzipSync(buildOrca3mf())['3D/Objects/object_1.model'])).not.toContain('paint_texture_0');
  });

  it('a new project forgets the passthrough; the recipe accessor round-trips', () => {
    openForeign(orca25Project3mf());
    expect(getOrcaCadRecipe()).toEqual(CAD_RECIPE);
    setOrcaCadRecipe(new Uint8Array([1, 2, 3]));
    expect(unzipSync(buildOrca3mf())['Metadata/orca_cad.bin']).toEqual(new Uint8Array([1, 2, 3]));
    S.resetProject();
    expect(getOrcaCadRecipe()).toBeNull();
    expect(Object.keys(unzipSync(buildOrca3mf())).some((k) => /orca_cad|texture_displacement|Auxiliaries/.test(k))).toBe(false);
  });
});

describe('published 3MF', () => {
  it('is recognised and carries the published keys and payload', () => {
    const p = parseOrca3mf(buf(orca25Published3mf()));
    expect(p.settings).toBeNull();
    expect(p.published).toEqual({
      keys: ['sparse_infill_density', 'wall_loops', 'retraction_length#1', 'nozzle_diameter', 'print_settings_id'],
      materials: [{
        slot: 1, keys: ['filament_type'], full: false, fullKeys: [], publishType: false, type: '', publishColor: true, color: '#00FF00',
        material: { filamentType: '', filamentVendor: '', filamentId: '', settingId: '', name: '' },
      }],
      printerLayout: null, printLayout: null,
      config: expect.objectContaining({ sparse_infill_density: '33%', retraction_length: '0.8,1.2', filament_type: 'PLA;PETG' }),
    });
    expect(p.printableArea).toEqual([[0, 0], [200, 0], [200, 200], [0, 200]]);
    expect(p.modelMetadata.some(([k]) => k.startsWith('orca_published'))).toBe(false);
  });

  it('saves as a normal project (published metadata stripped)', () => {
    openForeign(orca25Published3mf());
    const model = strFromU8(unzipSync(buildOrca3mf())['3D/3dmodel.model']);
    expect(model).not.toContain('orca_published');
    expect(model).toContain('<metadata name="OrcaSlicer">2.5.0</metadata>');
  });
});

describe('real desktop files', () => {
  it('Orca 2.5.0-dev (2.4.x layout: auto_drop on build items) opens and round-trips', () => {
    const before = openForeign(fixture('orca-2.5.0-dev-badge.3mf'));
    expect(before.objects.map((o) => o.name)).toEqual(['OrcaSlicer Badge Horizontal', 'OrcaSlicer Badge Vertical', 'OrcaSlicer Badge Logo']);
    expect(before.objects.every((o) => o.keep.attrs.some(([k, v]) => k === 'auto_drop' && v === '0'))).toBe(true);
    expect(before.plates[0].config).toMatchObject({ filament_map_mode: 'Auto For Flush', filament_map: '1,2,3,4' });
    const saved = buildOrca3mf();
    const after = parseOrca3mf(buf(saved));
    expect(summary(after)).toEqual(summary(before));
    expect(strFromU8(unzipSync(saved)['Metadata/model_settings.config']).match(/auto_drop="0"/g)).toHaveLength(3);
  }, 120_000);

  it('Bambu Studio 2.0 (cut info, nullable per-variant values, source files) opens and round-trips', () => {
    const before = openForeign(fixture('bambu-studio-2.0-pa-line-dual.3mf'));
    expect(before.producer).toBe('Bambu Studio');
    expect(before.objects).toHaveLength(8);
    const withModifier = before.objects.find((o) => o.volumes.length === 2)!;
    expect(withModifier.volumes[1]).toMatchObject({ type: 'modifier', config: { outer_wall_speed: '80,nil,80,nil' } });
    expect(withModifier.volumes[0].keep.meshMetadata).toContainEqual(['source_file', 'C:\\Users\\zhimin.zeng\\Downloads\\自动流量校准展示模型.3mf']);
    expect(before.objects.every((o) => o.cutInfo?.startsWith('<cut_id'))).toBe(true);
    const after = parseOrca3mf(buf(buildOrca3mf()));
    expect(summary(after)).toEqual(summary(before));
  });
});

describe('CubbyCAD holes', () => {
  it('a stand-alone hole saves as non-printable for desktop Orca and reopens as a hole', async () => {
    const box = (w: number, extra: Partial<CadNode> = {}) => ({ ...createPrimitiveNode('box', { params: { width: w, depth: w, height: w } }), ...extra }) as CadNode;
    S.addCadObjects([{ node: box(20) }]);
    S.addCadObjects([{ node: box(5, { contribution: 'subtract' }) }]);
    const file = buildOrca3mf();
    const model = strFromU8(unzipSync(file)['3D/3dmodel.model']);
    expect(model.match(/printable="(\d)"/g)).toEqual(['printable="1"', 'printable="0"']);
    S.resetProject();
    await openOrcaProject('h.3mf', buf(file));
    const hole = S.objects.value.find((o) => o.cad?.node.contribution === 'subtract')!;
    expect(hole.printable).toBe(true); // our own flag is untouched; only Orca's copy is non-printable
  });
});

describe('per-plate bed type (A32)', () => {
  it('only printers with several bed types keep plate bed types', () => {
    expect(platesMayOverrideBedType({ vendor: 'BBL', config: {} })).toBe(true);
    expect(platesMayOverrideBedType({ config: { support_multi_bed_types: '1' } })).toBe(true);
    expect(platesMayOverrideBedType({ config: { support_multi_bed_types: '0' } })).toBe(false);
    const r = resetPlateBedTypes([{ name: '', locked: false, config: { curr_bed_type: 'Cool Plate', spiral_mode: '1' } }, { name: '', locked: false }]);
    expect(r.reset).toBe(true);
    expect(r.plates[0].config).toEqual({ spiral_mode: '1' });
  });
});

describe('Orca 2.5 mixed filaments in project settings', () => {
  it('a plain mix and a gradient mix survive save → open', () => {
    const plain: MixedDef = { components: [1, 2], ratios: [70, 30], gradient: false, direction: 'ab', curve: [], perPart: false };
    const gradient: MixedDef = { components: [1, 2], ratios: [50, 50], gradient: true, direction: 'ba', curve: [], perPart: true };
    const mixed = [slotValues(plain), slotValues(gradient)];
    const vec = (k: (typeof MIXED_SLOT_KEYS)[number], physical: string) => [physical, physical, ...mixed.map((m) => m[k])];
    const cfg: Record<string, string | string[]> = {
      printable_area: '0x0,220x0,220x220,0x220', printable_height: '250', filament_colour: ['#FF0000', '#0000FF', '#B2004C', '#800080'],
    };
    for (const k of MIXED_SLOT_KEYS) cfg[k] = vec(k, k === 'filament_is_mixed' ? '0' : slotValues({ ...plain, components: [] })[k] ?? '');
    resolvedConfig.value = cfg;
    const w = S.addParsedObjects;
    w([{ name: 'A', positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]), transform: null }]);
    const p = parseOrca3mf(buf(buildOrca3mf()));
    for (const k of MIXED_SLOT_KEYS) expect(p.settings?.[k], k).toEqual(cfg[k]);
    const split = splitProjectSlots(p.settings as Record<string, string[]>, 4);
    expect(split.physical).toEqual([0, 1]);
    expect(split.mixed).toEqual([plain, gradient]);
  });
});

describe('Orca 2.5 nozzle variants in project settings', () => {
  it('writes project-config keys and per-variant vectors at full width with their layout keys', () => {
    const cfg: Record<string, string | string[]> = {
      printable_area: '0x0,220x0,220x220,0x220', printable_height: '250',
      nozzle_diameter: ['0.4', '0.4'], extruder_type: ['Direct Drive', 'Direct Drive'],
      nozzle_volume_type: ['Standard', 'High Flow'], filament_map: ['1', '2'], filament_map_mode: 'Manual',
      filament_volume_map: ['0', '1'], prime_volume_mode: 'Fast', flush_multiplier_fast: ['1.2', '1.3'],
      // A nozzle rack split per type (H2C), and Nozzle Manual's nozzle per filament.
      extruder_nozzle_stats: ['Standard#1', 'Standard#3|High Flow#3'], filament_nozzle_map: ['0', '4'],
      // Two extruders × two flow types: four print / printer columns.
      print_extruder_id: ['1', '1', '2', '2'],
      print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
      outer_wall_speed: ['200', '300', '210', '310'],
      printer_extruder_id: ['1', '1', '2', '2'],
      printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
      // Filament 1 has two columns, filament 2 one.
      filament_self_index: ['1', '1', '2'],
      filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard'],
      filament_max_volumetric_speed: ['20', '30', '12'],
    };
    resolvedConfig.value = cfg;
    S.addParsedObjects([{ name: 'A', positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]), transform: null }]);
    const p = parseOrca3mf(buf(buildOrca3mf()));
    for (const [k, v] of Object.entries(cfg)) if (k !== 'printable_area' && k !== 'printable_height') expect(p.settings?.[k], k).toEqual(v);
  });
});

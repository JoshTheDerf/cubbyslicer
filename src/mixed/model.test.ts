import { describe, expect, it } from 'vitest';
import type { PresetValues } from '../presets/types';
import { parseGradientCurve } from './mixer';
import {
  defError, expandFlushMatrix, formatRatios, mixedColour, mixedLabel, mixedProblems, parseRatios, readMixedSlots, recommendations, remapOnDelete,
  slotValues, splitProjectSlots, withMixedSlots, writeMixedLayout, type MixedDef, type MixedFilament,
} from './model';

const def = (over: Partial<MixedDef> = {}): MixedDef => ({ components: [1, 2], ratios: [70, 30], gradient: false, direction: 'ab', curve: [], perPart: false, ...over });

describe('mixed filament slots (Orca 2.5 project vectors)', () => {
  it('writes a slot the way desktop Orca does', () => {
    expect(slotValues(def())).toEqual({
      filament_is_mixed: '1', filament_mixed_components: '1,2', filament_mixed_sublayer_ratios: '0.7000,0.3000', filament_mixed_gradient: '0',
      filament_mixed_gradient_range: '', filament_mixed_gradient_curve: '', filament_mixed_gradient_per_part: '0',
    });
    expect(slotValues(def({ gradient: true, direction: 'ba', perPart: true }))).toMatchObject({
      filament_mixed_gradient: '1', filament_mixed_gradient_range: '0.1000,0.9000', filament_mixed_gradient_curve: '', filament_mixed_gradient_per_part: '1',
    });
    // A curve that is just the direction's line isn't stored; a bent one is.
    expect(slotValues(def({ gradient: true, curve: parseGradientCurve('0,0.9|1,0.1') })).filament_mixed_gradient_curve).toBe('');
    expect(slotValues(def({ gradient: true, curve: parseGradientCurve('0,0.9|0.5,0.7|1,0.1') })).filament_mixed_gradient_curve).toBe('0.0000,0.9000|0.5000,0.7000|1.0000,0.1000');
    // Gradients need exactly two components.
    expect(slotValues(def({ components: [1, 2, 3], ratios: [40, 30, 30], gradient: true })).filament_mixed_gradient).toBe('0');
    expect(formatRatios([1, 2])).toBe('0.3333,0.6667');
    expect(formatRatios([0, 0])).toBe('0.0000,0.0000');
  });

  it('lays out physical slots then mixes and reads them back', () => {
    const project: PresetValues = { filament_colour: ['#FF0000', ''], curr_bed_type: 'Cool Plate' };
    const mixes = [def(), def({ components: [2, 1], ratios: [50, 50], gradient: true, direction: 'ba', curve: parseGradientCurve('0,0.2|0.4,0.6|1,0.8'), perPart: true })];
    writeMixedLayout(project, 2, mixes, ['#111111', '#222222']);
    expect(project.filament_is_mixed).toEqual(['0', '0', '1', '1']);
    expect(project.filament_colour).toEqual(['#FF0000', '', '#111111', '#222222']);
    expect(project.filament_mixed_components).toEqual(['', '', '1,2', '2,1']);
    expect(project.curr_bed_type).toBe('Cool Plate');
    const back = readMixedSlots(project);
    expect(back.map((s) => s.index)).toEqual([2, 3]);
    expect(back[0].def).toEqual(mixes[0]);
    expect(back[1].def.gradient && back[1].def.direction === 'ba' && back[1].def.perPart).toBe(true);
    expect(back[1].def.curve.map((a) => [a.x, a.y])).toEqual([[0, 0.2], [0.4, 0.6], [1, 0.8]]);

    // Growing the physical list keeps the mixes at the tail.
    writeMixedLayout(project, 3, back.map((s) => s.def), ['#111111', '#222222']);
    expect(project.filament_is_mixed).toEqual(['0', '0', '0', '1', '1']);
    expect(project.filament_colour).toEqual(['#FF0000', '', '', '#111111', '#222222']);

    // No mixes left: the mixed vectors go and colours list only the physical slots.
    writeMixedLayout(project, 3, [], []);
    expect(project.filament_is_mixed).toBeUndefined();
    expect(project.filament_mixed_components).toBeUndefined();
    expect(project.filament_colour).toEqual(['#FF0000', '', '']);
  });

  it('parses ratios as integer percent, evenly when they do not match the components', () => {
    expect(parseRatios('0.7000,0.3000', 2)).toEqual([70, 30]);
    expect(parseRatios('0.3333,0.3333,0.3334', 3)).toEqual([33, 33, 33]);
    expect(parseRatios('', 3)).toEqual([34, 33, 33]);
    expect(parseRatios('0.5', 2)).toEqual([50, 50]);
  });

  it('marks the deleted filament as missing and shifts later components (remap_mixed_components_on_delete)', () => {
    expect(remapOnDelete([def({ components: [1, 3] }), def({ components: [2, 4] })], 2).map((d) => d.components)).toEqual([[1, 2], [0, 3]]);
  });

  it('blends the display colour from the physical colours', () => {
    expect(mixedColour({ components: [1, 2], ratios: [50, 50] }, ['#002185', '#FCD300'])).toBe('#2F8D38');
    expect(mixedColour({ components: [1, 9], ratios: [50, 50] }, ['#002185'])).toBe(mixedColour({ components: [1, 2], ratios: [50, 50] }, ['#002185', '#808080']));
    expect(mixedLabel(def())).toBe('1 (70%) + 2 (30%)');
    expect(mixedLabel(def({ gradient: true, direction: 'ba' }))).toBe('2 → 1');
  });

  it('flags missing components and mixed types', () => {
    const m = (id: number, components: number[]): MixedFilament => ({ ...def({ components }), id, color: '#000' });
    expect(mixedProblems([m(4, [1, 2]), m(5, [0, 2]), m(6, [1, 3])], ['PLA', 'PLA', 'PETG'])).toEqual([{ id: 5, reason: 'missing' }, { id: 6, reason: 'types' }]);
    expect(defError(def(), ['PLA', 'PLA'])).toBeNull();
    expect(defError(def({ components: [1, 1] }), ['PLA', 'PLA'])).toMatch(/once/);
    expect(defError(def({ ratios: [95, 5] }), ['PLA', 'PLA'])).toMatch(/10 %/);
    expect(defError(def({ ratios: [60, 30] }), ['PLA', 'PLA'])).toMatch(/100/);
    expect(defError(def(), ['PLA', 'PETG'])).toMatch(/types/);
    expect(defError(def({ components: [1, 2, 3, 4], ratios: [25, 25, 25, 25] }), ['PLA', 'PLA', 'PLA', 'PLA'])).toMatch(/2 to 3/);
  });

  it('recommends same-type pairs and triples', () => {
    const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffffff'];
    const pairs = recommendations(colours, ['PLA', 'PLA', 'PLA', 'PETG'], false);
    expect(pairs.map((r) => r.components)).toEqual([[1, 2], [1, 3], [2, 3]]);
    expect(pairs[0].ratios).toEqual([50, 50]);
    const triples = recommendations(colours, ['PLA', 'PLA', 'PLA', 'PLA-S'], true);
    expect(triples.map((r) => r.components)).toEqual([[2, 3, 1], [3, 1, 2], [1, 2, 3]]);
    expect(triples[0].ratios).toEqual([25, 25, 50]);
  });
});

describe('mixed slots in the slice config', () => {
  it('expands the flush matrix with zero rows / columns for mixed slots', () => {
    expect(expandFlushMatrix(['0', '5', '7', '0'], 2, 3, 1)).toEqual(['0', '5', '0', '7', '0', '0', '0', '0', '0']);
    expect(expandFlushMatrix(['0', '1', '2', '0', '0', '3', '4', '0'], 2, 3, 2)).toEqual(['0', '1', '0', '2', '0', '0', '0', '0', '0', '0', '3', '0', '4', '0', '0', '0', '0', '0']);
    expect(expandFlushMatrix(['0', '1', '2'], 2, 3, 1)).toBeNull();
    expect(expandFlushMatrix(['0', '1', '2', '0'], 2, 2, 1)).toBeNull();
  });

  it('adds the mixed vectors, colours and flush matrix', () => {
    const mixed: MixedFilament[] = [{ ...def(), id: 3, color: '#ABCDEF' }];
    const cfg = withMixedSlots({ filament_colour: ['#FF0000', '#00FF00', '#FF0000'], flush_volumes_matrix: ['0', '1', '2', '0'], layer_height: '0.2' }, 2, mixed, 'flush_volumes_matrix', 1);
    expect(cfg.filament_is_mixed).toEqual(['0', '0', '1']);
    expect(cfg.filament_mixed_components).toEqual(['', '', '1,2']);
    expect(cfg.filament_mixed_sublayer_ratios).toEqual(['', '', '0.7000,0.3000']);
    expect(cfg.filament_colour).toEqual(['#FF0000', '#00FF00', '#ABCDEF']);
    expect(cfg.flush_volumes_matrix).toEqual(['0', '1', '0', '2', '0', '0', '0', '0', '0']);
    expect(cfg.layer_height).toBe('0.2');
    expect(withMixedSlots({ a: '1' }, 2, [], 'flush_volumes_matrix', 1)).toEqual({ a: '1' });
  });

  it('splits a desktop project into physical slots and mixes', () => {
    const s = {
      filament_colour: ['#FF0000', '#00FF00', '#0000FF', '#808080'],
      filament_is_mixed: ['0', '1', '0', '1'],
      filament_mixed_components: ['', '1,3', '', '3,1'],
      filament_mixed_sublayer_ratios: ['', '0.5000,0.5000', '', '0.2000,0.8000'],
    };
    const r = splitProjectSlots(s, 4);
    expect(r.physical).toEqual([0, 2]);
    expect(r.mixed.map((d) => [d.components, d.ratios])).toEqual([[[1, 2], [50, 50]], [[2, 1], [20, 80]]]);
    // A 2.4 project has no mixed vectors: every slot is physical.
    expect(splitProjectSlots({ filament_colour: ['#FF0000', '#00FF00'] }, 2)).toEqual({ physical: [0, 1], mixed: [] });
  });
});

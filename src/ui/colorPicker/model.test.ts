// Ported from OrcaSlicer v2.5.0 resources/web/dialog/ColorPickerDialog/colorpicker.test.js (options renamed to camelCase).
import { describe, expect, it } from 'vitest';
import * as model from './model';
import { PALETTES } from './palettes';

describe('Orca colour picker model', () => {
  it('complete RGB/RGBA hex accepts mixed case and rejects partial or unbounded input', () => {
    expect(model.parseHex('#Ab12cD80')).toEqual([171, 18, 205, 128]);
    for (const hex of ['', '123456', '#123', '#1234567', '#123456789', '#12345Z', '#123456GG', ' #123456', null]) expect(model.parseHex(hex as string)).toBeNull();
    for (let b = 0; b <= 255; ++b) expect(model.parseHex(model.toHex([b, b, b, b]))).toEqual([b, b, b, b]);
  });

  it('HSL conversion preserves primary channels and hue wraps at 360', () => {
    for (const rgb of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [128, 128, 128], [37, 129, 240]] as Array<[number, number, number]>) expect(model.hslToRgb(...model.rgbToHsl(...rgb))).toEqual(rgb);
    expect(model.hslToRgb(360, 100, 50)).toEqual([255, 0, 0]);
    expect(model.hslToRgb(240, 100, 50)).toEqual([0, 0, 255]);
  });

  it('capabilities default off and reject gradient through every model entry', () => {
    const gradient: model.Selection = { type: 'gradient', colors: ['#FF000080', '#0000FF20'] };
    const state = model.createState()!;
    expect(state.options).toEqual({ allowGradient: false, allowAlpha: false });
    expect(model.createState({}, gradient)).toBeNull();
    expect(model.applySelection(state, gradient)).toBe(false);
    expect(model.setMode(state, 'gradient')).toBe(false);
    expect(model.setAlphaPercent(state, 20)).toBe(false);
    expect(model.createState({ allowAlpha: true }, gradient)).toBeNull();
    expect(model.exportSelection(model.createState({ allowGradient: true }, gradient)!)).toEqual({ type: 'gradient', colors: ['#FF0000FF', '#0000FFFF'] });
  });

  it('gradient endpoint edits keep order and preserve unedited byte alpha', () => {
    const state = model.createState({ allowGradient: true, allowAlpha: true }, { type: 'gradient', colors: ['#FF000001', '#0000FF80'] })!;
    state.active = 0; model.setRgb(state, [0, 255, 0]);
    state.active = 1; model.setHex(state, '#112233');
    expect(model.exportSelection(state)).toEqual({ type: 'gradient', colors: ['#00FF0001', '#11223380'] });
    model.setAlphaPercent(state, 0);
    expect(model.exportSelection(state)!.colors).toEqual(['#00FF0001', '#11223300']);
    model.setAlphaPercent(state, 100);
    expect(model.exportSelection(state)!.colors[1]).toBe('#112233FF');
  });

  it('favorites retain alpha and gradient even when the selection disables them', () => {
    const favorite: model.Selection = { type: 'solid', colors: ['#ABCDEF80'] };
    const gradient: model.Selection = { type: 'gradient', colors: ['#FFFFFF00', '#00000010'] };
    const favorites = model.normalizeFavorites([favorite, gradient]);
    const state = model.createState()!;
    expect(model.applySelection(state, favorites[0])).toBe(true);
    expect(model.exportSelection(state)).toEqual({ type: 'solid', colors: ['#ABCDEFFF'] });
    expect(favorites).toEqual([favorite, gradient]);
    expect(model.applySelection(state, favorites[1])).toBe(false);
    expect(model.normalizeFavorites(Array(25).fill(favorite))).toHaveLength(24);
    // Saving moves a colour to the front without duplicates.
    expect(model.addFavorite([favorite, gradient], gradient)).toEqual([gradient, favorite]);
  });

  it('invalid cardinality and channel edits cannot change a selection', () => {
    const state = model.createState({ allowAlpha: true })!;
    const before = model.exportSelection(state);
    for (const v of [{ type: 'solid', colors: [] }, { type: 'solid', colors: ['#112233', '#445566'] }, { type: 'gradient', colors: ['#112233'] }, { type: 'other', colors: ['#112233'] }]) {
      expect(model.applySelection(state, v as model.Selection)).toBe(false);
    }
    expect(model.setHex(state, '#GG2233')).toBe(false);
    for (const v of [-1, 101, NaN, Infinity]) expect(model.setAlphaPercent(state, v)).toBe(false);
    expect(model.setRgb(state, [256, 0, 0])).toBe(false);
    expect(model.exportSelection(state)).toEqual(before);
  });

  it('multi-colour gradients stay at 2 colours unless the caller raises the limit', () => {
    const five: model.Selection = { type: 'gradient', colors: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF'] };
    expect(model.normalizeSelection(five, { allowGradient: true })).toBeNull();
    expect(model.createState({ allowGradient: true, maxGradientColors: 7 }, five)!.gradient).toHaveLength(5);
    expect(model.normalizeSelection({ ...five, colors: Array(8).fill('#000000') }, { allowGradient: true }, 7)).toBeNull();
    expect(model.createState({ allowGradient: true, maxGradientColors: 99 })!.maxGradientColors).toBe(model.MAX_GRADIENT_COLORS);
  });

  it('adding and removing gradient colours keeps order, selection and the 2..max limits', () => {
    const state = model.createState({ allowGradient: true, allowAlpha: true, maxGradientColors: 4 }, { type: 'gradient', colors: ['#FF000080', '#0000FFFF'] })!;
    expect(model.removeGradientColor(state)).toBe(false);
    expect(model.addGradientColor(state)).toBe(true);
    expect(model.exportSelection(state)!.colors).toEqual(['#FF000080', '#BFFF0080', '#0000FFFF']);
    expect(state.active).toBe(1);
    state.active = 2; expect(model.addGradientColor(state)).toBe(true);
    expect(state.active).toBe(3);
    expect(model.addGradientColor(state)).toBe(false);
    state.active = 1; expect(model.removeGradientColor(state)).toBe(true);
    expect(model.exportSelection(state)!.colors.slice(0, 2)).toEqual(['#FF000080', '#0000FFFF']);
    model.applySelection(state, { type: 'gradient', colors: ['#111111', '#222222'] });
    state.active = 1; model.addGradientColor(state); model.addGradientColor(state);
    model.applySelection(state, { type: 'gradient', colors: ['#111111', '#222222'] });
    expect(state.active).toBe(1);
  });

  it('a new gradient starts at the solid colour and its 75° hue neighbour', () => {
    const state = model.createState({ allowGradient: true, allowAlpha: true }, { type: 'solid', colors: ['#FF000080'] })!;
    expect(model.setMode(state, 'gradient')).toBe(true);
    expect(model.exportSelection(state)!.colors).toEqual(['#FF000080', '#BFFF0080']);
  });

  it('palettes: Orca 2.5 sizes and the filter', () => {
    expect([PALETTES.basic.length, PALETTES.orca.length, PALETTES.ral.length, PALETTES.gradient.length]).toEqual([151, 50, 223, 12]);
    expect(PALETTES.ral.filter((e) => model.paletteMatches(e, '9010'))).toEqual([{ hex: '#FFFFFF', name: '9010 Pure white' }]);
    expect(model.paletteMatches({ name: 'Coral fire', hex: '#ED1C24' }, '#ed1c')).toBe(true);
    expect(model.paletteMatches({ name: 'Coral fire', hex: '#ED1C24' }, 'coral blue')).toBe(false);
  });
});

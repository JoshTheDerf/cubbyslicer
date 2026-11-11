import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import {
  contrastText, configFilamentColour, formatFilamentColour, fromInt, hexToInt, intToCss, isTranslucent, mixColour,
  normaliseHex, parseColour, parseColourOr, parseFilamentColour, swatchBackground, toHex, toInt, toRgb01,
  toThreeColor, withRgb,
} from './colour';

describe('parseColour', () => {
  it('reads Orca #RRGGBB and #RRGGBBAA', () => {
    expect(parseColour('#F2754E')).toEqual({ r: 0xf2, g: 0x75, b: 0x4e, a: 255 });
    expect(parseColour('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 0x80 });
  });
  it('is lenient on short forms, missing # and whitespace', () => {
    expect(parseColour(' abc ')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 255 });
    expect(parseColour('#abcd')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 0xdd });
  });
  it('rejects junk', () => {
    for (const s of ['', '#', '#12345', '#1234567', 'red', '#GGGGGG', undefined, null]) expect(parseColour(s)).toBeNull();
  });
  it('parseColourOr falls back', () => {
    expect(parseColourOr('nope', '#010203')).toEqual({ r: 1, g: 2, b: 3, a: 255 });
  });
});

describe('formatting', () => {
  it('toHex is uppercase and adds alpha only when translucent by default', () => {
    expect(toHex({ r: 255, g: 1, b: 16, a: 255 })).toBe('#FF0110');
    expect(toHex({ r: 255, g: 1, b: 16, a: 128 })).toBe('#FF011080');
    expect(toHex({ r: 255, g: 1, b: 16, a: 128 }, 'never')).toBe('#FF0110');
    expect(toHex({ r: 255, g: 1, b: 16 }, 'always')).toBe('#FF0110FF');
    expect(toHex({ r: 300, g: -4, b: 12.6 })).toBe('#FF000D');
  });
  it('normalises and round-trips', () => {
    expect(normaliseHex('#abc')).toBe('#AABBCC');
    expect(normaliseHex('#aabbccff')).toBe('#AABBCC');
    expect(normaliseHex('x')).toBeNull();
  });
  it('withRgb keeps the old alpha', () => {
    expect(withRgb('#11223344', '#AABBCC')).toBe('#AABBCC44');
    expect(withRgb('#112233', 'aabbcc')).toBe('#AABBCC');
    expect(withRgb('', '#abcdef')).toBe('#ABCDEF');
    expect(withRgb('#112233', 'nope')).toBeNull();
  });
  it('integer forms', () => {
    expect(hexToInt('#12345678')).toBe(0x123456);
    expect(hexToInt('zz')).toBeNull();
    expect(toInt(fromInt(0xabcdef))).toBe(0xabcdef);
    expect(intToCss(0xff)).toBe('#0000ff');
  });
  it('isTranslucent', () => {
    expect(isTranslucent('#000000FE')).toBe(true);
    expect(isTranslucent('#000000FF')).toBe(false);
    expect(isTranslucent('#000000')).toBe(false);
    expect(isTranslucent('nope')).toBe(false);
  });
});

describe('derived colours', () => {
  it('contrastText matches the dialogs’ Rec.601 > 150 rule', () => {
    expect(contrastText('#FFFFFF')).toBe('#111');
    expect(contrastText('#000000')).toBe('#fff');
    expect(contrastText('#969696')).toBe('#fff'); // exactly 150
    expect(contrastText('#979797')).toBe('#111');
    expect(contrastText('nonsense')).toBe('#fff');
  });
  it('contrastText ignores alpha', () => {
    expect(contrastText('#00000010')).toBe('#fff');
    expect(contrastText('#FFFFFF10')).toBe('#111');
  });
  it('toRgb01 / toThreeColor', () => {
    expect(toRgb01({ r: 255, g: 0, b: 51 })).toEqual([1, 0, 0.2]);
    const c = toThreeColor('#FF8000CC');
    expect(c.getHexString()).toBe(new Color('#ff8000').getHexString());
    expect(toThreeColor('nope', '#00ff00').getHex()).toBe(0x00ff00);
  });
  it('mixColour', () => {
    expect(mixColour({ r: 0, g: 0, b: 0, a: 0 }, { r: 200, g: 100, b: 50, a: 255 }, 0.5)).toEqual({ r: 100, g: 50, b: 25, a: 127.5 });
  });
});

describe('Orca 2.5 filament colours', () => {
  it('single colour: filament_colour alone or with an empty multi value', () => {
    const fc = parseFilamentColour('#FF0000', '', '1');
    expect(fc).toEqual({ colours: [{ r: 255, g: 0, b: 0, a: 255 }], gradient: false });
    expect(parseFilamentColour('#FF0000')).toEqual(fc);
  });
  it('multi colour is space separated; type "0" means gradient', () => {
    const seg = parseFilamentColour('#FF0000', '#FF0000 #00FF00 #0000FF', '1');
    expect(seg.colours.map((c) => toHex(c))).toEqual(['#FF0000', '#00FF00', '#0000FF']);
    expect(seg.gradient).toBe(false);
    expect(parseFilamentColour('#FF0000', '#FF0000  #00FF0080', '0').gradient).toBe(true);
  });
  it('gradient needs two colours', () => {
    expect(parseFilamentColour('#FF0000', '#FF0000', '0').gradient).toBe(false);
  });
  it('bad entries are skipped; nothing usable gives the fallback', () => {
    expect(parseFilamentColour('#FF0000', 'junk #00FF00').colours.map((c) => toHex(c))).toEqual(['#00FF00']);
    expect(toHex(parseFilamentColour('', '').colours[0])).toBe('#F2754E');
    expect(toHex(parseFilamentColour(undefined, undefined, undefined, '#123456').colours[0])).toBe('#123456');
  });
  it('keeps opacity', () => {
    expect(parseFilamentColour('#FFFFFF40').colours[0].a).toBe(0x40);
  });
  it('reads a slot from a config (arrays or serialized strings)', () => {
    const cfg = {
      filament_colour: ['#111111', '#22222280'],
      filament_multi_colour: ['', '#222222 #333333'],
      filament_colour_type: ['1', '0'],
    };
    expect(configFilamentColour(cfg, 0).colours.map((c) => toHex(c))).toEqual(['#111111']);
    const s1 = configFilamentColour(cfg, 1);
    expect(s1.gradient).toBe(true);
    expect(s1.colours.length).toBe(2);
    expect(configFilamentColour({ filament_colour: '#111111;#222222' }, 1).colours.map((c) => toHex(c))).toEqual(['#222222']);
    expect(toHex(configFilamentColour({}, 3).colours[0])).toBe('#F2754E');
  });
  it('formats back to the three config values', () => {
    expect(formatFilamentColour(parseFilamentColour('#AA0000', '#aa0000 #00bb0080', '0'))).toEqual({
      filament_colour: '#AA0000', filament_multi_colour: '#AA0000 #00BB0080', filament_colour_type: '0',
    });
    expect(formatFilamentColour(parseFilamentColour('#AA0000'))).toEqual({
      filament_colour: '#AA0000', filament_multi_colour: '#AA0000', filament_colour_type: '1',
    });
  });
});

describe('swatchBackground', () => {
  it('opaque single colour is a flat colour', () => {
    expect(swatchBackground('#ff0000')).toBe('#FF0000');
    expect(swatchBackground({ r: 0, g: 0, b: 255, a: 255 })).toBe('#0000FF');
  });
  it('translucent colours sit on the checkerboard', () => {
    const bg = swatchBackground('#FF000080');
    expect(bg).toMatch(/^linear-gradient\(#FF000080, #FF000080\), repeating-conic-gradient\(#D9D9D9 0 25%, #FFFFFF 0 50%\)/);
  });
  it('gradient blends, segments get hard stops', () => {
    expect(swatchBackground(parseFilamentColour('#FF0000', '#FF0000 #0000FF', '0'))).toBe('linear-gradient(to right, #FF0000, #0000FF)');
    expect(swatchBackground(parseFilamentColour('#FF0000', '#FF0000 #00FF00 #0000FF', '1')))
      .toBe('linear-gradient(to right, #FF0000 0% 33.33%, #00FF00 33.33% 66.67%, #0000FF 66.67% 100%)');
  });
});

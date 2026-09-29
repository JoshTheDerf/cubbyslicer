import { describe, expect, it } from 'vitest';
import type { ConfigOptionDef } from '../engine/types';
import {
  configsEqual, escapeStrings, joinVector, normalizeInput, normalizeValue, parseDefault, parseFloatOrPercent, parsePoint,
  splitVector, unescapeStrings, valuesEqual,
} from './values';

const def = (type: ConfigOptionDef['type'], dflt = '', extra: Partial<ConfigOptionDef> = {}): ConfigOptionDef => ({
  type, label: 'x', fullLabel: 'x', category: '', tooltip: '', sidetext: '', mode: 'simple', min: null, max: null,
  default: dflt, scope: 'print', ...extra,
});

describe('string vector (c-style) serialization', () => {
  it('round-trips plain and complex strings', () => {
    const cases: string[][] = [['a', 'b'], [''], ['with space', 'semi;colon', 'quote"d', 'back\\slash', 'multi\nline'], ['', 'x']];
    for (const c of cases) expect(unescapeStrings(escapeStrings(c))).toEqual(c);
  });
  it('matches Orca output for simple lists', () => {
    expect(escapeStrings(['PLA', 'PETG'])).toBe('PLA;PETG');
    expect(escapeStrings([''])).toBe('""');
    expect(escapeStrings(['Generic PLA'])).toBe('"Generic PLA"');
  });
  it('parses empty input as no elements', () => {
    expect(unescapeStrings('')).toEqual([]);
  });
});

describe('defaults and raw preset values', () => {
  it('parses schema defaults into the option shape', () => {
    expect(parseDefault(def('float', '0.2'))).toBe('0.2');
    expect(parseDefault(def('floats', '500,200'))).toEqual(['500', '200']);
    expect(parseDefault(def('points', '0x0,200x0,200x200,0x200'))).toEqual(['0x0', '200x0', '200x200', '0x200']);
    expect(parseDefault(def('strings', '"#F2754E"'))).toEqual(['#F2754E']);
    expect(parseDefault(def('percents', '85%'))).toEqual(['85%']);
  });
  it('normalizes raw JSON values', () => {
    expect(normalizeValue(def('floats'), '0.4')).toEqual(['0.4']);
    expect(normalizeValue(def('floats'), ['0.4', 0.6])).toEqual(['0.4', '0.6']);
    expect(normalizeValue(def('float'), ['0.2'])).toBe('0.2');
    expect(normalizeValue(def('bool'), true)).toBe('1');
    expect(normalizeValue(def('int'), 3)).toBe('3');
    expect(normalizeValue(undefined, ['a'])).toEqual(['a']);
  });
  it('splits and joins vectors per type', () => {
    expect(splitVector('floats', '1, 2,3')).toEqual(['1', '2', '3']);
    expect(joinVector('strings', ['a b', 'c'])).toBe('"a b";c');
    expect(joinVector('points', ['0x0', '1x1'])).toBe('0x0,1x1');
  });
});

describe('scalar input normalisation', () => {
  it('handles each type', () => {
    expect(normalizeInput('bool', 'true')).toBe('1');
    expect(normalizeInput('bool', '0')).toBe('0');
    expect(normalizeInput('int', ' 5 ')).toBe('5');
    expect(normalizeInput('int', '5.5')).toBe('5.5'); // left for validation to flag
    expect(normalizeInput('float', '1.50')).toBe('1.5');
    expect(normalizeInput('float', '0.30000000000000004')).toBe('0.3');
    expect(normalizeInput('percent', '15 %')).toBe('15%');
    expect(normalizeInput('percent', '15')).toBe('15%');
    expect(normalizeInput('floatOrPercent', '50%')).toBe('50%');
    expect(normalizeInput('floatOrPercent', '0.45')).toBe('0.45');
    expect(normalizeInput('floats', '2.0')).toBe('2');
    expect(normalizeInput('point', '10 x 20')).toBe('10x20');
    expect(normalizeInput('string', '  keep  ')).toBe('  keep  ');
    expect(normalizeInput('float', 'abc')).toBe('abc');
  });
  it('parses floatOrPercent and points', () => {
    expect(parseFloatOrPercent('50%')).toEqual({ value: 50, percent: true });
    expect(parseFloatOrPercent('0.4')).toEqual({ value: 0.4, percent: false });
    expect(parseFloatOrPercent('x')).toBeNull();
    expect(parsePoint('-5x10.5')).toEqual([-5, 10.5]);
    expect(parsePoint('5,10')).toBeNull();
  });
});

describe('equality', () => {
  it('compares values and configs element-wise', () => {
    expect(valuesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(valuesEqual(['a'], 'a')).toBe(false);
    expect(configsEqual({ a: '1', b: ['2'] }, { b: ['2'], a: '1' })).toBe(true);
    expect(configsEqual({ a: '1' }, { a: '1', b: '2' })).toBe(false);
  });
});

describe('scalar options given as JSON arrays', () => {
  it('joins with commas like Orca load_from_json (thumbnails)', () => {
    const def = { type: 'string' } as unknown as Parameters<typeof normalizeValue>[0];
    expect(normalizeValue(def, ['16x16/QOI', '313x173/QOI', '480x240/QOI'])).toBe('16x16/QOI,313x173/QOI,480x240/QOI');
  });
});

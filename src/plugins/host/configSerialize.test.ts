import { describe, expect, it } from 'vitest';
import { escapeStringsCstyle, parseOrcaValue, serializeOrcaValue, unescapeStringsCstyle } from './configSerialize';
import { escapeStrings, unescapeStrings } from '../../presets/values';

describe('Orca config serialization (ConfigOption::serialize)', () => {
  it('quotes strings items like escape_strings_cstyle', () => {
    expect(escapeStringsCstyle(['PLA', 'PETG'])).toBe('PLA;PETG');
    expect(escapeStringsCstyle(['Generic PLA', 'a;b'])).toBe('"Generic PLA";"a;b"');
    expect(escapeStringsCstyle([''])).toBe('""');
    expect(escapeStringsCstyle(['', 'x'])).toBe(';x');
    expect(escapeStringsCstyle(['say "hi"\\\n'])).toBe('"say \\"hi\\"\\\\\\n"');
    expect(escapeStringsCstyle([])).toBe('');
  });

  it('agrees with the preset store\'s own escaping and round-trips', () => {
    for (const v of [['PLA', 'PETG'], ['Generic PLA', 'a;b'], [''], ['x', ''], ['multi\nline', 'tab\there', 'q"uote']]) {
      expect(escapeStringsCstyle(v)).toBe(escapeStrings(v));
      expect(unescapeStringsCstyle(escapeStringsCstyle(v))).toEqual(v);
      expect(unescapeStrings(escapeStringsCstyle(v))).toEqual(v);
    }
  });

  it('serializes each option type', () => {
    expect(serializeOrcaValue('strings', ['#FF0000', '#00FF00'])).toBe('#FF0000;#00FF00');
    expect(serializeOrcaValue('floats', ['0.4', '0.6'])).toBe('0.4,0.6');
    expect(serializeOrcaValue('bools', ['1', 'false', '0'])).toBe('1,0,0');
    expect(serializeOrcaValue('bool', 'true')).toBe('1');
    expect(serializeOrcaValue('points', ['0x0', '220x0', '220x220'])).toBe('0x0,220x0,220x220');
    expect(serializeOrcaValue('percents', ['15%'])).toBe('15%');
    expect(serializeOrcaValue('float', '0.2')).toBe('0.2');
    expect(serializeOrcaValue('enum', 'gyroid')).toBe('gyroid');
    expect(serializeOrcaValue('string', 'G28\nG1 Z5 ; "home"')).toBe('G28\\nG1 Z5 ; \\"home\\"');
    expect(serializeOrcaValue('string', 'already\\nescaped')).toBe('already\\nescaped');
    expect(serializeOrcaValue(undefined, ['a b'])).toBe('"a b"');
    expect(serializeOrcaValue('float', undefined)).toBeNull();
  });

  it('parses serialized text back', () => {
    expect(parseOrcaValue('strings', '"Generic PLA";PETG')).toEqual(['Generic PLA', 'PETG']);
    expect(parseOrcaValue('floats', '0.4, 0.6')).toEqual(['0.4', '0.6']);
    expect(parseOrcaValue('string', 'G28\\nG1')).toBe('G28\nG1');
    expect(parseOrcaValue('ints', '')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { ConfigOptionDef, ConfigSchema } from '../engine/types';
import { validateConfig, validateScalar, validateValue } from './validate';

const d = (type: ConfigOptionDef['type'], extra: Partial<ConfigOptionDef> = {}): ConfigOptionDef => ({
  type, label: 'L', fullLabel: 'Label', category: '', tooltip: '', sidetext: '', mode: 'simple', min: null, max: null, default: '', scope: 'print', ...extra,
});

describe('validateScalar', () => {
  it('accepts both point notations for single points', () => {
    expect(validateScalar(d('point'), '0.5,0.5')).toBeNull();
    expect(validateScalar(d('point'), '10x20')).toBeNull();
    expect(validateScalar(d('point'), 'abc')).toMatch(/point/);
  });
  it('checks numbers, ranges and integers', () => {
    expect(validateScalar(d('float', { min: 0, max: 10 }), '5')).toBeNull();
    expect(validateScalar(d('float', { min: 0 }), '-1')).toMatch(/≥ 0/);
    expect(validateScalar(d('float', { max: 10 }), '11')).toMatch(/≤ 10/);
    expect(validateScalar(d('float'), 'abc')).toMatch(/number/);
    expect(validateScalar(d('int'), '2.5')).toMatch(/whole/);
    expect(validateScalar(d('int'), '3')).toBeNull();
  });
  it('checks percent / floatOrPercent', () => {
    expect(validateScalar(d('percent', { max: 100 }), '15%')).toBeNull();
    expect(validateScalar(d('percent', { max: 100 }), '150%')).toMatch(/≤ 100/);
    expect(validateScalar(d('floatOrPercent', { min: 0 }), '50%')).toBeNull();
    expect(validateScalar(d('floatOrPercent', { min: 0 }), '0.4')).toBeNull();
    expect(validateScalar(d('floatOrPercent'), 'x%')).toMatch(/percentage/);
  });
  it('checks enums (closed vs open), bools, points, nil', () => {
    const e = d('enum', { enumValues: ['a', 'b'] });
    expect(validateScalar(e, 'a')).toBeNull();
    expect(validateScalar(e, 'c')).toMatch(/not a valid/);
    expect(validateScalar({ ...e, guiType: 'f_enum_open' }, 'c')).toBeNull();
    expect(validateScalar(d('bool'), '1')).toBeNull();
    expect(validateScalar(d('bool'), 'maybe')).toMatch(/on\/off/);
    expect(validateScalar(d('point'), '1x2')).toBeNull();
    expect(validateScalar(d('floats', { nullable: true }), 'nil')).toBeNull();
    expect(validateScalar(d('floats'), 'nil')).toMatch(/number/);
  });
});

describe('validateValue / validateConfig', () => {
  it('reports vector elements with their index', () => {
    expect(validateValue(d('floats', { min: 0 }), ['0.4', '-1'])).toEqual([{ index: 1, message: 'must be ≥ 0' }]);
    expect(validateValue(d('points'), ['0x0', 'bad'])).toEqual([{ index: 1, message: 'must be a point like 10x20' }]);
  });
  it('validates a whole config against the schema', () => {
    const schema: ConfigSchema = { engine: 'orca', version: 't', options: { a: d('int', { min: 1 }), b: d('string') } };
    const probs = validateConfig(schema, { a: '0', b: 'x', unknown: '?' });
    expect(probs).toHaveLength(1);
    expect(probs[0]).toMatchObject({ key: 'a', label: 'Label', severity: 'error' });
  });
});

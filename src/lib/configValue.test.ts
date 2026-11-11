import { describe, expect, it } from 'vitest';
import {
  SCALAR, absValue, asList, cfgAbs, cfgBool, cfgNumber, cfgString, joinValue, parseFloatOrPercent, toBool, toNumber,
  valueAt, valueCount, variantIndex, variantName, variantSelector, variantValue,
} from './configValue';
import type { FlatConfig } from '../engine/types';

describe('valueAt', () => {
  it('reads scalars and vector elements', () => {
    expect(valueAt('5', SCALAR)).toBe('5');
    expect(valueAt('5', 3)).toBe('5');
    expect(valueAt(['a', 'b'], 1)).toBe('b');
    expect(valueAt(undefined, 0)).toBeUndefined();
  });
  it('falls back to element 0 out of range (Orca get_at)', () => {
    expect(valueAt(['a', 'b'], 5)).toBe('a');
    expect(valueAt([], 0)).toBeUndefined();
  });
  it('splits serialized vectors only when asked', () => {
    expect(valueAt('0.4,0.6', 1)).toBe('0.4,0.6');
    expect(valueAt('0.4,0.6', 1, { serialized: true })).toBe('0.6');
    expect(valueAt('0.4;0.6', 4, { serialized: true })).toBe('0.4');
  });
  it('asList / valueCount / joinValue', () => {
    expect(asList('x')).toEqual(['x']);
    expect(asList('x,y', { serialized: true })).toEqual(['x', 'y']);
    expect(asList(undefined)).toEqual([]);
    expect(valueCount(['a', 'b', 'c'])).toBe(3);
    expect(valueCount('a;b;', { serialized: true })).toBe(2);
    expect(valueCount('a')).toBe(1);
    expect(valueCount(undefined)).toBe(0);
    expect(joinValue(['1', '2'])).toBe('1,2');
    expect(joinValue(['1', '2'], ';')).toBe('1;2');
    expect(joinValue('x')).toBe('x');
    expect(joinValue(undefined)).toBe('');
  });
});

describe('element parsers', () => {
  it('toNumber', () => {
    expect(toNumber('0.2')).toBe(0.2);
    expect(toNumber(' 3 ')).toBe(3);
    expect(toNumber('110%')).toBe(110);
    expect(toNumber('nil', 7)).toBe(7);
    expect(toNumber('', 7)).toBe(7);
    expect(toNumber('abc', 7)).toBe(7);
    expect(toNumber(undefined)).toBeNaN();
  });
  it('toBool', () => {
    expect(toBool('1')).toBe(true);
    expect(toBool('TRUE')).toBe(true);
    expect(toBool('0', true)).toBe(false);
    expect(toBool('false', true)).toBe(false);
    expect(toBool('enabled')).toBe(false);
    expect(toBool(undefined, true)).toBe(true);
  });
  it('floatOrPercent', () => {
    expect(parseFloatOrPercent('110%')).toEqual({ value: 110, percent: true });
    expect(parseFloatOrPercent('0.42')).toEqual({ value: 0.42, percent: false });
    expect(parseFloatOrPercent('nil')).toBeNull();
    expect(absValue('50%', 0.4)).toBeCloseTo(0.2);
    expect(absValue('0.3', 0.4)).toBe(0.3);
    expect(absValue('', 0.4, 9)).toBe(9);
  });
});

describe('config reads', () => {
  const cfg: FlatConfig = { a: ['1', '2'], s: 'by object', b: ['0', '1'], w: '150%', e: '' };
  it('index is explicit', () => {
    expect(cfgNumber(cfg, 'a', 1)).toBe(2);
    expect(cfgNumber(cfg, 'a', 0)).toBe(1);
    expect(cfgNumber(cfg, 'missing', 0, 4)).toBe(4);
    expect(cfgNumber(cfg, 'e', 0, 4)).toBe(4);
    expect(cfgString(cfg, 's', SCALAR)).toBe('by object');
    expect(cfgString(cfg, 'missing', SCALAR)).toBe('');
    expect(cfgBool(cfg, 'b', 1)).toBe(true);
    expect(cfgBool(cfg, 'b', 0, true)).toBe(false);
    expect(cfgAbs(cfg, 'w', SCALAR, 0.4)).toBeCloseTo(0.6);
  });
});

describe('nozzle variants (Orca 2.5)', () => {
  it('variantName joins type and volume; Hybrid reads Standard', () => {
    expect(variantName('Direct Drive', 'High Flow')).toBe('Direct Drive High Flow');
    expect(variantName('Bowden', 'Hybrid')).toBe('Bowden Standard');
  });

  // Two extruders: left Direct Drive {Standard, High Flow}, right Direct Drive Standard only.
  const cfg: FlatConfig = {
    extruder_type: ['Direct Drive', 'Direct Drive'],
    nozzle_volume_type: ['High Flow', 'Standard'],
    print_extruder_id: ['1', '1', '2'],
    print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard'],
    outer_wall_speed: ['200', '300', '150'],
    printer_extruder_id: ['1', '1', '2'],
    printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard'],
    machine_max_speed_x: ['500', '200', '600', '250', '700', '300'],
  };

  it('finds the column whose id and variant match', () => {
    expect(variantIndex(cfg, 'print', { extruderId: 1, extruderType: 'Direct Drive', nozzleVolumeType: 'Standard' })).toBe(0);
    expect(variantIndex(cfg, 'print', variantSelector(cfg, 0))).toBe(1);
    expect(variantIndex(cfg, 'print', variantSelector(cfg, 1))).toBe(2);
  });
  it('honours stride (machine limits: normal / silent pairs)', () => {
    expect(variantIndex(cfg, 'printer', variantSelector(cfg, 0), 2)).toBe(2);
    expect(variantIndex(cfg, 'printer', variantSelector(cfg, 1), 2)).toBe(4);
  });
  it('-1 when nothing matches or there is no variant table', () => {
    expect(variantIndex(cfg, 'print', { extruderId: 2, extruderType: 'Direct Drive', nozzleVolumeType: 'High Flow' })).toBe(-1);
    expect(variantIndex(cfg, 'print', { extruderId: 1, extruderType: 'Bowden', nozzleVolumeType: 'Standard' })).toBe(-1);
    expect(variantIndex({}, 'print', { extruderId: 1, extruderType: 'Direct Drive', nozzleVolumeType: 'Standard' })).toBe(-1);
  });
  it('variant only when there is no id column (filament family, or id key absent)', () => {
    const f: FlatConfig = { filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'] };
    expect(variantIndex(f, 'filament', { extruderId: 2, extruderType: 'Direct Drive', nozzleVolumeType: 'High Flow' })).toBe(1);
    const p: FlatConfig = { print_extruder_variant: ['Direct Drive Standard', 'Bowden Standard'] };
    expect(variantIndex(p, 'print', { extruderId: 9, extruderType: 'Bowden', nozzleVolumeType: 'Standard' })).toBe(1);
  });
  it('incomplete id column: ids come from extruder_variant_list order', () => {
    const g: FlatConfig = {
      extruder_variant_list: ['Direct Drive Standard,Direct Drive High Flow', 'Direct Drive Standard'],
      print_extruder_id: ['1'],
      print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard'],
    };
    expect(variantIndex(g, 'print', { extruderId: 2, extruderType: 'Direct Drive', nozzleVolumeType: 'Standard' })).toBe(2);
    expect(variantIndex(g, 'print', { extruderId: 1, extruderType: 'Direct Drive', nozzleVolumeType: 'High Flow' })).toBe(1);
  });
  it('variantValue reads the right column, or the extruder element without a table', () => {
    expect(variantValue(cfg, 'outer_wall_speed', 'print', 0)).toBe('300');
    expect(variantValue(cfg, 'outer_wall_speed', 'print', 1)).toBe('150');
    expect(variantValue({ outer_wall_speed: ['120', '130'] }, 'outer_wall_speed', 'print', 1)).toBe('130');
    expect(variantValue({ outer_wall_speed: '120' }, 'outer_wall_speed', 'print', 1)).toBe('120');
  });
  it('variantSelector defaults', () => {
    expect(variantSelector({}, 0)).toEqual({ extruderId: 1, extruderType: 'Direct Drive', nozzleVolumeType: 'Standard' });
  });
});

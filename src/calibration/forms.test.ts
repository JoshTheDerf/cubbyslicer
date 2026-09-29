import { describe, expect, it } from 'vitest';
import { corneringParams, paDefaults, paParams, rangeParams, shaperTypesFor, snapTemp, tempFilamentOf, tempParams, tempRangeFor } from './forms';
import { calibNumberString, findOptimalPASpeed, mm3PerMm, PAPatternGeometry, parseIntList } from './flowMath';

describe('calibration forms', () => {
  it('temperature: presets, snapping and validation like Temp_Calibration_Dlg', () => {
    expect(tempRangeFor('PETG')).toEqual({ start: 250, end: 230 });
    expect(tempFilamentOf('PLA-CF')).toBe('PLA');
    expect(tempFilamentOf('ASA')).toBe('ABS/ASA');
    expect(snapTemp(233)).toBe(230);
    expect(snapTemp(900)).toBe(500);
    expect(snapTemp(20)).toBe(155);
    expect(tempParams(230, 190)).toEqual({ mode: 'temp_tower', start: 230, end: 190, step: 5 });
    expect(typeof tempParams(200, 199)).toBe('string');
  });

  it('pressure advance defaults follow reset_params', () => {
    expect(paDefaults('pa_tower', false)).toEqual({ start: 0, end: 0.1, step: 0.002, printNumbers: false });
    expect(paDefaults('pa_pattern', false)).toMatchObject({ end: 0.08, step: 0.005 });
    expect(paDefaults('pa_pattern', true)).toMatchObject({ end: 1, step: 0.05 });
    expect(paDefaults('pa_line', true)).toMatchObject({ end: 1, step: 0.02, printNumbers: true });
  });

  it('pressure advance params: lists, swapped inputs', () => {
    const ok = paParams({ method: 'pa_pattern', bowden: false, start: 0, end: 0.08, step: 0.005, printNumbers: true, accels: '1000, 5000', speeds: '100 200' });
    expect(ok).toMatchObject({ mode: 'pa_pattern', accelerations: [1000, 5000], speeds: [100, 200] });
    const swapped = paParams({ method: 'pa_pattern', bowden: false, start: 0, end: 0.08, step: 0.005, printNumbers: true, accels: '100', speeds: '500' });
    expect(typeof swapped).toBe('string');
    expect(typeof paParams({ method: 'pa_line', bowden: false, start: 0.1, end: 0.1, step: 0.002, printNumbers: true, accels: '', speeds: '' })).toBe('string');
  });

  it('range dialogs validate like Orca', () => {
    expect(rangeParams('retraction_tower', 0, 2, 0.1)).toMatchObject({ mode: 'retraction_tower' });
    expect(typeof rangeParams('vfa_tower', 10, 200, 10)).toBe('string');
    expect(typeof rangeParams('vol_speed_tower', 5, 5.2, 0.5)).toBe('string');
  });

  it('input shaper types per firmware and cornering limits', () => {
    expect(shaperTypesFor('klipper')).toContain('MZV');
    expect(shaperTypesFor('marlin2')).toEqual(['ZV']);
    const r = corneringParams(1, 25, 0, false);
    expect(typeof r).toBe('object');
    expect((r as { warning?: string }).warning).toMatch(/layer shifts/);
    expect(typeof corneringParams(0, 0.4, 2, true)).toBe('string');
  });
});

describe('calibration maths', () => {
  it('flow and PA speed', () => {
    expect(mm3PerMm(0.45, 0.2)).toBeCloseTo(0.2 * (0.45 - 0.2 * (1 - Math.PI / 4)), 9);
    // at least 100 mm/s, capped by the max volumetric speed
    expect(findOptimalPASpeed({ nozzle_diameter: ['0.4'], filament_max_volumetric_speed: ['5'], outer_wall_speed: '60' }, 0.45, 0.2)).toBe(Math.floor(5 / mm3PerMm(0.45, 0.2)));
    expect(findOptimalPASpeed({ nozzle_diameter: ['0.4'], filament_max_volumetric_speed: ['50'], outer_wall_speed: '60' }, 0.45, 0.2)).toBe(100);
  });

  it('number labels and int lists', () => {
    expect(calibNumberString(0.005)).toBe('0.005');
    expect(calibNumberString(10000)).toBe('10000');
    expect(parseIntList('1000, 2000 x 3000')).toEqual([1000, 2000, 3000]);
  });

  it('PA pattern footprint', () => {
    const cfg = { nozzle_diameter: ['0.4'], line_width: '0.45', initial_layer_line_width: '0.56', layer_height: '0.2', initial_layer_print_height: '0.25', wall_loops: '3' };
    const g = new PAPatternGeometry(cfg, 0, 0.08, 0.005, 5000);
    expect(g.numPatterns()).toBe(17);
    expect(g.maxLayerZ()).toBeCloseTo(0.25 + 3 * 0.2, 9);
    expect(g.maxNumberingLength()).toBe(4); // every other label: "0.01", …, "5000"
    expect(g.printSizeX()).toBeGreaterThan(60);
    expect(g.printSizeY()).toBeCloseTo(2 * Math.sin(Math.PI / 4) * 30 + (4 * 2 + 3 * 1) + 2 + 0.56, 6);
    const off = g.handlePosOffset();
    expect(off[2]).toBeCloseTo(g.maxLayerZ() / 2, 9);
  });
});

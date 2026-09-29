import { describe, expect, it } from 'vitest';
import {
  autoFlushMatrix, autoFlushUpdate, calcFlushVolume, deltaE2000, flattenMatrices, FLUSH_TO_SUPPORT, matrixSize, MIN_FLUSH_FROM_SUPPORT,
  minFlushVolumes, nozzleMatrix, parseColour, resizeFlat,
} from './flushCalc';

describe('flush volume calculator (FlushVolCalc.cpp)', () => {
  it('parses colours', () => {
    expect(parseColour('#FF8000')).toEqual({ r: 255, g: 128, b: 0, a: 255 });
    expect(parseColour('#00000000').a).toBe(0);
    expect(parseColour('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 255 });
  });

  it('uses the measured table for known colours (dataset 0)', () => {
    // "#000000 #F4EE2A 386" in flush_data_standard.txt
    expect(calcFlushVolume('#000000', '#F4EE2A', 0, 0)).toBe(386);
    // near-identical colours map onto the same table entry (ΔE ≤ 5)
    expect(calcFlushVolume('#010101', '#F4EE2B', 0, 0)).toBe(386);
    // min flush volume is added on top
    expect(calcFlushVolume('#000000', '#F4EE2A', 100, 0)).toBe(486);
  });

  it('falls back to the HSV/luminance model and is asymmetric (dark→light costs more)', () => {
    const toLight = calcFlushVolume('#202040', '#F0E0D0', 0, 0);
    const toDark = calcFlushVolume('#F0E0D0', '#202040', 0, 0);
    expect(toLight).toBeGreaterThan(toDark);
    expect(toDark).toBeGreaterThanOrEqual(60);
    expect(calcFlushVolume('#123456', '#123456', 0, 0)).toBe(60);
  });

  it('CIEDE2000 is zero for identical colours', () => {
    expect(deltaE2000([50, 10, 10], [50, 10, 10])).toBeCloseTo(0, 9);
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3); // Sharma et al. test pair 1
  });
});

describe('flush matrix', () => {
  it('builds an n×n matrix with support rules', () => {
    const m = autoFlushMatrix(['#FFFFFF', '#000000', '#FF0000'], { minFlush: [0, 0, 0], support: [false, false, true] });
    expect(m[0][0]).toBe(0);
    expect(m[0][2]).toBe(FLUSH_TO_SUPPORT);
    expect(m[2][0]).toBeGreaterThanOrEqual(MIN_FLUSH_FROM_SUPPORT);
    expect(m[1][0]).toBeGreaterThan(m[0][1]);
  });

  it('updates only the changed row and column', () => {
    const base = [[0, 1, 2], [3, 0, 4], [5, 6, 0]];
    const next = autoFlushUpdate(base, ['#FFFFFF', '#000000', '#00FF00'], 2, { minFlush: [0, 0, 0] });
    expect(next[0][1]).toBe(1);
    expect(next[1][0]).toBe(3);
    expect(next[0][2]).not.toBe(2);
  });

  it('splits / joins multi-nozzle vectors and resizes', () => {
    const a = [[0, 10], [20, 0]], b = [[0, 30], [40, 0]];
    const flat = flattenMatrices([a, b]);
    expect(matrixSize(flat.length, 2)).toBe(2);
    expect(nozzleMatrix(flat, 2, 1, 2)).toEqual(b);
    const grown = resizeFlat(flat, 2, 3, 2, 99);
    expect(nozzleMatrix(grown, 3, 1, 2)).toEqual([[0, 30, 99], [40, 0, 99], [99, 99, 0]]);
    expect(resizeFlat(flat, 2, 1, 2)).toEqual([0, 0]);
  });

  it('computes minimum flush volumes from nozzle volume and long retraction', () => {
    expect(minFlushVolumes({ nozzle_volume: ['107'] }, 0, 2)).toEqual([107, 107]);
    const cfg = { nozzle_volume: ['100'], enable_long_retraction_when_cut: '2', long_retractions_when_cut: ['1'], retraction_distances_when_cut: ['18'],
      filament_long_retractions_when_cut: ['1', '0'], filament_retraction_distances_when_cut: ['10', '10'] };
    const [a, b] = minFlushVolumes(cfg, 0, 2);
    expect(a).toBe(Math.trunc(100 - (Math.PI * 1.75 * 1.75) / 4 * 10));
    expect(b).toBe(100);
  });
});

describe('multi-nozzle variants', () => {
  it('maps extruders to variant entries (H2D)', async () => {
    const { extruderVariantIndex, flushDataset } = await import('./flushCalc');
    const cfg = {
      printer_extruder_id: ['1', '1', '2', '2'],
      printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
      nozzle_volume_type: ['Standard', 'High Flow'], nozzle_flush_dataset: ['1', '2', '1', '2'],
    };
    expect(extruderVariantIndex(cfg, 0)).toBe(0);
    expect(extruderVariantIndex(cfg, 1)).toBe(3);
    expect(flushDataset(cfg, 1)).toBe(2);
    expect(extruderVariantIndex({}, 1)).toBe(1);
  });
});

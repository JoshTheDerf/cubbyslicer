import { describe, expect, it } from 'vitest';
import {
  autoFlushMatrix, autoFlushUpdate, calcFlushVolume, deltaE2000, flattenMatrices, FLUSH_TO_SUPPORT, matrixSize, MIN_FLUSH_FROM_SUPPORT,
  minFlushVolumes, nozzleMatrix, resizeFlat,
} from './flushCalc';

describe('flush volume calculator (FlushVolCalc.cpp)', () => {
  it('treats transparent and unparseable colours as white', () => {
    expect(calcFlushVolume('#FFFFFF00', '#000000', 0, 0)).toBe(calcFlushVolume('#FFFFFF', '#000000', 0, 0));
    expect(calcFlushVolume('nope', '#000000', 0, 0)).toBe(calcFlushVolume('#FFFFFF', '#000000', 0, 0));
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
  it('min flush reads the nozzle volume of the extruder\'s variant and each filament\'s own column', () => {
    const cfg = {
      printer_extruder_id: ['1', '1', '2', '2'],
      printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
      nozzle_diameter: ['0.4', '0.4'], nozzle_volume_type: ['Standard', 'High Flow'], nozzle_volume: ['130', '133', '145', '148'],
      enable_long_retraction_when_cut: '2', long_retractions_when_cut: ['0', '0', '0', '1'], retraction_distances_when_cut: ['10', '10', '10', '18'],
      // Filament 1: one column; filament 2: two columns (Standard / High Flow), printing on extruder 2.
      filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive Standard', 'Direct Drive High Flow'],
      filament_self_index: ['1', '2', '2'], filament_map: ['1', '2'],
      filament_long_retractions_when_cut: ['0', '0', '1'], filament_retraction_distances_when_cut: ['5', '5', '12'],
    };
    const [a, b] = minFlushVolumes(cfg, 1, 2);
    expect(a).toBe(148);
    expect(b).toBe(Math.trunc(148 - (Math.PI * 1.75 * 1.75) / 4 * 12));
  });
});

describe('mixed filament slots', () => {
  it('reads the physical block of a matrix over every slot (mixed slots never flush)', async () => {
    const { physicalBlock } = await import('./flushCalc');
    // 3 slots (2 physical + 1 mixed), 2 nozzles.
    const flat = [0, 1, 0, 2, 0, 0, 0, 0, 0, 0, 3, 0, 4, 0, 0, 0, 0, 0];
    expect(physicalBlock(flat, 2, 2)).toEqual([0, 1, 2, 0, 0, 3, 4, 0]);
    expect(physicalBlock([0, 5, 6, 0], 2, 1)).toEqual([0, 5, 6, 0]);
    expect(physicalBlock([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });
  it('picks a project\'s physical slots wherever the mixed ones sit (project open)', async () => {
    const { slotBlock } = await import('./flushCalc');
    // 3 slots, the mix in the middle: physical slots 0 and 2.
    const flat = [0, 11, 12, 21, 0, 23, 31, 32, 0];
    expect(slotBlock(flat, [0, 2], 1)).toEqual([0, 12, 31, 0]);
    expect(slotBlock(flat, [0, 1, 2], 1)).toEqual(flat);
    expect(slotBlock(flat, [0, 3], 1)).toBeNull();
    expect(slotBlock([1, 2, 3], [0], 1)).toBeNull();
  });
});

describe('matrix sized for the slice (the engine refuses any other size)', () => {
  it('fits a missing, single-nozzle or stale matrix to filaments² × nozzles', async () => {
    const { fitFlushMatrix } = await import('./flushCalc');
    const ok = [0, 1, 2, 0, 0, 3, 4, 0];
    expect(fitFlushMatrix(ok, 2, 2)).toBe(ok);
    // No project matrix (IDEX copy / mirror regression: the job carried none).
    expect(fitFlushMatrix([], 2, 2)).toEqual([0, 280, 280, 0, 0, 280, 280, 0]);
    // A 2×2 block for one nozzle is repeated per nozzle.
    expect(fitFlushMatrix([0, 5, 6, 0], 2, 2)).toEqual([0, 5, 6, 0, 0, 5, 6, 0]);
    // A 4×4 single-nozzle default on 2 filaments × 2 nozzles: its leading block, per nozzle.
    const four = Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 0 : 280 + i));
    expect(fitFlushMatrix(four, 2, 2)).toEqual([0, 281, 284, 0, 0, 281, 284, 0]);
    // Filament count changed on a 2-nozzle matrix: surviving pairs kept per nozzle.
    expect(fitFlushMatrix(ok, 3, 2)).toEqual([0, 1, 280, 2, 0, 280, 280, 280, 0, 0, 3, 280, 4, 0, 280, 280, 280, 0]);
    expect(fitFlushMatrix([], 1, 1)).toEqual([0]);
  });
});

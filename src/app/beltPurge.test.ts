import { describe, expect, it } from 'vitest';
import { flushMatrixOf, planPrism, prismMesh } from './beltPurge';

// BabyBelt-like: belt along Y, 45°, 200×300 bed, belt purge tower on.
const cfg = {
  belt_printer: '1', enable_belt_purge_tower: '1', belt_slice_rotation: 'x', belt_slice_rotation_angle: '45', layer_height: '0.2',
  purge_in_prime_tower: '0', single_extruder_multi_material: '0', prime_volume: '45', printable_height: '250', belt_purge_tower_width: '35',
  printable_area: ['0x0', '200x0', '200x300', '0x300'], nozzle_diameter: ['0.4'],
};
const parts = (filaments: number[]) => ({ filaments, box: { min: [50, 20, 0] as [number, number, number], max: [90, 60, 30] as [number, number, number] }, origin: [0, 0] as [number, number] });

describe('belt purge prism (ensure_belt_purge_tower)', () => {
  it('none for one filament, by-object prints, or with the tower off', () => {
    expect(planPrism(cfg, parts([1]), null)).toBeNull();
    expect(planPrism({ ...cfg, print_sequence: 'by object' }, parts([1, 2]), null)).toBeNull();
    expect(planPrism({ ...cfg, enable_belt_purge_tower: '0' }, parts([1, 2]), null)).toBeNull();
  });
  it('sized as desktop: height from prime volume, along the far lateral edge, spanning the parts along the belt', () => {
    const p = planPrism(cfg, parts([1, 2, 3]), null)!;
    expect(p.islands).toBe(2);
    expect(p.wSub).toBeCloseTo((35 - 1) / 2);
    const sin = Math.SQRT1_2;
    expect(p.height).toBeCloseTo((1.6 * 2 * 45 * sin) / (34 * 0.2 * 0.85), 6);
    // Lateral: against the right edge (200 − 1 − 35/2).
    expect(p.center[0]).toBeCloseTo(200 - 1 - 17.5);
    // Along the belt: from the parts' start minus the ramp to their end + margin + ramp + top reach (cot 45° = 1).
    const ramp = p.height / sin;
    const end = Math.min(60 + 5 + ramp + 30, 300 - 1), start = Math.max(0, Math.min(20 - ramp, end - 10));
    expect(p.length).toBeCloseTo(end - start);
    const m = prismMesh(p);
    expect(m.size[0]).toBeCloseTo(35);
    expect(m.indices.length).toBe(2 * 36);
  });
  it('uses the largest flush between the plate’s filaments when purging by the matrix', () => {
    const c = { ...cfg, purge_in_prime_tower: '1', single_extruder_multi_material: '1', flush_volumes_matrix: ['0', '100', '200', '0'], flush_multiplier: ['1'] };
    expect(flushMatrixOf(c)).toEqual([[0, 100], [200, 0]]);
    const p = planPrism(c, parts([1, 2]), flushMatrixOf(c))!;
    expect(p.height).toBeCloseTo((1.6 * 200 * Math.SQRT1_2) / (35 * 0.2 * 0.85), 6);
  });
});

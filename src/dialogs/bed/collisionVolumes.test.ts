import { describe, expect, it } from 'vitest';
import { boxVolume, parseVolume, parseVolumes, serializeVolumes } from './collisionVolumes';

describe('collision volumes (Orca bed_exclude_volumes)', () => {
  it('parses full-height and Z-limited polygons', () => {
    expect(parseVolume('0x0,10x0,10x10,0x10')).toEqual({ zMin: null, zMax: null, points: [[0, 0], [10, 0], [10, 10], [0, 10]] });
    expect(parseVolume('5..40;0x0, 10x0, 10x10')).toEqual({ zMin: 5, zMax: 40, points: [[0, 0], [10, 0], [10, 10]] });
    expect(parseVolume('..40;points=0x0,10x0,10x10')?.zMin).toBeNull();
  });

  it('rejects what Orca rejects', () => {
    expect(parseVolume('0x0,10x0')).toBeNull(); // < 3 points
    expect(parseVolume('0x0,10x0,20x0')).toBeNull(); // zero area
    expect(parseVolume('40..5;0x0,10x0,10x10')).toBeNull(); // empty range
    expect(parseVolume('300..400;0x0,10x0,10x10', 250)).toBeNull(); // clamps to a plane
    expect(parseVolume('a..5;0x0,10x0,10x10')).toBeNull();
    expect(parseVolume('0x0,10y0,10x10')).toBeNull();
  });

  it('round-trips a list', () => {
    const s = '0x0,10x0,10x10,0x10|5..;20x20,30x20,30x30';
    const { volumes, bad } = parseVolumes(s);
    expect(bad).toBe(0);
    expect(serializeVolumes(volumes)).toBe(s);
    expect(parseVolumes('0x0,1x0,1x1\nbad').bad).toBe(1);
    expect(serializeVolumes([boxVolume(-5, -5, 5, 5, 0, 20)])).toBe('0..20;-5x-5,5x-5,5x5,-5x5');
  });
});

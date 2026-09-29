import { describe, expect, it } from 'vitest';
import { colorDistance, fallbackColor, hexToRgb, kmeans, labToRgb, nearestFilaments, paintStates, parseMtl, recommendedClusters, rgbToHex, rgbToLab } from './objColor';

describe('obj colours → filaments', () => {
  it('round-trips hex / Lab', () => {
    for (const hex of ['#FF0000', '#00FF00', '#123456', '#FFFFFF', '#000000']) {
      expect(rgbToHex(labToRgb(rgbToLab(hexToRgb(hex)!)))).toBe(hex);
    }
    expect(hexToRgb('#abc')).toEqual([170, 187, 204]);
    expect(hexToRgb('nope')).toBeNull();
  });

  it('ΔE76 is 0 for equal colours and large for black / white', () => {
    expect(colorDistance('#336699', '#336699')).toBeCloseTo(0);
    expect(colorDistance('#000000', '#FFFFFF')).toBeCloseTo(100, 0);
  });

  it('clusters near-duplicate colours together', () => {
    const cols = [
      { color: '#FF0000', weight: 10 }, { color: '#F80505', weight: 5 },
      { color: '#0000FF', weight: 10 }, { color: '#0505F0', weight: 3 },
    ];
    const r = kmeans(cols, 2);
    expect(r.centers.length).toBe(2);
    expect(r.labels[0]).toBe(r.labels[1]);
    expect(r.labels[2]).toBe(r.labels[3]);
    expect(r.labels[0]).not.toBe(r.labels[2]);
  });

  it('recommends the distinct count when small, fewer clusters for noisy gradients', () => {
    expect(recommendedClusters([{ color: '#FF0000', weight: 1 }, { color: '#00FF00', weight: 1 }])).toBe(2);
    const noisy = Array.from({ length: 40 }, (_, i) => ({ color: rgbToHex([200 + (i % 5), 10 + (i % 7), 10]), weight: 1 }))
      .concat(Array.from({ length: 40 }, (_, i) => ({ color: rgbToHex([10, 10 + (i % 3), 200 + (i % 9)]), weight: 1 })));
    const k = recommendedClusters(noisy, 16);
    expect(k).toBeGreaterThanOrEqual(2);
    expect(k).toBeLessThan(16);
  });

  it('matches clusters to the nearest filament', () => {
    expect(nearestFilaments(['#FE0101', '#0000EE'], ['#FFFFFF', '#0000FF', '#FF0000'])).toEqual([3, 2]);
  });

  it('builds sparse per-triangle states with the dominant slot as base', () => {
    // groups: 0 red, 1 blue, 2 dark red; clusters: red(0) ← g0,g2; blue(1) ← g1
    const tri = new Uint32Array([0, 0, 1, 2, 0xffffffff, 1]);
    const { base, states } = paintStates(tri, [0, 1, 0], [2, 3]);
    expect(base).toBe(2);
    expect(states).toEqual([[2, 3], [5, 3]]);
  });

  it('parses MTL diffuse colours', () => {
    const m = parseMtl('newmtl Red\nKd 1 0 0\n\nnewmtl Blue\n  Kd 0.0 0.0 1.0\nnewmtl NoKd\nKa 1 1 1');
    expect(m.get('Red')).toBe('#FF0000');
    expect(m.get('Blue')).toBe('#0000FF');
    expect(m.has('NoKd')).toBe(false);
  });

  it('gives distinct fallback colours', () => {
    const cs = Array.from({ length: 6 }, (_, i) => fallbackColor(i));
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) expect(colorDistance(cs[i], cs[j])).toBeGreaterThan(5);
  });
});

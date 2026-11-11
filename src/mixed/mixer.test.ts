import { describe, expect, it } from 'vitest';
import {
  blendColours, gradientRamp, linearCurve, parseGradientCurve, pchipTangents, pigmentLerp, sampleGradientCurve, serializeGradientCurve,
} from './mixer';

describe('pigment mixer (Orca FilamentMixer)', () => {
  it('mixes like the C++ model', () => {
    // FilamentMixerModel.hpp's own example: blue + yellow → green.
    expect(pigmentLerp([0, 33, 133], [252, 211, 0], 0.5)).toEqual([47, 141, 56]);
    expect(pigmentLerp([10, 20, 30], [200, 100, 0], 0)).toEqual([10, 20, 30]);
    expect(pigmentLerp([10, 20, 30], [200, 100, 0], 1)).toEqual([200, 100, 0]);
  });

  it('blends by integer weights (blend_color_multi)', () => {
    expect(blendColours(['#002185', '#FCD300'], [50, 50])).toBe('#2F8D38');
    expect(blendColours(['#ff0000'], [1])).toBe('#FF0000');
    expect(blendColours([], [])).toBe('#000000');
    expect(blendColours(['#ff0000', '#00ff00'], [0, 0])).toBe('#000000');
    // A zero weight is skipped; the other colour passes through.
    expect(blendColours(['#123456', '#abcdef'], [0, 10])).toBe('#ABCDEF');
    // Unparseable colours count as mid grey.
    expect(blendColours(['nope', 'nope'], [1, 1])).toBe(blendColours(['#808080', '#808080'], [1, 1]));
  });
});

describe('gradient curves', () => {
  it('parses, clamps, sorts and drops curves with fewer than 2 points', () => {
    expect(parseGradientCurve('1,0.95|0,0.05')).toEqual([
      { x: 0, y: 0.1, mIn: NaN, mOut: NaN }, { x: 1, y: 0.9, mIn: NaN, mOut: NaN },
    ]);
    const t = parseGradientCurve('0,0.2,,0.5|1,0.8,nan,');
    expect(t[0].mOut).toBe(0.5);
    expect(Number.isNaN(t[0].mIn) && Number.isNaN(t[1].mIn) && Number.isNaN(t[1].mOut)).toBe(true);
    expect(parseGradientCurve('0.5,0.5')).toEqual([]);
    expect(parseGradientCurve('a,b|1,2,3')).toEqual([]);
    expect(parseGradientCurve('')).toEqual([]);
  });

  it('serialises with 2 fields unless a tangent is set', () => {
    expect(serializeGradientCurve(parseGradientCurve('0,0.15|0.5,0.5|1,0.85'))).toBe('0.0000,0.1500|0.5000,0.5000|1.0000,0.8500');
    expect(serializeGradientCurve(parseGradientCurve('0,0.2,,0.5|1,0.8'))).toBe('0.0000,0.2000,,0.5000|1.0000,0.8000');
  });

  it('samples with PCHIP between anchors and holds the ends', () => {
    const lin = linearCurve('ab');
    expect(sampleGradientCurve(lin, 0)).toBeCloseTo(0.9);
    expect(sampleGradientCurve(lin, 0.5)).toBeCloseTo(0.5);
    expect(sampleGradientCurve(lin, 1)).toBeCloseTo(0.1);
    const c = parseGradientCurve('0,0.1|0.5,0.9|1,0.9');
    expect(pchipTangents(c)[2]).toBe(0); // flat segment kills its tangents
    expect(sampleGradientCurve(c, 0.75)).toBeCloseTo(0.9);
    expect(sampleGradientCurve(c, 0.25)).toBeGreaterThan(0.1);
    expect(sampleGradientCurve(c, 0.25)).toBeLessThan(0.9);
    expect(sampleGradientCurve([], 0.3)).toBe(0.5);
  });

  it('ramps colours bottom to top', () => {
    const ramp = gradientRamp('#ff0000', '#0000ff', linearCurve('ab'), 4);
    expect(ramp).toHaveLength(4);
    expect(ramp[0]).not.toBe(ramp[3]);
    expect(gradientRamp('#ff0000', '#0000ff', [], 4)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  adaptiveProfile, adjustProfile, facesFromMesh, fitProfileToHeight, generateLayers, heightAt, isUniform, profileFromRanges,
  sanitizeProfile, slicingParams, smoothProfile, type SlicingParams,
} from './profile';
import { layerSliceFields } from './sliceFields';
import type { ProjectObject } from '../project/types';

const P = (over: Partial<SlicingParams> = {}): SlicingParams => ({
  layerHeight: 0.2, firstLayerHeight: 0.2, firstFixed: true, minLayerHeight: 0.07, maxLayerHeight: 0.3, objectHeight: 10, ...over,
});

describe('slicingParams', () => {
  it('reads Orca keys with object overrides first', () => {
    const p = slicingParams({ layer_height: '0.2', initial_layer_print_height: '0.25', nozzle_diameter: ['0.4'], min_layer_height: ['0.08'], max_layer_height: ['0.28'] },
      { layer_height: '0.16' }, 12);
    expect(p).toMatchObject({ layerHeight: 0.16, firstLayerHeight: 0.25, firstFixed: true, minLayerHeight: 0.08, maxLayerHeight: 0.28, objectHeight: 12 });
  });
  it('defaults max to 3/4 nozzle and min to 0.07; raft frees the first layer', () => {
    const p = slicingParams({ layer_height: '0.2', nozzle_diameter: '0.6', raft_layers: '2' }, undefined, 5);
    expect(p.maxLayerHeight).toBeCloseTo(0.45);
    expect(p.minLayerHeight).toBeCloseTo(0.07);
    expect(p.firstFixed).toBe(false);
    expect(p.firstLayerHeight).toBe(0.2);
  });
});

describe('profileFromRanges', () => {
  it('is [0,first, first,first, first,lh, top,lh] without ranges', () => {
    expect(profileFromRanges(P({ firstLayerHeight: 0.3 }), [])).toEqual([0, 0.3, 0.3, 0.3, 0.3, 0.2, 10, 0.2]);
  });
  it('inserts range steps and trims overlaps', () => {
    const prof = profileFromRanges(P(), [{ min: 2, max: 4, layerHeight: 0.1 }, { min: 3, max: 5, layerHeight: 0.3 }]);
    expect(heightAt(prof, 1)).toBeCloseTo(0.2);
    expect(heightAt(prof, 2.5)).toBeCloseTo(0.1);
    expect(heightAt(prof, 4.5)).toBeCloseTo(0.3);
    expect(heightAt(prof, 8)).toBeCloseTo(0.2);
    expect(prof.at(-2)).toBe(10);
  });
  it('is recognised as uniform', () => {
    expect(isUniform(P(), profileFromRanges(P(), []))).toBe(true);
    expect(isUniform(P(), [0, 0.2, 5, 0.1, 10, 0.2])).toBe(false);
  });
});

describe('adjustProfile (manual editor brush)', () => {
  const base = () => profileFromRanges(P(), []);
  it('decrease lowers the height around z only', () => {
    let prof = base();
    for (let i = 0; i < 30; i++) prof = adjustProfile(P(), prof, 5, 0.005, 2, 'decrease');
    expect(heightAt(prof, 5)).toBeLessThan(0.2);
    expect(heightAt(prof, 5)).toBeGreaterThanOrEqual(0.07 - 1e-9);
    expect(heightAt(prof, 1)).toBeCloseTo(0.2);
    expect(heightAt(prof, 9)).toBeCloseTo(0.2);
    expect(prof.at(-2)).toBeCloseTo(10);
    for (let i = 2; i < prof.length; i += 2) expect(prof[i]).toBeGreaterThanOrEqual(prof[i - 2]);
  });
  it('increase is clamped to the max layer height', () => {
    let prof = base();
    for (let i = 0; i < 400; i++) prof = adjustProfile(P(), prof, 5, 0.005, 2, 'increase');
    expect(heightAt(prof, 5)).toBeCloseTo(0.3);
  });
  it('reduce goes back to the base layer height', () => {
    let prof = base();
    for (let i = 0; i < 30; i++) prof = adjustProfile(P(), prof, 5, 0.005, 2, 'decrease');
    for (let i = 0; i < 200; i++) prof = adjustProfile(P(), prof, 5, 0.005, 2, 'reduce');
    expect(heightAt(prof, 5)).toBeCloseTo(0.2, 3);
  });
  it('ignores the first layer and height ranges', () => {
    const prof = base();
    expect(adjustProfile(P(), prof, 0.1, 0.005, 2, 'decrease')).toEqual(prof);
    expect(adjustProfile(P(), prof, 5, 0.005, 2, 'decrease', [{ min: 4, max: 6 }])).toEqual(prof);
  });
  it('smooth pulls a spike towards its neighbours', () => {
    let prof = base();
    for (let i = 0; i < 40; i++) prof = adjustProfile(P(), prof, 5, 0.005, 1.5, 'decrease');
    const before = heightAt(prof, 5);
    const sm = adjustProfile(P(), prof, 5, 0.005, 4, 'smooth');
    expect(heightAt(sm, 5)).toBeGreaterThan(before);
  });
});

describe('smoothProfile', () => {
  it('keeps min when asked and stays within limits', () => {
    const prof = [0, 0.2, 0.2, 0.2, 0.2, 0.2, 3, 0.1, 3.2, 0.3, 6, 0.3, 10, 0.2];
    const sm = smoothProfile(prof, P(), 5, false);
    expect(sm.length).toBe(prof.length);
    for (let i = 1; i < sm.length; i += 2) { expect(sm[i]).toBeGreaterThanOrEqual(0.07 - 1e-9); expect(sm[i]).toBeLessThanOrEqual(0.3 + 1e-9); }
    const km = smoothProfile(prof, P(), 5, true);
    for (let i = 5; i < km.length; i += 2) expect(km[i]).toBeLessThanOrEqual(prof[i] + 1e-9);
  });
});

describe('adaptive', () => {
  // A 10 mm cube with a 45° chamfer-ish top: a pyramid (slopes want thin layers) on a box.
  const positions = new Float32Array([
    0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, // bottom
    0, 0, 5, 10, 0, 5, 10, 10, 5, 0, 10, 5, // box top ring
    5, 5, 10, // apex
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, // walls
    4, 5, 8, 5, 6, 8, 6, 7, 8, 7, 4, 8, // pyramid
  ]);
  const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  it('uses thicker layers on vertical walls than on slopes', () => {
    const faces = facesFromMesh(positions, indices, ident);
    const prof = adaptiveProfile(P(), faces, 0.5);
    expect(prof[0]).toBe(0);
    expect(prof.at(-2)).toBeCloseTo(10);
    expect(heightAt(prof, 3)).toBeGreaterThan(heightAt(prof, 8) - 1e-9);
    for (let i = 1; i < prof.length; i += 2) expect(prof[i]).toBeLessThanOrEqual(0.3 + 1e-9);
  });
  it('generates layers that cover the object', () => {
    const p = P();
    const layers = generateLayers(p, profileFromRanges(p, []));
    expect(layers[0]).toBe(0);
    expect(layers.length / 2).toBe(50);
    expect(layers.at(-1)).toBeCloseTo(10, 5);
  });
});

describe('helpers', () => {
  it('fits a profile to a new height', () => {
    expect(fitProfileToHeight([0, 0.2, 10, 0.2], 20)).toEqual([0, 0.2, 20, 0.2]);
  });
  it('sanitises untrusted profiles', () => {
    expect(sanitizeProfile([0, 0.2, 5, 0.1, 10, 0.2])).toEqual([0, 0.2, 5, 0.1, 10, 0.2]);
    expect(sanitizeProfile([0, 0.2, 5, -1])).toEqual([]);
    expect(sanitizeProfile([5, 0.2, 1, 0.2])).toEqual([]);
    expect(sanitizeProfile('x')).toEqual([]);
  });
  it('builds engine job fields', () => {
    const o = {
      id: 'o', name: 'o', meshId: 'm', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true, printable: true, overrides: {}, color: '',
      layerHeightProfile: [0, 0.2, 10, 0.1],
      layerRanges: [{ id: 'b', min: 5, max: 6, overrides: { layer_height: '0.1' } }, { id: 'a', min: 1, max: 2, overrides: { wall_loops: '4' } }],
    } as ProjectObject;
    const f = layerSliceFields(o, 20);
    expect(f.layerHeightProfile).toEqual([0, 0.2, 20, 0.1]);
    expect(f.layerRanges).toEqual([{ min: 1, max: 2, config: { wall_loops: '4' } }, { min: 5, max: 6, config: { layer_height: '0.1' } }]);
    expect(layerSliceFields({ ...o, layerHeightProfile: undefined, layerRanges: undefined }, 10)).toEqual({});
  });
});

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GcodeChunks, chunkDrawCount, createSharedUniforms, planChunks } from './chunks';
import { fillValues, rampColor, schemeRange, toolColorsFromConfig } from './colors';
import { parseGcode } from '../parser/parse';
import { Feature } from '../parser/features';
import { buildFeatureRows, buildSummary, featureVolumeShare, formatDuration } from '../summary';
import prusa from '../__fixtures__/prusa-style.gcode?raw';
import orca from '../__fixtures__/orca-2.3.gcode?raw';

const enc = new TextEncoder();

describe('chunk planning', () => {
  it('splits exactly at the size boundary', () => {
    expect(planChunks(0, 4)).toEqual([]);
    expect(planChunks(4, 4)).toEqual([{ base: 0, count: 4 }]);
    expect(planChunks(5, 4)).toEqual([{ base: 0, count: 4 }, { base: 4, count: 1 }]);
    const cs = planChunks(10_000_001, 1 << 20);
    expect(cs.reduce((s, c) => s + c.count, 0)).toBe(10_000_001);
    expect(cs.every((c) => c.count <= 1 << 20)).toBe(true);
  });
  it('draw counts clip against the global range', () => {
    const c = { base: 100, count: 50 };
    expect(chunkDrawCount(c, 0, 99)).toBe(0);    // range ends before chunk
    expect(chunkDrawCount(c, 150, 200)).toBe(0); // starts after chunk
    expect(chunkDrawCount(c, 0, 100)).toBe(1);
    expect(chunkDrawCount(c, 0, 149)).toBe(50);
    expect(chunkDrawCount(c, 120, 1e9)).toBe(50); // lower bound is a shader clip
    expect(chunkDrawCount(c, 10, 5)).toBe(0);
  });
});

describe('GPU chunk buffers (CPU side)', () => {
  const p = parseGcode(enc.encode(orca));
  it('views the parser arrays without copying and overlaps one point between chunks', () => {
    const ch = new GcodeChunks(p, createSharedUniforms(), 10_000);
    while (ch.buildNext()) { /* build all */ }
    expect(ch.done).toBe(true);
    const meshes = ch.group.children.filter((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh);
    expect(meshes.length).toBe(Math.ceil(p.segmentCount / 10_000));
    const g0 = meshes[0].geometry as THREE.InstancedBufferGeometry;
    const g1 = meshes[1].geometry as THREE.InstancedBufferGeometry;
    const s0 = g0.getAttribute('aStart') as THREE.InterleavedBufferAttribute;
    const e0 = g0.getAttribute('aEnd') as THREE.InterleavedBufferAttribute;
    const s1 = g1.getAttribute('aStart') as THREE.InterleavedBufferAttribute;
    expect(s0.data.array.buffer).toBe(p.points.buffer); // zero-copy view
    expect(s0.data.stride).toBe(3);
    expect(e0.offset).toBe(3);
    // last end of chunk 0 === first start of chunk 1
    expect(e0.getX(9_999)).toBe(s1.getX(0));
    expect(e0.getZ(9_999)).toBe(s1.getZ(0));
    const meta = g0.getAttribute('aMeta') as THREE.InstancedBufferAttribute;
    expect(meta.getX(5)).toBe(p.feature[5]);
    expect(g0.boundingSphere!.radius).toBeGreaterThan(0);
    ch.setRange(0, 15_000);
    expect(meshes[0].visible).toBe(true);
    expect(g1.instanceCount).toBe(5_001);
    expect(meshes[2].visible).toBe(false);
    ch.setTravelVisible(true);
    ch.setMarkersVisible(true);
    expect(ch.gpuBytes()).toBeGreaterThan(p.segmentCount * 24);
    ch.setScheme('speed', true);
    const v0 = (g0.getAttribute('aValue') as THREE.InstancedBufferAttribute).getX(7);
    expect(v0).toBeCloseTo(p.speed[7], 5);
    ch.dispose();
    expect(ch.group.children.length).toBe(0);
  });
});

describe('colour schemes', () => {
  const p = parseGcode(enc.encode(prusa));
  it('ranges over extrusions only', () => {
    const w = schemeRange(p, 'width');
    expect(w.min).toBeCloseTo(0.42, 5);
    // purge line precedes the first ;WIDTH: → width derived from volume
    expect(w.max).toBeGreaterThan(0.5);
    const fan = schemeRange(p, 'fan');
    expect(fan.max).toBeCloseTo((127 / 255) * 100, 3);
    const lt = schemeRange(p, 'layerTime');
    expect(lt.max).toBeGreaterThan(0);
  });
  it('fills layer-time values per segment', () => {
    const out = new Float32Array(p.segmentCount);
    fillValues(p, 'layerTime', 0, out);
    expect(out[p.layerStart[1]]).toBeCloseTo(p.layerTime[1], 5);
    expect(out[p.segmentCount - 1]).toBeCloseTo(p.layerTime[p.layerCount - 1], 5);
  });
  it('ramp endpoints and config colours', () => {
    expect(rampColor(0)).toBe(0x0b2c7a);
    expect(rampColor(1)).toBe(0x94250d);
    const c = toolColorsFromConfig({ filament_colour: ['#FF0000', '#00ff00'], extruder_colour: ['', '#0000FF'] });
    expect(c[0]).toBe(0xff0000);
    expect(c[1]).toBe(0x0000ff);
  });
});

describe('summary', () => {
  const p = parseGcode(enc.encode(prusa));
  it('prefers engine stats, then header, then estimate', () => {
    const eng = buildSummary(p, {
      ok: true, error: null, warnings: [],
      stats: { printTimeSec: 100, filamentMm: [200, 0], filamentCm3: [0.5], filamentG: [0.6, 0], filamentCost: [0.02], layers: 3, maxZ: 0.6 },
    });
    expect(eng.timeSec).toBe(100);
    expect(eng.timeSource).toBe('engine');
    expect(eng.tools).toEqual([{ index: 0, mm: 200, g: 0.6, cost: 0.02 }]);
    const file = buildSummary(p, null);
    expect(file.timeSec).toBe(83);
    expect(file.timeSource).toBe('file');
    expect(file.tools[0].mm).toBe(123.45);
  });
  it('feature rows sum to the headline time', () => {
    const rows = buildFeatureRows(p, 100);
    // rows exclude travel, so they sum to their share of the headline time
    const sum = rows.reduce((s, r) => s + r.time, 0);
    const pct = rows.reduce((s, r) => s + r.percent, 0);
    expect(sum).toBeLessThan(100);
    expect(sum).toBeCloseTo(pct, 3);
    expect(rows.find((r) => r.id === Feature.OuterWall)).toBeTruthy();
    expect(rows.some((r) => r.id === Feature.Travel)).toBe(false);
    expect(rows.reduce((s, r) => s + r.percent, 0)).toBeLessThanOrEqual(100.0001);
  });
  it('splits filament use across features by extruded volume', () => {
    const share = featureVolumeShare(p);
    expect(share.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 6);
    expect(share[Feature.Travel]).toBe(0);
    const rows = buildFeatureRows(p, 100, { mm: 1000, g: 3 });
    expect(rows.reduce((a, r) => a + (r.filamentMm ?? 0), 0)).toBeCloseTo(1000, 3);
    expect(rows.reduce((a, r) => a + (r.filamentG ?? 0), 0)).toBeCloseTo(3, 6);
    expect(buildFeatureRows(p, 100).every((r) => r.filamentMm === null)).toBe(true);
  });
  it('formats durations', () => {
    expect(formatDuration(59)).toBe('59s');
    expect(formatDuration(3725)).toBe('1h 2m');
    expect(formatDuration(null)).toBe('–');
  });
});

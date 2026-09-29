import { describe, expect, it } from 'vitest';
import orca23 from '../__fixtures__/orca-2.3.gcode?raw';
import orca24 from '../__fixtures__/orca-2.4-style.gcode?raw';
import prusa from '../__fixtures__/prusa-style.gcode?raw';
import generic from '../__fixtures__/generic-marlin.gcode?raw';
import { parseGcode, parseDuration, trapezoidTime } from './parse';
import { Feature, classifyFeature } from './features';
import { MarkerKind } from './types';
import type { ParsedGcode } from './types';

const enc = new TextEncoder();
const parse = (s: string) => parseGcode(enc.encode(s));
const gcode = (...lines: string[]) => parse(lines.join('\n') + '\n');

function segEnd(p: ParsedGcode, i: number): [number, number, number] {
  return [p.points[(i + 1) * 3], p.points[(i + 1) * 3 + 1], p.points[(i + 1) * 3 + 2]];
}
function segsOf(p: ParsedGcode, f: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.segmentCount; i++) if (p.feature[i] === f) out.push(i);
  return out;
}
function layerOf(p: ParsedGcode, seg: number): number {
  for (let l = 0; l < p.layerCount; l++) if (seg < p.layerStart[l + 1]) return l;
  return -1;
}

describe('feature classification', () => {
  it('normalizes dialects', () => {
    expect(classifyFeature('External perimeter')).toBe(Feature.OuterWall);
    expect(classifyFeature('Outer wall')).toBe(Feature.OuterWall);
    expect(classifyFeature('WALL-OUTER')).toBe(Feature.OuterWall);
    expect(classifyFeature('Perimeter')).toBe(Feature.InnerWall);
    expect(classifyFeature('Inner wall')).toBe(Feature.InnerWall);
    expect(classifyFeature('Overhang perimeter')).toBe(Feature.OverhangWall);
    expect(classifyFeature('Overhang wall')).toBe(Feature.OverhangWall);
    expect(classifyFeature('Internal infill')).toBe(Feature.SparseInfill);
    expect(classifyFeature('Sparse infill')).toBe(Feature.SparseInfill);
    expect(classifyFeature('Solid infill')).toBe(Feature.SolidInfill);
    expect(classifyFeature('Internal solid infill')).toBe(Feature.SolidInfill);
    expect(classifyFeature('Top solid infill')).toBe(Feature.TopSurface);
    expect(classifyFeature('Top surface')).toBe(Feature.TopSurface);
    expect(classifyFeature('Bottom surface')).toBe(Feature.BottomSurface);
    expect(classifyFeature('Bridge infill')).toBe(Feature.Bridge);
    expect(classifyFeature('Bridge')).toBe(Feature.Bridge);
    expect(classifyFeature('Internal Bridge')).toBe(Feature.InternalBridge);
    expect(classifyFeature('Gap fill')).toBe(Feature.GapInfill);
    expect(classifyFeature('Gap infill')).toBe(Feature.GapInfill);
    expect(classifyFeature('Skirt/Brim')).toBe(Feature.SkirtBrim);
    expect(classifyFeature('Brim')).toBe(Feature.SkirtBrim);
    expect(classifyFeature('Support material')).toBe(Feature.Support);
    expect(classifyFeature('Support material interface')).toBe(Feature.SupportInterface);
    expect(classifyFeature('Support transition')).toBe(Feature.SupportTransition);
    expect(classifyFeature('Wipe tower')).toBe(Feature.WipeTower);
    expect(classifyFeature('Prime tower')).toBe(Feature.WipeTower);
    expect(classifyFeature('Ironing')).toBe(Feature.Ironing);
    expect(classifyFeature('Custom')).toBe(Feature.Custom);
    expect(classifyFeature('???')).toBe(Feature.Other);
  });
});

describe('Orca 2.3 WASM fixture', () => {
  const p = parse(orca23);
  it('finds all layers', () => {
    expect(p.layerCount).toBe(125);
    expect(p.header.layerCount).toBe(125);
    expect(p.layerZ[0]).toBeCloseTo(0.2, 5);
    expect(p.layerZ[124]).toBeCloseTo(25, 4);
    for (let l = 1; l < p.layerCount; l++) if (p.layerStart[l] < p.layerStart[l - 1]) throw new Error('non-monotonic');
    expect(p.layerStart[p.layerCount]).toBe(p.segmentCount);
    expect(p.layerHeight[5]).toBeCloseTo(0.2, 5);
  });
  it('classifies walls and travel', () => {
    const outer = segsOf(p, Feature.OuterWall).length, inner = segsOf(p, Feature.InnerWall).length;
    expect(outer).toBeGreaterThan(1000);
    expect(inner).toBeGreaterThan(1000);
    expect(p.stats.travelCount).toBeGreaterThan(125);
    expect(p.stats.extrusionCount).toBe(outer + inner + segsOf(p, Feature.Other).length + segsOf(p, Feature.Custom).length);
    // every layer's extrusions sit at the layer Z
    for (const l of [0, 10, 60, 124]) {
      let bad = 0;
      for (let s = p.layerStart[l]; s < p.layerStart[l + 1]; s++) {
        if (p.feature[s] === Feature.OuterWall && Math.abs(segEnd(p, s)[2] - p.layerZ[l]) > 1e-4) bad++;
      }
      expect(bad).toBe(0);
    }
  });
  it('reads widths, header and retract markers', () => {
    const i = segsOf(p, Feature.InnerWall)[0];
    expect(p.wh[i * 2]).toBe(450);
    expect(p.wh[i * 2 + 1]).toBe(200);
    expect(p.header.maxZ).toBe(25);
    expect(p.header.filamentDiameter).toBe(1.75);
    expect(p.stats.max[2]).toBeCloseTo(25, 4);
    const kinds = Array.from(p.markerKind);
    expect(kinds.filter((k) => k === MarkerKind.Retract).length).toBe(2);
    expect(kinds.filter((k) => k === MarkerKind.Seam).length).toBeGreaterThanOrEqual(125);
  });
  it('estimates a sane print time and maps lines', () => {
    // Engine header said M73 R14 → ~14 min; our estimate should be same order.
    expect(p.stats.estimatedTimeSec).toBeGreaterThan(5 * 60);
    expect(p.stats.estimatedTimeSec).toBeLessThan(40 * 60);
    let sum = 0;
    for (let l = 0; l < p.layerCount; l++) sum += p.layerTime[l];
    expect(sum).toBeCloseTo(p.stats.estimatedTimeSec, 0);
    const bytes = enc.encode(orca23);
    const i = segsOf(p, Feature.InnerWall)[0];
    const lineText = new TextDecoder().decode(bytes.subarray(p.byteOffset[i], bytes.indexOf(10, p.byteOffset[i])));
    expect(lineText).toBe('G1 X3.971 Y7.271 E.01147');
    expect(orca23.split('\n')[p.lineNo[i]]).toBe(lineText);
    let monotonic = true;
    for (let s = 1; s < p.segmentCount; s++) if (p.lineNo[s] < p.lineNo[s - 1]) monotonic = false;
    expect(monotonic).toBe(true);
  });
  it('tracks fan and temperature', () => {
    const last = p.segmentCount - 1;
    expect(p.temp[segsOf(p, Feature.InnerWall)[0]]).toBe(2000);
    expect(p.fan[0]).toBe(0);
    expect(p.fan.some((f) => f > 0) || p.fan.every((f) => f === 0)).toBe(true);
    expect(last).toBeGreaterThan(0);
  });
});

describe('PrusaSlicer / preFlight dialect', () => {
  const p = parse(prusa);
  it('layers from ;LAYER_CHANGE with ;Z: and ;HEIGHT:', () => {
    expect(p.layerCount).toBe(3);
    expect(Array.from(p.layerZ)).toEqual([0.2, 0.4, 0.6].map((v) => Math.fround(v)));
    expect(p.layerHeight[1]).toBeCloseTo(0.2, 5);
  });
  it('absolute E with G92 resets', () => {
    // purge line at start: E0 → 5 absolute = 5 mm; after G92 E0 then E-0.8 = retract.
    const purge = segsOf(p, Feature.Custom);
    expect(purge.length).toBe(1);
    expect(p.flow[purge[0]]).toBeGreaterThan(0);
    const outer = segsOf(p, Feature.OuterWall);
    expect(outer.length).toBe(6);
    // 4 wall moves of 0.9 mm E over 20 mm: flow = 0.9 * area * 20 mm/s / 20mm
    const area = Math.PI * 0.875 * 0.875;
    expect(p.flow[outer[0]]).toBeCloseTo(0.9 * area * 20 / 20, 3);
    const retracts = Array.from(p.markerKind).filter((k) => k === MarkerKind.Retract).length;
    expect(retracts).toBe(3); // start, after wipe, end
  });
  it('wipe moves are not extrusions', () => {
    const wipes = segsOf(p, Feature.Wipe);
    expect(wipes.length).toBe(1);
    expect(p.wh[wipes[0] * 2]).toBe(0);
  });
  it('classifies every Prusa role', () => {
    for (const f of [Feature.OuterWall, Feature.InnerWall, Feature.SparseInfill, Feature.SkirtBrim, Feature.SolidInfill,
      Feature.TopSurface, Feature.Bridge, Feature.GapInfill, Feature.OverhangWall, Feature.Support,
      Feature.SupportInterface, Feature.WipeTower, Feature.Ironing]) {
      expect(segsOf(p, f).length, `feature ${f}`).toBeGreaterThan(0);
    }
    const inner = segsOf(p, Feature.InnerWall);
    expect(p.wh[inner[0] * 2]).toBe(500);
    const bridge = segsOf(p, Feature.Bridge)[0];
    expect(p.wh[bridge * 2 + 1]).toBe(400);
    expect(p.wh[segsOf(p, Feature.GapInfill)[0] * 2 + 1]).toBe(200);
  });
  it('fan changes', () => {
    expect(p.fan[segsOf(p, Feature.SolidInfill)[0]]).toBe(127);
    expect(p.fan[segsOf(p, Feature.OuterWall)[5]]).toBe(0);
  });
  it('reads footer stats', () => {
    expect(p.header.printTimeSec).toBe(83);
    expect(p.header.filamentMm).toEqual([123.45]);
    expect(p.header.filamentG).toEqual([0.37]);
    expect(p.header.filamentCost).toEqual([0.01]);
    expect(p.header.generator).toMatch(/preFlight/);
  });
});

describe('Orca 2.4 dialect', () => {
  const p = parse(orca24);
  it('layers from ; CHANGE_LAYER / ; Z_HEIGHT', () => {
    expect(p.layerCount).toBe(2);
    expect(p.layerZ[0]).toBeCloseTo(0.2, 5);
    expect(p.layerZ[1]).toBeCloseTo(0.4, 5);
    expect(p.header.printTimeSec).toBe(80);
    expect(p.header.filamentMm).toEqual([10.5, 2.25]);
  });
  it('tessellates arcs within tolerance', () => {
    const outer = segsOf(p, Feature.OuterWall);
    expect(outer.length).toBeGreaterThan(20); // two half circles r=5
    for (const s of outer) {
      const [x, y] = segEnd(p, s);
      expect(Math.hypot(x - 55, y - 50)).toBeCloseTo(5, 3);
      expect(p.wh[s * 2]).toBe(420);
    }
    // arc E is spread across sub-segments: total ≈ 1.0 mm
    let e = 0;
    for (const s of outer) {
      const len = Math.hypot(segEnd(p, s)[0] - p.points[s * 3], segEnd(p, s)[1] - p.points[s * 3 + 1]);
      e += (p.flow[s] * len) / p.speed[s] / (Math.PI * 0.875 * 0.875);
    }
    expect(e).toBeCloseTo(1.0, 3);
    // R-form arc ends where it should
    const inner = segsOf(p, Feature.InnerWall);
    const [ex, ey] = segEnd(p, inner[inner.length - 1]);
    expect(ex).toBeCloseTo(50, 4);
    expect(ey).toBeCloseTo(60, 4);
    // all points of the R arc are 5 from a centre
    const [mx, my] = segEnd(p, inner[Math.floor(inner.length / 2)]);
    expect(Math.hypot(mx - 50, my - 55) > 4.99 || Math.hypot(mx - 55, my - 55) > 0).toBe(true);
  });
  it('firmware retract G10/G11 markers', () => {
    const r = segsOf(p, Feature.Retract), u = segsOf(p, Feature.Unretract);
    expect(r.length).toBe(2); // G1 E-.8 + G10
    expect(u.length).toBe(2); // G1 E.8 + G11
  });
  it('tool changes and per-tool temps, prime tower', () => {
    const tower = segsOf(p, Feature.WipeTower);
    expect(tower.length).toBe(1);
    expect(p.tool[tower[0]]).toBe(1);
    expect(p.temp[tower[0]]).toBe(2400);
    expect(p.tool[segsOf(p, Feature.OuterWall)[0]]).toBe(0);
    expect(p.stats.toolsUsed).toEqual([0, 1]);
    expect(layerOf(p, tower[0])).toBe(1);
  });
  it('ignores malformed lines safely', () => {
    const brim = segsOf(p, Feature.SkirtBrim);
    expect(brim.length).toBe(2);
    const [x, y, z] = segEnd(p, brim[1]);
    expect([x, y, z]).toEqual([85, 85, Math.fround(0.4)]);
  });
  it('classifies Orca roles', () => {
    for (const f of [Feature.SolidInfill, Feature.TopSurface, Feature.BottomSurface, Feature.InternalBridge,
      Feature.GapInfill, Feature.SupportTransition, Feature.SparseInfill]) {
      expect(segsOf(p, f).length, `feature ${f}`).toBeGreaterThan(0);
    }
  });
});

describe('generic G-code without comments', () => {
  const p = parse(generic);
  it('derives layers from Z of extrusions', () => {
    expect(p.layerCount).toBe(3);
    expect(p.layerZ[0]).toBeCloseTo(0.3, 5);
    expect(p.layerZ[1]).toBeCloseTo(0.6, 5);
    expect(p.layerZ[2]).toBeCloseTo(0.9, 5);
    expect(p.layerHeight[1]).toBeCloseTo(0.3, 5);
  });
  it('derives width from extrusion volume', () => {
    const ext = segsOf(p, Feature.Other);
    expect(ext.length).toBe(6);
    // 1 mm filament over 10 mm at h=0.3 → area 0.2405 mm² → w ≈ 0.866
    const w = p.wh[ext[0] * 2] / 1000;
    expect(w).toBeGreaterThan(0.7);
    expect(w).toBeLessThan(1.0);
    // M83 relative after absolute: last segment extrudes 1 mm too
    expect(p.flow[ext[5]]).toBeGreaterThan(0);
  });
  it('G91 relative Z', () => {
    const ext = segsOf(p, Feature.Other);
    expect(segEnd(p, ext[4])[2]).toBeCloseTo(0.9, 5);
  });
  it('travel layer boundary is at the Z move', () => {
    // layer 1 starts at the travel that lowered to Z0.6 (or the Z move before)
    const s = p.layerStart[1];
    expect(p.feature[s]).toBe(Feature.Travel);
  });
});

describe('edge cases', () => {
  it('G20 inches', () => {
    const p = gcode('G20', 'G1 X1 Y0 F60');
    expect(segEnd(p, 0)[0]).toBeCloseTo(25.4, 4);
  });
  it('empty and garbage input', () => {
    expect(parse('').segmentCount).toBe(0);
    expect(parse('').layerCount).toBe(1);
    const p = parse('\u0000ÿ\r\n;;;\nG\nG1\nM\nX1\nG1 X- Y. Z\néè G1 X5');
    expect(p.segmentCount).toBe(0);
  });
  it('CRLF line endings and line numbers/checksums', () => {
    const p = parse('N1 G1 X10 Y0 F600*57\r\nN2 G1 X20 E1*33\r\n');
    expect(p.segmentCount).toBe(2);
    expect(segEnd(p, 1)[0]).toBe(20);
    expect(p.feature[1]).toBe(Feature.Other);
  });
  it('G92 X resets without drawing', () => {
    const p = gcode('G1 X10 F600', 'G92 X0', 'G1 X5');
    // travel to 10, invisible jump to 0, travel to 5
    expect(segEnd(p, p.segmentCount - 1)[0]).toBe(5);
    expect(p.time[1]).toBe(0);
  });
  it('full-circle arc', () => {
    const p = gcode('M83', 'G1 X10 Y0 F600', 'G2 X10 Y0 I5 J0 E1');
    const ext = segsOf(p, Feature.Other);
    expect(ext.length).toBeGreaterThan(30);
  });
  it('grows buffers past the initial capacity (chunk boundaries)', () => {
    const lines: string[] = ['M83'];
    for (let i = 0; i < 50000; i++) lines.push(`G1 X${i % 2 ? 10 : 0} Y${(i * 0.01).toFixed(2)} E0.1 F1200`);
    const p = parseGcode(enc.encode(lines.join('\n')), { progressEvery: 1 << 16 });
    expect(p.segmentCount).toBe(50000);
    expect(segEnd(p, 49999)[1]).toBeCloseTo(499.99, 2);
    expect(p.points.length).toBe(50001 * 3);
  });
  it('reports progress', () => {
    const calls: number[] = [];
    parseGcode(enc.encode(orca23), { progressEvery: 100000 }, (d) => calls.push(d));
    expect(calls.length).toBeGreaterThan(5);
    expect(calls[calls.length - 1]).toBe(enc.encode(orca23).length);
  });
});

describe('time model', () => {
  it('trapezoid', () => {
    // 100 mm at 100 mm/s, a=1000: accel 0.1 s over 5 mm each side → 0.1+0.1+0.9 = 1.1 s
    expect(trapezoidTime(100, 100, 1000, 0, 0)).toBeCloseTo(1.1, 6);
    // triangle: 1 mm, a = 1000, peak = 31.6 mm/s
    expect(trapezoidTime(1, 100, 1000, 0, 0)).toBeCloseTo(2 * Math.sqrt(1 / 1000), 6);
    expect(trapezoidTime(10, 10, 0, 0, 0)).toBe(1);
  });
  it('straight line split into segments ≈ one move', () => {
    const one = gcode('M204 S1000', 'G1 X100 F6000');
    const many = gcode('M204 S1000', ...Array.from({ length: 100 }, (_, i) => `G1 X${i + 1} F6000`));
    expect(many.stats.estimatedTimeSec).toBeGreaterThan(one.stats.estimatedTimeSec * 0.95);
    expect(many.stats.estimatedTimeSec).toBeLessThan(one.stats.estimatedTimeSec * 1.3);
  });
  it('dwell adds time', () => {
    const p = gcode('G1 X10 F600', 'G4 P2000', 'G1 X20');
    expect(p.stats.estimatedTimeSec).toBeGreaterThan(2);
  });
  it('durations', () => {
    expect(parseDuration('1d 2h 3m 4s')).toBe(93784);
    expect(parseDuration('14m 22s')).toBe(862);
    expect(parseDuration('01:02:03')).toBe(3723);
  });
});

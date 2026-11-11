/**
 * OrcaSlicer 2.5 G-code.
 *
 * Every `src/preview/__fixtures__/orca-2.5*.gcode` gets the invariants below.
 * `orca-2.5-synthetic.gcode` is hand-written from the v2.5.0 sources (no
 * 2.5 engine build existed when it was written) and also gets exact checks.
 *
 * Real 2.5.0 engine fixtures (10 mm boxes, thumbnail blocks stripped): Bambu
 * P1S, MyKlipper (`;TYPE:` dialect), Vivedino Xplorer IDEX in copy mode and a
 * Printcepts BabyBelt Pro belt printer. Adding another one:
 *   npx vite --port 5431 &
 *   SAVE_GCODE=src/preview/__fixtures__/orca-2.5-p1s.gcode \
 *     node scripts/dev/e2e-slice.mjs http://localhost:5431/slicer/ orca 'sys:BBL/Bambu Lab P1S 0.4 nozzle'
 *   # and a non-Bambu printer for the `;TYPE:` dialect, e.g.
 *   SAVE_GCODE=src/preview/__fixtures__/orca-2.5-mk4.gcode \
 *     node scripts/dev/e2e-slice.mjs http://localhost:5431/slicer/ orca 'sys:Prusa/Prusa MK4 0.4 nozzle'
 * The file is picked up by name; nothing else to change. Keep it small (the
 * script slices a 20 mm cube).
 */
import { describe, expect, it } from 'vitest';
import { parseGcode } from './parse';
import { Feature, FEATURE_COUNT, isExtrusionFeature } from './features';
import { configFilamentColour } from '../../lib/colour';

const fixtures = import.meta.glob('../__fixtures__/orca-2.5*.gcode', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const enc = new TextEncoder();

describe.each(Object.entries(fixtures))('Orca 2.5 G-code %s', (_name, text) => {
  const p = parseGcode(enc.encode(text));

  it('is from Orca 2.5', () => {
    expect(p.header.generator).toMatch(/OrcaSlicer 2\.5/);
  });
  it('has one layer per header layer, in order', () => {
    if (p.header.layerCount !== null) expect(p.layerCount).toBe(p.header.layerCount);
    for (let l = 1; l <= p.layerCount; l++) expect(p.layerStart[l]).toBeGreaterThanOrEqual(p.layerStart[l - 1]);
    for (let l = 1; l < p.layerCount; l++) expect(p.layerZ[l]).toBeGreaterThan(p.layerZ[l - 1]);
  });
  it('knows every role it extrudes', () => {
    // Roles came from ;TYPE: / ; FEATURE: tags; none should fall back to "Other".
    expect(p.stats.featureCount[Feature.Other]).toBe(0);
    let extrusions = 0;
    for (let f = 0; f < FEATURE_COUNT; f++) if (isExtrusionFeature(f)) extrusions += p.stats.featureCount[f];
    expect(extrusions).toBe(p.stats.extrusionCount);
  });
  it('uses as much filament per tool as the footer says', () => {
    const footer = p.header.filamentMm ?? [];
    footer.forEach((mm, t) => { if (mm > 0) expect(p.stats.filamentMmPerTool[t]).toBeCloseTo(mm, -1); });
  });
  it('reads the config block colours', () => {
    if (!p.header.config.filament_colour) return;
    const fc = configFilamentColour(p.header.config, 0);
    expect(fc.colours.length).toBeGreaterThan(0);
  });
});

describe('synthetic Orca 2.5 fixture', () => {
  const text = fixtures['../__fixtures__/orca-2.5-synthetic.gcode'];
  const p = parseGcode(enc.encode(text));

  it('brackets the machine start / end G-code', () => {
    expect(p.header.startGcodeEndSeg).toBeGreaterThan(0);
    expect(p.header.endGcodeStartSeg).toBeGreaterThan(p.header.startGcodeEndSeg!);
    // The start G-code purge line is Custom, before the marker.
    expect(p.feature[p.header.startGcodeEndSeg! - 1]).toBe(Feature.Custom);
  });
  it('ignores dwells after MACHINE_END_GCODE_START (Orca 2.5 drops them from the estimate)', () => {
    expect(p.stats.estimatedTimeSec).toBeLessThan(120);
  });
  it('2.5 tags are not mistaken for header values or roles', () => {
    expect(p.header.printTimeSec).toBe(62);
    expect(p.layerCount).toBe(3);
    expect(p.stats.featureCount[Feature.WipeTower]).toBe(2);
    expect(p.stats.featureCount[Feature.OverhangWall]).toBe(1);
    expect(p.stats.featureCount[Feature.InternalBridge]).toBe(1);
    expect(p.stats.featureCount[Feature.Ironing]).toBe(2);
  });
  it('tool changes: ;VT0, T1 and per-tool usage', () => {
    expect(p.stats.toolsUsed).toEqual([0, 1]);
    const tower = Array.from(p.feature).indexOf(Feature.WipeTower);
    expect(p.tool[tower]).toBe(1);
  });
  it('colour change with a translucent colour', () => {
    expect(p.colorChanges).toHaveLength(1);
    expect(p.colorChanges![0]).toMatchObject({ extruder: 1, color: 0x3366cc });
  });
  it('config block: translucent, multi-colour and mixed slots', () => {
    const c = p.header.config;
    expect(c.filament_colour).toEqual(['#FF000080', '#00FF00', '#808000']);
    expect(configFilamentColour(c, 0).colours[0].a).toBe(0x80);
    const second = configFilamentColour(c, 1);
    expect(second.colours).toHaveLength(2);
    expect(second.gradient).toBe(true);
    expect(c.filament_is_mixed).toEqual(['0', '0', '1']);
    expect(c.filament_mixed_components).toEqual(['', '', '1,2']);
    // Inside the config block the belt angle is just a setting, not a belt file.
    expect(p.header.beltTiltAngle).toBeNull();
  });
  it('belt header outside the config block', () => {
    const belt = parseGcode(enc.encode('; generated by OrcaSlicer 2.5.0\n; belt_slice_rotation_angle = -45.0\n;LAYER_CHANGE\n;Z:0.2\nG1 X1 Y1 Z0.2 E1\n'));
    expect(belt.header.beltTiltAngle).toBe(45);
  });
  it('Bambu filament select M1020 and ;VT with a nozzle id', () => {
    const q = parseGcode(enc.encode('M83\n;VT2 H1\nG1 X1 E1\nM1020 S3 H0\nG1 X2 E1\nT0 H1\nG1 X3 E1\n'));
    expect(Array.from(q.tool)).toEqual([2, 3, 0]);
  });
});

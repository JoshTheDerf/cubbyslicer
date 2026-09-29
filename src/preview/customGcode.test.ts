import { describe, expect, it } from 'vitest';
import { colorPrintSlots, layerOfZ, sliderTicks, zOfLayer } from './customGcode';
import { parseGcode } from './parser/parse';
import type { ParsedGcode } from './parser/types';

const Z = new Float32Array([0.2, 0.4, 0.6, 0.8]);

describe('slider ticks', () => {
  it('maps print Z to layers like Orca (mid-point rule)', () => {
    expect(layerOfZ(Z, 0.2)).toBe(0);
    expect(layerOfZ(Z, 0.6)).toBe(2);
    expect(layerOfZ(Z, 0.55)).toBe(2);
    expect(layerOfZ(Z, 0.45)).toBe(1);
    expect(layerOfZ(Z, 5)).toBe(-1);
    expect(zOfLayer(Z, 2)).toBe(0.6);
  });
  it('builds markers with colours and titles', () => {
    const t = sliderTicks([
      { z: 0.6, type: 'color_change', color: '#ff0000', extruder: 1 },
      { z: 0.4, type: 'pause', extra: 'magnets' },
      { z: 0.8, type: 'tool_change', extruder: 2 },
      { z: 9, type: 'custom', extra: 'M117' },
    ], Z, [0x112233, 0x445566]);
    expect(t.map((x) => [x.layer, x.color])).toEqual([[1, '#f5b041'], [2, '#ff0000'], [3, '#445566']]);
    expect(t[0].title).toContain('magnets');
  });
});

describe('colour print', () => {
  it('parses COLOR_CHANGE tags and remaps segments to new colour slots', () => {
    const g = [
      ';LAYER_CHANGE', ';Z:0.2', 'G1 Z0.2', ';TYPE:Outer wall', 'G1 X10 Y0 E1', 'G1 X10 Y10 E1',
      ';LAYER_CHANGE', ';Z:0.4', 'G1 Z0.4', ';COLOR_CHANGE,T0,#FF0000', 'M600', 'G1 X0 Y10 E1', 'G1 X0 Y0 E1',
      ';LAYER_CHANGE', ';Z:0.6', 'G1 Z0.6', '; COLOR_CHANGE,T0', 'G1 X10 Y0 E1',
    ].join('\n');
    const p = parseGcode(new TextEncoder().encode(g)) as ParsedGcode;
    expect(p.colorChanges?.length).toBe(2);
    expect(p.colorChanges![0].color).toBe(0xff0000);
    const r = colorPrintSlots(p, [0x00ff00])!;
    expect(r.colors.slice(0, 2)).toEqual([0x00ff00, 0xff0000]);
    expect(r.colors.length).toBe(3);
    const firstSlot = r.tool[p.layerStart[0] + 1];
    const lastSlot = r.tool[p.segmentCount - 1];
    expect(firstSlot).toBe(0);
    expect(lastSlot).toBe(2);
    expect(colorPrintSlots({ ...p, colorChanges: undefined }, [])).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { FlatConfig } from '../engine/types';
import {
  computeImexZoneLayout, effectiveImexMode, imexCarriages, imexHeadTransforms, imexModeKind, imexPlateModeChoices, imexPrimaryTool,
  imexZoneViolation, parseImexActiveTools,
} from './imex';

// Vivedino Xplorer IDEX / IQEX 0.4 (Orca 2.5 profiles).
const IDEX: FlatConfig = {
  is_imex: '1', imex_tool_layout: 'front-left', imex_nozzle_clearance_x: '40',
  imex_mode_names: ['primary', 'copy', 'mirror'], imex_mode_active_tools: ['0:P', '0:P,1:C', '0:P,1:M'],
  imex_mode_gcodes: ['SET_PRINT_MODE MODE=PRIMARY', 'SET_PRINT_MODE MODE=COPY', 'SET_PRINT_MODE MODE=MIRROR'],
};
const IQEX: FlatConfig = {
  is_imex: '1', imex_gantry_count: '2', imex_tool_layout: 'rear-left', imex_nozzle_clearance_x: '40',
  imex_mode_names: ['primary', 'copy', 'mirror', 'iq-copy', 'iq-mirror', 'mc-copy', 'mc-mirror'],
  imex_mode_active_tools: ['0:P', '0:P,1:C', '0:P,1:M', '0:P,1:C,2:C,3:C', '0:P,1:C,2:M,3:M', '0:P,1:S,2:C,3:C', '0:P,1:S,2:M,3:M'],
};
const BED = { min: [0, 0] as [number, number], max: [400, 400] as [number, number] };

describe('IMEX modes', () => {
  it('parses roles and the primary', () => {
    expect(parseImexActiveTools('0:P, 1:C,2:M,3:S,4:X')).toEqual([[0, 'P'], [1, 'C'], [2, 'M'], [3, 'S'], [4, 'C']]);
    expect(imexPrimaryTool('1:C,0:P')).toBe(0);
    expect(imexPrimaryTool('2,3:C')).toBe(2); // legacy bare index
    expect(imexModeKind('0:P')).toBe('primary');
    expect(imexModeKind('0:P,1:C')).toBe('copy');
    expect(imexModeKind('0:P,1:C,2:M,3:M')).toBe('mirror');
    expect(imexModeKind('0:P,1:S,2:C,3:C')).toBe('custom');
  });
  it('lists plate choices once, primary first', () => {
    expect(imexPlateModeChoices(IDEX)).toEqual(['primary', 'copy', 'mirror']);
  });
  it('plate mode wins over the process preset unless primary', () => {
    expect(effectiveImexMode({ ...IDEX, imex_parallel_mode: 'copy' }, undefined)).toBe('copy');
    expect(effectiveImexMode({ ...IDEX, imex_parallel_mode: 'copy' }, { imex_parallel_mode: 'mirror' })).toBe('mirror');
    expect(effectiveImexMode({}, { imex_parallel_mode: 'mirror' })).toBe('');
  });
});

describe('IMEX zones', () => {
  it('no zones in primary mode or on a plain printer', () => {
    expect(computeImexZoneLayout(IDEX, 'primary', BED).primaryZone).toBeNull();
    expect(computeImexZoneLayout({ ...IDEX, is_imex: '0' }, 'copy', BED).primaryZone).toBeNull();
    expect(computeImexZoneLayout(IDEX, 'nonexistent', BED).primaryZone).toBeNull();
  });
  it('IDEX copy: left half for T0, right half copies, no strip', () => {
    const l = computeImexZoneLayout(IDEX, 'copy', BED);
    expect(l.primaryZone).toEqual({ x0: 0, x1: 200, y0: 0, y1: 400 });
    expect(l.copyZones).toEqual([{ x0: 200, x1: 400, y0: 0, y1: 400 }]);
    expect(l.collisionZones).toEqual([]);
    expect(imexHeadTransforms(IDEX, 'copy', l, BED)).toEqual([{ head: 1, role: 'C', sx: 1, sy: 1, tx: 200, ty: 0 }]);
  });
  it('IDEX mirror: a collision strip at the boundary, mirrored about x = 200', () => {
    const l = computeImexZoneLayout(IDEX, 'mirror', BED);
    expect(l.mirrorZones).toEqual([{ x0: 200, x1: 400, y0: 0, y1: 400 }]);
    expect(l.collisionZones).toEqual([{ x0: 160, x1: 200, y0: 0, y1: 400 }]);
    const [t] = imexHeadTransforms(IDEX, 'mirror', l, BED);
    expect(t).toMatchObject({ head: 1, sx: -1, sy: 1 });
    expect(t.sx * 50 + t.tx).toBe(350); // x = 50 in T0's zone prints at 350
    expect(imexZoneViolation(l, [[150, 10], [170, 10], [170, 30], [150, 30]])).toBe(true);
    expect(imexZoneViolation(l, [[10, 10], [150, 10], [150, 30], [10, 30]])).toBe(false);
  });
  it('front-right layout puts T0 on the right', () => {
    const l = computeImexZoneLayout({ ...IDEX, imex_tool_layout: 'front-right' }, 'mirror', BED);
    expect(l.primaryZone).toEqual({ x0: 200, x1: 400, y0: 0, y1: 400 });
    expect(l.collisionZones).toEqual([{ x0: 200, x1: 240, y0: 0, y1: 400 }]);
  });
  it('IQEX (rear-left) four-way mirror: T0 rear-left quadrant', () => {
    const l = computeImexZoneLayout(IQEX, 'iq-mirror', BED);
    expect(l.primaryZone).toEqual({ x0: 0, x1: 200, y0: 200, y1: 400 });
    expect(l.copyZones).toEqual([{ x0: 200, x1: 400, y0: 200, y1: 400 }]);
    expect(l.mirrorZones).toEqual([{ x0: 0, x1: 200, y0: 0, y1: 200 }, { x0: 200, x1: 400, y0: 0, y1: 200 }]);
    // T2 sits in front of T0: mirrored in Y across y = 200, strip along T0's front edge (clearance y defaults to 30).
    expect(l.collisionZones).toEqual([{ x0: 0, x1: 200, y0: 200, y1: 230 }]);
    const t2 = imexHeadTransforms(IQEX, 'iq-mirror', l, BED).find((t) => t.head === 2)!;
    expect([t2.sx, t2.sy]).toEqual([1, -1]);
    expect(t2.sy * 300 + t2.ty).toBe(100);
  });
  it('IQEX multicolour copy: the front gantry aggregates into a full-width strip', () => {
    const l = computeImexZoneLayout(IQEX, 'mc-copy', BED);
    expect(l.primaryZone).toEqual({ x0: 0, x1: 400, y0: 200, y1: 400 });
    expect(l.copyZones).toEqual([{ x0: 0, x1: 400, y0: 0, y1: 200 }]);
    const ts = imexHeadTransforms(IQEX, 'mc-copy', l, BED);
    expect(ts).toEqual([{ head: 2, role: 'C', sx: 1, sy: 1, tx: 0, ty: -200 }]);
  });
  it('preview carriages: primary box faces the mirror', () => {
    const l = computeImexZoneLayout(IDEX, 'mirror', BED);
    const c = imexCarriages(IDEX, 'mirror', l, BED)!;
    expect(c.size).toEqual([40, 30]);
    expect(c.carriages[0]).toMatchObject({ head: 0, boxX: 0 });
    expect(c.carriages[1]).toMatchObject({ head: 1, boxX: -40 });
    expect(imexCarriages({ ...IDEX, imex_firmware_managed_zones: '1' }, 'mirror', l, BED)).toBeNull();
  });
});

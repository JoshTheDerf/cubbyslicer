import { describe, expect, it } from 'vitest';
import { bedPoints, convexHullXY, parseBed, parseCustomText, serializeBed } from './bedShape';

describe('bed shape (Orca BedShape)', () => {
  it('round-trips a rectangle with origin', () => {
    const m = parseBed(['-110x-110', '110x-110', '110x110', '-110x110']);
    expect(m.type).toBe('rect');
    expect(m.rect).toEqual({ width: 220, depth: 220, originX: 110, originY: 110 });
    expect(serializeBed(bedPoints(m))).toEqual(['-110x-110', '110x-110', '110x110', '-110x110']);
  });
  it('detects circles centred on the origin', () => {
    const c = bedPoints({ type: 'circle', rect: { width: 0, depth: 0, originX: 0, originY: 0 }, circle: { diameter: 180 }, custom: [] });
    const m = parseBed(serializeBed(c));
    expect(m.type).toBe('circle');
    expect(m.circle.diameter).toBeCloseTo(180, 1);
  });
  it('keeps other polygons as custom', () => {
    const m = parseBed(['0x0', '200x0', '220x100', '200x200', '0x200']);
    expect(m.type).toBe('custom');
    expect(parseCustomText('0x0\n10x0, 10x10\nbad').bad).toBe(true);
  });
  it('hulls a mesh outline', () => {
    const hull = convexHullXY([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 5, 5, 3]);
    expect(hull).toHaveLength(4);
  });
});

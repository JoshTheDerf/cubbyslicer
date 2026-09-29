import { describe, expect, it } from 'vitest';
import { parseStl } from './stl';
import { parseModel } from './parse';
import { asciiStl, binaryStl, cubeSoup, toBuffer } from '../testutil';

describe('STL parser', () => {
  it('parses binary STL', () => {
    const soup = cubeSoup(10);
    const out = parseStl(binaryStl(soup));
    expect(out.length).toBe(soup.length);
    expect(Array.from(out)).toEqual(Array.from(soup));
  });

  it('parses ASCII STL', () => {
    const out = parseStl(toBuffer(asciiStl(cubeSoup(5))));
    expect(out.length).toBe(12 * 9);
    expect(Math.max(...out)).toBe(5);
  });

  it('treats a binary file whose header starts with "solid" as binary', () => {
    const buf = binaryStl(cubeSoup(10));
    new Uint8Array(buf).set(new TextEncoder().encode('solid binary header'), 0);
    expect(parseStl(buf).length).toBe(12 * 9);
  });

  it('clamps an over-declared triangle count to what the file holds', () => {
    const out = parseStl(binaryStl(cubeSoup(10), 1_000_000));
    expect(out.length).toBe(12 * 9);
  });

  it('rejects truncated / empty files', () => {
    expect(() => parseStl(new ArrayBuffer(0))).toThrow();
    expect(() => parseStl(new ArrayBuffer(40))).toThrow();
    expect(() => parseStl(binaryStl(new Float32Array(0)))).toThrow();
  });

  it('welds a cube soup to 8 vertices and centres it', () => {
    const r = parseModel('cube.stl', binaryStl(cubeSoup(10, [100, 100, 5])));
    const o = r.objects[0];
    expect(o.name).toBe('cube');
    expect(o.positions.length / 3).toBe(8);
    expect(o.indices.length / 3).toBe(12);
    expect(Math.min(...o.positions)).toBe(-5);
    expect(Math.max(...o.positions)).toBe(5);
  });

  it('drops NaN vertices and degenerate triangles', () => {
    const soup = cubeSoup(10);
    soup[0] = NaN;
    soup.set([1, 1, 1, 1, 1, 1, 2, 2, 2], 9);
    const r = parseModel('bad.stl', binaryStl(soup));
    expect(r.objects[0].indices.length / 3).toBe(10);
    expect(r.warnings.join()).toMatch(/degenerate/);
  });
});

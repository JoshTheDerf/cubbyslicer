import { describe, expect, it } from 'vitest';
import { parseObj } from './obj';
import { toBuffer } from '../testutil';

describe('OBJ parser', () => {
  it('parses vertices and triangulates quads', () => {
    const r = parseObj(toBuffer('o Box\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n'));
    expect(r.name).toBe('Box');
    expect(r.positions.length).toBe(12);
    expect(Array.from(r.indices)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('supports v/vt/vn tokens and negative indices', () => {
    const r = parseObj(toBuffer('v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nf -3//1 -2//1 -1//1\nf 1/1/1 2/2/1 3/3/1\n'));
    expect(Array.from(r.indices)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('skips out-of-range and malformed faces', () => {
    const r = parseObj(toBuffer('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\nf 1 2\nf 0 1 2\nf a b c\nf 1 2 3\n'));
    expect(r.indices.length).toBe(3);
    expect(r.skippedFaces).toBe(4);
  });

  it('handles CRLF line endings', () => {
    const r = parseObj(toBuffer('v 0 0 0\r\nv 1 0 0\r\nv 0 1 0\r\nf 1 2 3\r\n'));
    expect(r.indices.length).toBe(3);
  });

  it('rejects files without geometry', () => {
    expect(() => parseObj(toBuffer('# nothing\n'))).toThrow();
    expect(() => parseObj(toBuffer('v 0 0 0\n'))).toThrow();
  });
});

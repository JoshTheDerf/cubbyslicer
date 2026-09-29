import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'opentype.js';
import { DEFAULT_TEXT, textMeshFromFont, textName } from './textMesh';
import { isClosedManifold, signedVolume } from '../geom/meshUtil';
import { weldVertices } from '../../project/mesh';

const fontBytes = (f: string) => {
  const b = readFileSync(resolve(__dirname, '../../../public/fonts', f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('text emboss mesh', () => {
  const font = parse(fontBytes('NotoSans-Regular.ttf'));

  it('builds a closed, outward-wound solid for glyphs with holes', () => {
    const m = textMeshFromFont(font, { ...DEFAULT_TEXT, text: 'AgO8', size: 10, depth: 2 })!;
    expect(m).not.toBeNull();
    const w = weldVertices(m.positions, m.indices);
    expect(isClosedManifold(w.indices)).toBe(true);
    expect(signedVolume(w.positions, w.indices)).toBeGreaterThan(0);
    // z spans the depth; XY centred
    let zmin = Infinity, zmax = -Infinity, xmin = Infinity, xmax = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) {
      zmin = Math.min(zmin, m.positions[i + 2]); zmax = Math.max(zmax, m.positions[i + 2]);
      xmin = Math.min(xmin, m.positions[i]); xmax = Math.max(xmax, m.positions[i]);
    }
    expect(zmin).toBeCloseTo(0);
    expect(zmax).toBeCloseTo(2);
    expect(xmin + xmax).toBeCloseTo(0, 4);
  });

  it('scales with font size and grows with letter spacing', () => {
    const w = (t: Partial<typeof DEFAULT_TEXT>) => {
      const m = textMeshFromFont(font, { ...DEFAULT_TEXT, text: 'HH', ...t })!;
      let a = Infinity, b = -Infinity;
      for (let i = 0; i < m.positions.length; i += 3) { a = Math.min(a, m.positions[i]); b = Math.max(b, m.positions[i]); }
      return b - a;
    };
    expect(w({ size: 20 }) / w({ size: 10 })).toBeCloseTo(2, 1);
    expect(w({ size: 10, letterSpacing: 3 }) - w({ size: 10 })).toBeCloseTo(3, 1);
  });

  it('supports multiple lines and blank text', () => {
    expect(textMeshFromFont(font, { ...DEFAULT_TEXT, text: '   ' })).toBeNull();
    const one = textMeshFromFont(font, { ...DEFAULT_TEXT, text: 'A' })!;
    const two = textMeshFromFont(font, { ...DEFAULT_TEXT, text: 'A\nA' })!;
    const h = (m: typeof one) => { let a = Infinity, b = -Infinity; for (let i = 1; i < m.positions.length; i += 3) { a = Math.min(a, m.positions[i]); b = Math.max(b, m.positions[i]); } return b - a; };
    expect(h(two)).toBeGreaterThan(h(one) * 1.8);
  });

  it('names volumes after their text', () => {
    expect(textName('  Hello\n world ')).toBe('Hello world');
    expect(textName('')).toBe('Text');
    expect(textName('x'.repeat(40)).length).toBe(25);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  engineWritesGcodeThumbnails, extractGcodeThumbnails, formatThumbnailBlocks, hasGcodeThumbnails, parseThumbnailList,
  spliceThumbnails, thumbnailInsertOffset, thumbnailSpecs, type EncodedThumbnail,
} from './gcode';
import { base64 } from './encode';

const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../../preview/__fixtures__/${n}`, import.meta.url)));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const png = (w: number, h: number, bytes: Uint8Array): EncodedThumbnail => ({ spec: { width: w, height: h, format: 'PNG' }, width: w, height: h, bytes });

describe('thumbnail list (make_and_check_thumbnail_list)', () => {
  it('parses Orca / Prusa strings', () => {
    expect(parseThumbnailList('96x96/PNG, 300x300/PNG').specs).toEqual([
      { width: 96, height: 96, format: 'PNG' }, { width: 300, height: 300, format: 'PNG' }]);
    expect(parseThumbnailList('16x16/QOI,313x173/qoi,48x48/JPG,160x160/BTT_TFT,200x200/ColPic').specs.map((s) => s.format))
      .toEqual(['QOI', 'QOI', 'JPG', 'BTT_TFT', 'COLPIC']);
  });
  it('uses thumbnails_format for entries without an extension, else PNG', () => {
    expect(parseThumbnailList('48x48, 300x300/QOI', 'JPG').specs.map((s) => s.format)).toEqual(['JPG', 'QOI']);
    expect(parseThumbnailList('48x48').specs[0].format).toBe('PNG');
    expect(thumbnailSpecs({ thumbnails: ['96x96', '300x300'], thumbnails_format: 'QOI' }, 'orca').specs.map((s) => [s.width, s.format]))
      .toEqual([[96, 'QOI'], [300, 'QOI']]);
  });
  it('none configured → no thumbnails', () => {
    expect(thumbnailSpecs({}, 'orca').specs).toEqual([]);
    expect(thumbnailSpecs({ thumbnails: '' }, 'preflight').specs).toEqual([]);
    expect(thumbnailSpecs({ thumbnails: [] }, 'orca').specs).toEqual([]);
  });
  it('reports bad entries like the engines do', () => {
    // Orca: unknown extension → PNG (flagged); preFlight skips it.
    expect(parseThumbnailList('48x48/BMP', '', 'orca')).toEqual({ specs: [{ width: 48, height: 48, format: 'PNG' }], errors: ['InvalidExt'] });
    expect(parseThumbnailList('48x48/BMP', '', 'preflight')).toEqual({ specs: [], errors: ['InvalidExt'] });
    expect(parseThumbnailList('0x48/PNG, 1000x10/PNG').errors).toEqual(['OutOfRange']);
    expect(parseThumbnailList('garbage').errors).toEqual(['InvalidVal']);
  });
  it('skips Bambu Lab printers on Orca (thumbnails go into the 3MF there)', () => {
    expect(engineWritesGcodeThumbnails({ printer_model: 'Bambu Lab P1S' }, 'orca')).toBe(false);
    expect(engineWritesGcodeThumbnails({ printer_model: 'Voron 2.4 350' }, 'orca')).toBe(true);
    expect(engineWritesGcodeThumbnails({ printer_model: 'Bambu Lab P1S' }, 'preflight')).toBe(true);
    expect(engineWritesGcodeThumbnails({ binary_gcode: '1' }, 'preflight')).toBe(false);
  });
});

describe('G-code thumbnail blocks (export_thumbnails_to_file)', () => {
  const bytes = new Uint8Array(100).map((_, i) => (i * 37) & 255); // 136 base64 chars → 78 + 58
  const b64 = base64(bytes);

  it('Orca: THUMBNAIL_BLOCK per image, 78-char rows, LEN = base64 length', () => {
    const out = formatThumbnailBlocks([png(48, 48, bytes)], 'orca', base64);
    expect(b64.length).toBe(136);
    expect(out).toBe(`; THUMBNAIL_BLOCK_START\n\n;\n; thumbnail begin 48x48 136\n; ${b64.slice(0, 78)}\n; ${b64.slice(78)}\n; thumbnail end\n; THUMBNAIL_BLOCK_END\n\n`);
  });

  it('preFlight: PrusaSlicer layout, no block markers', () => {
    const out = formatThumbnailBlocks([png(48, 48, bytes), { ...png(16, 16, bytes), spec: { width: 16, height: 16, format: 'QOI' } }], 'preflight', base64);
    expect(out).toBe(`\n;\n; thumbnail begin 48x48 136\n; ${b64.slice(0, 78)}\n; ${b64.slice(78)}\n; thumbnail end\n;\n`
      + `\n;\n; thumbnail_QOI begin 16x16 136\n; ${b64.slice(0, 78)}\n; ${b64.slice(78)}\n; thumbnail_QOI end\n;\n`);
  });

  it('exact multiple of 78 leaves no empty row; JPG tag', () => {
    const b = new Uint8Array(117); // 156 chars = 2 rows
    const out = formatThumbnailBlocks([{ ...png(8, 8, b), spec: { width: 8, height: 8, format: 'JPG' } }], 'orca', base64);
    const rows = out.split('\n').filter((l) => /^; [A-Za-z0-9+/=]{10,}$/.test(l));
    expect(rows.map((r) => r.length)).toEqual([80, 80]);
    expect(out).toContain('; thumbnail_JPG begin 8x8 156\n');
    expect(out).toContain('; thumbnail_JPG end\n; THUMBNAIL_BLOCK_END\n\n');
  });

  it('BTT_TFT: size header in hex, CRLF, end marker after the last entry only', () => {
    const btt = (w: number, h: number): EncodedThumbnail => ({ spec: { width: w, height: h, format: 'BTT_TFT' }, width: w, height: h, text: `;ffff\r\n` });
    expect(formatThumbnailBlocks([btt(70, 70), btt(160, 160)], 'orca', base64))
      .toBe(';00460046\r\n;ffff\r\n;00a000a0\r\n;ffff\r\n; bigtree thumbnail end\r\n\r\n');
  });

  it('ColPic: first under ;gimage:, then ;simage:', () => {
    const cp = (w: number): EncodedThumbnail => ({ spec: { width: w, height: w, format: 'COLPIC' }, width: w, height: w, text: 'ABC' });
    expect(formatThumbnailBlocks([cp(200), cp(160)], 'orca', base64)).toBe('\n\n;gimage:ABC\n\n\n\n;simage:ABC\n\n');
  });

  it('round-trips through extract', () => {
    const out = formatThumbnailBlocks([png(48, 48, bytes), png(300, 300, bytes)], 'orca', base64);
    expect(extractGcodeThumbnails(out)).toEqual([
      { tag: 'thumbnail', width: 48, height: 48, base64: b64 }, { tag: 'thumbnail', width: 300, height: 300, base64: b64 }]);
  });
});

describe('where the blocks go', () => {
  it('Orca: after HEADER_BLOCK_END and its blank line', () => {
    const g = fixture('orca-2.3.gcode');
    const blocks = formatThumbnailBlocks([png(4, 4, new Uint8Array([1, 2, 3]))], 'orca', base64);
    const t = text(spliceThumbnails(g, blocks, 'orca'));
    expect(t).toContain('; filament: 1\n; HEADER_BLOCK_END\n\n; THUMBNAIL_BLOCK_START\n\n;\n; thumbnail begin 4x4 4\n; AQID\n; thumbnail end\n; THUMBNAIL_BLOCK_END\n\n; external perimeters extrusion width = 0.45mm\n');
    expect(hasGcodeThumbnails(spliceThumbnails(g, blocks, 'orca'))).toBe(true);
    expect(hasGcodeThumbnails(g)).toBe(false);
    expect(text(spliceThumbnails(g, blocks, 'orca')).length).toBe(text(g).length + blocks.length);
  });

  it('Orca with BTT_TFT (no header block): before the extrusion widths', () => {
    const g = new TextEncoder().encode('; external perimeters extrusion width = 0.45mm\n\n; EXECUTABLE_BLOCK_START\nG28\n');
    expect(thumbnailInsertOffset(g, 'orca')).toBe(0);
    const g2 = new TextEncoder().encode('M117 hello\n; external perimeters extrusion width = 0.45mm\n');
    expect(thumbnailInsertOffset(g2, 'orca')).toBe('M117 hello\n'.length);
  });

  it('preFlight: after the "generated by" line and blank line', () => {
    const g = new TextEncoder().encode('; generated by preFlight 1.3.0 on 2026-09-25 at 10:00:00 UTC\n\n; external perimeters extrusion width = 0.45mm\n');
    const blocks = formatThumbnailBlocks([png(4, 4, new Uint8Array([1, 2, 3]))], 'preflight', base64);
    expect(text(spliceThumbnails(g, blocks, 'preflight')))
      .toBe('; generated by preFlight 1.3.0 on 2026-09-25 at 10:00:00 UTC\n\n\n;\n; thumbnail begin 4x4 4\n; AQID\n; thumbnail end\n;\n; external perimeters extrusion width = 0.45mm\n');
  });

  it('byte offsets survive multi-byte characters before the anchor', () => {
    const g = new TextEncoder().encode('; HEADER_BLOCK_START\n; generated by OrcaSlicer — ✓ on …\n; HEADER_BLOCK_END\n\nG28\n');
    const t = text(spliceThumbnails(g, 'X\n', 'orca'));
    expect(t).toBe('; HEADER_BLOCK_START\n; generated by OrcaSlicer — ✓ on …\n; HEADER_BLOCK_END\n\nX\nG28\n');
  });
});

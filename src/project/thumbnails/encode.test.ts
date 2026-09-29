import { inflateSync, crc32 as nodeCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { base64, colpicSize, encodeBttTft, encodeColPic, encodePng, encodeQoi, type RgbaImage } from './encode';

/** A little test image: transparent background, a gradient square, a flat run. */
function sample(w = 24, h = 16): RgbaImage {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (x > 3 && x < 18 && y > 2 && y < 13) { px[i] = 200 + (x & 7); px[i + 1] = 60 + y; px[i + 2] = x * 9; px[i + 3] = 255; }
    else if (y === 14) { px[i] = 10; px[i + 1] = 20; px[i + 2] = 30; px[i + 3] = 128; }
  }
  return { width: w, height: h, pixels: px };
}

describe('PNG', () => {
  it('writes a valid 8-bit RGBA PNG (filter 0 rows)', () => {
    const img = sample();
    const png = encodePng(img);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dv = new DataView(png.buffer, png.byteOffset);
    let o = 8;
    const chunks: Record<string, Uint8Array> = {};
    while (o < png.length) {
      const len = dv.getUint32(o);
      const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
      const data = png.subarray(o + 8, o + 8 + len);
      expect(dv.getUint32(o + 8 + len)).toBe(nodeCrc32(png.subarray(o + 4, o + 8 + len)));
      chunks[type] = data;
      o += 12 + len;
    }
    expect(Object.keys(chunks)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect([...chunks.IHDR]).toEqual([0, 0, 0, 24, 0, 0, 0, 16, 8, 6, 0, 0, 0]);
    const raw = inflateSync(chunks.IDAT);
    expect(raw.length).toBe(16 * (24 * 4 + 1));
    for (let y = 0; y < 16; y++) {
      expect(raw[y * 97]).toBe(0);
      expect(Buffer.compare(raw.subarray(y * 97 + 1, (y + 1) * 97), Buffer.from(img.pixels.subarray(y * 96, (y + 1) * 96)))).toBe(0);
    }
  });
});

/** Reference QOI decoder (qoi.h). */
function qoiDecode(b: Uint8Array): RgbaImage {
  const dv = new DataView(b.buffer, b.byteOffset);
  expect(String.fromCharCode(...b.subarray(0, 4))).toBe('qoif');
  const w = dv.getUint32(4), h = dv.getUint32(8);
  expect([b[12], b[13]]).toEqual([4, 0]);
  const out = new Uint8Array(w * h * 4);
  const index = new Uint8Array(256);
  let r = 0, g = 0, bl = 0, a = 255, p = 14, run = 0;
  for (let px = 0; px < out.length; px += 4) {
    if (run > 0) run--;
    else {
      const b1 = b[p++];
      if (b1 === 0xfe) { r = b[p++]; g = b[p++]; bl = b[p++]; }
      else if (b1 === 0xff) { r = b[p++]; g = b[p++]; bl = b[p++]; a = b[p++]; }
      else if ((b1 & 0xc0) === 0x00) { const i = b1 * 4; r = index[i]; g = index[i + 1]; bl = index[i + 2]; a = index[i + 3]; }
      else if ((b1 & 0xc0) === 0x40) { r = (r + ((b1 >> 4) & 3) - 2) & 255; g = (g + ((b1 >> 2) & 3) - 2) & 255; bl = (bl + (b1 & 3) - 2) & 255; }
      else if ((b1 & 0xc0) === 0x80) { const b2 = b[p++]; const vg = (b1 & 0x3f) - 32; r = (r + vg - 8 + ((b2 >> 4) & 15)) & 255; g = (g + vg) & 255; bl = (bl + vg - 8 + (b2 & 15)) & 255; }
      else run = b1 & 0x3f;
      const i = ((r * 3 + g * 5 + bl * 7 + a * 11) % 64) * 4;
      index[i] = r; index[i + 1] = g; index[i + 2] = bl; index[i + 3] = a;
    }
    out[px] = r; out[px + 1] = g; out[px + 2] = bl; out[px + 3] = a;
  }
  expect([...b.subarray(b.length - 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  return { width: w, height: h, pixels: out };
}

describe('QOI', () => {
  it('round-trips through a reference decoder', () => {
    const img = sample();
    expect(qoiDecode(encodeQoi(img)).pixels).toEqual(img.pixels);
    // all-transparent → one long run chain
    const empty: RgbaImage = { width: 100, height: 3, pixels: new Uint8Array(1200) };
    expect(qoiDecode(encodeQoi(empty)).pixels).toEqual(empty.pixels);
  });
});

describe('BTT_TFT', () => {
  it('RGB565 hex of alpha-premultiplied pixels, one ";" row per line, CRLF', () => {
    const img: RgbaImage = { width: 3, height: 2, pixels: new Uint8Array([
      255, 255, 255, 255, /* white */ 255, 0, 0, 255, /* red */ 0, 0, 0, 0, /* transparent */
      255, 255, 255, 128, /* half white */ 8, 8, 8, 255, /* → 0841 → 0000 */ 0, 8, 0, 255, /* → 0040 */
    ]) };
    expect(encodeBttTft(img)).toBe(';fffff8000000\r\n;8410' + '0000' + '0040\r\n');
  });
});

/** Decode a ColPic string back to its RGB565 pixels (checks header, palette and RLE). */
function colpicDecode(s: string): { w: number; h: number; px: number[] } {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const t = [...s.slice(i, i + 4)].map((c) => (c === '~' ? 92 : c.charCodeAt(0)) - 48);
    bytes.push((t[0] << 2) | (t[1] >> 4), ((t[1] & 15) << 4) | (t[2] >> 2), ((t[2] & 3) << 6) | t[3]);
  }
  const u8 = new Uint8Array(bytes);
  const dv = new DataView(u8.buffer);
  expect(u8[0]).toBe(3);
  expect(dv.getUint32(12, true)).toBe(0x05ddc33c);
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true), listBytes = dv.getUint32(16, true), dataBytes = dv.getUint32(20, true);
  const pal: number[] = [];
  for (let i = 0; i < listBytes / 2; i++) pal.push(dv.getUint16(32 + i * 2, true));
  const px: number[] = [];
  let sid = 0;
  for (let i = 32 + listBytes; i < 32 + listBytes + dataBytes;) {
    const b = u8[i++];
    const hi = b >> 5, lo = b & 31;
    if (hi === 7) { sid = lo; continue; }
    const n = hi === 0 ? u8[i++] : hi;
    for (let k = 0; k < n; k++) px.push(pal[sid * 32 + lo]);
  }
  return { w, h, px };
}

describe('ColPic', () => {
  it('encodes palette + RLE that decodes back to the RGB565 image (transparent → Orca background)', () => {
    const img = sample(40, 30);
    const s = encodeColPic(img);
    expect(s.length % 4).toBe(0);
    expect(s).not.toContain('\\');
    const d = colpicDecode(s);
    expect([d.w, d.h]).toEqual([40, 30]);
    const expected: number[] = [];
    for (let i = 0; i < 40 * 30; i++) {
      const [r, g, b, a] = img.pixels.subarray(i * 4, i * 4 + 4);
      expected.push(a === 0 ? ((46 >> 3) << 11) | ((51 >> 2) << 5) | (72 >> 3) : ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
    }
    expect(d.px).toEqual(expected);
  });
  it('caps at 512 px keeping the aspect', () => {
    expect(colpicSize(300, 300)).toEqual([300, 300]);
    expect(colpicSize(900, 600)).toEqual([512, 341]);
    expect(colpicSize(600, 900)).toEqual([341, 512]);
  });
});

describe('base64', () => {
  it('matches Buffer (with padding)', () => {
    const b = new Uint8Array(70000).map((_, i) => (i * 7919) & 255);
    expect(base64(b)).toBe(Buffer.from(b).toString('base64'));
    expect(base64(new Uint8Array([1, 2]))).toBe('AQI=');
  });
});

/**
 * Thumbnail image encoders, ported from OrcaSlicer / preFlight
 * libslic3r/GCode/Thumbnails.cpp so the G-code payloads match what the
 * desktop apps write for the same pixels.
 *
 * Every encoder takes an RGBA image with rows top-down (the order image files
 * use). Orca's ThumbnailData is bottom-up (glReadPixels) and each Orca encoder
 * flips it first; the renderer here flips once on readback instead.
 */
import { zlibSync } from 'fflate';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, rows top-down. */
  pixels: Uint8Array;
}

// ---- PNG (miniz tdefl_write_image_to_png_file_in_memory_ex: filter 0 on every row, one IDAT) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGBA → PNG (8-bit RGBA, zlib level 6 like MZ_DEFAULT_LEVEL). */
export function encodePng(img: RgbaImage, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  const { width: w, height: h, pixels } = img;
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = zlibSync(raw, { level });
  const chunks: Array<[string, Uint8Array]> = [
    ['IHDR', new Uint8Array([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 6, 0, 0, 0])],
    ['IDAT', idat],
    ['IEND', new Uint8Array(0)],
  ];
  const size = 8 + chunks.reduce((s, [, d]) => s + 12 + d.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let o = 8;
  for (const [type, data] of chunks) {
    dv.setUint32(o, data.length);
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
    out.set(data, o + 8);
    dv.setUint32(o + 8 + data.length, crc32(out, o + 4, o + 8 + data.length));
    o += 12 + data.length;
  }
  return out;
}

// ---- QOI (reference qoi.h encoder, 4 channels, QOI_SRGB) ----

export function encodeQoi(img: RgbaImage): Uint8Array {
  const { width: w, height: h, pixels } = img;
  const out = new Uint8Array(14 + w * h * 5 + 8);
  const dv = new DataView(out.buffer);
  let p = 0;
  out.set([0x71, 0x6f, 0x69, 0x66], 0); // "qoif"
  dv.setUint32(4, w);
  dv.setUint32(8, h);
  out[12] = 4; // channels
  out[13] = 0; // QOI_SRGB
  p = 14;
  const index = new Uint8Array(64 * 4);
  let run = 0;
  let pr = 0, pg = 0, pb = 0, pa = 255;
  const len = w * h * 4;
  const last = len - 4;
  for (let px = 0; px < len; px += 4) {
    const r = pixels[px], g = pixels[px + 1], b = pixels[px + 2], a = pixels[px + 3];
    if (r === pr && g === pg && b === pb && a === pa) {
      run++;
      if (run === 62 || px === last) { out[p++] = 0xc0 | (run - 1); run = 0; }
      continue;
    }
    if (run > 0) { out[p++] = 0xc0 | (run - 1); run = 0; }
    const ix = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
    if (index[ix] === r && index[ix + 1] === g && index[ix + 2] === b && index[ix + 3] === a) {
      out[p++] = ix / 4;
    } else {
      index[ix] = r; index[ix + 1] = g; index[ix + 2] = b; index[ix + 3] = a;
      if (a === pa) {
        // qoi.h computes the diffs as signed chars.
        const vr = ((r - pr) << 24) >> 24, vg = ((g - pg) << 24) >> 24, vb = ((b - pb) << 24) >> 24;
        const vgr = ((vr - vg) << 24) >> 24, vgb = ((vb - vg) << 24) >> 24;
        if (vr > -3 && vr < 2 && vg > -3 && vg < 2 && vb > -3 && vb < 2) {
          out[p++] = 0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2);
        } else if (vgr > -9 && vgr < 8 && vg > -33 && vg < 32 && vgb > -9 && vgb < 8) {
          out[p++] = 0x80 | (vg + 32);
          out[p++] = ((vgr + 8) << 4) | (vgb + 8);
        } else {
          out[p++] = 0xfe; out[p++] = r; out[p++] = g; out[p++] = b;
        }
      } else {
        out[p++] = 0xff; out[p++] = r; out[p++] = g; out[p++] = b; out[p++] = a;
      }
    }
    pr = r; pg = g; pb = b; pa = a;
  }
  out.set([0, 0, 0, 0, 0, 0, 0, 1], p);
  return out.slice(0, p + 8);
}

// ---- BTT_TFT (RGB565 hex text, one ';'-prefixed line per row, CRLF) ----

export const hex4 = (n: number) => n.toString(16).padStart(4, '0');

export function encodeBttTft(img: RgbaImage): string {
  const { width: w, height: h, pixels } = img;
  const lines: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = ';';
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = pixels[i + 3];
      const rv = Math.floor((a * pixels[i]) / 255), gv = Math.floor((a * pixels[i + 1]) / 255), bv = Math.floor((a * pixels[i + 2]) / 255);
      let c = hex4(((rv >> 3) << 11) | ((gv >> 2) << 5) | (bv >> 3));
      if (c === '0020' || c === '0841' || c === '0861') c = '0000'; // as BTT's own converter
      line += c;
    }
    lines.push(`${line}\r\n`);
  }
  return lines.join('');
}

// ---- ColPic (Elegoo Neptune / QIDI; "ColPic_EncodeStr") ----

/** ColPic is capped at 512 px on the long side (aspect kept, at least 1 px). */
export function colpicSize(w: number, h: number): [number, number] {
  const MAX = 512;
  if (w <= MAX && h <= MAX) return [w, h];
  const ar = w / h;
  return ar > 1 ? [MAX, Math.max(1, Math.trunc(MAX / ar))] : [Math.max(1, Math.trunc(MAX * ar)), MAX];
}

interface U16Head { colo16: number; A0: number; A1: number; A2: number; qty: number }

function colPicEncode(from: Uint16Array, picw: number, pich: number, out: Uint8Array, outMax: number, colorsMaxIn: number): number {
  const colorsMax = Math.min(colorsMaxIn, 1024);
  const list: U16Head[] = [];
  const dots = picw * pich;
  for (let i = 0; i < dots; i++) {
    const val = from[i];
    if (list.length >= 1024) continue;
    const hit = list.find((l) => l.colo16 === val);
    if (hit) { hit.qty++; continue; }
    list.push({ colo16: val, A0: (val >> 11) & 255, A1: ((val << 5) >> 10) & 255, A2: ((val << 11) >> 11) & 255, qty: 1 });
  }
  // Orca's insertion sort by count (ties: the later one goes first).
  for (let index = 1; index < list.length; index++) {
    const l0 = list[index];
    for (let i = 0; i < index; i++) {
      if (l0.qty >= list[i].qty) { list.splice(index, 1); list.splice(i, 0, l0); break; }
    }
  }
  while (list.length > colorsMax) {
    const l0 = list[list.length - 1];
    let minval = 255, fid = -1;
    for (let i = 0; i < colorsMax; i++) {
      const ch = Math.abs(list[i].A0 - l0.A0) + Math.abs(list[i].A1 - l0.A1) + Math.abs(list[i].A2 - l0.A2);
      if (ch < minval) { minval = ch; fid = i; }
    }
    for (let i = 0; i < dots; i++) if (from[i] === l0.colo16) from[i] = list[fid].colo16;
    list.pop();
  }
  const HEAD = 32;
  out.fill(0, 0, HEAD);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const listBytes = list.length * 2;
  out[0] = 3; // encodever
  dv.setUint16(2, 0, true); // oncelistqty
  dv.setUint32(12, 0x05ddc33c, true); // mark
  dv.setUint32(16, listBytes, true); // ListDataSize
  list.forEach((l, i) => dv.setUint16(HEAD + i * 2, l.colo16, true));
  const palette = list.map((l) => l.colo16);
  // Byte8bitEncode
  const base = HEAD + listBytes;
  const max = outMax - HEAD - listBytes;
  let src = 0, dec = 0, lastid = 0, left = dots;
  const put = (v: number): boolean => { if (dec >= max) return false; out[base + dec++] = v & 255; return true; };
  outer: while (left > 0) {
    let n = 1;
    for (let i = 0; i < left - 1; i++) {
      if (from[src + i] !== from[src + i + 1]) break;
      n++;
      if (n === 255) break;
    }
    let temp = palette.indexOf(from[src]);
    if (temp < 0) temp = 0;
    const tid = temp % 32, sid = Math.floor(temp / 32);
    if (lastid !== sid) { if (!put((7 << 5) + sid)) break outer; lastid = sid; }
    if (n <= 6) { if (!put((n << 5) + tid)) break outer; } else { if (!put(tid)) break outer; if (!put(n)) break outer; }
    src += n;
    left -= n;
  }
  dv.setUint32(20, dec, true); // ColorDataSize
  dv.setUint32(4, picw, true);
  dv.setUint32(8, pich, true);
  return HEAD + listBytes + dec;
}

/**
 * ColPic payload string (without the ";gimage:" / ";simage:" prefix).
 * `img` must already be at colpicSize(). Returns '' when encoding fails.
 */
export function encodeColPic(img: RgbaImage): string {
  const { width: w, height: h, pixels } = img;
  const buf = new Uint16Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let r = pixels[i * 4] >> 3, g = pixels[i * 4 + 1] >> 2, b = pixels[i * 4 + 2] >> 3;
    if (pixels[i * 4 + 3] === 0) { r = 46 >> 3; g = 51 >> 2; b = 72 >> 3; }
    buf[i] = (r << 11) | (g << 5) | b;
  }
  const outMax = Math.max(w * h * 10, 32 + 1024 * 2 + 64);
  const out = new Uint8Array(outMax + 4);
  let qty = colPicEncode(buf, w, h, out, outMax, 1024);
  if (qty === 0) return '';
  let pad = 3 - (qty % 3);
  while (pad-- > 0) out[qty++] = 0;
  if ((qty * 4) / 3 >= outMax) return '';
  const chars: string[] = [];
  for (let i = 0; i < qty; i += 3) {
    const t = [out[i] >> 2, ((out[i] & 3) << 4) + (out[i + 1] >> 4), ((out[i + 1] & 15) << 2) + (out[i + 2] >> 6), out[i + 2] & 63];
    for (const v of t) { const c = v + 48; chars.push(String.fromCharCode(c === 92 ? 126 : c)); }
  }
  return chars.join('');
}

// ---- base64 ----

export function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

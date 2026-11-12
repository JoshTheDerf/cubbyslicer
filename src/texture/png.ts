/**
 * The PNGs texture displacement layers carry: desktop's import
 * (TextureLibrary.cpp import_texture_to_library → encode_png_bytes) turns any
 * image into an 8-bit greyscale PNG, or an 8-bit RGB PNG (alpha dropped) when
 * it has colour. Pure: encoding takes decoded RGBA pixels.
 */
import { zlibSync } from 'fflate';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export interface PngInfo { width: number; height: number; bitDepth: number; colorType: number }

/** IHDR of a PNG, or null when the bytes aren't one. */
export function pngInfo(b: Uint8Array): PngInfo | null {
  if (b.length < 33 || SIG.some((v, i) => b[i] !== v)) return null;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20), bitDepth: b[24], colorType: b[25] };
}

/** is_decodable_8bit_png: an 8-bit greyscale, RGB or RGBA PNG (what the bake decodes as-is). */
export function isDecodable8bitPng(b: Uint8Array): boolean {
  const i = pngInfo(b);
  return !!i && i.width > 0 && i.height > 0 && i.bitDepth === 8 && (i.colorType === 0 || i.colorType === 2 || i.colorType === 6);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode 8-bit pixels (`channels` 1 = grey, 3 = RGB) as a PNG. */
export function encodePng(width: number, height: number, pixels: Uint8Array, channels: 1 | 3): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = channels === 1 ? 0 : 2;
  const parts = [new Uint8Array(SIG), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * encode_png_bytes on decoded RGBA: colour (any pixel with r, g, b not all
 * equal, image_has_color) → RGB PNG without alpha; otherwise a greyscale PNG.
 */
export function encodeTexturePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const n = width * height;
  let colour = false;
  for (let i = 0; i < n && !colour; i++) colour = rgba[i * 4] !== rgba[i * 4 + 1] || rgba[i * 4 + 1] !== rgba[i * 4 + 2];
  if (colour) {
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2]; }
    return encodePng(width, height, rgb, 3);
  }
  const grey = new Uint8Array(n);
  for (let i = 0; i < n; i++) grey[i] = rgba[i * 4];
  return encodePng(width, height, grey, 1);
}

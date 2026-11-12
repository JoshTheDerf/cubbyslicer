/**
 * Height-map images as the bake reads them (libslic3r/TextureDisplacement.cpp
 * decode_height_texture): an 8-bit grey PNG decodes to its pixels, a colour
 * PNG to RGB plus a height that is its luminance (0.299 / 0.587 / 0.114),
 * rows top to bottom. Plus desktop's Smoothing blur (smooth_height_pixels)
 * and the image-adjustment panel's filters (apply_texture_adjustments). Pure:
 * used by the Fast view's height texture, the adjustment panel and tests.
 */
import { unzlibSync } from 'fflate';
import { encodePng, pngInfo } from './png';

export interface HeightImage {
  width: number;
  height: number;
  /** Height per texel, row-major, top row first. */
  pixels: Uint8Array;
  /** Interleaved RGB for a colour source (absent for grey). */
  rgb?: Uint8Array;
}

/** TextureAdjustments (all 0 = unchanged). */
export interface TextureAdjustments {
  /** -1..1: -1 black, +1 white (a lift, not an offset). */
  brightness: number;
  /** -1..1: -1 flat mid-grey, +1 a hard threshold. */
  contrast: number;
  /** 0..1: unsharp-mask amount. */
  sharpness: number;
  /** 0..1: a fraction of 5 % of the short side (max 48 texels), as Smoothing. */
  blur: number;
  /** -180..180°: no effect on a grey image. */
  hue_deg: number;
}

export const IDENTITY_ADJUST: Readonly<TextureAdjustments> = Object.freeze({ brightness: 0, contrast: 0, sharpness: 0, blur: 0, hue_deg: 0 });
export const isIdentity = (a: TextureAdjustments | null | undefined) =>
  !a || (a.brightness === 0 && a.contrast === 0 && a.sharpness === 0 && a.blur === 0 && a.hue_deg === 0);

// ---- PNG decode ------------------------------------------------------------------------------

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a non-interlaced 8-bit grey / grey+alpha / RGB / RGBA PNG (what
 * layers carry: desktop's import writes grey or RGB). Null for anything else.
 */
export function decodePng(bytes: Uint8Array): HeightImage | null {
  const info = pngInfo(bytes);
  if (!info || info.bitDepth !== 8 || !info.width || !info.height) return null;
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[info.colorType];
  if (!channels || bytes[28] !== 0) return null; // bytes[28]: interlace method
  const idat: Uint8Array[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let o = 8; o + 12 <= bytes.length;) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (o + 12 + len > bytes.length) return null;
    if (type === 'IDAT') idat.push(bytes.subarray(o + 8, o + 8 + len));
    if (type === 'IEND') break;
    o += 12 + len;
  }
  let joined: Uint8Array<ArrayBuffer>;
  if (idat.length === 1) joined = idat[0] as Uint8Array<ArrayBuffer>;
  else {
    joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
    let k = 0;
    for (const c of idat) { joined.set(c, k); k += c.length; }
  }
  let raw: Uint8Array;
  try { raw = unzlibSync(joined); } catch { return null; }
  const { width: w, height: h } = info;
  const stride = w * channels;
  if (raw.length < (stride + 1) * h) return null;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y ? px[up + x] : 0;
      const c = x >= channels && y ? px[up + x - channels] : 0;
      px[dst + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : f === 4 ? v + paeth(a, b, c) : v) & 255;
    }
  }
  const n = w * h;
  if (channels <= 2) {
    if (channels === 1) return { width: w, height: h, pixels: px };
    const g = new Uint8Array(n);
    for (let i = 0; i < n; i++) g[i] = px[i * 2];
    return { width: w, height: h, pixels: g };
  }
  const rgb = new Uint8Array(n * 3), pixels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * channels], g = px[i * channels + 1], b = px[i * channels + 2];
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    pixels[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { width: w, height: h, pixels, rgb };
}

/** An image back to the PNG desktop writes (save_texture_to_library → encode_png_bytes): grey, or RGB with colour. */
export function encodeHeightPng(img: HeightImage): Uint8Array {
  return img.rgb ? encodePng(img.width, img.height, img.rgb, 3) : encodePng(img.width, img.height, img.pixels, 1);
}

// ---- blur (smooth_height_pixels) ---------------------------------------------------------------

/** Two passes of a wrapping box blur of `radius` texels (smooth_height_pixels_box), in place. */
function boxBlur(pixels: Uint8Array, width: number, height: number, radius: number): void {
  if (radius <= 0 || width <= 0 || height <= 0 || pixels.length !== width * height) return;
  const inv = 1 / (2 * radius + 1);
  const wrap = (i: number, n: number) => ((i % n) + n) % n;
  const tmp = new Uint8Array(pixels.length);
  const sum = new Uint32Array(width);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += pixels[row + wrap(k, width)];
      for (let x = 0; x < width; x++) {
        tmp[row + x] = Math.round(s * inv);
        s += pixels[row + wrap(x + radius + 1, width)];
        s -= pixels[row + wrap(x - radius, width)];
      }
    }
    sum.fill(0);
    for (let k = -radius; k <= radius; k++) {
      const row = wrap(k, height) * width;
      for (let x = 0; x < width; x++) sum[x] += tmp[row + x];
    }
    for (let y = 0; y < height; y++) {
      const dst = y * width, add = wrap(y + radius + 1, height) * width, sub = wrap(y - radius, height) * width;
      for (let x = 0; x < width; x++) {
        pixels[dst + x] = Math.round(sum[x] * inv);
        sum[x] += tmp[add + x] - tmp[sub + x];
      }
    }
  }
}

/** A continuous-radius blur: the next whole radius, cross-faded with the raw image (smooth_height_pixels). */
export function smoothHeightPixels(pixels: Uint8Array, width: number, height: number, radius: number): void {
  if (!(radius > 0) || width <= 0 || height <= 0 || pixels.length !== width * height) return;
  const whole = Math.max(1, Math.ceil(radius));
  const mix = Math.min(1, Math.max(0, radius / whole));
  const raw = mix < 0.999 ? pixels.slice() : null;
  boxBlur(pixels, width, height, whole);
  if (raw) for (let i = 0; i < pixels.length; i++) pixels[i] = Math.round(raw[i] + (pixels[i] - raw[i]) * mix);
}

/** Smoothing's radius (decode_height_texture): `smoothing` × 5 % of the short side, at most 48 texels. */
export function smoothingRadius(smoothing: number, width: number, height: number): number {
  return Math.min(1, Math.max(0, smoothing)) * Math.min(0.05 * Math.min(width, height), 48);
}

/** The layer's Smoothing applied to a copy (height and, for colour, each channel). */
export function smoothed(img: HeightImage, smoothing: number): HeightImage {
  if (!(smoothing > 0)) return img;
  const r = smoothingRadius(smoothing, img.width, img.height);
  const pixels = img.pixels.slice();
  smoothHeightPixels(pixels, img.width, img.height, r);
  return { ...img, pixels, ...(img.rgb ? { rgb: blurChannels(img.rgb, img.width, img.height, (c) => smoothHeightPixels(c, img.width, img.height, r)) } : {}) };
}

function blurChannels(rgb: Uint8Array, w: number, h: number, f: (c: Uint8Array) => void): Uint8Array {
  const n = w * h, out = rgb.slice(), ch = new Uint8Array(n);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) ch[i] = out[i * 3 + c];
    f(ch);
    for (let i = 0; i < n; i++) out[i * 3 + c] = ch[i];
  }
  return out;
}

// ---- adjustments (apply_texture_adjustments) ---------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const applyBrightness = (v: number, b: number) => (b >= 0 ? v + b * (1 - v) : v * (1 + b));
const applyContrast = (v: number, c: number) => (v - 0.5) * (c >= 0 ? 1 / Math.max(1e-3, 1 - c) : 1 + c) + 0.5;

/** adjustment_blur_radius: the same span and cap as Smoothing. */
export function adjustmentBlurRadius(blur: number, width: number, height: number): number {
  if (!(blur > 0) || width <= 0 || height <= 0) return 0;
  return clamp(blur, 0, 1) * Math.min(0.05 * Math.min(width, height), 48);
}

function spatial(ch: Uint8Array, w: number, h: number, blur: number, sharpness: number): void {
  if (blur > 0) smoothHeightPixels(ch, w, h, adjustmentBlurRadius(blur, w, h));
  if (!(sharpness > 0)) return;
  const base = ch.slice();
  smoothHeightPixels(base, w, h, Math.max(1, 0.002 * Math.min(w, h)));
  const amount = 1.5 * clamp(sharpness, 0, 1);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.round(clamp(ch[i] + amount * (ch[i] - base[i]), 0, 255));
}

/**
 * The adjustment panel's filters on a copy: tone (brightness, contrast; hue
 * for colour) per texel, then blur, then sharpen. A colour image's height is
 * recomputed as the luminance of the adjusted colour. Grey stays grey.
 */
export function applyTextureAdjustments(src: HeightImage, adj: TextureAdjustments): HeightImage {
  if (isIdentity(adj) || !src.width || !src.height) return { ...src, pixels: src.pixels.slice(), ...(src.rgb ? { rgb: src.rgb.slice() } : {}) };
  const { width: w, height: h } = src;
  const n = w * h;
  const brightness = clamp(adj.brightness, -1, 1), contrast = clamp(adj.contrast, -1, 0.999);
  const blur = clamp(adj.blur, 0, 1), sharpness = clamp(adj.sharpness, 0, 1);
  const tone = new Uint8Array(256);
  for (let i = 0; i < 256; i++) tone[i] = Math.round(clamp(applyContrast(applyBrightness(i / 255, brightness), contrast), 0, 1) * 255);
  if (!src.rgb) {
    const pixels = new Uint8Array(n);
    for (let i = 0; i < n; i++) pixels[i] = tone[src.pixels[i]];
    spatial(pixels, w, h, blur, sharpness);
    return { width: w, height: h, pixels };
  }
  const t = (adj.hue_deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const m = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  const turn = adj.hue_deg !== 0;
  let rgb: Uint8Array = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = tone[src.rgb[i * 3]], g = tone[src.rgb[i * 3 + 1]], b = tone[src.rgb[i * 3 + 2]];
    rgb[i * 3] = Math.round(clamp(turn ? m[0] * r + m[1] * g + m[2] * b : r, 0, 255));
    rgb[i * 3 + 1] = Math.round(clamp(turn ? m[3] * r + m[4] * g + m[5] * b : g, 0, 255));
    rgb[i * 3 + 2] = Math.round(clamp(turn ? m[6] * r + m[7] * g + m[8] * b : b, 0, 255));
  }
  if (blur > 0 || sharpness > 0) rgb = blurChannels(rgb, w, h, (ch) => spatial(ch, w, h, blur, sharpness));
  const pixels = new Uint8Array(n);
  for (let i = 0; i < n; i++) pixels[i] = Math.round(0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]);
  return { width: w, height: h, pixels, rgb };
}

/** downscale_height_texture: box-filtered so neither side exceeds `maxPx` (never upscales). */
export function downscaleHeight(src: HeightImage, maxPx: number): HeightImage {
  if (maxPx <= 0 || (src.width <= maxPx && src.height <= maxPx)) return src;
  const scale = Math.max(1, Math.ceil(Math.max(src.width, src.height) / maxPx));
  const w = Math.max(1, Math.floor(src.width / scale)), h = Math.max(1, Math.floor(src.height / scale));
  const pixels = new Uint8Array(w * h), rgb = src.rgb ? new Uint8Array(w * h * 3) : undefined;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w));
      let sh = 0, r = 0, g = 0, b = 0, cnt = 0;
      for (let sy = y0; sy < y1 && sy < src.height; sy++) {
        for (let sx = x0; sx < x1 && sx < src.width; sx++, cnt++) {
          const si = sy * src.width + sx;
          sh += src.pixels[si];
          if (src.rgb) { r += src.rgb[si * 3]; g += src.rgb[si * 3 + 1]; b += src.rgb[si * 3 + 2]; }
        }
      }
      const di = y * w + x;
      pixels[di] = cnt ? Math.floor(sh / cnt) : 0;
      if (rgb) { rgb[di * 3] = cnt ? Math.floor(r / cnt) : 0; rgb[di * 3 + 1] = cnt ? Math.floor(g / cnt) : 0; rgb[di * 3 + 2] = cnt ? Math.floor(b / cnt) : 0; }
    }
  }
  return { width: w, height: h, pixels, ...(rgb ? { rgb } : {}) };
}

// ---- a layer's height, cached -----------------------------------------------------------------

const decoded = new WeakMap<Uint8Array, HeightImage | null>();

/** A layer image decoded once per buffer (layers share library buffers). */
export function decodeLayerImage(bytes: Uint8Array): HeightImage | null {
  if (decoded.has(bytes)) return decoded.get(bytes)!;
  const img = decodePng(bytes);
  decoded.set(bytes, img);
  return img;
}

/**
 * What the bake samples for a layer: the image, the live adjustment (when the
 * panel is open), then Smoothing (decode_height_texture's order). Cached for
 * the last (image, adjustment, smoothing) per image.
 */
const heightCache = new WeakMap<Uint8Array, { key: string; img: HeightImage }>();
export function layerHeight(bytes: Uint8Array, smoothing: number, adjust?: TextureAdjustments | null): HeightImage | null {
  const key = `${smoothing}|${isIdentity(adjust) ? '' : JSON.stringify(adjust)}`;
  const hit = heightCache.get(bytes);
  if (hit && hit.key === key) return hit.img;
  const src = decodeLayerImage(bytes);
  if (!src) return null;
  const img = smoothed(isIdentity(adjust) ? src : applyTextureAdjustments(src, adjust!), smoothing);
  heightCache.set(bytes, { key, img });
  return img;
}

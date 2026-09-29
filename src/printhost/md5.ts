/**
 * MD5 (RFC 1321). WebCrypto has no MD5, but ElegooLink uploads carry the
 * file's MD5 and PrusaLink uses HTTP digest auth. Incremental so a large
 * G-code file can be hashed without an extra copy.
 */

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;

export class Md5 {
  private h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Int32Array(16);

  update(data: Uint8Array | string): this {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.total += bytes.length;
    let i = 0;
    if (this.bufLen) {
      const n = Math.min(64 - this.bufLen, bytes.length);
      this.buf.set(bytes.subarray(0, n), this.bufLen);
      this.bufLen += n; i = n;
      if (this.bufLen === 64) { this.block(this.buf, 0); this.bufLen = 0; }
    }
    for (; i + 64 <= bytes.length; i += 64) this.block(bytes, i);
    if (i < bytes.length) { this.buf.set(bytes.subarray(i), 0); this.bufLen = bytes.length - i; }
    return this;
  }

  hex(): string {
    const bits = this.total * 8;
    const pad = new Uint8Array(((this.bufLen < 56 ? 56 : 120) - this.bufLen) + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, bits >>> 0, true);
    dv.setUint32(pad.length - 4, Math.floor(bits / 0x100000000), true);
    this.update(pad);
    let out = '';
    for (let j = 0; j < 4; j++) {
      const v = this.h[j];
      for (let b = 0; b < 4; b++) out += ((v >>> (b * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return out;
  }

  private block(d: Uint8Array, o: number): void {
    const w = this.w;
    for (let j = 0; j < 16; j++) w[j] = d[o + j * 4] | (d[o + j * 4 + 1] << 8) | (d[o + j * 4 + 2] << 16) | (d[o + j * 4 + 3] << 24);
    let [a, b, c, dd] = this.h;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & dd); g = i; }
      else if (i < 32) { f = (dd & b) | (~dd & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ dd; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~dd); g = (7 * i) & 15; }
      const t = dd;
      dd = c; c = b;
      const x = (a + f + K[i] + w[g]) | 0;
      b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
      a = t;
    }
    this.h[0] = (this.h[0] + a) | 0; this.h[1] = (this.h[1] + b) | 0; this.h[2] = (this.h[2] + c) | 0; this.h[3] = (this.h[3] + dd) | 0;
  }
}

export function md5Hex(data: Uint8Array | string): string {
  return new Md5().update(data).hex();
}

/** MD5 of a Blob, read in chunks. */
export async function md5Blob(blob: Blob, chunk = 4 << 20): Promise<string> {
  const h = new Md5();
  for (let o = 0; o < blob.size; o += chunk) h.update(new Uint8Array(await blob.slice(o, o + chunk).arrayBuffer()));
  return h.hex();
}

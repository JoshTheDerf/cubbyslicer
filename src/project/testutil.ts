/** Test fixtures (only imported by *.test.ts). */
export function cubeSoup(size = 10, origin: [number, number, number] = [0, 0, 0]): Float32Array {
  const [ox, oy, oz] = origin;
  const s = size;
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ].map(([x, y, z]) => [x + ox, y + oy, z + oz]);
  const f = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const out = new Float32Array(f.length * 9);
  f.forEach((tri, i) => tri.forEach((vi, k) => out.set(v[vi], i * 9 + k * 3)));
  return out;
}

export function binaryStl(soup: Float32Array, declared?: number): ArrayBuffer {
  const n = soup.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, declared ?? n, true);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12;
    for (let k = 0; k < 9; k++) { dv.setFloat32(o, soup[i * 9 + k], true); o += 4; }
    o += 2;
  }
  return buf;
}

export function asciiStl(soup: Float32Array): string {
  let s = 'solid test\n';
  for (let i = 0; i < soup.length; i += 9) {
    s += ' facet normal 0 0 0\n  outer loop\n';
    for (let k = 0; k < 3; k++) s += `   vertex ${soup[i + k * 3]} ${soup[i + k * 3 + 1]} ${soup[i + k * 3 + 2]}\n`;
    s += '  endloop\n endfacet\n';
  }
  return s + 'endsolid test\n';
}

export function toBuffer(s: string): ArrayBuffer {
  const u = new TextEncoder().encode(s);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

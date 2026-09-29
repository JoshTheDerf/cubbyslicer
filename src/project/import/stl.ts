/**
 * STL parser (binary + ASCII). Produces a triangle soup; welding happens in
 * the caller. Defensive: triangle counts are checked against the file size,
 * ASCII is scanned in chunks (no giant string), non-finite values are dropped
 * by the welder.
 */
import { GrowF32, ImportError, checkTriangleBudget } from '../mesh';

export function isAsciiStl(bytes: Uint8Array): boolean {
  // "solid" prefix is not enough — many binary STLs start with "solid" in their header.
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart().toLowerCase();
  if (!head.startsWith('solid')) return false;
  if (bytes.length >= 84) {
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (84 + n * 50 === bytes.length) return false; // size matches binary exactly
  }
  // Look for an ASCII keyword and no NULs in the first KB.
  const probe = bytes.subarray(0, Math.min(bytes.length, 1024));
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return false;
  return /facet|endsolid/.test(new TextDecoder().decode(probe).toLowerCase()) || bytes.length < 84;
}

/** Returns a triangle soup (9 floats per triangle). */
export function parseStl(buffer: ArrayBuffer): Float32Array {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) throw new ImportError('STL file is empty.');
  if (isAsciiStl(bytes)) return parseAsciiStl(bytes);
  return parseBinaryStl(bytes);
}

export function parseBinaryStl(bytes: Uint8Array): Float32Array {
  if (bytes.length < 84) throw new ImportError('STL file is truncated (no header).');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = dv.getUint32(80, true);
  const fit = Math.floor((bytes.length - 84) / 50);
  // Trust the smaller of declared and what fits; some exporters write 0 or pad the file.
  let n = declared;
  if (declared === 0 || declared > fit) n = fit;
  if (n === 0) throw new ImportError('STL file contains no triangles.');
  checkTriangleBudget(n);
  const out = new Float32Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12; // skip normal
    const base = i * 9;
    for (let k = 0; k < 9; k++) { out[base + k] = dv.getFloat32(o, true); o += 4; }
    o += 2; // attribute byte count
  }
  return out;
}

const CHUNK = 8 * 1024 * 1024;

export function parseAsciiStl(bytes: Uint8Array): Float32Array {
  const dec = new TextDecoder();
  const verts = new GrowF32(Math.min(bytes.length / 8, 1 << 22));
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  let carry = '';
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const end = Math.min(bytes.length, off + CHUNK);
    let text = carry + dec.decode(bytes.subarray(off, end), { stream: end < bytes.length });
    const cut = end < bytes.length ? text.lastIndexOf('\n') : text.length;
    if (cut >= 0) { carry = text.slice(cut); text = text.slice(0, cut); } else { carry = text; continue; }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      verts.push3(Number(m[1]), Number(m[2]), Number(m[3]));
    }
    checkTriangleBudget(Math.floor(verts.length / 9));
  }
  if (carry) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(carry))) verts.push3(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const whole = Math.floor(verts.length / 9) * 9;
  if (whole === 0) throw new ImportError('ASCII STL contains no readable facets.');
  checkTriangleBudget(whole / 9);
  const arr = verts.toArray();
  return arr.length === whole ? arr : arr.slice(0, whole);
}

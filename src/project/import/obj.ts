/**
 * Wavefront OBJ parser: `v` + `f` (normals/UVs ignored). Polygons are
 * fan-triangulated, negative (relative) indices supported, out-of-range faces
 * are skipped and counted. Face colours for Orca's ObjColorDialog are kept
 * as per-triangle groups: `usemtl` materials (colours resolved from the MTL
 * on the page) or, without materials, `v x y z r g b` vertex colours.
 */
import { GrowF32, GrowU32, ImportError, checkTriangleBudget } from '../mesh';

export interface ObjParse {
  positions: Float32Array;
  indices: Uint32Array;
  skippedFaces: number;
  name: string | null;
  /** Per-triangle colour groups (see ParsedObject.faceGroups); absent when the file has no colours. */
  faceGroups?: { tri: Uint32Array; groups: Array<{ name: string; color: string | null }> };
  /** `mtllib` file names referenced by the OBJ. */
  mtllibs?: string[];
}

const NO_GROUP = 0xffffffff;
const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');

const CHUNK = 8 * 1024 * 1024;

export function parseObj(buffer: ArrayBuffer): ObjParse {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) throw new ImportError('OBJ file is empty.');
  const dec = new TextDecoder();
  const verts = new GrowF32(1 << 16);
  const idx = new GrowU32(1 << 16);
  let skipped = 0;
  let name: string | null = null;
  const face: number[] = [];
  // Colours: material groups (usemtl) and vertex colours.
  let triGroup = new Uint32Array(1 << 12), triGroupN = 0;
  const pushGroup = (g: number) => {
    if (triGroupN >= triGroup.length) { const n = new Uint32Array(triGroup.length * 2); n.set(triGroup); triGroup = n; }
    triGroup[triGroupN++] = g;
  };
  const materials = new Map<string, number>();
  let curMat = NO_GROUP;
  const vcol = new GrowF32(1 << 12); // r,g,b per vertex (NaN = none)
  let anyVcol = false;
  const mtllibs: string[] = [];

  const line = (l: string) => {
    const c0 = l.charCodeAt(0);
    if (c0 === 118 /* v */ && (l.charCodeAt(1) === 32 || l.charCodeAt(1) === 9)) {
      const p = l.trim().split(/\s+/);
      verts.push3(Number(p[1]), Number(p[2]), Number(p[3]));
      if (p.length >= 7) { vcol.push3(Number(p[4]), Number(p[5]), Number(p[6])); anyVcol = true; }
      else vcol.push3(NaN, NaN, NaN);
    } else if (c0 === 102 /* f */ && (l.charCodeAt(1) === 32 || l.charCodeAt(1) === 9)) {
      const p = l.trim().split(/\s+/);
      const vcount = verts.length / 3;
      face.length = 0;
      for (let i = 1; i < p.length; i++) {
        const tok = p[i];
        const slash = tok.indexOf('/');
        const n = parseInt(slash < 0 ? tok : tok.slice(0, slash), 10);
        if (!Number.isFinite(n) || n === 0) { face.length = 0; break; }
        const v = n < 0 ? vcount + n : n - 1;
        if (v < 0) { face.length = 0; break; }
        face.push(v);
      }
      if (face.length < 3) { skipped++; return; }
      for (let i = 1; i + 1 < face.length; i++) { idx.push3(face[0], face[i], face[i + 1]); pushGroup(curMat); }
      checkTriangleBudget(idx.length / 3);
    } else if (l.startsWith('usemtl')) {
      const n = l.slice(6).trim();
      if (n) { if (!materials.has(n)) materials.set(n, materials.size); curMat = materials.get(n)!; }
    } else if (l.startsWith('mtllib')) {
      const n = l.slice(6).trim();
      if (n) mtllibs.push(n);
    } else if ((c0 === 111 /* o */ || c0 === 103 /* g */) && name === null && l.charCodeAt(1) === 32) {
      const n = l.slice(2).trim();
      if (n) name = n;
    }
  };

  let carry = '';
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const end = Math.min(bytes.length, off + CHUNK);
    const text = carry + dec.decode(bytes.subarray(off, end), { stream: end < bytes.length });
    const lines = text.split(/\r?\n|\r/);
    carry = end < bytes.length ? (lines.pop() ?? '') : '';
    for (const l of lines) if (l.length > 1) line(l);
  }
  if (carry.length > 1) line(carry);

  const vcount = verts.length / 3;
  if (vcount === 0) throw new ImportError('OBJ file has no vertices.');
  const raw = idx.toArray();
  checkTriangleBudget(raw.length / 3);
  // Drop triangles that reference vertices that never appeared.
  const groupsRaw = triGroup.subarray(0, triGroupN);
  const vc = anyVcol ? vcol.toArray() : null;
  let w = 0;
  for (let t = 0; t < raw.length; t += 3) {
    const a = raw[t], b = raw[t + 1], c = raw[t + 2];
    if (a >= vcount || b >= vcount || c >= vcount) { skipped++; continue; }
    groupsRaw[w / 3] = groupsRaw[t / 3];
    raw[w++] = a; raw[w++] = b; raw[w++] = c;
  }
  if (w === 0) throw new ImportError('OBJ file has no valid faces.');
  const indices = w === raw.length ? raw : raw.slice(0, w);
  let faceGroups: ObjParse['faceGroups'];
  if (materials.size) {
    faceGroups = { tri: groupsRaw.slice(0, w / 3), groups: [...materials.keys()].map((n) => ({ name: n, color: null })) };
  } else if (anyVcol) {
    // Face colour = mean of its vertex colours, grouped by hex.
    const byHex = new Map<string, number>();
    const tri = new Uint32Array(w / 3).fill(NO_GROUP);
    for (let t = 0; t < w / 3; t++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k];
        if (vc && Number.isFinite(vc[v * 3])) { r += vc[v * 3]; g += vc[v * 3 + 1]; b += vc[v * 3 + 2]; n++; }
      }
      if (!n) continue;
      const hex = `#${hex2(r / n)}${hex2(g / n)}${hex2(b / n)}`.toUpperCase();
      let gi = byHex.get(hex);
      if (gi === undefined) { gi = byHex.size; byHex.set(hex, gi); }
      tri[t] = gi;
    }
    if (byHex.size) faceGroups = { tri, groups: [...byHex.keys()].map((h) => ({ name: h, color: h })) };
  }
  return { positions: verts.toArray(), indices, skippedFaces: skipped, name, ...(faceGroups ? { faceGroups } : {}), ...(mtllibs.length ? { mtllibs } : {}) };
}

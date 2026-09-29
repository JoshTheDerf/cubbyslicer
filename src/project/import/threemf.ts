/**
 * 3MF reader (core spec + production-extension `p:path` references, which
 * Bambu/Orca use for per-object model parts). Build items become project
 * objects; components are flattened into one mesh per item with their
 * transforms baked. Unsupported extensions (materials, beam lattice, slices…)
 * are ignored. Object names come from the model, overridden by
 * Orca/Bambu `Metadata/model_settings.config` or Prusa
 * `Metadata/Slic3r_PE_model.config` when present.
 */
import { unzipSync, type Unzipped } from 'fflate';
import { GrowF32, GrowU32, ImportError, LIMITS, checkTriangleBudget } from '../mesh';
import { mat4Identity, mat4Multiply, type Mat4 } from '../math';
import type { ParsedObject } from '../types';
import { attr, parseAttrs, scanXml } from './xml';

const UNIT_SCALE: Record<string, number> = {
  micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000,
};

interface ObjDef {
  id: string;
  name: string;
  type: string;
  positions?: Float32Array;
  indices?: Uint32Array;
  components: Array<{ key: string; transform: Mat4 }>;
}

interface ModelPart {
  unit: number;
  objects: Map<string, ObjDef>;
  build: Array<{ key: string; transform: Mat4; printable: boolean }>;
}

/** Parse the 12-number 3MF transform ("m00 m01 m02 m10 … m32") into column-major 4x4. */
export function parse3mfTransform(s: string | undefined, warnings?: string[]): Mat4 {
  if (!s) return mat4Identity();
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) {
    warnings?.push(`Ignored malformed transform "${s.slice(0, 60)}"`);
    return mat4Identity();
  }
  return [v[0], v[1], v[2], 0, v[3], v[4], v[5], 0, v[6], v[7], v[8], 0, v[9], v[10], v[11], 1];
}

function normPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (s.startsWith('/')) s = s.slice(1);
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  return s;
}

function findEntry(files: Unzipped, path: string): string | undefined {
  const want = normPath(path).toLowerCase();
  return Object.keys(files).find((k) => k.toLowerCase() === want);
}

function parseModelPart(bytes: Uint8Array, path: string, warnings: string[]): ModelPart {
  const part: ModelPart = { unit: 1, objects: new Map(), build: [] };
  let cur: ObjDef | null = null;
  let verts: GrowF32 | null = null;
  let tris: GrowU32 | null = null;
  let inMesh = false;
  let totalTris = 0;
  const keyOf = (id: string, p?: string) => `${p ? normPath(p) : path}#${id}`;

  scanXml(bytes, (t) => {
    switch (t.name) {
      case 'model':
        if (!t.close) {
          const u = attr(t.attrs, 'unit');
          if (u) {
            const s = UNIT_SCALE[u.toLowerCase()];
            if (s) part.unit = s; else warnings.push(`Unknown unit "${u}", assuming millimetres`);
          }
        }
        break;
      case 'object':
        if (t.close) {
          if (cur) part.objects.set(cur.id, cur);
          cur = null;
        } else {
          const a = parseAttrs(t.attrs);
          cur = { id: a.id ?? '', name: a.name ?? '', type: (a.type ?? 'model').toLowerCase(), components: [] };
          if (t.selfClosing) { part.objects.set(cur.id, cur); cur = null; }
        }
        break;
      case 'mesh':
        if (!cur) break;
        if (t.close) {
          inMesh = false;
          if (verts && tris) {
            const vcount = verts.length / 3;
            const idx = tris.toArray();
            let w = 0, bad = 0;
            for (let i = 0; i < idx.length; i += 3) {
              const a = idx[i], b = idx[i + 1], c = idx[i + 2];
              if (a >= vcount || b >= vcount || c >= vcount) { bad++; continue; }
              idx[w++] = a; idx[w++] = b; idx[w++] = c;
            }
            if (bad) warnings.push(`Object ${cur.id}: skipped ${bad} triangle(s) with invalid vertex indices`);
            cur.positions = verts.toArray();
            cur.indices = w === idx.length ? idx : idx.slice(0, w);
          }
          verts = tris = null;
        } else if (!t.selfClosing) {
          inMesh = true;
          verts = new GrowF32(4096);
          tris = new GrowU32(4096);
        }
        break;
      case 'vertex':
        if (inMesh && verts && !t.close) {
          verts.push3(Number(attr(t.attrs, 'x')), Number(attr(t.attrs, 'y')), Number(attr(t.attrs, 'z')));
        }
        break;
      case 'triangle':
        if (inMesh && tris && !t.close) {
          const a = Number(attr(t.attrs, 'v1')), b = Number(attr(t.attrs, 'v2')), c = Number(attr(t.attrs, 'v3'));
          if (Number.isInteger(a) && Number.isInteger(b) && Number.isInteger(c) && a >= 0 && b >= 0 && c >= 0) {
            tris.push3(a, b, c);
            if (++totalTris > LIMITS.maxTriangles) checkTriangleBudget(totalTris);
          }
        }
        break;
      case 'component':
        if (cur && !t.close) {
          const a = parseAttrs(t.attrs);
          if (a.objectid) {
            const p = a['p:path'] ?? Object.entries(a).find(([k]) => k.endsWith(':path'))?.[1];
            cur.components.push({ key: keyOf(a.objectid, p), transform: parse3mfTransform(a.transform, warnings) });
          }
        }
        break;
      case 'item':
        if (!t.close) {
          const a = parseAttrs(t.attrs);
          if (a.objectid) {
            const p = a['p:path'] ?? Object.entries(a).find(([k]) => k.endsWith(':path'))?.[1];
            part.build.push({
              key: keyOf(a.objectid, p),
              transform: parse3mfTransform(a.transform, warnings),
              printable: a.printable !== '0',
            });
          }
        }
        break;
    }
  });
  return part;
}

/** Collect `{id → name}` from Orca/Bambu/Prusa metadata configs. */
function readVendorNames(files: Unzipped): Map<string, string> {
  const names = new Map<string, string>();
  for (const cfg of ['Metadata/model_settings.config', 'Metadata/Slic3r_PE_model.config', 'Metadata/PrusaSlicer_model.config']) {
    const k = findEntry(files, cfg);
    if (!k) continue;
    let objId: string | null = null;
    let depth = 0;
    try {
      scanXml(files[k], (t) => {
        if (t.name === 'object') {
          if (t.close) { objId = null; depth = 0; } else if (!t.selfClosing) { objId = parseAttrs(t.attrs).id ?? null; depth = 0; }
        } else if (t.name === 'part' || t.name === 'volume') {
          if (!t.selfClosing) depth += t.close ? -1 : 1;
        } else if (t.name === 'metadata' && objId && depth === 0 && !t.close) {
          const a = parseAttrs(t.attrs);
          if (a.key === 'name' && a.value && (a.type === undefined || a.type === 'object')) {
            if (!names.has(objId)) names.set(objId, a.value);
          }
        }
      });
    } catch { /* vendor metadata is optional */ }
  }
  return names;
}

export function parse3mf(buffer: ArrayBuffer, fileName = 'model.3mf'): { objects: ParsedObject[]; warnings: string[] } {
  const warnings: string[] = [];
  let files: Unzipped;
  try {
    files = unzipSync(new Uint8Array(buffer), {
      // Only decompress what we might read: model parts, rels and vendor configs.
      filter: (f) => /\.model$|\.rels$|\.config$/i.test(f.name),
    });
  } catch (e) {
    throw new ImportError(`Not a valid 3MF (zip) file: ${(e as Error).message}`);
  }

  // Root model from _rels/.rels, falling back to the conventional path.
  let rootPath = '3D/3dmodel.model';
  const relsKey = findEntry(files, '_rels/.rels');
  if (relsKey) {
    try {
      scanXml(files[relsKey], (t) => {
        if (t.name === 'Relationship' && !t.close) {
          const a = parseAttrs(t.attrs);
          if (a.Type?.endsWith('/3dmodel') && a.Target) rootPath = normPath(a.Target);
        }
      });
    } catch { /* use default */ }
  }
  let rootKey = findEntry(files, rootPath);
  if (!rootKey) rootKey = Object.keys(files).find((k) => /\.model$/i.test(k));
  if (!rootKey) throw new ImportError('3MF has no 3D model part.');

  const parts = new Map<string, ModelPart>();
  const loadPart = (path: string): ModelPart | null => {
    const key = findEntry(files, path);
    if (!key) return null;
    const norm = normPath(key);
    let p = parts.get(norm);
    if (!p) {
      try {
        p = parseModelPart(files[key], norm, warnings);
      } catch (e) {
        if (e instanceof ImportError) throw e;
        throw new ImportError(`3MF model part ${norm} is malformed: ${(e as Error).message}`);
      }
      parts.set(norm, p);
    }
    return p;
  };
  const root = loadPart(rootKey)!;
  const rootNorm = normPath(rootKey);
  const vendorNames = readVendorNames(files);

  const resolve = (key: string): { def: ObjDef; unit: number } | null => {
    const hash = key.lastIndexOf('#');
    const part = loadPart(key.slice(0, hash));
    const def = part?.objects.get(key.slice(hash + 1));
    return def && part ? { def, unit: part.unit } : null;
  };

  let build = root.build;
  if (build.length === 0) {
    // Non-conforming file with no <build>: use top-level objects that aren't components.
    const referenced = new Set<string>();
    for (const o of root.objects.values()) for (const c of o.components) referenced.add(c.key);
    build = [...root.objects.keys()]
      .map((id) => `${rootNorm}#${id}`)
      .filter((k) => !referenced.has(k))
      .map((key) => ({ key, transform: mat4Identity(), printable: true }));
    if (build.length) warnings.push('3MF has no build section; imported all objects.');
  }

  const out: ParsedObject[] = [];
  let totalTris = 0;
  const unitScale = (m: Mat4, u: number): Mat4 => {
    if (u === 1) return m;
    const r = m.slice();
    r[12] *= u; r[13] *= u; r[14] *= u;
    return r;
  };

  for (const item of build) {
    const pos = new GrowF32(1 << 14);
    const idx = new GrowU32(1 << 14);
    let skippedSupport = false;
    const visit = (key: string, m: Mat4, depth: number, stack: Set<string>) => {
      if (depth > 16 || stack.has(key)) { warnings.push('3MF component hierarchy is cyclic or too deep; truncated.'); return; }
      const r = resolve(key);
      if (!r) { warnings.push(`3MF references missing object ${key}`); return; }
      const { def, unit } = r;
      if (def.type === 'support' || def.type === 'solidsupport') { skippedSupport = true; return; }
      if (def.positions && def.indices) {
        totalTris += def.indices.length / 3;
        checkTriangleBudget(totalTris);
        const base = pos.length / 3;
        const p = def.positions;
        const s = unit;
        for (let i = 0; i < p.length; i += 3) {
          const x = p[i] * s, y = p[i + 1] * s, z = p[i + 2] * s;
          pos.push3(
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          );
        }
        const ind = def.indices;
        for (let i = 0; i < ind.length; i += 3) idx.push3(ind[i] + base, ind[i + 1] + base, ind[i + 2] + base);
      }
      stack.add(key);
      for (const c of def.components) visit(c.key, mat4Multiply(m, unitScale(c.transform, unit)), depth + 1, stack);
      stack.delete(key);
    };
    const r = resolve(item.key);
    if (!r) { warnings.push(`Build item references missing object ${item.key}`); continue; }
    visit(item.key, mat4Identity(), 0, new Set());
    if (skippedSupport) warnings.push('Skipped support-type meshes.');
    if (idx.length === 0) continue;
    const id = item.key.slice(item.key.lastIndexOf('#') + 1);
    const inRoot = item.key.startsWith(`${rootNorm}#`);
    const name = (inRoot && vendorNames.get(id)) || r.def.name || `${fileName.replace(/\.3mf$/i, '')} ${out.length + 1}`;
    out.push({
      name,
      positions: pos.toArray(),
      indices: idx.toArray(),
      transform: unitScale(item.transform, root.unit),
      printable: item.printable,
    });
  }
  if (out.length === 0) throw new ImportError('3MF contains no printable meshes.');
  return { objects: out, warnings };
}

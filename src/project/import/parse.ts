/**
 * Format dispatch + post-processing shared by the worker and the main-thread
 * fallback: parse → weld → recentre mesh on its bbox centre (compensating the
 * placement transform so world position is preserved).
 */
import { ImportError, LIMITS, recenter, weldVertices } from '../mesh';
import { mat4Multiply } from '../math';
import type { ParseResult, ParsedObject } from '../types';
import { parse3mf } from './threemf';
import { parseObj } from './obj';
import { parseStl } from './stl';

export type ModelFormat = 'stl' | 'obj' | '3mf';

export function detectFormat(name: string, bytes: Uint8Array): ModelFormat | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'stl' || ext === 'obj' || ext === '3mf') return ext;
  // Sniff: zip magic → 3mf, "v "/"#" → obj, else stl.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return '3mf';
  const head = new TextDecoder().decode(bytes.subarray(0, 256));
  if (/^\s*(#|v\s|o\s|g\s|mtllib)/m.test(head) && !/^\s*solid/i.test(head)) return 'obj';
  if (bytes.length >= 84) return 'stl';
  return null;
}

export function baseName(name: string): string {
  const b = name.split(/[\\/]/).pop() ?? name;
  return b.replace(/\.(stl|obj|3mf)$/i, '') || 'Object';
}

export function parseModel(name: string, buffer: ArrayBuffer): ParseResult {
  if (buffer.byteLength > LIMITS.maxFileBytes) {
    throw new ImportError(`${name} is ${(buffer.byteLength / 1048576).toFixed(0)} MB; the limit is ${LIMITS.maxFileBytes / 1048576} MB.`);
  }
  const fmt = detectFormat(name, new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 256)));
  if (!fmt) throw new ImportError(`${name}: unrecognised file type. Supported: STL, OBJ, 3MF.`);
  const warnings: string[] = [];
  let raw: Array<Omit<ParsedObject, 'indices'> & { indices: Uint32Array | null }>;
  let faceGroups: ParsedObject['faceGroups'];
  if (fmt === 'stl') {
    const soup = parseStl(buffer);
    raw = [{ name: baseName(name), positions: soup, indices: null, transform: null }];
  } else if (fmt === 'obj') {
    const r = parseObj(buffer);
    if (r.skippedFaces) warnings.push(`${name}: skipped ${r.skippedFaces} invalid face(s).`);
    raw = [{ name: baseName(name), positions: r.positions, indices: r.indices, transform: null }];
    faceGroups = r.faceGroups;
  } else {
    const r = parse3mf(buffer, name);
    warnings.push(...r.warnings.map((w) => `${name}: ${w}`));
    raw = r.objects;
  }

  const objects: ParsedObject[] = [];
  for (const o of raw) {
    const w = weldVertices(o.positions, o.indices, undefined, faceGroups?.tri);
    if (w.indices.length === 0) { warnings.push(`${o.name}: mesh has no valid triangles; skipped.`); continue; }
    if (w.dropped) warnings.push(`${o.name}: removed ${w.dropped} degenerate triangle(s).`);
    const c = recenter(w.positions);
    let transform = o.transform;
    if (transform) {
      transform = mat4Multiply(transform, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, c[0], c[1], c[2], 1]);
    }
    objects.push({
      name: o.name, positions: w.positions, indices: w.indices, transform, printable: o.printable,
      ...(faceGroups && w.triData ? { faceGroups: { tri: w.triData, groups: faceGroups.groups } } : {}),
    });
  }
  if (objects.length === 0) throw new ImportError(`${name}: no usable geometry.`);
  return { objects, warnings };
}

/**
 * Project (de)serialisation shared by .cubbyslice files and the IndexedDB
 * autosave. Geometry is always binary; project.json holds only metadata.
 */
import { ImportError } from '../mesh';
import type { Quat, Vec3 } from '../math';
import type { LayerRange, MeshData, ObjectPart, PartType, ProjectObject } from '../types';
import { MAX_PLATES, type PlateMeta } from '../plates';
import type { CustomGcodeItem } from '../../engine/types';
import { sanitizeProfile } from '../../layers/profile';
import { computeBBox } from '../mesh';
import { sanitizeBrimPoints, sanitizeEmboss } from './toolsFormat';

// tools metadata (text / SVG emboss source, brim ears)
const optEmboss = (raw: unknown) => { const e = sanitizeEmboss(raw); return e ? { emboss: e } : {}; };
const optBrim = (raw: unknown) => { const b = sanitizeBrimPoints(raw); return b.length ? { brimPoints: b } : {}; };

export const PROJECT_FORMAT = 'cubbyslice';
export const PROJECT_VERSION = 1;

export interface MeshRef { id: string; vertexCount: number; triangleCount: number }

export interface ProjectJson {
  format: typeof PROJECT_FORMAT;
  version: number;
  name: string;
  savedAt: string;
  objects: ProjectObject[];
  meshes: MeshRef[];
  /** Multi-plate layout (absent = one plate). */
  plates?: PlateMeta[];
  /** Painted facets per mesh id (Orca support / seam / color / fuzzy painting). */
  paint?: Record<string, import('../../engine/types').PaintLayers>;
  sections?: Record<string, unknown>;
}

/** Validate untrusted plate records (at most MAX_PLATES; empty → undefined = one plate). */
export function sanitizePlates(raw: unknown): PlateMeta[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  return raw.slice(0, MAX_PLATES).map((r) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const plate: PlateMeta = { name: typeof o.name === 'string' ? o.name.slice(0, 80) : '', locked: o.locked === true };
    const config = sanitizeOverrides(o.config);
    if (Object.keys(config).length) plate.config = config;
    const gcodes = sanitizeCustomGcodes(o.customGcodes);
    if (gcodes.length) plate.customGcodes = gcodes;
    return plate;
  });
}

const GCODE_TYPES: CustomGcodeItem['type'][] = ['color_change', 'pause', 'custom', 'tool_change', 'template'];

/** Validate untrusted slider custom G-code items (Orca CustomGCode::Item). */
export function sanitizeCustomGcodes(raw: unknown): CustomGcodeItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomGcodeItem[] = [];
  for (const r of raw.slice(0, 2000)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const z = Number(o.z);
    if (!Number.isFinite(z) || z < 0 || z > 100000 || !GCODE_TYPES.includes(o.type as CustomGcodeItem['type'])) continue;
    const item: CustomGcodeItem = { z, type: o.type as CustomGcodeItem['type'] };
    const e = Number(o.extruder);
    if (Number.isInteger(e) && e >= 0 && e <= 64) item.extruder = e;
    if (typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color)) item.color = o.color;
    if (typeof o.extra === 'string') item.extra = o.extra.slice(0, 20000);
    out.push(item);
  }
  return out.sort((a, b) => a.z - b.z);
}

/** Validate untrusted height range modifiers. */
function sanitizeLayerRanges(raw: unknown): LayerRange[] {
  if (!Array.isArray(raw)) return [];
  const out: LayerRange[] = [];
  for (const r of raw.slice(0, 256)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const min = Number(o.min), max = Number(o.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max <= min || max > 100000) continue;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id.slice(0, 64) : `lr_${Math.random().toString(36).slice(2, 12)}`,
      min, max, overrides: sanitizeOverrides(o.overrides),
    });
  }
  return out;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: number[]): number[] =>
  Array.isArray(v) && v.length === d.length ? v.map((x, i) => num(x, d[i])) : d.slice();

const PART_TYPES: PartType[] = ['part', 'negative', 'modifier', 'support_blocker', 'support_enforcer'];

function sanitizeOverrides(raw: unknown): Record<string, string | string[]> {
  const overrides: Record<string, string | string[]> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') overrides[k] = v;
      else if (Array.isArray(v)) overrides[k] = v.map(String);
      else if (typeof v === 'number' || typeof v === 'boolean') overrides[k] = String(v);
    }
  }
  return overrides;
}

/** Validate + normalise untrusted object records. */
export function sanitizeObjects(raw: unknown, meshIds: Set<string>): ProjectObject[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectObject[] = [];
  const seen = new Set<string>();
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') continue;
    const meshId = String(r.meshId ?? '');
    if (!meshIds.has(meshId)) continue;
    let id = String(r.id ?? '');
    if (!id || seen.has(id)) id = `o_${Math.random().toString(36).slice(2, 12)}`;
    seen.add(id);
    const overrides = sanitizeOverrides(r.overrides);
    const parts: ObjectPart[] = [];
    if (Array.isArray(r.parts)) {
      for (const pr of (r.parts as Array<Record<string, unknown>>).slice(0, 1024)) {
        if (!pr || typeof pr !== 'object' || !meshIds.has(String(pr.meshId ?? ''))) continue;
        const type = PART_TYPES.includes(pr.type as PartType) ? (pr.type as PartType) : 'part';
        parts.push({
          id: typeof pr.id === 'string' && pr.id ? pr.id.slice(0, 64) : `p_${Math.random().toString(36).slice(2, 12)}`,
          name: typeof pr.name === 'string' && pr.name ? pr.name.slice(0, 200) : 'Part',
          meshId: String(pr.meshId), type,
          position: vec(pr.position, [0, 0, 0]) as Vec3,
          rotation: vec(pr.rotation, [0, 0, 0, 1]) as Quat,
          scale: vec(pr.scale, [1, 1, 1]) as Vec3,
          overrides: sanitizeOverrides(pr.overrides),
          ...optEmboss(pr.emboss),
        });
      }
    }
    const profile = sanitizeProfile(r.layerHeightProfile);
    const ranges = sanitizeLayerRanges(r.layerRanges);
    out.push({
      ...(parts.length ? { parts } : {}),
      ...(profile.length ? { layerHeightProfile: profile } : {}),
      ...(ranges.length ? { layerRanges: ranges } : {}),
      ...optEmboss(r.emboss),
      ...optBrim(r.brimPoints),
      ...(r.assembly && typeof r.assembly === 'object' ? { assembly: {
        position: vec((r.assembly as Record<string, unknown>).position, [0, 0, 0]) as Vec3,
        rotation: vec((r.assembly as Record<string, unknown>).rotation, [0, 0, 0, 1]) as Quat,
        scale: vec((r.assembly as Record<string, unknown>).scale, [1, 1, 1]) as Vec3,
      } } : {}),
      id,
      name: typeof r.name === 'string' && r.name ? r.name.slice(0, 200) : 'Object',
      meshId,
      position: vec(r.position, [0, 0, 0]) as Vec3,
      rotation: vec(r.rotation, [0, 0, 0, 1]) as Quat,
      scale: vec(r.scale, [1, 1, 1]) as Vec3,
      visible: r.visible !== false,
      printable: r.printable !== false,
      overrides,
      color: typeof r.color === 'string' ? r.color.slice(0, 64) : '',
    });
  }
  return out;
}

/** Pack a mesh into one buffer: float32 positions then uint32 indices. */
export function packMesh(m: MeshData): Uint8Array {
  const out = new Uint8Array(m.positions.byteLength + m.indices.byteLength);
  out.set(new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength), 0);
  out.set(new Uint8Array(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength), m.positions.byteLength);
  return out;
}

export function unpackMesh(ref: MeshRef, bytes: Uint8Array): { positions: Float32Array; indices: Uint32Array } {
  const vc = ref.vertexCount, tc = ref.triangleCount;
  if (!Number.isInteger(vc) || !Number.isInteger(tc) || vc < 3 || tc < 1) throw new ImportError(`Mesh ${ref.id}: bad header.`);
  if (bytes.byteLength !== vc * 12 + tc * 12) throw new ImportError(`Mesh ${ref.id}: size mismatch (file is corrupt).`);
  // Copy into fresh aligned buffers (zip entries aren't 4-aligned).
  const positions = new Float32Array(vc * 3);
  new Uint8Array(positions.buffer).set(bytes.subarray(0, vc * 12));
  const indices = new Uint32Array(tc * 3);
  new Uint8Array(indices.buffer).set(bytes.subarray(vc * 12));
  for (let i = 0; i < indices.length; i++) if (indices[i] >= vc) throw new ImportError(`Mesh ${ref.id}: index out of range.`);
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new ImportError(`Mesh ${ref.id}: invalid vertex.`);
  return { positions, indices };
}

export function meshFromArrays(id: string, positions: Float32Array, indices: Uint32Array): MeshData {
  return { id, positions, indices, bbox: computeBBox(positions), vertexCount: positions.length / 3, triangleCount: indices.length / 3 };
}

/** Validate untrusted paint records: { meshId: { support|seam|color|fuzzy: [[triangle, hex], ...] } }. */
export function sanitizePaint(raw: unknown, meshIds: Set<string>): Record<string, import('../../engine/types').PaintLayers> {
  const out: Record<string, import('../../engine/types').PaintLayers> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, layers] of Object.entries(raw as Record<string, unknown>)) {
    if (!meshIds.has(id) || !layers || typeof layers !== 'object') continue;
    const clean: import('../../engine/types').PaintLayers = {};
    for (const l of ['support', 'seam', 'color', 'fuzzy'] as const) {
      const arr = (layers as Record<string, unknown>)[l];
      if (!Array.isArray(arr)) continue;
      const pairs = arr.filter((e): e is [number, string] => Array.isArray(e) && e.length === 2 && Number.isInteger(e[0]) && e[0] >= 0
        && typeof e[1] === 'string' && e[1].length > 0 && e[1].length < 1 << 20 && /^[0-9A-Fa-f]+$/.test(e[1]));
      if (pairs.length) clean[l] = pairs;
    }
    if (Object.keys(clean).length) out[id] = clean;
  }
  return out;
}

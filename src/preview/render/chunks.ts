/**
 * Chunked GPU buffers for a parsed G-code.
 *
 * Segments are split into fixed-size chunks (default 512 Ki instances) so no
 * single GL allocation is huge and chunks can be built incrementally across
 * frames. Per chunk:
 *   - extrusion capsules: InstancedBufferGeometry over a zero-copy view of the
 *     parser's point array (aStart/aEnd = same buffer, offsets 0 and 3),
 *     width/height (Uint16 view, zero-copy), packed meta (Uint8×4) and a
 *     Float32 value attribute rewritten when the colour scheme changes;
 *   - travel/wipe lines and retract/seam points, built lazily on first show.
 * All chunks share uniform objects, so range/visibility/colour changes are
 * uniform writes; each chunk only owns its `uBase`.
 */
import * as THREE from 'three';
import { Feature, FIRST_NON_EXTRUSION } from '../parser/features';
import type { ParsedGcode } from '../parser/types';
import { EXTRUSION_FRAG, EXTRUSION_VERT, LINE_FRAG, LINE_VERT, POINT_FRAG, POINT_VERT } from './shaders';
import { fillValues } from './colors';
import type { ColorScheme } from './colors';

export const DEFAULT_CHUNK_SIZE = 1 << 19;

export interface ChunkRange { base: number; count: number }

/** Split `total` segments into chunks of at most `size`. */
export function planChunks(total: number, size = DEFAULT_CHUNK_SIZE): ChunkRange[] {
  const out: ChunkRange[] = [];
  for (let base = 0; base < total; base += size) out.push({ base, count: Math.min(size, total - base) });
  return out;
}

/** Instances to draw for a chunk given the global inclusive range [min, max]. */
export function chunkDrawCount(c: ChunkRange, min: number, max: number): number {
  if (max < c.base || min > c.base + c.count - 1 || max < min) return 0;
  return Math.min(c.count, max - c.base + 1);
}

type U = { value: unknown };
export interface SharedUniforms {
  [k: string]: U;
  uRangeMin: { value: number };
  uRangeMax: { value: number };
  uFeatVis: { value: Float32Array };
  uFeatColor: { value: THREE.Color[] };
  uToolColor: { value: THREE.Color[] };
  uScheme: { value: number };
  uVMin: { value: number };
  uVMax: { value: number };
  uRamp: { value: THREE.Color[] };
  uViewport: { value: THREE.Vector2 };
  uMinPx: { value: number };
  uNear: { value: number };
  uTopStart: { value: number };
  uDimBelow: { value: number };
  uTravelColor: { value: THREE.Color };
  uWipeColor: { value: THREE.Color };
  uKindColor: { value: THREE.Color[] };
  uKindVis: { value: Float32Array };
  uPointPx: { value: number };
}

const lin = (hex: number) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);

export function createSharedUniforms(): SharedUniforms {
  return {
    uRangeMin: { value: 0 },
    uRangeMax: { value: -1 },
    uFeatVis: { value: new Float32Array(32).fill(1) },
    uFeatColor: { value: Array.from({ length: 32 }, () => lin(0x999999)) },
    uToolColor: { value: Array.from({ length: 16 }, () => lin(0x999999)) },
    uScheme: { value: 0 },
    uVMin: { value: 0 },
    uVMax: { value: 1 },
    uRamp: { value: Array.from({ length: 11 }, () => lin(0)) },
    uViewport: { value: new THREE.Vector2(1, 1) },
    uMinPx: { value: 0.6 },
    uNear: { value: 0.1 },
    uTopStart: { value: 0 },
    uDimBelow: { value: 0 },
    uTravelColor: { value: lin(0x3848a0) },
    uWipeColor: { value: lin(0xffff00) },
    uKindColor: { value: [lin(0xcc00cc), lin(0x00cccc), lin(0xe6e6e6)] },
    uKindVis: { value: new Float32Array([0, 0, 0]) },
    uPointPx: { value: 6 },
  };
}

function material(vert: string, frag: string, shared: SharedUniforms, base: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { ...shared, uBase: { value: base } },
  });
}

// One quad, shared by all chunks (never disposed per chunk).
let quad: { pos: THREE.BufferAttribute; index: THREE.BufferAttribute } | null = null;
function quadAttrs() {
  if (!quad) {
    quad = {
      pos: new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3),
      index: new THREE.BufferAttribute(new Uint16Array([0, 2, 1, 1, 2, 3]), 1),
    };
  }
  return quad;
}

interface Chunk extends ChunkRange {
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  value: Float32Array;
  valueAttr: THREE.InstancedBufferAttribute;
  gpuBytes: number;
  travel: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
  markers: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
}

export class GcodeChunks {
  readonly group = new THREE.Group();
  private chunks: Chunk[] = [];
  private pending: ChunkRange[];
  private scheme: ColorScheme = 'feature';
  private numeric = false;
  private travelOn = false;
  private markersOn = false;
  private rangeMin = 0;
  private rangeMax = -1;

  constructor(readonly data: ParsedGcode, readonly shared: SharedUniforms, chunkSize = DEFAULT_CHUNK_SIZE) {
    this.group.name = 'gcode-chunks';
    this.pending = planChunks(data.segmentCount, chunkSize);
  }

  get totalChunks(): number { return this.chunks.length + this.pending.length; }
  get builtChunks(): number { return this.chunks.length; }
  get done(): boolean { return this.pending.length === 0; }

  /** Build the next pending chunk. Returns true while more remain. */
  buildNext(): boolean {
    const r = this.pending.shift();
    if (!r) return false;
    const c = this.buildChunk(r);
    this.chunks.push(c);
    this.group.add(c.mesh);
    if (this.travelOn) this.ensureTravel(c);
    if (this.markersOn) this.ensureMarkers(c);
    this.applyRangeTo(c);
    return this.pending.length > 0;
  }

  private buildChunk({ base, count }: ChunkRange): Chunk {
    const p = this.data;
    const geo = new THREE.InstancedBufferGeometry();
    const q = quadAttrs();
    geo.setAttribute('position', q.pos);
    geo.setIndex(q.index);
    const pts = new THREE.InstancedInterleavedBuffer(p.points.subarray(base * 3, (base + count + 1) * 3), 3, 1);
    geo.setAttribute('aStart', new THREE.InterleavedBufferAttribute(pts, 3, 0));
    geo.setAttribute('aEnd', new THREE.InterleavedBufferAttribute(pts, 3, 3));
    geo.setAttribute('aWH', new THREE.InstancedBufferAttribute(p.wh.subarray(base * 2, (base + count) * 2), 2));
    const meta = new Uint8Array(count * 4);
    const f = p.feature, t = p.tool;
    for (let k = 0; k < count; k++) { meta[k * 4] = f[base + k]; meta[k * 4 + 1] = t[base + k]; }
    geo.setAttribute('aMeta', new THREE.InstancedBufferAttribute(meta, 4));
    const value = new Float32Array(count);
    if (this.numeric) fillValues(p, this.scheme, base, value);
    const valueAttr = new THREE.InstancedBufferAttribute(value, 1);
    valueAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aValue', valueAttr);
    geo.instanceCount = count;

    // Bounding sphere over this chunk's extrusion points (for frustum culling).
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let k = 0; k < count; k++) {
      if (f[base + k] >= FIRST_NON_EXTRUSION) continue;
      const i = (base + k + 1) * 3;
      v.set(p.points[i], p.points[i + 1], p.points[i + 2]);
      box.expandByPoint(v);
      const j = (base + k) * 3;
      v.set(p.points[j], p.points[j + 1], p.points[j + 2]);
      box.expandByPoint(v);
    }
    const sphere = new THREE.Sphere();
    if (box.isEmpty()) sphere.set(new THREE.Vector3(), 0); else box.getBoundingSphere(sphere);
    sphere.radius += 3; // bead radius margin
    geo.boundingSphere = sphere;
    geo.boundingBox = box.isEmpty() ? new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()) : box;

    const mesh = new THREE.Mesh(geo, material(EXTRUSION_VERT, EXTRUSION_FRAG, this.shared, base));
    mesh.name = `gcode-chunk-${base}`;
    mesh.frustumCulled = !box.isEmpty();
    const gpuBytes = (count + 1) * 12 + count * 4 + meta.byteLength + value.byteLength;
    return { base, count, mesh, value, valueAttr, gpuBytes, travel: null, markers: null };
  }

  private ensureTravel(c: Chunk): void {
    if (c.travel) { c.travel.visible = true; return; }
    const p = this.data, f = p.feature;
    let n = 0;
    for (let k = 0; k < c.count; k++) { const x = f[c.base + k]; if (x === Feature.Travel || x === Feature.Wipe) n++; }
    const pos = new Float32Array(n * 6), seg = new Float32Array(n * 2), feat = new Float32Array(n * 2);
    let j = 0;
    for (let k = 0; k < c.count; k++) {
      const s = c.base + k, x = f[s];
      if (x !== Feature.Travel && x !== Feature.Wipe) continue;
      pos.set(p.points.subarray(s * 3, s * 3 + 6), j * 6);
      seg[j * 2] = k; seg[j * 2 + 1] = k;
      feat[j * 2] = x; feat[j * 2 + 1] = x;
      j++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeg', new THREE.BufferAttribute(seg, 1));
    geo.setAttribute('aFeat', new THREE.BufferAttribute(feat, 1));
    const lines = new THREE.LineSegments(geo, material(LINE_VERT, LINE_FRAG, this.shared, c.base));
    lines.frustumCulled = false;
    c.travel = lines;
    c.gpuBytes += pos.byteLength + seg.byteLength + feat.byteLength;
    this.group.add(lines);
    this.applyRangeTo(c);
  }

  private ensureMarkers(c: Chunk): void {
    if (c.markers) { c.markers.visible = true; return; }
    const p = this.data;
    // markers are sorted by segment index
    const lo = lowerBound(p.markerSeg, p.markerCount, c.base);
    const hi = lowerBound(p.markerSeg, p.markerCount, c.base + c.count);
    const n = hi - lo;
    const pos = p.markerPos.slice(lo * 3, hi * 3);
    const seg = new Float32Array(n), kind = new Float32Array(n);
    for (let k = 0; k < n; k++) { seg[k] = p.markerSeg[lo + k] - c.base; kind[k] = p.markerKind[lo + k]; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeg', new THREE.BufferAttribute(seg, 1));
    geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    const pts = new THREE.Points(geo, material(POINT_VERT, POINT_FRAG, this.shared, c.base));
    pts.frustumCulled = false;
    c.markers = pts;
    c.gpuBytes += pos.byteLength + seg.byteLength + kind.byteLength;
    this.group.add(pts);
    this.applyRangeTo(c);
  }

  setTravelVisible(on: boolean): void {
    this.travelOn = on;
    for (const c of this.chunks) {
      if (on) this.ensureTravel(c);
      else if (c.travel) c.travel.visible = false;
    }
  }

  setMarkersVisible(on: boolean): void {
    this.markersOn = on;
    for (const c of this.chunks) {
      if (on) this.ensureMarkers(c);
      else if (c.markers) c.markers.visible = false;
    }
  }

  /** Recompute the value attribute for a numeric scheme (no-op for categorical). */
  setScheme(scheme: ColorScheme, numeric: boolean): void {
    const changed = scheme !== this.scheme || numeric !== this.numeric;
    this.scheme = scheme; this.numeric = numeric;
    if (!changed || !numeric) return;
    for (const c of this.chunks) {
      fillValues(this.data, scheme, c.base, c.value);
      c.valueAttr.needsUpdate = true;
    }
  }

  /** Global inclusive segment range to draw. */
  setRange(min: number, max: number): void {
    this.rangeMin = min; this.rangeMax = max;
    for (const c of this.chunks) this.applyRangeTo(c);
  }

  private applyRangeTo(c: Chunk): void {
    const n = chunkDrawCount(c, this.rangeMin, this.rangeMax);
    c.mesh.visible = n > 0;
    c.mesh.geometry.instanceCount = Math.max(n, 1);
    if (c.travel) c.travel.visible = this.travelOn && n > 0;
    if (c.markers) c.markers.visible = this.markersOn && n > 0;
  }

  gpuBytes(): number {
    return this.chunks.reduce((s, c) => s + c.gpuBytes, 0);
  }

  dispose(): void {
    for (const c of this.chunks) {
      // Keep the shared quad attributes alive: detach before disposing.
      c.mesh.geometry.dispose();
      c.mesh.material.dispose();
      c.travel?.geometry.dispose(); c.travel?.material.dispose();
      c.markers?.geometry.dispose(); c.markers?.material.dispose();
    }
    this.group.clear();
    this.chunks = [];
    this.pending = [];
  }
}

function lowerBound(a: Uint32Array, n: number, v: number): number {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * Variable layer height: pure TypeScript ports of OrcaSlicer's
 * libslic3r/Slicing.cpp + SlicingAdaptive.cpp (the parts the GUI's layer
 * editing mode uses). A profile is Orca's ModelObject::layer_height_profile:
 * flat [z0, h0, z1, h1, …], z in mm from the object's bottom (print
 * coordinates, after scaling), h = layer height at z; linear in between.
 *
 * The engine implements `adaptive` / `smooth` natively (engine/client.ts
 * adaptiveLayerProfile / smoothLayerProfile); these ports are the fallback
 * and drive the manual editor + preview, which Orca also runs in the GUI.
 */
import type { ConfigValue, FlatConfig } from '../engine/types';

export const EPSILON = 1e-4;
const MIN_LAYER_HEIGHT = 0.01;
const MIN_LAYER_HEIGHT_DEFAULT = 0.07;
const LAYER_HEIGHT_CHANGE_STEP = 0.04;

/** Orca GLCanvas3D::LayersEditing defaults. */
export const DEFAULT_BAND_WIDTH = 2;
export const DEFAULT_STRENGTH = 0.005;
export const BAND_WIDTH_MIN = 1.5;
export const BAND_WIDTH_MAX = 10;

/** The subset of Orca SlicingParameters the layer editor needs. */
export interface SlicingParams {
  layerHeight: number;
  /** first_object_layer_height. */
  firstLayerHeight: number;
  /** first_object_layer_height_fixed(): no raft → the first layer keeps its own height. */
  firstFixed: boolean;
  minLayerHeight: number;
  maxLayerHeight: number;
  /** object_print_z_uncompensated_height(): the object's printed height (mm). */
  objectHeight: number;
}

export type LayerEditAction = 'increase' | 'decrease' | 'reduce' | 'smooth';

/** A height range modifier as the profile code sees it. */
export interface HeightRange { min: number; max: number; layerHeight?: number }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const approx = (a: number, b: number, eps = EPSILON) => Math.abs(a - b) < eps;

function scalar(v: ConfigValue | undefined, idx = 0): number {
  if (v === undefined) return NaN;
  const s = Array.isArray(v) ? (v[idx] ?? v[0]) : String(v).split(/[,;]/)[idx] ?? String(v).split(/[,;]/)[0];
  const n = parseFloat(String(s ?? ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * SlicingParameters::create_from_config for one object (supports / extra
 * extruders ignored, as Orca's editor bar does for plain objects).
 * `config` = resolved global config, `overrides` = the object's own.
 */
export function slicingParams(config: FlatConfig, overrides: Record<string, ConfigValue> | undefined, objectHeight: number): SlicingParams {
  const get = (k: string, idx = 0) => {
    const o = overrides?.[k];
    const v = scalar(o, idx);
    return Number.isFinite(v) ? v : scalar(config[k], idx);
  };
  let layerHeight = get('layer_height');
  if (!(layerHeight > 0)) layerHeight = 0.2;
  let first = get('initial_layer_print_height');
  if (!Number.isFinite(first)) first = get('first_layer_height');
  if (!(first > 0)) first = layerHeight;
  const extruder = Math.max(1, Math.round(get('extruder')) || 1);
  const nozzleIdx = extruder - 1;
  const minCfg = get('min_layer_height', nozzleIdx);
  const minNozzle = !(minCfg > 0) ? MIN_LAYER_HEIGHT_DEFAULT : Math.max(MIN_LAYER_HEIGHT, minCfg);
  const maxCfg = get('max_layer_height', nozzleIdx);
  const nozzle = get('nozzle_diameter', nozzleIdx);
  const maxNozzle = Math.max(minNozzle, !(maxCfg > 0) ? 0.75 * (nozzle > 0 ? nozzle : 0.4) : maxCfg);
  const raft = get('raft_layers') > 0;
  return {
    layerHeight,
    firstLayerHeight: raft ? layerHeight : first,
    firstFixed: !raft,
    minLayerHeight: Math.min(Math.max(MIN_LAYER_HEIGHT, minNozzle), layerHeight),
    maxLayerHeight: Math.max(maxNozzle, layerHeight),
    objectHeight: Math.max(0, objectHeight),
  };
}

/** Uniform profile (Orca layer_height_profile_from_ranges with no ranges). */
export function defaultProfile(p: SlicingParams, ranges: HeightRange[] = []): number[] {
  return profileFromRanges(p, ranges);
}

/** Orca layer_height_profile_from_ranges. Ranges without a layer height use the object's. */
export function profileFromRanges(p: SlicingParams, ranges: HeightRange[]): number[] {
  const non: Array<[number, number, number]> = [];
  if (p.firstFixed) non.push([0, p.firstLayerHeight, p.firstLayerHeight]);
  const sorted = ranges.slice().sort((a, b) => a.min - b.min || a.max - b.max);
  for (const r of sorted) {
    let lo = r.min;
    const hi = Math.min(r.max, p.objectHeight);
    const h = r.layerHeight && r.layerHeight > 0 ? r.layerHeight : p.layerHeight;
    if (non.length) lo = Math.max(lo, non[non.length - 1][1]);
    if (lo + EPSILON < hi) non.push([lo, hi, h]);
  }
  const out: number[] = [];
  const lastZ = () => (out.length ? out[out.length - 2] : 0);
  const append = (z: number, h: number) => {
    if (out.length) {
      const zMatch = approx(out[out.length - 2], z);
      const hMatch = approx(out[out.length - 1], h);
      if (hMatch) {
        if (zMatch) return;
        if (out.length >= 4 && approx(out[out.length - 3], h)) { out[out.length - 2] = z; return; }
      }
    }
    out.push(z, h);
  };
  for (const [lo, hi, h] of non) {
    const z = lastZ();
    if (lo > z + EPSILON) { append(z, p.layerHeight); append(lo, p.layerHeight); }
    append(lo, h);
    append(hi, h);
  }
  const z = lastZ();
  if (z < p.objectHeight) { append(z, p.layerHeight); append(p.objectHeight, p.layerHeight); }
  return out;
}

/** Layer height of the profile at z (linear interpolation, clamped at the ends). */
export function heightAt(profile: readonly number[], z: number, fallback = 0.2): number {
  if (profile.length < 2) return fallback;
  for (let i = 0; i < profile.length; i += 2) {
    if (i + 2 === profile.length) return profile[i + 1];
    if (profile[i + 2] > z) {
      const z1 = profile[i], h1 = profile[i + 1], z2 = profile[i + 2], h2 = profile[i + 3];
      return z2 - z1 > 0 ? lerp(h1, h2, clamp((z - z1) / (z2 - z1), 0, 1)) : h1;
    }
  }
  return profile[profile.length - 1];
}

/** Orca check_object_layers_fixed: the profile describes plain uniform layers (Reset is a no-op). */
export function isUniform(p: SlicingParams, profile: readonly number[]): boolean {
  if (!profile.length) return true;
  if (profile.length !== 4 && profile.length !== 8) return false;
  const step1 = approx(profile[1], profile[3]);
  const step2 = profile.length === 4 || (profile[2] === profile[4] && approx(profile[5], profile[7]));
  if (!step1 || !step2) return false;
  if (profile[2] < 0.5 * p.firstLayerHeight + EPSILON || !approx(profile[3], p.firstLayerHeight)) return false;
  const zMax = profile[profile.length - 2];
  const z2nd = p.firstLayerHeight + 0.5 * p.layerHeight;
  if (z2nd > zMax) return true;
  if (z2nd < profile[profile.length - 4] + EPSILON || !approx(profile[profile.length - 1], p.layerHeight)) return false;
  return true;
}

/**
 * Orca adjust_layer_height_profile: one brush step of the manual editor at z
 * (mm from the object's bottom). Returns a new profile (or the input when
 * nothing changes). Ranges block edits inside them, like Orca.
 */
export function adjustProfile(p: SlicingParams, input: readonly number[], z: number, delta: number, bandWidth: number,
  action: LayerEditAction, ranges: HeightRange[] = []): number[] {
  const profile = input.length >= 4 ? input.slice() : defaultProfile(p);
  const spanLo = p.firstFixed ? p.firstLayerHeight : 0, spanHi = p.objectHeight;
  if (z < spanLo || z > spanHi || profile.length < 4) return profile;
  // Keep the profile's top on the object's height (it may be from before a rescale).
  if (Math.abs(profile[profile.length - 2] - spanHi) > EPSILON) return profile;

  const current = heightAt(profile, z, p.layerHeight);
  for (const r of ranges) if (z >= r.min - current && z <= r.max + current) return profile;

  let d = action === 'decrease' ? -delta : delta;
  switch (action) {
    case 'decrease':
    case 'increase':
      if (d > 0) {
        if (current >= p.maxLayerHeight - EPSILON) return profile;
        d = Math.min(d, p.maxLayerHeight - current);
      } else {
        if (current <= p.minLayerHeight + EPSILON) return profile;
        d = Math.max(d, p.minLayerHeight - current);
      }
      break;
    case 'reduce':
    case 'smooth':
      d = Math.min(Math.abs(d), Math.abs(p.layerHeight - current));
      if (d < EPSILON) return profile;
      break;
  }

  // Densify inside z ± band/2.
  const lo = Math.max(spanLo, z - 0.5 * bandWidth);
  const hi = z + 0.5 * bandWidth;
  const zStep = 0.1;
  let idx = 0;
  while (idx < profile.length && profile[idx] < lo) idx += 2;
  idx -= 2;
  if (idx < 0) idx = 0;
  const next: number[] = profile.slice(0, idx + 2);
  let zz = lo;
  const iStart = next.length;
  while (zz < hi) {
    const nx = idx + 2;
    const z1 = profile[idx], h1 = profile[idx + 1];
    let height = h1;
    if (nx < profile.length) {
      const z2 = profile[nx], h2 = profile[nx + 1];
      height = z2 - z1 > 0 ? lerp(h1, h2, (zz - z1) / (z2 - z1)) : h1;
    }
    const w = Math.abs(zz - z) < 0.5 * bandWidth ? 0.5 + 0.5 * Math.cos((2 * Math.PI * (zz - z)) / bandWidth) : 0;
    if (action === 'increase' || action === 'decrease') height += w * d;
    else if (action === 'reduce') {
      const dd = height - p.layerHeight;
      const step = w * d;
      height += Math.abs(dd) > step ? (dd > 0 ? -step : step) : -dd;
    }
    height = clamp(height, p.minLayerHeight, p.maxLayerHeight);
    if (zz === spanHi) {
      if (next[next.length - 2] + EPSILON > zz) next.length -= 2;
      next.push(zz, height);
      idx = profile.length;
      break;
    }
    if (next[next.length - 2] + EPSILON < zz) next.push(zz, height);
    zz = Math.min(zz + zStep, spanHi);
    idx = nx;
    while (idx < profile.length && profile[idx] < zz) idx += 2;
    idx -= 2;
  }
  idx += 2;
  let iEnd = next.length;
  if (idx < profile.length) next.push(...profile.slice(idx));
  else if (next[next.length - 2] + 0.5 * EPSILON < spanHi) next.push(...profile.slice(profile.length - 2));

  if (action === 'smooth') {
    let start = iStart;
    if (start === 0) start++;
    if (iEnd === next.length) iEnd -= 2;
    for (let round = 0; round < 6; round++) {
      const prev = next.slice();
      for (let i = start; i < iEnd; i += 2) {
        const zi = prev[i];
        const t = Math.abs(zi - z) < 0.5 * bandWidth ? 0.25 + 0.25 * Math.cos((2 * Math.PI * (zi - z)) / bandWidth) : 0;
        if (i === 0) next[i + 1] = (1 - t) * prev[i + 1] + t * prev[i + 3];
        else if (i + 1 === prev.length) next[i + 1] = (1 - t) * prev[i + 1] + t * prev[i - 1];
        else next[i + 1] = (1 - t) * prev[i + 1] + 0.5 * t * ((prev[i - 1] ?? prev[i + 1]) + (prev[i + 3] ?? prev[i + 1]));
      }
    }
  }
  return next;
}

/** Orca smooth_height_profile (HeightProfileSmoothingParams: radius 1..10, keep_min). */
export function smoothProfile(profile: readonly number[], p: SlicingParams, radius: number, keepMin: boolean): number[] {
  const kernel = (r: number) => {
    const size = 2 * r + 1;
    const sigma = 0.3 * (r - 1) + 0.8;
    const two = 2 * sigma * sigma;
    const inv = 1 / Math.sqrt(Math.PI * two);
    return Array.from({ length: size }, (_, i) => { const x = i - r; return inv * Math.exp((-x * x) / two); });
  };
  const blur = (src: readonly number[]): number[] => {
    const skip = p.firstFixed ? 4 : 0;
    if (src.length - skip < 6) return src.slice();
    const r = Math.max(1, Math.round(radius));
    const k = kernel(r);
    const two = 2 * r;
    const out: number[] = src.slice(0, skip);
    const deltaH = p.maxLayerHeight - p.minLayerHeight;
    const invDelta = deltaH !== 0 ? 1 / deltaH : 1;
    const maxDzBand = r * p.layerHeight;
    for (let i = skip; i < src.length; i += 2) {
      const zi = src[i], hi = src[i + 1];
      let height = 0, wt = 0;
      const begin = Math.max(i - two, skip), end = Math.min(i + two, src.length - 2);
      for (let j = begin; j <= end; j += 2) {
        const kid = r + (j - i) / 2;
        const dz = Math.abs(zi - src[j]);
        if (dz * p.layerHeight <= maxDzBand) {
          const dh = Math.abs(p.maxLayerHeight - src[j + 1]);
          const w = k[kid] * Math.sqrt(dh * invDelta);
          height += w * src[j + 1];
          wt += w;
        }
      }
      let h = clamp(wt === 0 ? hi : height / wt, p.minLayerHeight, p.maxLayerHeight);
      if (keepMin) h = Math.min(h, hi);
      out.push(zi, h);
    }
    return out;
  };
  let out = profile.slice();
  for (let i = 0; i < 6; i++) out = blur(out);
  return out;
}

// ---- adaptive (SlicingAdaptive) -------------------------------------------------------

interface FaceZ { lo: number; hi: number; nCos: number; nSin: number }

/**
 * Facets of a mesh in print coordinates: positions through the column-major
 * `transform` (mesh-local → bed), z relative to the lowest vertex.
 */
export function facesFromMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, transform: readonly number[]): FaceZ[] {
  const m = transform;
  const n = positions.length / 3;
  const w = new Float64Array(n * 3);
  let minZ = Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    w[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    w[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    w[i * 3 + 2] = wz;
    if (wz < minZ) minZ = wz;
  }
  const faces: FaceZ[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = w[b] - w[a], uy = w[b + 1] - w[a + 1], uz = w[b + 2] - w[a + 2];
    const vx = w[c] - w[a], vy = w[c + 1] - w[a + 1], vz = w[c + 2] - w[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const za = w[a + 2] - minZ, zb = w[b + 2] - minZ, zc = w[c + 2] - minZ;
    faces.push({ lo: Math.min(za, zb, zc), hi: Math.max(za, zb, zc), nCos: Math.abs(nz / len), nSin: Math.hypot(nx, ny) / len });
  }
  faces.sort((f1, f2) => f1.lo - f2.lo || f1.hi - f2.hi);
  return faces;
}

function heightFromSlope(f: FaceZ, dev: number): number {
  return Math.min(dev / 0.184, f.nCos > 1e-5 ? 1.44 * dev * Math.sqrt(f.nSin / f.nCos) : Number.MAX_VALUE);
}

/** Orca layer_height_profile_adaptive (quality 0 = best quality … 1 = fastest). */
export function adaptiveProfile(p: SlicingParams, faces: FaceZ[], quality: number, ranges: HeightRange[] = []): number[] {
  const q = clamp(quality, 0, 1);
  const dev = q < 0.5 ? lerp(p.minLayerHeight, p.layerHeight, 2 * q) : lerp(p.maxLayerHeight, p.layerHeight, 2 * (1 - q));
  let current = 0;
  const next = (printZ: number): number => {
    let height = p.maxLayerHeight;
    let id = current;
    let firstHit = false;
    for (; id < faces.length; id++) {
      const f = faces[id];
      if (f.lo >= printZ) break;
      if (f.hi > printZ) {
        if (!firstHit) { firstHit = true; current = id; }
        if (f.hi < printZ + EPSILON) continue;
        height = Math.min(height, heightFromSlope(f, dev));
      }
    }
    height = Math.max(height, p.minLayerHeight);
    if (height > p.minLayerHeight) {
      for (; id < faces.length; id++) {
        const f = faces[id];
        if (f.lo >= printZ + height) break;
        if (f.hi < printZ + EPSILON) continue;
        const reduced = heightFromSlope(f, dev);
        const zDiff = f.lo - printZ;
        if (reduced < zDiff) height = zDiff;
        else if (reduced < height) height = reduced;
      }
      height = Math.max(height, p.minLayerHeight);
    }
    return height;
  };
  const out: number[] = [0, p.firstLayerHeight];
  if (p.firstFixed) out.push(p.firstLayerHeight, p.firstLayerHeight);
  let printZ = p.firstLayerHeight;
  let guard = 0;
  while (printZ + EPSILON < p.objectHeight && guard++ < 200_000) {
    let height = Math.min(next(printZ), p.maxLayerHeight);
    const last = out[out.length - 1];
    if (last < height && height - last > LAYER_HEIGHT_CHANGE_STEP) height = last + LAYER_HEIGHT_CHANGE_STEP;
    else if (last > height && last - height > LAYER_HEIGHT_CHANGE_STEP) height = last - LAYER_HEIGHT_CHANGE_STEP;
    for (const r of ranges) if (printZ >= r.min && printZ <= r.max) { height = r.layerHeight && r.layerHeight > 0 ? r.layerHeight : height; break; }
    out.push(printZ, height);
    printZ += height;
  }
  const gap = p.objectHeight - out[out.length - 2];
  if (gap > 0) out.push(p.objectHeight, clamp(gap, p.minLayerHeight, p.maxLayerHeight));
  return out;
}

// ---- layers ----------------------------------------------------------------------------

/** Orca generate_object_layers: [lo0, hi0, lo1, hi1, …] layer boundaries for a profile. */
export function generateLayers(p: SlicingParams, profile: readonly number[]): number[] {
  const prof = profile.length >= 4 ? profile : defaultProfile(p);
  const out: number[] = [];
  let printZ = 0;
  if (p.firstFixed) { out.push(0, p.firstLayerHeight); printZ = p.firstLayerHeight; }
  let idx = 0;
  let sliceZ = printZ + 0.5 * p.minLayerHeight;
  let guard = 0;
  while (sliceZ < p.objectHeight && guard++ < 200_000) {
    let height = p.minLayerHeight;
    if (idx < prof.length) {
      let nx = idx + 2;
      for (;;) {
        if (nx >= prof.length || sliceZ < prof[nx]) break;
        idx = nx;
        nx += 2;
      }
      const z1 = prof[idx], h1 = prof[idx + 1];
      height = h1;
      if (nx < prof.length) {
        const z2 = prof[nx], h2 = prof[nx + 1];
        height = z2 - z1 > 0 ? lerp(h1, h2, (sliceZ - z1) / (z2 - z1)) : h1;
      }
    }
    height = Math.max(height, MIN_LAYER_HEIGHT);
    sliceZ = printZ + 0.5 * height;
    if (sliceZ >= p.objectHeight) break;
    out.push(printZ);
    printZ += height;
    sliceZ = printZ + 0.5 * p.minLayerHeight;
    out.push(printZ);
  }
  return out;
}

/** Scale a profile's z values so its top matches `height` (after the object was rescaled). */
export function fitProfileToHeight(profile: readonly number[], height: number): number[] {
  if (profile.length < 4 || !(height > 0)) return profile.slice();
  const top = profile[profile.length - 2];
  if (!(top > 0) || Math.abs(top - height) < EPSILON) return profile.slice();
  const s = height / top;
  return profile.map((v, i) => (i % 2 === 0 ? v * s : v));
}

/** Sanitise an untrusted profile: even length, finite, z non-decreasing from 0, h > 0. Empty → []. */
export function sanitizeProfile(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length < 4) return [];
  const out: number[] = [];
  let lastZ = -Infinity;
  for (let i = 0; i + 1 < raw.length && out.length < 200_000; i += 2) {
    const z = Number(raw[i]), h = Number(raw[i + 1]);
    if (!Number.isFinite(z) || !Number.isFinite(h) || h <= 0 || h > 10 || z < 0 || z < lastZ) return [];
    out.push(z, h);
    lastZ = z;
  }
  return out.length >= 4 ? out : [];
}

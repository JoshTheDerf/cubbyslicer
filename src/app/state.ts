/**
 * Cross-module app state. Each feature area owns its own store module
 * (project/, presets/, preview/, engine/); only the handful of values that
 * several areas need to read live here, so no module has to import another
 * feature's internals.
 */
import { ref, shallowRef } from 'vue';
import type { EngineId, FlatConfig, SliceResult } from '../engine/types';

/** Active engine. Owned by the presets area (switching engine swaps catalogs). */
export const activeEngine = ref<EngineId>('orca');

/**
 * The fully-resolved global config for the active engine (system presets +
 * user presets + unsaved overrides). Written by the presets store, read by the
 * plater (bed shape) and the slice orchestrator.
 */
export const resolvedConfig = shallowRef<FlatConfig>({});

/** Which centre view is showing. */
export const activeView = ref<'prepare' | 'preview'>('prepare');

/** Latest slice output, written by the slice orchestrator (src/app/slice.ts). */
export const lastSlice = shallowRef<SliceResult | null>(null);

/**
 * Bumped whenever something that affects slicing changes (objects, transforms,
 * per-object config, resolved config). The orchestrator compares it with the
 * revision it sliced to decide whether the preview is stale.
 */
export const sliceInputRevision = ref(0);
export function markSliceInputsChanged(): void { sliceInputRevision.value++; }

// ---- bed ----------------------------------------------------------------

export interface BedShape {
  /** Printable area polygon in bed coordinates (mm), CCW. */
  polygon: Array<[number, number]>;
  /** Axis-aligned bounds of `polygon`. */
  min: [number, number];
  max: [number, number];
  /** Max printable height (mm). 0 = unknown. */
  maxHeight: number;
  /** Areas where nothing may be placed (e.g. Bambu purge chute). */
  excludeAreas: Array<Array<[number, number]>>;
}

function firstScalar(v: FlatConfig[string] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(',') : v;
}

/** Parse "0x0,256x0,256x256,0x256" (Orca `printable_area`, Prusa `bed_shape`). */
export function parsePointList(raw: string | undefined): Array<[number, number]> {
  if (!raw) return [];
  const out: Array<[number, number]> = [];
  for (const tok of raw.split(/[,;]/)) {
    const m = tok.trim().match(/^(-?[\d.]+)\s*x\s*(-?[\d.]+)$/i);
    if (!m) continue;
    const x = Number(m[1]), y = Number(m[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

export function bedFromConfig(cfg: FlatConfig): BedShape {
  let polygon = parsePointList(firstScalar(cfg.printable_area) ?? firstScalar(cfg.bed_shape));
  if (polygon.length < 3) polygon = [[0, 0], [220, 0], [220, 220], [0, 220]];
  const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
  const h = Number(firstScalar(cfg.printable_height) ?? firstScalar(cfg.max_print_height) ?? 0);
  const exclude = parsePointList(firstScalar(cfg.bed_exclude_area));
  return {
    polygon,
    min: [Math.min(...xs), Math.min(...ys)],
    max: [Math.max(...xs), Math.max(...ys)],
    maxHeight: Number.isFinite(h) ? h : 0,
    excludeAreas: exclude.length >= 3 ? [exclude] : [],
  };
}

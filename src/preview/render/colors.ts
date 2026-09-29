/**
 * Colour schemes for the preview: which per-segment value drives the colour,
 * its range, and the shared ramp used by numeric schemes.
 */
import { FEATURES, FIRST_NON_EXTRUSION } from '../parser/features';
import type { ParsedGcode } from '../parser/types';
import type { FlatConfig } from '../../engine/types';

export type ColorScheme =
  | 'feature' | 'height' | 'width' | 'speed' | 'fan' | 'temperature' | 'tool' | 'layerTime' | 'flow';

export interface SchemeMeta {
  id: ColorScheme;
  label: string;
  unit: string;
  /** Numeric schemes use the gradient ramp + value attribute. */
  numeric: boolean;
  /** Decimals for legend labels. */
  digits: number;
}

export const SCHEMES: readonly SchemeMeta[] = [
  { id: 'feature', label: 'Line type', unit: '', numeric: false, digits: 0 },
  { id: 'height', label: 'Layer height', unit: 'mm', numeric: true, digits: 2 },
  { id: 'width', label: 'Line width', unit: 'mm', numeric: true, digits: 2 },
  { id: 'speed', label: 'Speed', unit: 'mm/s', numeric: true, digits: 0 },
  { id: 'fan', label: 'Fan speed', unit: '%', numeric: true, digits: 0 },
  { id: 'temperature', label: 'Temperature', unit: '°C', numeric: true, digits: 0 },
  { id: 'tool', label: 'Filament', unit: '', numeric: false, digits: 0 },
  { id: 'layerTime', label: 'Layer time', unit: 's', numeric: true, digits: 1 },
  { id: 'flow', label: 'Volumetric flow rate', unit: 'mm³/s', numeric: true, digits: 1 },
];

export function schemeMeta(id: ColorScheme): SchemeMeta {
  return SCHEMES.find((s) => s.id === id) ?? SCHEMES[0];
}

/** PrusaSlicer/Orca "range" colours, blue → red (sRGB hex). */
export const RAMP: readonly number[] = [
  0x0b2c7a, 0x135985, 0x1c8891, 0x04d60f, 0xaaf200, 0xfcf903, 0xf5ce0a, 0xe38820, 0xd16830, 0xc2523c, 0x94250d,
];

export function rampColor(t: number): number {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(Math.floor(x), RAMP.length - 2);
  const f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

export const DEFAULT_TOOL_COLORS: readonly number[] = [
  0x19c37d, 0x4ea1ff, 0xf5b041, 0xef5b5b, 0xb07cff, 0x2bbed1, 0xff7d38, 0xe6e6e6,
  0x9aa36b, 0xff6fb1, 0x6b8e23, 0x8b5a2b, 0x00a3a3, 0xc0c000, 0x7f7fff, 0xa0a0a0,
];

function parseHex(s: string): number | null {
  const m = s.trim().match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  return m ? parseInt(m[1], 16) : null;
}

/** Filament colours from the resolved config (Orca `filament_colour`, Prusa `extruder_colour`). */
export function toolColorsFromConfig(cfg: FlatConfig): number[] {
  const out = DEFAULT_TOOL_COLORS.slice();
  const read = (key: string) => {
    const v = cfg[key];
    if (v === undefined) return [] as string[];
    return Array.isArray(v) ? v : v.split(/[;,]/);
  };
  const filament = read('filament_colour');
  const extruder = read('extruder_colour');
  for (let i = 0; i < out.length; i++) {
    const c = parseHex(extruder[i] ?? '') ?? parseHex(filament[i] ?? '');
    if (c !== null) out[i] = c;
  }
  return out;
}

/** Raw numeric value for segment `i` under `scheme` (display units). */
export function segmentValue(p: ParsedGcode, scheme: ColorScheme, i: number, layerTimeOfSeg?: Float32Array): number {
  switch (scheme) {
    case 'height': return p.wh[i * 2 + 1] / 1000;
    case 'width': return p.wh[i * 2] / 1000;
    case 'speed': return p.speed[i];
    case 'fan': return (p.fan[i] / 255) * 100;
    case 'temperature': return p.temp[i] / 10;
    case 'flow': return p.flow[i];
    case 'layerTime': return layerTimeOfSeg ? layerTimeOfSeg[i] : 0;
    default: return 0;
  }
}

/** Fill `out[k] = value(s0 + k)` for a numeric scheme. */
export function fillValues(p: ParsedGcode, scheme: ColorScheme, s0: number, out: Float32Array): void {
  const n = out.length;
  switch (scheme) {
    case 'height': for (let k = 0; k < n; k++) out[k] = p.wh[(s0 + k) * 2 + 1] * 0.001; break;
    case 'width': for (let k = 0; k < n; k++) out[k] = p.wh[(s0 + k) * 2] * 0.001; break;
    case 'speed': out.set(p.speed.subarray(s0, s0 + n)); break;
    case 'flow': out.set(p.flow.subarray(s0, s0 + n)); break;
    case 'fan': for (let k = 0; k < n; k++) out[k] = p.fan[s0 + k] * (100 / 255); break;
    case 'temperature': for (let k = 0; k < n; k++) out[k] = p.temp[s0 + k] * 0.1; break;
    case 'layerTime': {
      let l = layerOfSegment(p, s0);
      for (let k = 0; k < n; k++) {
        const s = s0 + k;
        while (l + 1 < p.layerCount && s >= p.layerStart[l + 1]) l++;
        out[k] = p.layerTime[l];
      }
      break;
    }
    default: out.fill(0);
  }
}

export function layerOfSegment(p: ParsedGcode, seg: number): number {
  let lo = 0, hi = p.layerCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.layerStart[mid] <= seg) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export interface ValueRange { min: number; max: number }

/** Min/max of a numeric scheme over extrusion segments (layer time: over layers). */
export function schemeRange(p: ParsedGcode, scheme: ColorScheme): ValueRange {
  let min = Infinity, max = -Infinity;
  if (scheme === 'layerTime') {
    for (let l = 0; l < p.layerCount; l++) {
      if (p.layerStart[l + 1] === p.layerStart[l]) continue;
      const v = p.layerTime[l];
      if (v < min) min = v; if (v > max) max = v;
    }
  } else {
    const n = p.segmentCount, f = p.feature;
    for (let i = 0; i < n; i++) {
      if (f[i] >= FIRST_NON_EXTRUSION) continue;
      const v = segmentValue(p, scheme, i);
      if (v < min) min = v; if (v > max) max = v;
    }
  }
  if (!(min <= max)) return { min: 0, max: 1 };
  return { min, max };
}

export function featureColor(id: number): number {
  return FEATURES[id]?.color ?? 0x999999;
}

export function hexCss(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

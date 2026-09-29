/**
 * Legend + summary data derived from the parsed G-code and the engine report.
 * Engine figures win (they come from the real planner); the parser's own
 * estimate and header comments are fallbacks.
 */
import { FEATURES, FIRST_NON_EXTRUSION } from './parser/features';
import type { ParsedGcode } from './parser/types';
import type { SliceReport } from '../engine/types';

/** Orca "Options" block toggles (plus our dim-below extra). */
export interface LegendOptions {
  travel: boolean;
  wipe: boolean;
  retracts: boolean;
  unretracts: boolean;
  seams: boolean;
  toolMarker: boolean;
  dimBelow: boolean;
}

export const DEFAULT_LEGEND_OPTIONS: LegendOptions = {
  travel: false, wipe: false, retracts: false, unretracts: false, seams: false, toolMarker: true, dimBelow: false,
};

export interface FeatureRow {
  id: number;
  label: string;
  color: number;
  /** Seconds (scaled so the rows sum to the headline total). */
  time: number;
  /** 0..100 */
  percent: number;
  count: number;
  /** Filament used by this feature (share of the headline total), when known. */
  filamentMm: number | null;
  filamentG: number | null;
}

export interface ToolRow {
  index: number;
  mm: number;
  g: number | null;
  cost: number | null;
}

export interface Summary {
  timeSec: number | null;
  timeSource: 'engine' | 'file' | 'estimate';
  layers: number;
  maxZ: number;
  tools: ToolRow[];
  totalMm: number;
  totalG: number | null;
  totalCost: number | null;
  segments: number;
}

export function buildSummary(p: ParsedGcode, report: SliceReport | null): Summary {
  const st = report?.stats ?? null;
  let timeSec: number | null = null;
  let timeSource: Summary['timeSource'] = 'estimate';
  if (st && st.printTimeSec > 0) { timeSec = st.printTimeSec; timeSource = 'engine'; }
  else if (p.header.printTimeSec && p.header.printTimeSec > 0) { timeSec = p.header.printTimeSec; timeSource = 'file'; }
  else if (p.stats.estimatedTimeSec > 0) timeSec = p.stats.estimatedTimeSec;

  const mm = st?.filamentMm?.length ? st.filamentMm : p.header.filamentMm?.length ? p.header.filamentMm : p.stats.filamentMmPerTool;
  const g = st?.filamentG?.length ? st.filamentG : p.header.filamentG;
  const cost = st?.filamentCost?.length ? st.filamentCost : p.header.filamentCost;
  const tools: ToolRow[] = [];
  for (let i = 0; i < mm.length; i++) {
    if (!(mm[i] > 0)) continue;
    tools.push({ index: i, mm: mm[i], g: g?.[i] ?? null, cost: cost?.[i] ?? null });
  }
  const sum = (a: number[] | null | undefined) => (a && a.length ? a.reduce((s, v) => s + (v || 0), 0) : null);
  const maxZ = st && st.maxZ > 0 ? st.maxZ : p.header.maxZ ?? (p.stats.extrusionCount ? p.stats.max[2] : 0);
  return {
    timeSec, timeSource,
    layers: p.layerCount,
    maxZ,
    tools,
    totalMm: tools.reduce((a, t) => a + t.mm, 0),
    totalG: sum(g),
    totalCost: sum(cost),
    segments: p.segmentCount,
  };
}

/**
 * Relative extruded volume per feature id (sums to 1 when anything extruded).
 * Volume per segment = flow (mm³/s) × length / feedrate.
 */
export function featureVolumeShare(p: ParsedGcode): Float64Array {
  const vol = new Float64Array(FEATURES.length);
  const n = p.segmentCount, f = p.feature, pt = p.points, flow = p.flow, speed = p.speed;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const id = f[i];
    if (id >= FIRST_NON_EXTRUSION || !(flow[i] > 0) || !(speed[i] > 0)) continue;
    const j = i * 3;
    const dx = pt[j + 3] - pt[j], dy = pt[j + 4] - pt[j + 1], dz = pt[j + 5] - pt[j + 2];
    const v = (flow[i] * Math.sqrt(dx * dx + dy * dy + dz * dz)) / speed[i];
    vol[id] += v;
    total += v;
  }
  if (total > 0) for (let i = 0; i < vol.length; i++) vol[i] /= total;
  return vol;
}

/** Extrusion features present in the print, with time share and filament use. */
export function buildFeatureRows(p: ParsedGcode, totalTimeSec: number | null, totals?: { mm: number; g: number | null }): FeatureRow[] {
  const ft = p.stats.featureTime, fc = p.stats.featureCount;
  let est = 0;
  for (let i = 0; i < ft.length; i++) est += ft[i];
  const scale = totalTimeSec && est > 0 ? totalTimeSec / est : 1;
  const share = totals && totals.mm > 0 ? featureVolumeShare(p) : null;
  const rows: FeatureRow[] = [];
  for (const f of FEATURES) {
    if (f.id >= FIRST_NON_EXTRUSION) continue;
    if (!fc[f.id]) continue;
    rows.push({
      id: f.id, label: f.label, color: f.color,
      time: ft[f.id] * scale,
      percent: est > 0 ? (ft[f.id] / est) * 100 : 0,
      count: fc[f.id],
      filamentMm: share && totals ? share[f.id] * totals.mm : null,
      filamentG: share && totals && totals.g !== null ? share[f.id] * totals.g : null,
    });
  }
  return rows;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '–';
  const s = Math.round(sec);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${r}s`;
  return `${r}s`;
}

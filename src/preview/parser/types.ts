/**
 * Parsed G-code as flat typed arrays (struct-of-arrays), cheap to transfer
 * from the worker and to hand to the GPU without per-move JS objects.
 *
 * Every motion (extrusion, travel, wipe, E-only retract/unretract, arc
 * sub-segment) is one *segment*. Segments form one continuous polyline in
 * file order, so segment `i` goes from point `i` to point `i + 1` and the
 * point array has `segmentCount + 1` entries. Layers are contiguous segment
 * ranges (layer index increases monotonically in file order), so a layer
 * range + intra-layer move clip is a single segment-index interval.
 */

export interface ParseOptions {
  /** Filament diameter (mm) when not found in the file. Default 1.75. */
  filamentDiameter?: number;
  /** Default print acceleration (mm/s²) when the file sets none. Default 1500. */
  acceleration?: number;
  /** Default travel acceleration (mm/s²). Defaults to `acceleration`. */
  travelAcceleration?: number;
  /** Max chord error (mm) for G2/G3 tessellation. Default 0.01. */
  arcTolerance?: number;
  /** Progress callback granularity in bytes. Default 4 MB. */
  progressEvery?: number;
}

/** Values read from slicer header/footer comments (all optional). */
export interface GcodeHeaderInfo {
  generator: string | null;
  printTimeSec: number | null;
  layerCount: number | null;
  maxZ: number | null;
  filamentMm: number[] | null;
  filamentG: number[] | null;
  filamentCm3: number[] | null;
  filamentCost: number[] | null;
  filamentDiameter: number | null;
}

export interface ParsedStats {
  /** Parser time estimate (s) — trapezoid model, no backward planner pass. */
  estimatedTimeSec: number;
  /** Estimated seconds per feature id (index = FeatureId). */
  featureTime: Float64Array;
  /** Segment count per feature id. */
  featureCount: Uint32Array;
  /** Net extruded filament length (mm) per tool index. */
  filamentMmPerTool: number[];
  /** Tool indices that extruded anything. */
  toolsUsed: number[];
  /** Extrusion bounds (mm). Infinity/-Infinity when nothing extruded. */
  min: [number, number, number];
  max: [number, number, number];
  extrusionCount: number;
  travelCount: number;
  lineCount: number;
  parseMs: number;
}

export const MarkerKind = { Retract: 0, Unretract: 1, Seam: 2 } as const;

export interface ParsedGcode {
  segmentCount: number;
  /** xyz per point, (segmentCount + 1) * 3 floats. */
  points: Float32Array;
  /** width, height per segment in micrometres (2 per segment). */
  wh: Uint16Array;
  /** FeatureId per segment. */
  feature: Uint8Array;
  /** Tool (extruder) index per segment. */
  tool: Uint8Array;
  /** Part-cooling fan 0..255 per segment. */
  fan: Uint8Array;
  /** Nozzle temperature ×10 (°C) per segment. */
  temp: Uint16Array;
  /** Commanded feedrate (mm/s) per segment. */
  speed: Float32Array;
  /** Volumetric flow (mm³/s) per segment, 0 for non-extrusion. */
  flow: Float32Array;
  /** Estimated duration (s) per segment. */
  time: Float32Array;
  /** 0-based G-code line number per segment. */
  lineNo: Uint32Array;
  /** Byte offset of the segment's G-code line start. */
  byteOffset: Uint32Array;

  layerCount: number;
  /** Segment index where each layer starts; length layerCount + 1 (last = segmentCount). */
  layerStart: Uint32Array;
  /** Print Z per layer (mm). */
  layerZ: Float32Array;
  /** Layer thickness per layer (mm). */
  layerHeight: Float32Array;
  /** Estimated seconds per layer. */
  layerTime: Float32Array;

  /** Retract / unretract / seam markers. */
  markerCount: number;
  /** Segment index each marker belongs to. */
  markerSeg: Uint32Array;
  /** MarkerKind per marker. */
  markerKind: Uint8Array;
  /** xyz per marker. */
  markerPos: Float32Array;

  header: GcodeHeaderInfo;
  stats: ParsedStats;
  /**
   * Colour changes from `;COLOR_CHANGE,T<e>,#rrggbb` tags (Orca / PrusaSlicer
   * GCodeProcessor): from segment `seg` on, extruder `extruder` (0-based)
   * prints in `color` (null = next default colour). Absent when none.
   */
  colorChanges?: Array<{ seg: number; extruder: number; color: number | null }>;
}

/** All typed arrays of a ParsedGcode (for transfer lists / byte accounting). */
export function parsedBuffers(p: ParsedGcode): ArrayBufferLike[] {
  return [
    p.points, p.wh, p.feature, p.tool, p.fan, p.temp, p.speed, p.flow, p.time, p.lineNo, p.byteOffset,
    p.layerStart, p.layerZ, p.layerHeight, p.layerTime, p.markerSeg, p.markerKind, p.markerPos,
  ].map((a) => a.buffer);
}

export function parsedByteSize(p: ParsedGcode): number {
  return parsedBuffers(p).reduce((s, b) => s + b.byteLength, 0);
}

// ---- worker protocol ------------------------------------------------------

export type ParserRequest = { type: 'parse'; id: number; bytes: Uint8Array; options: ParseOptions };

export type ParserResponse =
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'result'; id: number; data: ParsedGcode }
  | { type: 'error'; id: number; message: string };

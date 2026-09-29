/**
 * Small ports of the libslic3r maths the calibration setup needs
 * (Flow.cpp, calib.cpp CalibPressureAdvance / CalibPressureAdvancePattern
 * geometry), evaluated against a flat resolved config.
 */
import type { ConfigValue, FlatConfig } from '../engine/types';

export function num(v: ConfigValue | undefined, index = 0, fallback = 0): number {
  const s = Array.isArray(v) ? (v[index] ?? v[0]) : v;
  if (s === undefined || s === '' || s === 'nil') return fallback;
  const n = parseFloat(String(s));
  return Number.isFinite(n) ? n : fallback;
}

/** ConfigBase::get_abs_value: a float, or a percent of `ratioOver` ("110%"). */
export function absValue(cfg: FlatConfig, key: string, ratioOver = 0): number {
  const v = cfg[key];
  const s = String(Array.isArray(v) ? v[0] ?? '' : v ?? '').trim();
  if (s.endsWith('%')) return (parseFloat(s) / 100) * ratioOver;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** Flow::auto_extrusion_width for perimeters / infill (1.125 × nozzle). */
export function autoExtrusionWidth(nozzle: number): number { return 1.125 * nozzle; }

/** Flow::mm3_per_mm of a non-bridging rounded-rectangle extrusion. */
export function mm3PerMm(width: number, height: number): number {
  return height * (width - height * (1 - Math.PI / 4));
}

/** CalibPressureAdvance::find_optimal_PA_speed. */
export function findOptimalPASpeed(cfg: FlatConfig, lineWidth: number, layerHeight: number, extruder = 0, filament = 0): number {
  const maxVol = num(cfg.filament_max_volumetric_speed, filament, 0);
  const nozzle = num(cfg.nozzle_diameter, extruder, 0.4);
  const w = lineWidth > 0 ? lineWidth : autoExtrusionWidth(nozzle);
  const perMm = mm3PerMm(w, layerHeight);
  const outer = num(cfg.outer_wall_speed, 0, 0);
  const speed = Math.max(100, outer);
  return Math.floor(maxVol > 0 && perMm > 0 ? Math.min(speed, maxVol / perMm) : speed);
}

/** std::ostream << double with setprecision(p) (general format, trailing zeros dropped). */
function streamNumber(n: number, precision?: number): string {
  if (!precision) return String(Number(n.toPrecision(6)));
  return String(Number(n.toPrecision(Math.max(1, precision))));
}

/** CalibPressureAdvance::convert_number_to_string(num, precision). */
export function calibNumberString(n: number, precision = 0): string {
  if (!precision) return streamNumber(n);
  return streamNumber(n, n >= 1000 ? precision : precision - 1);
}

/**
 * CalibPressureAdvancePattern sizes (calib.hpp/.cpp): the footprint of one
 * test pattern and where its 'handle' cube sits. `cfg` is the full config
 * after the pattern's suggested settings were applied.
 */
export class PAPatternGeometry {
  static readonly handleXY = 5;
  static readonly handleSpacing = 1.2;
  static readonly numLayers = 4;
  static readonly wallSide = 30;
  static readonly cornerAngle = 90;
  static readonly patternSpacing = 2;
  static readonly glyphPadV = 1;
  static readonly glyphPadH = 1;
  static readonly digitSegment = 2;
  static readonly digitGap = 1;
  static readonly maxNumberLen = 5;

  constructor(private readonly cfg: FlatConfig, private readonly start: number, private readonly end: number, private readonly step: number, private readonly accel: number) {}

  private get nozzle(): number { return num(this.cfg.nozzle_diameter, 0, 0.4); }
  lineWidth(): number { const w = absValue(this.cfg, 'line_width', this.nozzle); return w > 0 ? w : autoExtrusionWidth(this.nozzle); }
  lineWidthFirstLayer(): number { const w = absValue(this.cfg, 'initial_layer_line_width', this.nozzle); return w > 0 ? w : autoExtrusionWidth(this.nozzle); }
  heightLayer(): number { return absValue(this.cfg, 'layer_height'); }
  heightFirstLayer(): number { return absValue(this.cfg, 'initial_layer_print_height'); }
  wallCount(): number { return Math.round(num(this.cfg.wall_loops, 0, 3)); }
  numPatterns(): number { return Math.ceil((this.end - this.start) / this.step + 1); }

  private rad(deg: number): number { return (deg * Math.PI) / 180; }
  lineSpacing(): number { return this.lineWidth() - this.heightLayer() * (1 - Math.PI / 4); }
  lineSpacingFirstLayer(): number { return this.lineWidthFirstLayer() - this.heightFirstLayer() * (1 - Math.PI / 4); }
  lineSpacingAngle(): number { return this.lineSpacing() / Math.sin(this.rad(PAPatternGeometry.cornerAngle) / 2); }

  maxNumberingLength(): number {
    let most = 0;
    for (let i = 0; i < this.numPatterns(); i += 2) most = Math.max(most, calibNumberString(this.start + i * this.step).length);
    most = Math.max(most, calibNumberString(this.accel).length);
    return Math.min(most, PAPatternGeometry.maxNumberLen);
  }
  maxNumberingHeight(): number {
    const n = this.maxNumberingLength();
    return n * PAPatternGeometry.digitSegment + (n - 1) * PAPatternGeometry.digitGap;
  }
  patternShift(): number {
    return (this.wallCount() - 1) * this.lineSpacingFirstLayer() + this.lineWidthFirstLayer() + PAPatternGeometry.glyphPadH;
  }
  objectSizeX(): number {
    const n = this.numPatterns();
    return n * ((this.wallCount() - 1) * this.lineSpacingAngle()) + (n - 1) * (PAPatternGeometry.patternSpacing + this.lineWidth())
      + Math.cos(this.rad(PAPatternGeometry.cornerAngle) / 2) * PAPatternGeometry.wallSide + this.lineSpacingFirstLayer() * this.wallCount();
  }
  objectSizeY(): number {
    return 2 * (Math.sin(this.rad(PAPatternGeometry.cornerAngle) / 2) * PAPatternGeometry.wallSide) + this.maxNumberingHeight()
      + PAPatternGeometry.glyphPadV * 2 + this.lineWidthFirstLayer();
  }
  printSizeX(): number { return this.objectSizeX() + this.patternShift(); }
  printSizeY(): number { return this.objectSizeY(); }
  maxLayerZ(): number { return this.heightFirstLayer() + (PAPatternGeometry.numLayers - 1) * this.heightLayer(); }
  /** Offset from the pattern footprint's centre to the handle cube's centre. */
  handlePosOffset(): [number, number, number] {
    return [
      -this.printSizeX() / 2 + PAPatternGeometry.handleXY / 2 + PAPatternGeometry.handleSpacing,
      -this.maxNumberingHeight() / 2 - PAPatternGeometry.glyphPadV,
      this.maxLayerZ() / 2,
    ];
  }
}

/** Calib_Params parsing helper for comma-separated positive integers (calib_dlg.cpp ParseStringValues). */
export function parseIntList(s: string): number[] {
  return s.replace(/,/g, ' ').split(/\s+/).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0);
}

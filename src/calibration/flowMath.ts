/**
 * Small ports of the libslic3r maths the calibration setup needs
 * (Flow.cpp, calib.cpp CalibPressureAdvance / CalibPressureAdvancePattern
 * geometry), evaluated against a flat resolved config.
 */
import type { FlatConfig } from '../engine/types';
import { cfgAbs, cfgNumber, SCALAR } from '../lib/configValue';

/** Flow::auto_extrusion_width for perimeters / infill (1.125 × nozzle). */
export function autoExtrusionWidth(nozzle: number): number { return 1.125 * nozzle; }

/** Flow::mm3_per_mm of a non-bridging rounded-rectangle extrusion. */
export function mm3PerMm(width: number, height: number): number {
  return height * (width - height * (1 - Math.PI / 4));
}

/**
 * CalibPressureAdvance::find_optimal_PA_speed: max(100, outer wall speed),
 * capped by the max volumetric speed; `outer_wall_speed` and `nozzle_diameter`
 * at the bare extruder element, the volumetric limit at the filament's, as
 * Orca 2.5 reads them. An unset volumetric limit (0) leaves the speed uncapped:
 * Orca would return 0, a speed the engine refuses (min 1).
 */
export function findOptimalPASpeed(cfg: FlatConfig, lineWidth: number, layerHeight: number, extruder = 0, filament = 0): number {
  const maxVol = cfgNumber(cfg, 'filament_max_volumetric_speed', filament, 0);
  const nozzle = cfgNumber(cfg, 'nozzle_diameter', extruder, 0.4);
  const w = lineWidth > 0 ? lineWidth : autoExtrusionWidth(nozzle);
  const perMm = mm3PerMm(w, layerHeight);
  const outer = cfgNumber(cfg, 'outer_wall_speed', extruder, 0);
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

  private get nozzle(): number { return cfgNumber(this.cfg, 'nozzle_diameter', SCALAR, 0.4); }
  private abs(key: string, over = 0): number { return cfgAbs(this.cfg, key, SCALAR, over); }
  lineWidth(): number { const w = this.abs('line_width', this.nozzle); return w > 0 ? w : autoExtrusionWidth(this.nozzle); }
  lineWidthFirstLayer(): number { const w = this.abs('initial_layer_line_width', this.nozzle); return w > 0 ? w : autoExtrusionWidth(this.nozzle); }
  heightLayer(): number { return this.abs('layer_height'); }
  heightFirstLayer(): number { return this.abs('initial_layer_print_height'); }
  wallCount(): number { return Math.round(cfgNumber(this.cfg, 'wall_loops', SCALAR, 3)); }
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

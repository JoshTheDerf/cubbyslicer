/**
 * Time model for the preview parser: per-move trapezoid with acceleration,
 * junction speed from Marlin-style junction deviation, one-move lookahead
 * (forward pass only). Good enough for colour-by-time and relative feature
 * times; the headline total comes from the engine report when there is one.
 */

/** Duration of a trapezoidal move (s). */
export function trapezoidTime(len: number, vMax: number, accel: number, vIn: number, vOut: number): number {
  if (len <= 0) return 0;
  if (vMax <= 0) return 0;
  if (accel <= 0) return len / vMax;
  vIn = Math.min(vIn, vMax); vOut = Math.min(vOut, vMax);
  const d1 = (vMax * vMax - vIn * vIn) / (2 * accel);
  const d2 = (vMax * vMax - vOut * vOut) / (2 * accel);
  if (d1 + d2 <= len) {
    return (vMax - vIn) / accel + (vMax - vOut) / accel + (len - d1 - d2) / vMax;
  }
  const vp = Math.sqrt(Math.max((2 * accel * len + vIn * vIn + vOut * vOut) / 2, 0));
  const peak = Math.max(vp, vIn, vOut);
  return (peak - vIn) / accel + (peak - vOut) / accel;
}

/**
 * Holds one pending move until the next one fixes its exit speed, then reports
 * its duration through `done(segment, seconds)`.
 */
export class Planner {
  /** Junction deviation (mm), from M205 J / jerk / square corner velocity. */
  junctionDev = 0.02;
  private idx = -1;
  private len = 0; private v = 0; private a = 0; private entry = 0;
  private dx = 0; private dy = 0; private dz = 0; private eOnly = false;
  /** Dwell (s) added to the pending move. */
  private extra = 0;

  /** `fallbackAccel`: mm/s² for a move with no usable acceleration. */
  constructor(private fallbackAccel: number, private done: (seg: number, seconds: number) => void) {}

  /** Queue segment `idx`: length, cruise speed, acceleration and unit direction. */
  plan(idx: number, len: number, v: number, a: number, ux: number, uy: number, uz: number, eOnly: boolean): void {
    if (!(a > 0) || a === Infinity) a = this.fallbackAccel;
    let vj = 0;
    if (this.idx >= 0 && !eOnly && !this.eOnly) {
      const cos = -(this.dx * ux + this.dy * uy + this.dz * uz);
      if (cos < -0.999999) vj = Math.min(v, this.v);
      else if (cos > 0.999999) vj = 0;
      else {
        const sinHalf = Math.sqrt(0.5 * (1 - cos));
        vj = Math.sqrt((a * this.junctionDev * sinHalf) / (1 - sinHalf));
        vj = Math.min(vj, v, this.v);
      }
    }
    const entry = this.flush(vj);
    this.idx = idx; this.len = len; this.v = v; this.a = a; this.entry = Math.min(entry, v);
    this.dx = ux; this.dy = uy; this.dz = uz; this.eOnly = eOnly;
  }

  /** Add a dwell to the pending move and finish it (the machine stops). */
  dwell(seconds: number): void {
    this.extra += seconds;
    this.flush(0);
  }

  /** Finish the pending move with the given exit speed; returns the actual exit speed. */
  flush(vExit: number): number {
    if (this.idx < 0) { this.extra = 0; return 0; }
    const reach = Math.sqrt(this.entry * this.entry + 2 * this.a * this.len);
    const exit = Math.min(vExit, reach, this.v);
    const t = trapezoidTime(this.len, this.v, this.a, this.entry, exit) + this.extra;
    const idx = this.idx;
    this.idx = -1;
    this.extra = 0;
    this.done(idx, t);
    return exit;
  }
}

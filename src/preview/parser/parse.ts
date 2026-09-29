/**
 * Streaming byte-level G-code parser.
 *
 * Works directly on the UTF-8 bytes: motion lines are tokenized without ever
 * creating a JS string (numbers are parsed from bytes), only short comment
 * lines and rare extended (Klipper-style) commands are turned into strings.
 * Output is the struct-of-arrays `ParsedGcode` (see ./types.ts).
 *
 * Supported: G0/G1, G2/G3 (I/J or R, tessellated with a chord-error bound,
 * helical Z), G4 dwell, G10/G11 firmware retract, G20/G21, G28, G90/G91, G92,
 * M82/M83, M104/M109, M106/M107, M201/M203/M204/M205, Klipper
 * SET_VELOCITY_LIMIT, T<n>. Comment dialects: PrusaSlicer/preFlight, Orca/
 * Bambu, Cura (see ./features.ts). Without layer comments, layers are
 * derived from Z changes of extruding moves.
 *
 * Time model: per-move trapezoid with acceleration, junction speed from
 * Marlin-style junction deviation, one-move lookahead (forward pass only).
 * Good enough for colour-by-time and relative feature times; the headline
 * total should come from the engine report when present.
 */
import { Feature, FEATURE_COUNT, classifyFeature, isExtrusionFeature } from './features';
import { MarkerKind } from './types';
import type { GcodeHeaderInfo, ParseOptions, ParsedGcode } from './types';

const NL = 10, CR = 13, SP = 32, TAB = 9, SEMI = 59, DOT = 46, MINUS = 45, PLUS = 43;
const LETTER = (c: string) => c.charCodeAt(0) - 65;
const PX = LETTER('X'), PY = LETTER('Y'), PZ = LETTER('Z'), PE = LETTER('E'), PF = LETTER('F');
const PI_ = LETTER('I'), PJ = LETTER('J'), PR = LETTER('R'), PS = LETTER('S'), PP = LETTER('P'), PT = LETTER('T');
const PL = LETTER('L');
const BIT = (p: number) => 1 << p;

const E_EPS = 1e-7;
const LEN_EPS = 1e-6;
const LAYER_Z_EPS = 0.009;

let numEnd = 0;
const INV_POW10 = new Float64Array(16).map((_, i) => 1 / 10 ** i);
/** Parse a decimal number (no exponent — `E` is an axis letter). NaN if no digits. */
function parseNumber(b: Uint8Array, p: number, end: number): number {
  let neg = false;
  let c = b[p];
  if (c === MINUS) { neg = true; p++; } else if (c === PLUS) { p++; }
  let intPart = 0, digits = 0;
  while (p < end) {
    const d = b[p] - 48;
    if (d < 0 || d > 9) break;
    intPart = intPart * 10 + d; p++; digits++;
  }
  let v = intPart;
  if (p < end && b[p] === DOT) {
    p++;
    let frac = 0, nd = 0;
    while (p < end) {
      const d = b[p] - 48;
      if (d < 0 || d > 9) break;
      if (nd < 15) { frac = frac * 10 + d; nd++; }
      p++; digits++;
    }
    v += frac * INV_POW10[nd];
  }
  numEnd = p;
  if (digits === 0) return NaN;
  return neg ? -v : v;
}

function ascii(b: Uint8Array, start: number, end: number): string {
  const sub = b.subarray(start, end);
  // fromCharCode.apply on a typed array: fast for short strings.
  return String.fromCharCode.apply(null, sub as unknown as number[]);
}

/** "1d 2h 3m 4s" / "2h 5m" / "45s" → seconds; NaN if nothing parsed. */
export function parseDuration(s: string): number {
  let total = 0, any = false;
  const re = /(\d+(?:\.\d+)?)\s*([dhms])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    any = true;
    const v = Number(m[1]);
    switch (m[2].toLowerCase()) {
      case 'd': total += v * 86400; break;
      case 'h': total += v * 3600; break;
      case 'm': total += v * 60; break;
      default: total += v;
    }
  }
  if (!any) {
    const hms = s.match(/(\d+):(\d{2}):(\d{2})/);
    if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    return NaN;
  }
  return total;
}

function numList(s: string): number[] {
  return s.split(/[,;]/).map((t) => Number(t.trim())).filter((v) => Number.isFinite(v));
}

/** Trapezoid move time. */
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

class GcodeParser {
  // ---- input ----
  private b: Uint8Array;
  private opts: Required<ParseOptions>;

  // ---- segment storage (growable) ----
  private cap = 0;
  private n = 0; // segment count
  points!: Float32Array;
  wh!: Uint16Array;
  feature!: Uint8Array;
  tool!: Uint8Array;
  fan!: Uint8Array;
  temp!: Uint16Array;
  speed!: Float32Array;
  flow!: Float32Array;
  time!: Float32Array;
  lineNo!: Uint32Array;
  byteOffset!: Uint32Array;

  // markers
  private mCap = 0;
  private mN = 0;
  markerSeg = new Uint32Array(0);
  markerKind = new Uint8Array(0);
  markerPos = new Float32Array(0);

  // ---- machine state ----
  private x = 0; private y = 0; private z = 0; private e = 0;
  private feed = 25; // mm/s
  private absXYZ = true;
  private relE = false; // M83
  private unit = 1;
  private curTool = 0;
  private curFan = 0;
  private temps = new Float64Array(64);
  private curFeature: number = Feature.Other;
  private inWipe = false;
  private curWidth = 0.45;
  private widthKnown = false;
  private curHeight = 0; // from ;HEIGHT comments (0 = unknown)
  private filArea = Math.PI * 0.875 * 0.875;
  private filDiamFromFile = false;
  private lastWasExtrusion = false;
  /** `;COLOR_CHANGE,T<e>,#rrggbb` tags (Orca GCodeProcessor ETags::Color_Change). */
  private colorChanges: Array<{ seg: number; extruder: number; color: number | null }> = [];

  // limits
  private accelPrint: number;
  private accelTravel: number;
  private accelRetract = 3000;
  private maxAccelXY = Infinity;
  private maxAccelZ = Infinity;
  private maxAccelE = Infinity;
  private maxVX = Infinity; private maxVY = Infinity; private maxVZ = Infinity; private maxVE = Infinity;
  private junctionDev = 0.02;

  // planner (one pending move)
  private pIdx = -1;
  private pLen = 0; private pV = 0; private pA = 0; private pEntry = 0;
  private pdx = 0; private pdy = 0; private pdz = 0; private pEOnly = false;
  private pExtra = 0; // dwell added to the pending move

  // ---- params of the current line ----
  private pv = new Float64Array(26);
  private mask = 0;

  // ---- layers ----
  // marker based
  private mkStart: number[] = [];
  private mkZ: number[] = [];
  private mkH: number[] = [];
  // Z based fallback
  private fbStart: number[] = [];
  private fbZ: number[] = [];
  private fbCurZ = -Infinity;
  private fbPrevZ = 0;
  private lastZChangeSeg = -1;

  // ---- stats ----
  private featureTime = new Float64Array(FEATURE_COUNT);
  private featureCount = new Uint32Array(FEATURE_COUNT);
  private filPerTool: number[] = [];
  private min: [number, number, number] = [Infinity, Infinity, Infinity];
  private max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  private extrusionCount = 0;
  private travelCount = 0;
  private totalTime = 0;
  header: GcodeHeaderInfo = {
    generator: null, printTimeSec: null, layerCount: null, maxZ: null,
    filamentMm: null, filamentG: null, filamentCm3: null, filamentCost: null, filamentDiameter: null,
  };

  // current line
  private lineIdx = 0;
  private lineStart = 0;

  constructor(bytes: Uint8Array, opts: ParseOptions) {
    this.b = bytes;
    this.opts = {
      filamentDiameter: opts.filamentDiameter ?? 1.75,
      acceleration: opts.acceleration ?? 1500,
      travelAcceleration: opts.travelAcceleration ?? opts.acceleration ?? 1500,
      arcTolerance: opts.arcTolerance ?? 0.01,
      progressEvery: opts.progressEvery ?? 4 * 1024 * 1024,
    };
    const r = this.opts.filamentDiameter / 2;
    this.filArea = Math.PI * r * r;
    this.accelPrint = this.opts.acceleration;
    this.accelTravel = this.opts.travelAcceleration;
    this.temps.fill(0);
    this.grow(Math.max(1024, Math.min(Math.ceil(bytes.length / 24), 1 << 24)));
    this.growMarkers(256);
  }

  // ---- storage ---------------------------------------------------------

  private grow(newCap: number): void {
    const copy = <T extends Float32Array | Uint16Array | Uint8Array | Uint32Array>(
      a: T | undefined, ctor: new (n: number) => T, per: number, extra = 0,
    ): T => {
      const out = new ctor(newCap * per + extra);
      if (a) out.set(a.subarray(0, Math.min(a.length, out.length)) as never);
      return out;
    };
    this.points = copy(this.points, Float32Array, 3, 3);
    this.wh = copy(this.wh, Uint16Array, 2);
    this.feature = copy(this.feature, Uint8Array, 1);
    this.tool = copy(this.tool, Uint8Array, 1);
    this.fan = copy(this.fan, Uint8Array, 1);
    this.temp = copy(this.temp, Uint16Array, 1);
    this.speed = copy(this.speed, Float32Array, 1);
    this.flow = copy(this.flow, Float32Array, 1);
    this.time = copy(this.time, Float32Array, 1);
    this.lineNo = copy(this.lineNo, Uint32Array, 1);
    this.byteOffset = copy(this.byteOffset, Uint32Array, 1);
    this.cap = newCap;
  }

  private growMarkers(newCap: number): void {
    const s = new Uint32Array(newCap); s.set(this.markerSeg.subarray(0, this.mN));
    const k = new Uint8Array(newCap); k.set(this.markerKind.subarray(0, this.mN));
    const p = new Float32Array(newCap * 3); p.set(this.markerPos.subarray(0, this.mN * 3));
    this.markerSeg = s; this.markerKind = k; this.markerPos = p; this.mCap = newCap;
  }

  private addMarker(kind: number, seg: number, x: number, y: number, z: number): void {
    if (this.mN >= this.mCap) this.growMarkers(this.mCap * 2);
    const i = this.mN++;
    this.markerSeg[i] = seg; this.markerKind[i] = kind;
    this.markerPos[i * 3] = x; this.markerPos[i * 3 + 1] = y; this.markerPos[i * 3 + 2] = z;
  }

  // ---- main loop -------------------------------------------------------

  run(onProgress?: (done: number, total: number) => void): void {
    const n = this.b.length;
    const every = this.opts.progressEvery;
    let nextReport = every;
    this.points[0] = 0; this.points[1] = 0; this.points[2] = 0;
    let i = 0;
    while (i < n) {
      this.lineStart = i;
      i = this.line(i) + 1;
      this.lineIdx++;
      if (onProgress && i >= nextReport) { onProgress(Math.min(i, n), n); nextReport = i + every; }
    }
    this.flushPending(0);
    onProgress?.(n, n);
  }

  /** Index of the next '\n' at or after `p` (or buffer length). */
  private eol(p: number): number {
    const b = this.b, n = b.length;
    while (p < n && b[p] !== NL) p++;
    return p;
  }

  /** Content end (excluding a trailing CR) for a line ending at `e`. */
  private trimCR(start: number, e: number): number {
    return e > start && this.b[e - 1] === CR ? e - 1 : e;
  }

  /** Tokenize one line starting at `p`; returns the index of its '\n' (or length). */
  private line(p: number): number {
    const b = this.b, n = b.length;
    while (p < n && (b[p] === SP || b[p] === TAB)) p++;
    if (p >= n) return n;
    let c = b[p];
    if (c === NL) return p;
    if (c === SEMI) {
      const e = this.eol(p + 1);
      this.comment(p + 1, this.trimCR(p + 1, e));
      return e;
    }
    // Optional line number "N123 "
    if ((c | 0x20) === 110 /* n */ && p + 1 < n && b[p + 1] >= 48 && b[p + 1] <= 57) {
      p++;
      while (p < n && b[p] >= 48 && b[p] <= 57) p++;
      while (p < n && (b[p] === SP || b[p] === TAB)) p++;
      if (p >= n) return n;
      c = b[p];
      if (c === NL) return p;
    }
    const up = c & 0xdf;
    const next = p + 1 < n ? b[p + 1] : 0;
    if (!(next >= 48 && next <= 57) || (up !== 71 && up !== 77 && up !== 84)) {
      const e = this.eol(p);
      if (up >= 65 && up <= 90 && !(next >= 48 && next <= 57)) this.extended(p, this.trimCR(p, e));
      return e;
    }
    let q = p + 1;
    let code = 0;
    while (q < n) { const d = b[q] - 48; if (d < 0 || d > 9) break; code = code * 10 + d; q++; }
    if (q < n && b[q] === DOT) { q++; while (q < n && b[q] >= 48 && b[q] <= 57) q++; }
    // params
    const pv = this.pv;
    let mask = 0;
    while (q < n) {
      const ch = b[q];
      if (ch === NL) break;
      if (ch === SEMI) { q = this.eol(q); break; }
      const L = (ch & 0xdf) - 65;
      if (L >= 0 && L < 26) {
        const v = parseNumber(b, q + 1, n);
        q = numEnd > q + 1 ? numEnd : q + 1;
        if (v === v) { pv[L] = v; mask |= 1 << L; }
        else if (L === PX || L === PY || L === PZ || L === PE) { /* bare axis (e.g. G28 X) */ pv[L] = NaN; mask |= 1 << L; }
      } else {
        q++;
      }
    }
    if (up === 84) { this.toolChange(code); return q; }
    this.mask = mask;
    if (up === 71) this.gcode(code);
    else this.mcode(code);
    return q;
  }

  private has(p: number): boolean { return (this.mask & BIT(p)) !== 0; }
  private num(p: number): number { return this.pv[p]; }
  private hasNum(p: number): boolean { return (this.mask & BIT(p)) !== 0 && this.pv[p] === this.pv[p]; }

  private gcode(code: number): void {
    switch (code) {
      case 0: case 1: this.linear(); break;
      case 2: case 3: this.arc(code === 2); break;
      case 4: {
        let t = 0;
        if (this.hasNum(PP)) t = this.num(PP) / 1000;
        else if (this.hasNum(PS)) t = this.num(PS);
        if (t > 0) { this.pExtra += t; this.flushPending(0); }
        break;
      }
      case 10: if (!this.has(PP) && !this.has(PL)) this.fwRetract(true); break;
      case 11: this.fwRetract(false); break;
      case 20: this.unit = 25.4; break;
      case 21: this.unit = 1; break;
      case 28: {
        const any = this.has(PX) || this.has(PY) || this.has(PZ);
        if (!any || this.has(PX)) this.x = 0;
        if (!any || this.has(PY)) this.y = 0;
        if (!any || this.has(PZ)) this.z = 0;
        this.flushPending(0);
        this.syncPoint();
        break;
      }
      case 90: this.absXYZ = true; break;
      case 91: this.absXYZ = false; break;
      case 92: {
        if (this.mask === 0) { this.e = 0; break; }
        if (this.hasNum(PX)) this.x = this.num(PX) * this.unit;
        if (this.hasNum(PY)) this.y = this.num(PY) * this.unit;
        if (this.hasNum(PZ)) this.z = this.num(PZ) * this.unit;
        if (this.hasNum(PE)) this.e = this.num(PE) * this.unit;
        if (this.has(PX) || this.has(PY) || this.has(PZ)) this.syncPoint();
        break;
      }
    }
  }

  /**
   * Coordinates were reset without motion (G28/G92): the polyline must stay
   * continuous, so emit an invisible zero-time "jump" travel segment only if
   * the point actually changed.
   */
  private syncPoint(): void {
    const pts = this.points, i = this.n * 3;
    if (pts[i] === this.x && pts[i + 1] === this.y && pts[i + 2] === this.z) return;
    this.pushSeg(Feature.Travel, 0, 0, 0, 0);
    this.time[this.n - 1] = 0;
    this.lastWasExtrusion = false;
  }

  private mcode(code: number): void {
    switch (code) {
      case 82: this.relE = false; break;
      case 83: this.relE = true; break;
      case 104: case 109: {
        const v = this.hasNum(PS) ? this.num(PS) : this.hasNum(PR) ? this.num(PR) : NaN;
        if (v === v) {
          const t = this.hasNum(PT) ? this.num(PT) | 0 : this.curTool;
          if (t >= 0 && t < 64) this.temps[t] = v;
        }
        break;
      }
      case 106: {
        if (this.hasNum(PP) && this.num(PP) !== 0) break;
        this.curFan = this.hasNum(PS) ? Math.max(0, Math.min(255, this.num(PS))) : 255;
        break;
      }
      case 107: if (!this.hasNum(PP) || this.num(PP) === 0) this.curFan = 0; break;
      case 201: {
        const x = this.hasNum(PX) ? this.num(PX) : Infinity, y = this.hasNum(PY) ? this.num(PY) : Infinity;
        if (this.has(PX) || this.has(PY)) this.maxAccelXY = Math.min(x, y);
        if (this.hasNum(PZ)) this.maxAccelZ = this.num(PZ);
        if (this.hasNum(PE)) this.maxAccelE = this.num(PE);
        break;
      }
      case 203: {
        if (this.hasNum(PX)) this.maxVX = this.num(PX);
        if (this.hasNum(PY)) this.maxVY = this.num(PY);
        if (this.hasNum(PZ)) this.maxVZ = this.num(PZ);
        if (this.hasNum(PE)) this.maxVE = this.num(PE);
        break;
      }
      case 204: {
        if (this.hasNum(PS)) { this.accelPrint = this.num(PS); this.accelTravel = this.num(PS); }
        if (this.hasNum(PP)) this.accelPrint = this.num(PP);
        if (this.hasNum(PT)) this.accelTravel = this.num(PT);
        if (this.hasNum(PR)) this.accelRetract = this.num(PR);
        break;
      }
      case 205: {
        if (this.hasNum(LETTER('J'))) this.junctionDev = this.num(LETTER('J'));
        else if (this.hasNum(PX)) {
          const jerk = this.num(PX);
          this.junctionDev = Math.max(0.001, (0.4 * jerk * jerk) / Math.max(this.accelPrint, 1));
        }
        break;
      }
    }
  }

  private extended(p: number, end: number): void {
    const b = this.b;
    // Only a few Klipper commands matter; check the first letters cheaply.
    if (b[p] !== 83 /* S */ || end - p > 256) return;
    const s = ascii(b, p, end);
    if (!s.startsWith('SET_VELOCITY_LIMIT')) return;
    const get = (k: string) => {
      const m = s.match(new RegExp(`${k}=([\\d.]+)`, 'i'));
      return m ? Number(m[1]) : NaN;
    };
    const a = get('ACCEL');
    if (a > 0) { this.accelPrint = a; this.accelTravel = a; }
    const v = get('VELOCITY');
    if (v > 0) { this.maxVX = v; this.maxVY = v; }
    const scv = get('SQUARE_CORNER_VELOCITY');
    if (scv >= 0) this.junctionDev = Math.max(0.001, (scv * scv * (Math.SQRT2 - 1)) / Math.max(this.accelPrint, 1));
  }

  private toolChange(t: number): void {
    if (t < 0 || t > 255) return;
    this.curTool = t;
  }

  // ---- motion ----------------------------------------------------------

  private target(p: number, cur: number): number {
    if (!this.hasNum(p)) return cur;
    const v = this.num(p) * this.unit;
    return this.absXYZ ? v : cur + v;
  }

  private readE(): number {
    if (!this.hasNum(PE)) return 0;
    const v = this.num(PE) * this.unit;
    if (this.relE || !this.absXYZ) { this.e += v; return v; }
    const d = v - this.e;
    this.e = v;
    return d;
  }

  private readF(): void {
    if (this.hasNum(PF)) {
      const f = (this.num(PF) * this.unit) / 60;
      if (f > 0) this.feed = f;
    }
  }

  private linear(): void {
    this.readF();
    const nx = this.target(PX, this.x), ny = this.target(PY, this.y), nz = this.target(PZ, this.z);
    const dE = this.readE();
    this.motion(nx, ny, nz, dE);
  }

  private arc(cw: boolean): void {
    this.readF();
    const x0 = this.x, y0 = this.y, z0 = this.z;
    const x1 = this.target(PX, x0), y1 = this.target(PY, y0), z1 = this.target(PZ, z0);
    const dE = this.readE();
    let cx: number, cy: number;
    if (this.hasNum(PI_) || this.hasNum(PJ)) {
      cx = x0 + (this.hasNum(PI_) ? this.num(PI_) * this.unit : 0);
      cy = y0 + (this.hasNum(PJ) ? this.num(PJ) * this.unit : 0);
    } else if (this.hasNum(PR)) {
      // R form: centre on the perpendicular bisector.
      let r = this.num(PR) * this.unit;
      const dx = x1 - x0, dy = y1 - y0;
      const d = Math.hypot(dx, dy);
      if (d < LEN_EPS || Math.abs(r) < d / 2 - 1e-6) { this.motion(x1, y1, z1, dE); return; }
      const h = Math.sqrt(Math.max(r * r - (d * d) / 4, 0));
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      // Negative R = the long way round.
      let sgn = cw ? 1 : -1;
      if (r < 0) { sgn = -sgn; r = -r; }
      cx = mx + (sgn * h * dy) / d;
      cy = my - (sgn * h * dx) / d;
    } else {
      this.motion(x1, y1, z1, dE);
      return;
    }
    const r = Math.hypot(x0 - cx, y0 - cy);
    if (!(r > LEN_EPS)) { this.motion(x1, y1, z1, dE); return; }
    const a0 = Math.atan2(y0 - cy, x0 - cx);
    const a1 = Math.atan2(y1 - cy, x1 - cx);
    let sweep = a1 - a0;
    if (cw) { if (sweep >= -1e-9) sweep -= Math.PI * 2; }
    else if (sweep <= 1e-9) sweep += Math.PI * 2;
    // Full circle when start == end
    const tol = Math.min(this.opts.arcTolerance, r * 0.5);
    const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
    let steps = Math.ceil(Math.abs(sweep) / Math.max(maxStep, 1e-3));
    if (steps < 1) steps = 1;
    if (steps > 2048) steps = 2048;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const ang = a0 + sweep * t;
      const px = s === steps ? x1 : cx + r * Math.cos(ang);
      const py = s === steps ? y1 : cy + r * Math.sin(ang);
      const pz = z0 + (z1 - z0) * t;
      this.motion(px, py, pz, dE / steps);
    }
  }

  private fwRetract(retract: boolean): void {
    this.readF();
    // Typical firmware retract: ~0.8 mm at 35 mm/s. Only the event matters.
    this.eOnly(retract ? -0.8 : 0.8, 35);
  }

  private eOnly(dE: number, v: number): void {
    const kind = dE < 0 ? Feature.Retract : Feature.Unretract;
    const idx = this.pushSeg(kind, 0, 0, v, 0);
    this.addMarker(dE < 0 ? MarkerKind.Retract : MarkerKind.Unretract, idx, this.x, this.y, this.z);
    const len = Math.abs(dE);
    const vv = Math.min(v, this.maxVE);
    this.plan(idx, len, vv, Math.min(this.accelRetract, this.maxAccelE), 0, 0, 0, true);
    this.addFilament(dE);
    this.lastWasExtrusion = false;
  }

  private addFilament(dE: number): void {
    const t = this.curTool;
    while (this.filPerTool.length <= t) this.filPerTool.push(0);
    this.filPerTool[t] += dE;
  }

  private motion(nx: number, ny: number, nz: number, dE: number): void {
    const dx = nx - this.x, dy = ny - this.y, dz = nz - this.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < LEN_EPS) {
      this.x = nx; this.y = ny; this.z = nz;
      if (dE > E_EPS || dE < -E_EPS) this.eOnly(dE, this.feed);
      return;
    }
    if (dz !== 0) this.lastZChangeSeg = this.n;
    const oldX = this.x, oldY = this.y, oldZ = this.z;
    this.x = nx; this.y = ny; this.z = nz;
    const lenXY = Math.sqrt(dx * dx + dy * dy);
    const inv = 1 / len;
    // Speed cap by per-axis limits.
    let v = this.feed;
    if (dx !== 0 && this.maxVX !== Infinity) { const c = (this.maxVX * len) / Math.abs(dx); if (c < v) v = c; }
    if (dy !== 0 && this.maxVY !== Infinity) { const c = (this.maxVY * len) / Math.abs(dy); if (c < v) v = c; }
    if (dz !== 0 && this.maxVZ !== Infinity) { const c = (this.maxVZ * len) / Math.abs(dz); if (c < v) v = c; }

    if (dE > E_EPS) {
      let feat = this.curFeature;
      if (!isExtrusionFeature(feat)) feat = Feature.Other;
      if (lenXY < LEN_EPS) {
        // Pure-Z extrusion: rare; draw it but keep it thin.
      }
      const h = this.currentHeight(nz);
      let w: number;
      if (this.widthKnown) w = this.curWidth;
      else {
        const area = (dE * this.filArea) / len;
        w = area / Math.max(h, 0.01) + h * (1 - Math.PI / 4);
        if (!(w > 0.05)) w = 0.05; else if (w > 5) w = 5;
      }
      const flow = (dE * this.filArea * v) / len;
      if (feat === Feature.OuterWall && !this.lastWasExtrusion) {
        this.addMarker(MarkerKind.Seam, this.n, oldX, oldY, oldZ);
      }
      const idx = this.pushSeg(feat, w, h, v, flow);
      this.fallbackLayer(nz, idx);
      let a = Math.min(this.accelPrint, this.maxAccelXY);
      if (lenXY < LEN_EPS) a = Math.min(this.accelPrint, this.maxAccelZ);
      this.plan(idx, len, v, a, dx * inv, dy * inv, dz * inv, false);
      this.addFilament(dE);
      this.extrusionCount++;
      if (nx < this.min[0]) this.min[0] = nx; if (nx > this.max[0]) this.max[0] = nx;
      if (ny < this.min[1]) this.min[1] = ny; if (ny > this.max[1]) this.max[1] = ny;
      if (nz < this.min[2]) this.min[2] = nz; if (nz > this.max[2]) this.max[2] = nz;
      if (oldX < this.min[0]) this.min[0] = oldX; if (oldX > this.max[0]) this.max[0] = oldX;
      if (oldY < this.min[1]) this.min[1] = oldY; if (oldY > this.max[1]) this.max[1] = oldY;
      this.lastWasExtrusion = true;
    } else {
      const feat = this.inWipe || dE < -E_EPS ? Feature.Wipe : Feature.Travel;
      const idx = this.pushSeg(feat, 0, 0, v, 0);
      let a = Math.min(this.accelTravel, this.maxAccelXY);
      if (lenXY < LEN_EPS) a = Math.min(a, this.maxAccelZ);
      this.plan(idx, len, v, a, dx * inv, dy * inv, dz * inv, false);
      if (dE !== 0) this.addFilament(dE);
      this.travelCount++;
      this.lastWasExtrusion = false;
    }
  }

  private currentHeight(z: number): number {
    if (this.curHeight > 0) return this.curHeight;
    // Fallback: distance to the previous extrusion layer.
    if (this.fbStart.length > 0 && Math.abs(z - this.fbCurZ) < LAYER_Z_EPS) {
      const h = this.fbCurZ - this.fbPrevZ;
      return h > 0.01 ? h : 0.2;
    }
    const h = z - (this.fbStart.length > 0 ? this.fbCurZ : 0);
    return h > 0.01 && h < 2 ? h : 0.2;
  }

  private fallbackLayer(z: number, idx: number): void {
    if (this.fbStart.length === 0 || z > this.fbCurZ + LAYER_Z_EPS || z < this.fbCurZ - LAYER_Z_EPS) {
      const prevStart = this.fbStart.length ? this.fbStart[this.fbStart.length - 1] : -1;
      const start = this.lastZChangeSeg > prevStart && this.lastZChangeSeg <= idx ? this.lastZChangeSeg : idx;
      this.fbPrevZ = this.fbStart.length ? this.fbCurZ : 0;
      this.fbStart.push(start);
      this.fbZ.push(z);
      this.fbCurZ = z;
    }
  }

  /** Append a segment ending at the current position. Returns its index. */
  private pushSeg(feat: number, w: number, h: number, v: number, flow: number): number {
    if (this.n + 1 >= this.cap) this.grow(Math.ceil(this.cap * 1.5) + 1024);
    const i = this.n++;
    const pi = (i + 1) * 3;
    const pts = this.points;
    pts[pi] = this.x; pts[pi + 1] = this.y; pts[pi + 2] = this.z;
    const wi = w * 1000 + 0.5, hi = h * 1000 + 0.5;
    this.wh[i * 2] = wi > 65535 ? 65535 : wi;
    this.wh[i * 2 + 1] = hi > 65535 ? 65535 : hi;
    this.feature[i] = feat;
    this.tool[i] = this.curTool > 255 ? 255 : this.curTool;
    this.fan[i] = this.curFan;
    const tc = this.temps[this.curTool < 64 ? this.curTool : 0] * 10;
    this.temp[i] = tc < 0 ? 0 : tc > 65535 ? 65535 : tc;
    this.speed[i] = v;
    this.flow[i] = flow;
    this.time[i] = 0;
    this.lineNo[i] = this.lineIdx;
    this.byteOffset[i] = this.lineStart;
    this.featureCount[feat]++;
    return i;
  }

  // ---- planner -----------------------------------------------------------

  private plan(idx: number, len: number, v: number, a: number, ux: number, uy: number, uz: number, eOnly: boolean): void {
    if (!(a > 0) || a === Infinity) a = this.opts.acceleration;
    let vj = 0;
    if (this.pIdx >= 0 && !eOnly && !this.pEOnly) {
      const cos = -(this.pdx * ux + this.pdy * uy + this.pdz * uz);
      if (cos < -0.999999) vj = Math.min(v, this.pV);
      else if (cos > 0.999999) vj = 0;
      else {
        const sinHalf = Math.sqrt(0.5 * (1 - cos));
        vj = Math.sqrt((a * this.junctionDev * sinHalf) / (1 - sinHalf));
        vj = Math.min(vj, v, this.pV);
      }
    }
    const entry = this.flushPending(vj);
    this.pIdx = idx; this.pLen = len; this.pV = v; this.pA = a; this.pEntry = Math.min(entry, v);
    this.pdx = ux; this.pdy = uy; this.pdz = uz; this.pEOnly = eOnly;
  }

  /** Finalize the pending move with the given exit speed; returns the actual exit speed. */
  private flushPending(vExit: number): number {
    if (this.pIdx < 0) { this.pExtra = 0; return 0; }
    const reach = Math.sqrt(this.pEntry * this.pEntry + 2 * this.pA * this.pLen);
    const exit = Math.min(vExit, reach, this.pV);
    const t = trapezoidTime(this.pLen, this.pV, this.pA, this.pEntry, exit) + this.pExtra;
    this.time[this.pIdx] = t;
    this.totalTime += t;
    this.featureTime[this.feature[this.pIdx]] += t;
    this.pIdx = -1;
    this.pExtra = 0;
    return exit;
  }

  // ---- comments ------------------------------------------------------------

  private comment(p: number, end: number): void {
    const b = this.b;
    if (end - p > 400) return;
    // Fast paths for the per-move comments that matter.
    const c0 = b[p];
    if (c0 === 87 /* W */) {
      // WIDTH:0.45  WIPE_START  WIPE_END
      if (b[p + 1] === 73 && b[p + 2] === 68) {
        const v = parseNumber(b, p + 6, end);
        if (v > 0) { this.curWidth = v; this.widthKnown = true; }
        return;
      }
      if (b[p + 1] === 73 && b[p + 2] === 80) {
        if (b[p + 5] === 83) this.inWipe = true; else if (b[p + 5] === 69) this.inWipe = false;
        return;
      }
    }
    if (c0 === 72 /* H */ && b[p + 1] === 69 && b[p + 6] === 58 /* HEIGHT: */) {
      const v = parseNumber(b, p + 7, end);
      if (v > 0) { this.curHeight = v; this.setMarkerHeight(v); }
      return;
    }
    if (c0 === 90 /* Z */ && b[p + 1] === 58) {
      const v = parseNumber(b, p + 2, end);
      if (v === v) this.setMarkerZ(v);
      return;
    }
    const s = ascii(b, p, end).trim();
    if (s.startsWith('TYPE:')) { this.setFeature(s.slice(5)); return; }
    if (s === 'LAYER_CHANGE' || s === 'CHANGE_LAYER' || s.startsWith('LAYER:')) { this.newMarkerLayer(); return; }
    if (s.startsWith('FEATURE:')) { this.setFeature(s.slice(8)); return; }
    if (s.startsWith('Z_HEIGHT:')) { const v = Number(s.slice(9)); if (Number.isFinite(v)) this.setMarkerZ(v); return; }
    if (s.startsWith('LAYER_HEIGHT:')) {
      const v = Number(s.slice(13));
      if (v > 0) { this.curHeight = v; this.setMarkerHeight(v); }
      return;
    }
    if (s.startsWith('LINE_WIDTH:')) { const v = Number(s.slice(11)); if (v > 0) { this.curWidth = v; this.widthKnown = true; } return; }
    if (s.startsWith('WIDTH:')) { const v = Number(s.slice(6)); if (v > 0) { this.curWidth = v; this.widthKnown = true; } return; }
    if (s.startsWith('HEIGHT:')) { const v = Number(s.slice(7)); if (v > 0) { this.curHeight = v; this.setMarkerHeight(v); } return; }
    if (s.startsWith('COLOR_CHANGE')) { this.colorChangeTag(s); return; }
    if (s === 'WIPE_START') { this.inWipe = true; return; }
    if (s === 'WIPE_END') { this.inWipe = false; return; }
    this.headerComment(s);
  }

  private colorChangeTag(s: string): void {
    const tok = s.split(',').map((t) => t.trim());
    const t = tok[1]?.startsWith('T') ? parseInt(tok[1].slice(1), 10) : this.curTool;
    const m = tok[2]?.match(/^#([0-9a-f]{6})$/i);
    if (this.colorChanges.length < 250) this.colorChanges.push({ seg: this.n, extruder: Number.isFinite(t) && t >= 0 && t < 256 ? t : this.curTool, color: m ? parseInt(m[1], 16) : null });
  }

  private setFeature(raw: string): void {
    this.curFeature = classifyFeature(raw);
  }

  private newMarkerLayer(): void {
    this.mkStart.push(this.n);
    this.mkZ.push(NaN);
    this.mkH.push(NaN);
  }
  private setMarkerZ(z: number): void {
    const k = this.mkZ.length - 1;
    if (k >= 0 && this.mkZ[k] !== this.mkZ[k]) this.mkZ[k] = z;
  }
  private setMarkerHeight(h: number): void {
    const k = this.mkH.length - 1;
    if (k >= 0 && this.mkH[k] !== this.mkH[k]) this.mkH[k] = h;
  }

  private headerComment(s: string): void {
    const H = this.header;
    const kv = s.match(/^([^=:]+?)\s*[=:]\s*(.*)$/);
    if (!kv) return;
    const key = kv[1].toLowerCase(), val = kv[2];
    if (key.startsWith('generated by')) { H.generator = s.slice(12).trim(); return; }
    if (key.startsWith('estimated printing time (normal mode)') || key === 'estimated printing time') {
      const t = parseDuration(val); if (t === t) H.printTimeSec = t; return;
    }
    if (key === 'model printing time') {
      const m = s.match(/total estimated time:\s*([^;]+)/i);
      if (m) { const t = parseDuration(m[1]); if (t === t) H.printTimeSec = t; }
      return;
    }
    if (key === 'total estimated time') { const t = parseDuration(val); if (t === t) H.printTimeSec = t; return; }
    if (key === 'total layers count' || key === 'total layer number' || key === 'total_layer_count') {
      const v = Number(val); if (Number.isFinite(v)) H.layerCount = v; return;
    }
    if (key === 'max_z_height') { const v = Number(val); if (Number.isFinite(v)) H.maxZ = v; return; }
    if (key === 'filament used [mm]') { H.filamentMm = numList(val); return; }
    if (key === 'filament used [g]') { H.filamentG = numList(val); return; }
    if (key === 'filament used [cm3]') { H.filamentCm3 = numList(val); return; }
    if (key === 'filament cost') { H.filamentCost = numList(val); return; }
    if (key === 'filament_diameter') {
      const v = numList(val)[0];
      if (v > 0 && !this.filDiamFromFile) {
        this.filDiamFromFile = true;
        H.filamentDiameter = v;
        this.filArea = Math.PI * (v / 2) * (v / 2);
      }
    }
  }

  // ---- finish ------------------------------------------------------------

  result(parseMs: number): ParsedGcode {
    const n = this.n;
    const trim = <T extends Float32Array | Uint16Array | Uint8Array | Uint32Array>(a: T, len: number): T =>
      (a.length === len ? a : a.slice(0, len)) as T;

    // Layers: prefer slicer layer comments; else Z-based fallback.
    let starts: number[], zs: number[], hs: number[];
    if (this.mkStart.length > 0) {
      starts = this.mkStart.slice(); zs = this.mkZ.slice(); hs = this.mkH.slice();
      starts[0] = 0;
    } else if (this.fbStart.length > 0) {
      starts = this.fbStart.slice(); zs = this.fbZ.slice(); hs = zs.map(() => NaN);
      starts[0] = 0;
    } else {
      starts = [0]; zs = [0]; hs = [NaN];
    }
    // Drop empty trailing layers created after the last move? Keep them but
    // make sure starts are monotonic and within range.
    for (let k = 1; k < starts.length; k++) if (starts[k] < starts[k - 1]) starts[k] = starts[k - 1];
    const L = starts.length;
    const layerStart = new Uint32Array(L + 1);
    for (let k = 0; k < L; k++) layerStart[k] = Math.min(starts[k], n);
    layerStart[L] = n;
    const layerZ = new Float32Array(L), layerHeight = new Float32Array(L), layerTime = new Float32Array(L);
    const pts = this.points;
    let prevZ = 0;
    for (let k = 0; k < L; k++) {
      let z = zs[k];
      const s0 = layerStart[k], s1 = layerStart[k + 1];
      let t = 0, zMax = -Infinity;
      for (let s = s0; s < s1; s++) {
        t += this.time[s];
        if (this.feature[s] < Feature.Travel) { const pz = pts[(s + 1) * 3 + 2]; if (pz > zMax) zMax = pz; }
      }
      if (!(z === z)) z = zMax > -Infinity ? zMax : prevZ;
      layerTime[k] = t;
      layerZ[k] = z;
      let h = hs[k];
      if (!(h > 0)) h = z - prevZ;
      layerHeight[k] = h > 0 ? h : 0;
      prevZ = z;
    }

    const toolsUsed: number[] = [];
    for (let t = 0; t < this.filPerTool.length; t++) if (this.filPerTool[t] > 1e-6) toolsUsed.push(t);

    return {
      segmentCount: n,
      points: trim(this.points, (n + 1) * 3),
      wh: trim(this.wh, n * 2),
      feature: trim(this.feature, n),
      tool: trim(this.tool, n),
      fan: trim(this.fan, n),
      temp: trim(this.temp, n),
      speed: trim(this.speed, n),
      flow: trim(this.flow, n),
      time: trim(this.time, n),
      lineNo: trim(this.lineNo, n),
      byteOffset: trim(this.byteOffset, n),
      layerCount: L,
      layerStart, layerZ, layerHeight, layerTime,
      markerCount: this.mN,
      markerSeg: this.markerSeg.slice(0, this.mN),
      markerKind: this.markerKind.slice(0, this.mN),
      markerPos: this.markerPos.slice(0, this.mN * 3),
      header: this.header,
      ...(this.colorChanges.length ? { colorChanges: this.colorChanges } : {}),
      stats: {
        estimatedTimeSec: this.totalTime,
        featureTime: this.featureTime,
        featureCount: this.featureCount,
        filamentMmPerTool: this.filPerTool.map((v) => Math.max(0, v)),
        toolsUsed,
        min: this.min,
        max: this.max,
        extrusionCount: this.extrusionCount,
        travelCount: this.travelCount,
        lineCount: this.lineIdx,
        parseMs,
      },
    };
  }
}

/** Parse G-code bytes synchronously (call from a worker for large files). */
export function parseGcode(
  bytes: Uint8Array,
  options: ParseOptions = {},
  onProgress?: (done: number, total: number) => void,
): ParsedGcode {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const p = new GcodeParser(bytes, options);
  p.run(onProgress);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return p.result(t1 - t0);
}

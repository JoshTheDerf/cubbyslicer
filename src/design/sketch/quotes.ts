/**
 * Orca's live measurement labels (DesignSketchTool `render_live_quotes`): the characteristic,
 * non-driving dimensions of the entity being dragged or of a lone selection, drawn in their own
 * colour; a click on one makes it a real dimension (Length / Radius: a driving constraint, then
 * its value editor) or edits the geometry directly (a line's angle, an arc's sweep, an ellipse's
 * axes — `open_angle_editor`, `open_arc_angle_editor`, `open_ellipse_axis_editor`).
 *
 * What each entity shows (the ungrouped cases of `render_live_quotes`):
 * - line: Length (dimension line beside it) and Angle to +X, 0–360° (a wedge at its start);
 * - circle: Radius (a leader from the centre towards +X);
 * - arc: Radius and its sweep angle (a wedge just outside the arc);
 * - ellipse: semi-major and semi-minor axes; an elliptical arc also its sweep.
 * A quote already driven by a dimension of the same kind on the entity is not shown (Orca skips
 * it: the dimension is drawn instead). Labels follow Orca's `dim_text`: two decimals, trailing
 * zeros dropped, "R" before a radius, " mm" after a length, "°" after an angle.
 *
 * Orca's grouped-shape quotes (rectangle Width / Height, slot, polygon, rounded rectangle, arc
 * slot) need its shape grouping, which this sketcher doesn't keep: a member line of such a shape
 * shows its own Length / Angle.
 */
import { add, onCircle, scale, sub, type SkConstraint, type SkEntity, type V2 } from './model';

export type QuoteKind = 'length' | 'angle' | 'radius' | 'sweep' | 'major' | 'minor';

export interface LiveQuote {
  kind: QuoteKind;
  /** The entity it measures. */
  e: number;
  value: number;
  text: string;
  /** Leader / dimension lines (plane mm). */
  lines: V2[][];
  /** Label anchor (plane mm). */
  label: V2;
}

/** Edit-op and transform tools draw their own value gizmo (Orca: no quotes then). */
const NO_QUOTES = new Set(['trim', 'extend', 'fillet', 'chamfer', 'offset', 'mirror', 'move', 'rotate', 'scale', 'array', 'polar', 'use-edges']);

/** Orca's `dim_text`. */
export function quoteText(kind: QuoteKind, value: number): string {
  let num = value.toFixed(2);
  if (num.includes('.')) num = num.replace(/0+$/, '').replace(/\.$/, '');
  if (num === '-0') num = '0';
  if (kind === 'angle' || kind === 'sweep') return `${num}°`;
  return `${kind === 'radius' ? 'R' : ''}${num} mm`;
}

/** The entity the quotes are for: the one being dragged (the driver selects it) or a lone selection. */
export function quotedEntity(sel: readonly { e: number }[], tool: string): number {
  if (NO_QUOTES.has(tool) || !sel.length) return -1;
  const e = sel[0].e;
  return sel.every((s) => s.e === e) ? e : -1;
}

const deg = (r: number) => (r * 180) / Math.PI;
const norm360 = (d: number) => (d < 0 ? d + 360 : d);

function arcPoints(c: V2, r: number, a0: number, sweep: number, n: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i <= n; i++) out.push(onCircle(c, r, a0 + (sweep * i) / n));
  return out;
}

/**
 * The live quotes of entity `ei`. `th` is Orca's label height (15 px) in plane mm; it sets the
 * label offsets and wedge radii as Orca's do.
 */
export function liveQuotes(entities: readonly SkEntity[], constraints: readonly SkConstraint[], ei: number, th: number): LiveQuote[] {
  const e = entities[ei];
  if (!e) return [];
  const out: LiveQuote[] = [];
  const driven = (kind: 'length' | 'radius') => constraints.some((c) => (kind === 'length'
    ? c.type === 'distance' && c.ea === ei && c.eb === ei && c.ra !== c.rb
    : c.type === 'radius' && c.ea === ei));
  const q = (kind: QuoteKind, value: number, lines: V2[][], label: V2) => out.push({ kind, e: ei, value, text: quoteText(kind, value), lines, label });

  if (e.type === 'line') {
    const d = sub(e.p1, e.p0), L = Math.hypot(d[0], d[1]);
    if (L < 1e-6) return out;
    const u: V2 = [d[0] / L, d[1] / L], n: V2 = [-u[1], u[0]];
    if (!driven('length')) {
      // draw_dim_quote (Length, side +1): offset max(L·0.18, 8 mm), label beside its middle.
      const off = Math.max(L * 0.18, 8);
      const A2 = add(e.p0, scale(n, off)), B2 = add(e.p1, scale(n, off));
      const as = Math.max(L * 0.04, 2);
      const arrow = (tip: V2, dir: V2): V2[] => { const back = add(tip, scale(dir, as)); return [add(back, scale(n, as * 0.5)), tip, sub(back, scale(n, as * 0.5))]; };
      q('length', L, [[A2, B2], arrow(A2, u), arrow(B2, scale(u, -1))], add(scale(add(A2, B2), 0.5), scale(n, th * 0.7 + 1.5)));
    }
    // Angle to +X (measure_dim: atan2, 0–360), a wedge about the start: arc radius max(min(L·0.35, 40), th·1.6).
    const ang = Math.atan2(d[1], d[0]);
    const rr = Math.max(Math.min(L * 0.35, 40), th * 1.6);
    q('angle', norm360(deg(ang)), [[e.p0, add(e.p0, [rr * 1.15, 0])], arcPoints(e.p0, rr, 0, ang, 20)], onCircle(e.p0, rr + th * 1.1, ang / 2));
    return out;
  }
  if ((e.type === 'circle' || e.type === 'arc') && e.radius > 1e-6 && !driven('radius')) {
    // Radius: a leader from the centre along +X, the label over its middle.
    const rim = add(e.center, [e.radius, 0]);
    q('radius', e.radius, [[e.center, rim]], add(scale(add(e.center, rim), 0.5), [0, th * 0.8]));
  }
  if (e.type === 'arc' && e.radius > 1e-6) {
    // The sweep: a wedge from start to end just outside the arc, the label past its middle.
    const sweep = e.end_angle - e.start_angle, rr = e.radius + th * 2.5;
    q('sweep', Math.abs(deg(sweep)), [[e.center, onCircle(e.center, rr, e.start_angle)], [e.center, onCircle(e.center, rr, e.end_angle)], arcPoints(e.center, rr, e.start_angle, sweep, 24)],
      onCircle(e.center, rr + th * 1.2, e.start_angle + sweep / 2));
  }
  if ((e.type === 'ellipse' || e.type === 'ellipse_arc') && e.radius > 1e-6 && e.rminor > 1e-6) {
    const um: V2 = [Math.cos(e.rotation), Math.sin(e.rotation)], un: V2 = [-um[1], um[0]];
    q('major', e.radius, [[e.center, add(e.center, scale(um, e.radius))]], add(add(e.center, scale(um, e.radius * 0.5)), scale(un, th)));
    q('minor', e.rminor, [[e.center, add(e.center, scale(un, e.rminor))]], add(add(e.center, scale(un, e.rminor * 0.5)), scale(um, th)));
    if (e.type === 'ellipse_arc') {
      const mid = (e.start_angle + e.end_angle) / 2;
      const mp = add(e.center, add(scale(um, e.radius * Math.cos(mid)), scale(un, e.rminor * Math.sin(mid))));
      const o = sub(mp, e.center), ol = Math.hypot(o[0], o[1]) || 1;
      q('sweep', Math.abs(deg(e.end_angle - e.start_angle)), [], add(mp, scale(o, (th * 1.5) / ol)));
    }
  }
  return out;
}

/** The geometry a typed value gives (Orca's `set_line_angle`, `set_arc_sweep`, `set_ellipse_axis`, `set_ellipsearc_sweep`), or a refusal. */
export function quoteEdit(e: SkEntity, kind: QuoteKind, v: number): SkEntity | string {
  if (kind === 'angle' && e.type === 'line') {
    const L = Math.hypot(e.p1[0] - e.p0[0], e.p1[1] - e.p0[1]);
    if (L < 1e-9) return 'The line has no length';
    const r = (v * Math.PI) / 180;
    return { ...e, p1: [e.p0[0] + Math.cos(r) * L, e.p0[1] + Math.sin(r) * L] };
  }
  if (kind === 'sweep' && (e.type === 'arc' || e.type === 'ellipse_arc')) {
    if (!(v > 0 && v < 360)) return 'The angle must be between 0° and 360°';
    const end = e.start_angle + (e.end_angle >= e.start_angle ? 1 : -1) * (v * Math.PI) / 180;
    return { ...e, end_angle: end, p1: pointAt(e, end) };
  }
  if ((kind === 'major' || kind === 'minor') && (e.type === 'ellipse' || e.type === 'ellipse_arc')) {
    if (!(v > 0)) return 'The value must be greater than zero';
    if (kind === 'major' ? v < e.rminor : v > e.radius) return 'The semi-major axis cannot be shorter than the semi-minor axis';
    const n = { ...e, ...(kind === 'major' ? { radius: v } : { rminor: v }) };
    return e.type === 'ellipse_arc' ? { ...n, p0: pointAt(n, n.start_angle), p1: pointAt(n, n.end_angle) } : n;
  }
  return 'That value is not edited this way';
}

function pointAt(e: SkEntity, t: number): V2 {
  if (e.type === 'arc') return onCircle(e.center, e.radius, t);
  const c = Math.cos(e.rotation), s = Math.sin(e.rotation), x = e.radius * Math.cos(t), y = e.rminor * Math.sin(t);
  return [e.center[0] + x * c - y * s, e.center[1] + x * s + y * c];
}

/** The value editor's title (Orca's inline editor labels). */
export const QUOTE_TITLE: Record<QuoteKind, string> = { length: 'Length', radius: 'Radius', angle: 'Angle (°)', sweep: 'Angle (°)', major: 'Semi-major axis', minor: 'Semi-minor axis' };

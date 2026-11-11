/**
 * Sketch constraints: the catalog (Orca's CONSTRAIN group of 20 buttons plus the kernel's other
 * five types), what a button does with the current selection, glyphs and names.
 *
 * Entity selections go through the kernel's own planner (`sketch_plan`, Orca's
 * `plan_entity_constraint`): apply, ask for a value, or reject with a reason. Orca's planner only
 * knows entities, so selections that include *vertices* (a line's end, an arc's centre, a Point)
 * are planned here with the same rules — coincident of two vertices, a vertex on a curve, a
 * midpoint, a fixed vertex, distances between vertices, symmetric vertices.
 *
 * `guard()` refuses nonsensical requests (a radius on a line, a tangent between two lines) with a
 * friendly message before they are sent; kernel v1.2 refuses the same ones itself (-32602; v1.1
 * trapped on some of them).
 */
import {
  cons, dist, entityName, isRound, rolePoint, sub, angleOf, REF_AXIS_X, REF_AXIS_Y, REF_ORIGIN,
  type Role, type SkConstraint, type SkConstraintType, type SkEntity, type V2,
} from './model';

/** One selected item: an entity, or one of its points (`role`). */
export interface SelItem { e: number; role?: Role }

export interface ConstraintDef {
  type: SkConstraintType;
  label: string;
  /** Short glyph drawn on the entity (badge). */
  glyph: string;
  icon: string;
  /** Orca's button tooltip. */
  hint: string;
  /** On the CONSTRAIN bar (Orca's 20); the others are reached from the Dimension tool / menus. */
  button: boolean;
}

export const CONSTRAINTS: ConstraintDef[] = [
  { type: 'horizontal', label: 'Horizontal', glyph: 'H', icon: 'i-lucide-move-horizontal', hint: 'Make a line horizontal, or two points level', button: true },
  { type: 'vertical', label: 'Vertical', glyph: 'V', icon: 'i-lucide-move-vertical', hint: 'Make a line vertical, or two points plumb', button: true },
  { type: 'parallel', label: 'Parallel', glyph: '∥', icon: 'i-lucide-equal', hint: 'Make two lines parallel', button: true },
  { type: 'perpendicular', label: 'Perpendicular', glyph: '⊥', icon: 'i-lucide-square-dashed-bottom', hint: 'Make two lines perpendicular', button: true },
  { type: 'coincident', label: 'Coincident', glyph: '●', icon: 'i-lucide-merge', hint: 'Join two points (the nearest ends of two entities)', button: true },
  { type: 'equal_length', label: 'Equal length', glyph: '=', icon: 'i-lucide-equal-approximately', hint: 'Give two lines the same length (two arcs / circles: the same radius)', button: true },
  { type: 'equal_radius', label: 'Equal radius', glyph: '=R', icon: 'i-lucide-circle-equal', hint: 'Give two arcs / circles the same radius', button: true },
  { type: 'collinear', label: 'Collinear', glyph: '⋯', icon: 'i-lucide-align-horizontal-distribute-center', hint: 'Put two lines on one line', button: true },
  { type: 'concentric', label: 'Concentric', glyph: '◎', icon: 'i-lucide-circle-dot', hint: 'Give two arcs / circles the same centre', button: true },
  { type: 'tangent', label: 'Tangent', glyph: 'T', icon: 'i-lucide-spline', hint: 'Make a line and an arc / circle (or two arcs) tangent', button: true },
  { type: 'midpoint', label: 'Midpoint', glyph: 'M', icon: 'i-lucide-git-commit-horizontal', hint: 'Put a point on the middle of a line', button: true },
  { type: 'symmetric', label: 'Symmetric', glyph: '⇹', icon: 'i-lucide-flip-horizontal-2', hint: 'Mirror two points (or two lines) about a line — select the line last', button: true },
  { type: 'symmetric_about_y', label: 'Symmetric about the vertical axis', glyph: '⇔', icon: 'i-lucide-flip-horizontal', hint: 'Mirror two points about the sketch’s Y axis', button: true },
  { type: 'symmetric_about_x', label: 'Symmetric about the horizontal axis', glyph: '⇕', icon: 'i-lucide-flip-vertical', hint: 'Mirror two points about the sketch’s X axis', button: true },
  { type: 'angle', label: 'Angle', glyph: '∠', icon: 'i-lucide-triangle-right', hint: 'Dimension the angle between two lines', button: true },
  { type: 'radius', label: 'Radius', glyph: 'R', icon: 'i-lucide-radius', hint: 'Dimension the radius of an arc / circle', button: true },
  { type: 'diameter', label: 'Diameter', glyph: 'Ø', icon: 'i-lucide-diameter', hint: 'Dimension the diameter of a circle / arc', button: true },
  { type: 'fix', label: 'Fix point', glyph: '⚓', icon: 'i-lucide-anchor', hint: 'Anchor a point where it is', button: true },
  { type: 'distance_x', label: 'Horizontal distance', glyph: '↔', icon: 'i-lucide-ruler', hint: 'Dimension the horizontal distance between two points', button: true },
  { type: 'distance_y', label: 'Vertical distance', glyph: '↕', icon: 'i-lucide-ruler', hint: 'Dimension the vertical distance between two points', button: true },
  // Kernel types without an Orca button (Orca makes them from the dimension tool and re-anchoring).
  { type: 'distance', label: 'Distance', glyph: '↗', icon: 'i-lucide-ruler-dimension-line', hint: 'Dimension a line’s length, or the distance between two points', button: false },
  { type: 'point_on_line', label: 'Distance to line', glyph: '⟂', icon: 'i-lucide-ruler', hint: 'Dimension a point’s distance from a line', button: false },
  { type: 'point_on_object', label: 'Point on curve', glyph: '∈', icon: 'i-lucide-locate', hint: 'Put a point on a line, arc or circle', button: false },
  { type: 'lock_x', label: 'Lock X', glyph: 'X', icon: 'i-lucide-lock', hint: 'Fix a point’s X coordinate', button: false },
  { type: 'lock_y', label: 'Lock Y', glyph: 'Y', icon: 'i-lucide-lock', hint: 'Fix a point’s Y coordinate', button: false },
];
export const CONSTRAINT_BY_TYPE = new Map(CONSTRAINTS.map((c) => [c.type, c]));
export const constraintLabel = (t: SkConstraintType) => CONSTRAINT_BY_TYPE.get(t)?.label ?? t;

/** What applying a constraint to the selection does (Orca's ConstraintPlan). */
export type Plan =
  | { kind: 'apply'; constraints: SkConstraint[] }
  | { kind: 'ask_value'; constraints: SkConstraint[]; prefill: number; unit: 'mm' | '°' }
  | { kind: 'reject'; reason: string };

/** Orca's reject reasons (SketchEngine.hpp ConstraintPlanReject) as sentences. */
export const REJECT_TEXT: Record<string, string> = {
  none: '', need_one_entity: 'Select one entity', need_two_entities: 'Select two entities', need_a_line: 'Select a line',
  need_two_lines: 'Select two lines', need_two_rounds: 'Select two arcs or circles', need_tangent_pair: 'Select a line and an arc / circle, or two arcs',
  need_joinable_points: 'Select two entities with ends to join', need_measurable_points: 'Select two points to measure between',
  need_point_and_line: 'Select a point and a line', need_two_points_or_lines: 'Select two points or two lines, then the mirror line',
  need_axis_line: 'Select the mirror line last', need_round: 'Select an arc or a circle', unsupported: 'That needs a different selection',
};
export function rejectText(reason: string): string {
  return REJECT_TEXT[reason] ?? (reason ? reason.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'That selection can’t take this constraint');
}

const DEG = 180 / Math.PI;
const isVertex = (s: SelItem, ents: readonly SkEntity[]) => s.role !== undefined || ents[s.e]?.type === 'point';
const vRole = (s: SelItem, ents: readonly SkEntity[]): Role => s.role ?? (ents[s.e]?.type === 'point' ? 'p0' : 'center');
export function selPoint(s: SelItem, ents: readonly SkEntity[]): V2 { return rolePoint(ents[s.e], vRole(s, ents)); }

/**
 * Plan locally when the selection has vertices, or for the types Orca's planner leaves to other
 * paths (distance, lock, point on line / object). Returns null: ask the kernel (`sketch_plan`).
 */
export function planLocal(type: SkConstraintType, sel: readonly SelItem[], ents: readonly SkEntity[]): Plan | null {
  const verts = sel.filter((s) => isVertex(s, ents));
  const curves = sel.filter((s) => !isVertex(s, ents));
  const v = (i: number) => ({ e: verts[i].e, r: vRole(verts[i], ents) });
  const P = (i: number) => selPoint(verts[i], ents);
  const ask = (c: SkConstraint[], prefill: number, unit: 'mm' | '°' = 'mm'): Plan => ({ kind: 'ask_value', constraints: c, prefill, unit });
  const apply = (c: SkConstraint[]): Plan => ({ kind: 'apply', constraints: c });
  const reject = (reason: string): Plan => ({ kind: 'reject', reason });
  switch (type) {
    case 'coincident':
      if (verts.length === 2 && !curves.length) return apply([cons('coincident', v(0).e, v(0).r, v(1).e, v(1).r)]);
      if (verts.length === 1 && curves.length === 1) return apply([cons('point_on_object', v(0).e, v(0).r, curves[0].e)]);
      return verts.length ? reject('Select two points, or a point and a curve') : null;
    case 'point_on_object':
      if (verts.length === 1 && curves.length === 1) return apply([cons('point_on_object', v(0).e, v(0).r, curves[0].e)]);
      return reject('Select a point and a line, arc or circle');
    case 'midpoint':
      if (verts.length === 1 && curves.length === 1 && ents[curves[0].e]?.type === 'line') return apply([cons('midpoint', v(0).e, v(0).r, curves[0].e)]);
      return verts.length ? reject('Select a point and a line') : null;
    case 'fix':
      if (verts.length === 1 && !curves.length) return apply([cons('fix', v(0).e, v(0).r)]);
      return verts.length ? reject('Select one point') : null;
    case 'lock_x': case 'lock_y': {
      if (sel.length !== 1) return reject('Select one point');
      const it = verts.length ? v(0) : { e: sel[0].e, r: ents[sel[0].e]?.type === 'line' ? 'p0' as Role : 'center' as Role };
      const p = rolePoint(ents[it.e], it.r);
      return ask([cons(type, it.e, it.r, -1, 'p0', type === 'lock_x' ? p[0] : p[1])], type === 'lock_x' ? p[0] : p[1]);
    }
    case 'horizontal': case 'vertical':
      if (verts.length === 2 && !curves.length) return apply([cons(type, v(0).e, v(0).r, v(1).e, v(1).r)]);
      return verts.length ? reject('Select a line, or two points') : null;
    case 'distance': case 'distance_x': case 'distance_y': {
      if (verts.length === 2 && !curves.length) {
        const a = P(0), b = P(1);
        let [ia, ib] = [v(0), v(1)];
        if (type === 'distance') return ask([cons('distance', ia.e, ia.r, ib.e, ib.r, dist(a, b))], dist(a, b));
        // Orca orders the refs so the prefill is non-negative.
        let d = type === 'distance_x' ? b[0] - a[0] : b[1] - a[1];
        if (d < 0) { [ia, ib] = [ib, ia]; d = -d; }
        return ask([cons(type, ia.e, ia.r, ib.e, ib.r, d)], d);
      }
      if (type === 'distance' && curves.length === 1 && !verts.length && ents[curves[0].e]?.type === 'line') {
        const l = ents[curves[0].e];
        return ask([cons('distance', curves[0].e, 'p0', curves[0].e, 'p1', dist(l.p0, l.p1))], dist(l.p0, l.p1));
      }
      if (verts.length === 1 && curves.length === 1 && ents[curves[0].e]?.type === 'line' && type === 'distance') return planLocal('point_on_line', sel, ents);
      if (type === 'distance' && curves.length === 1 && !verts.length && isRound(ents[curves[0].e])) {
        const e = ents[curves[0].e];
        return e.type === 'circle' ? ask([cons('diameter', curves[0].e, 'center', -1, 'p0', 2 * e.radius)], 2 * e.radius) : ask([cons('radius', curves[0].e, 'center', -1, 'p0', e.radius)], e.radius);
      }
      if (type !== 'distance' && curves.length === 1 && !verts.length && ents[curves[0].e]?.type === 'line') {
        const l = ents[curves[0].e];
        let d = type === 'distance_x' ? l.p1[0] - l.p0[0] : l.p1[1] - l.p0[1];
        let [ra, rb]: Role[] = ['p0', 'p1'];
        if (d < 0) { [ra, rb] = [rb, ra]; d = -d; }
        return ask([cons(type, curves[0].e, ra, curves[0].e, rb, d)], d);
      }
      return verts.length || type === 'distance' ? reject('Select two points, or a line') : null;
    }
    case 'point_on_line': {
      if (verts.length === 1 && curves.length === 1 && ents[curves[0].e]?.type === 'line') {
        const l = ents[curves[0].e], p = P(0);
        const dir = sub(l.p1, l.p0), L = Math.hypot(dir[0], dir[1]) || 1;
        const signed = (dir[0] * (p[1] - l.p0[1]) - dir[1] * (p[0] - l.p0[0])) / L;
        const d = Math.abs(signed);
        return ask([cons('point_on_line', v(0).e, v(0).r, curves[0].e, 'p0', d)], d);
      }
      return reject('Select a point and a line');
    }
    case 'symmetric':
      if (verts.length === 2 && curves.length === 1 && ents[curves[0].e]?.type === 'line') return apply([cons('symmetric', v(0).e, v(0).r, v(1).e, v(1).r, 0, curves[0].e)]);
      return verts.length ? reject('Select two points, then the mirror line') : null;
    case 'symmetric_about_x': case 'symmetric_about_y':
      if (verts.length === 2 && !curves.length) return apply([cons(type, v(0).e, v(0).r, v(1).e, v(1).r)]);
      return verts.length ? reject('Select two points') : null;
    case 'radius': case 'diameter': case 'equal_radius': case 'concentric': case 'tangent': case 'parallel': case 'perpendicular': case 'equal_length': case 'collinear': case 'angle':
      return verts.length ? reject(type === 'angle' ? 'Select two lines' : 'Select entities, not points') : null;
  }
  return null;
}

/** Angle between two lines (degrees, 0..180) for an angle prefill. */
export function lineAngle(a: SkEntity, b: SkEntity): number {
  let d = Math.abs(angleOf(sub(b.p1, b.p0)) - angleOf(sub(a.p1, a.p0))) * DEG;
  d %= 360; if (d > 180) d = 360 - d;
  return d;
}

/**
 * Refuse constraints that would trap the kernel or make no sense for the entity types (the
 * kernel accepts e.g. a tangent between two lines). Returns a message or null.
 */
export function guard(c: SkConstraint, ents: readonly SkEntity[]): string | null {
  const t = (i: number) => (i >= 0 ? ents[i]?.type : i < -1 ? 'ref' : undefined);
  const round = (i: number) => t(i) === 'arc' || t(i) === 'circle';
  const lineLike = (i: number) => t(i) === 'line' || (c.type === 'symmetric' && i === c.ec && i < -2);
  for (const i of [c.ea, c.eb, c.ec]) if (i >= ents.length) return `Entity ${i + 1} doesn’t exist`;
  switch (c.type) {
    case 'radius': case 'diameter': return round(c.ea) ? null : 'Radius and diameter need an arc or a circle';
    case 'equal_radius': case 'concentric': return round(c.ea) && round(c.eb) ? null : 'Select two arcs or circles';
    case 'tangent': return (round(c.ea) && (round(c.eb) || t(c.eb) === 'line')) || (t(c.ea) === 'line' && round(c.eb)) ? null : 'Tangent needs a line and an arc / circle, or two arcs / circles';
    case 'parallel': case 'perpendicular': case 'collinear': case 'angle': case 'equal_length':
      // equal length of two arcs / circles is not a solver constraint (libslvs EQUAL_LENGTH_LINES): use Equal radius
      return lineLike(c.ea) && lineLike(c.eb) ? null : c.type === 'equal_length' && round(c.ea) && round(c.eb) ? 'Equal length needs two lines — for arcs or circles use Equal radius' : 'Select two lines';
    case 'midpoint': return t(c.eb) === 'line' ? null : 'Midpoint needs a line';
    case 'point_on_line': return t(c.eb) === 'line' ? null : 'Select a point and a line';
    case 'symmetric': return t(c.ec) === 'line' ? null : 'Symmetric needs a mirror line';
    default: return null;
  }
}

/** The entities a constraint refers to (sketch references excluded). */
export function constraintEntities(c: SkConstraint): number[] {
  const out: number[] = [];
  for (const i of [c.ea, c.eb, c.ec]) if (i >= 0 && !out.includes(i)) out.push(i);
  if (c.type === 'radius' || c.type === 'diameter' || c.type === 'fix' || c.type === 'lock_x' || c.type === 'lock_y') return out.slice(0, 1);
  if (c.type !== 'symmetric' && out.length > 2) return out.slice(0, 2);
  return out;
}

/** Does `c` reference entity `e`'s point `role` (the end a trim / extend moves)? */
export function refsPoint(c: SkConstraint, e: number, role: Role): boolean {
  return (c.ea === e && c.ra === role && pointish(c, 'a')) || (c.eb === e && c.rb === role && pointish(c, 'b'));
}
function pointish(c: SkConstraint, slot: 'a' | 'b'): boolean {
  switch (c.type) {
    case 'coincident': case 'fix': case 'lock_x': case 'lock_y': case 'distance': case 'distance_x': case 'distance_y': case 'symmetric': case 'symmetric_about_x': case 'symmetric_about_y': return true;
    case 'midpoint': case 'point_on_line': case 'point_on_object': return slot === 'a';
    case 'horizontal': case 'vertical': return c.ea !== c.eb; // a line's own H / V is kept
    default: return false;
  }
}

/**
 * Wire units: kernel v1.2 sends and takes angle constraint values in **degrees** everywhere
 * (`sketch_constrain`, `sketch_describe`, `sketch_set_constraint`, `sketch_set_value`, `sketch_plan`),
 * like the UI, so these are identities (kept as the one place a unit change would go).
 */
export const toWire = (_t: SkConstraintType, v: number) => v;
export const fromWire = (_t: SkConstraintType, v: number) => v;

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, '');
/** A dimension's label ("12.5", "R 4", "Ø 8", "30°"). */
export function dimensionText(c: SkConstraint): string {
  switch (c.type) {
    case 'radius': return `R ${fmt(c.value)}`;
    case 'diameter': return `Ø ${fmt(c.value)}`;
    case 'angle': return `${fmt(c.value)}°`;
    case 'lock_x': return `X ${fmt(c.value)}`;
    case 'lock_y': return `Y ${fmt(c.value)}`;
    default: return fmt(c.value);
  }
}
export const formatMm = fmt;

/** A sentence naming a constraint for conflict reports ("Distance 40 mm on line 1"). */
export function describeConstraint(c: SkConstraint, ents: readonly SkEntity[], index?: number): string {
  const label = constraintLabel(c.type);
  const val = c.type === 'angle' ? ` ${fmt(c.value)}°` : c.value && (c.type === 'distance' || c.type === 'distance_x' || c.type === 'distance_y' || c.type === 'radius' || c.type === 'diameter' || c.type === 'point_on_line' || c.type === 'lock_x' || c.type === 'lock_y') ? ` ${fmt(c.value)} mm` : '';
  const on = constraintEntities(c).map((i) => entityName(ents, i));
  if (c.eb === REF_ORIGIN || c.ea === REF_ORIGIN) on.push('the origin');
  if (c.ec === REF_AXIS_X || c.ec === REF_AXIS_Y) on.push(entityName(ents, c.ec));
  const uniq = [...new Set(on)];
  return `${label}${val}${uniq.length ? ` on ${uniq.join(' and ')}` : ''}${index !== undefined ? ` (#${index + 1})` : ''}`;
}

/** Same constraint already there (same type and the same refs, either order)? */
export function duplicateOf(c: SkConstraint, list: readonly SkConstraint[]): number {
  const key = (x: SkConstraint, swap: boolean) => (swap ? `${x.type}|${x.eb}.${x.rb}|${x.ea}.${x.ra}|${x.ec}` : `${x.type}|${x.ea}.${x.ra}|${x.eb}.${x.rb}|${x.ec}`);
  const k = key(c, false);
  const symmetricRefs = !['distance_x', 'distance_y', 'angle', 'point_on_line', 'point_on_object', 'midpoint', 'tangent'].includes(c.type);
  return list.findIndex((x) => x.type === c.type && (key(x, false) === k || (symmetricRefs && key(x, true) === k)) && (!isValued(c) || Math.abs(x.value - c.value) < 1e-9));
}
const isValued = (c: SkConstraint) => ['distance', 'distance_x', 'distance_y', 'angle', 'radius', 'diameter', 'lock_x', 'lock_y', 'point_on_line'].includes(c.type);

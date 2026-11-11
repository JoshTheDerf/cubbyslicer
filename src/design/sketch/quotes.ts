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
 * Grouped shapes (Orca's `Feature` spans: rectangle, slot, polygon, rounded rectangle, arc slot)
 * show the shape's labels instead, whichever member is selected (`shapeGroups`, below):
 * - rectangle: Width (first edge) and Height (second edge) as Length quotes on opposite sides,
 *   plus its Angle when drawn off-axis (2°–88° from an axis);
 * - slot: centre-line Length, full Width, centre-line Angle;
 * - polygon: Side (on the first edge, outward) and Orientation (centre → first vertex, a wedge);
 * - rounded rectangle: Width below, Height left, corner Radius at the top-right corner;
 * - arc slot: centre-line Radius and full Width.
 * Orca edits a shape's sizes geometrically (`set_slot`, `set_rounded_rect`…); this sketcher keeps
 * the shape's constraints in the kernel, so a size label becomes the driving dimension the drawing
 * tool's own size fields use (shapes.ts), and an angle label rotates the shape (with its
 * construction geometry) about Orca's pivot (`set_rect_angle`, `set_slot_angle`, `set_polygon_angle`).
 * What Orca's editor keeps while one size changes (the other sizes, its anchor point) is held for
 * that solve only (`hold`), so a typed corner radius doesn't grow the rounded rectangle.
 */
import { add, onCircle, scale, sub, cons, type SkConstraint, type SkEntity, type V2 } from './model';

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
  /** A shape label: the driving dimension a click adds (instead of the entity's own Length / Radius). */
  dim?: SkConstraint;
  /** A shape's angle label: a typed value turns these entities about `pivot` (degrees, 0–360). */
  rotate?: { ents: number[]; pivot: V2 };
  /** The value editor's title when not the kind's (Width, Height, Side…). */
  title?: string;
  /**
   * A shape's size label: what Orca's geometric editor keeps (`set_rounded_rect` keeps the min
   * corner and the other sizes, `set_slot` the start cap's centre…), held by these constraints
   * only while the typed value is solved, then removed (session.ts `setConstraintValue`).
   */
  hold?: SkConstraint[];
  /** A shape's size label: Orca's refusal for a value the shape can't take (null = fine). */
  check?: (v: number) => string | null;
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

/**
 * The entity the quotes are for: the one being dragged (the driver selects it), a lone selection,
 * or (Orca) a selection that is all one grouped shape — any member speaks for it.
 */
export function quotedEntity(sel: readonly { e: number }[], tool: string, groups: readonly ShapeGroup[] = []): number {
  if (NO_QUOTES.has(tool) || !sel.length) return -1;
  const e = sel[0].e;
  if (sel.every((s) => s.e === e)) return e;
  const g = groupOf(groups, e);
  return g && sel.every((s) => s.e >= g.begin && s.e < g.end) ? e : -1;
}

// ---- grouped shapes (Orca's Feature spans) -----------------------------------------------------------

export type ShapeKind = 'rect' | 'slot' | 'polygon' | 'rounded-rect' | 'arc-slot';
export interface ShapeGroup {
  kind: ShapeKind;
  /** Members [begin, end) in the entity list (a drawing tool adds a shape's entities together, in order). */
  begin: number;
  end: number;
  /** Rect: first corner. Slot: centre of the cap at the start (c0). Polygon / arc slot: the centre. */
  c0: V2;
  /** Slot: centre of the cap at the end. Arc slot: the centre line's start (start cap's centre). */
  c1: V2;
  /** Slot / arc slot: half-width. Rounded rect: corner radius. Polygon: circumradius. */
  param: number;
  /** Construction entities the shape's constraints tie to it (slot centre line, centre-rect diagonal…): they turn with it. */
  helpers: number[];
}

export const groupOf = (groups: readonly ShapeGroup[], e: number): ShapeGroup | undefined => groups.find((g) => e >= g.begin && e < g.end);

const near = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 0.05 + 1e-3 * Math.max(Math.hypot(a[0], a[1]), Math.hypot(b[0], b[1]));

/**
 * Orca's `rebuild_features_from_entities`: every run of consecutive entities joined end to end
 * into a closed chain is classified — L,A,L,A → slot; four arcs (outer / inner concentric, equal
 * caps) → arc slot; L,A × 4 with equal corner radii → rounded rectangle; four lines at right
 * angles → rectangle; N equal lines → polygon. Orca uses it for a re-opened sketch (its drawing
 * tools record the span while drawing); here it is the only record, so a chain must also carry the
 * constraints the drawing tool gives that shape (shapes.ts): its joints Coincident, and the
 * constraints that keep it that shape — so a closed polyline that merely looks like one, or a
 * shape whose defining constraints were deleted, stays plain lines and arcs.
 */
export function shapeGroups(entities: readonly SkEntity[], constraints: readonly SkConstraint[]): ShapeGroup[] {
  const out: ShapeGroup[] = [];
  const n = entities.length;
  const curve = (i: number) => entities[i].type === 'line' || entities[i].type === 'arc';
  const pair = (type: SkConstraint['type'], a: number, b: number) => constraints.some((c) => c.type === type && ((c.ea === a && c.eb === b) || (c.ea === b && c.eb === a)));
  const on = (type: SkConstraint['type'], a: number) => constraints.some((c) => c.type === type && c.ea === a && (c.eb === a || c.eb < 0));
  let i = 0;
  while (i < n) {
    if (!curve(i)) { i++; continue; }
    // Chain from entity i (either direction for each member: the kernel may report an arc reversed).
    let j = i, closed = false;
    for (const [h, t] of [[entities[i].p0, entities[i].p1], [entities[i].p1, entities[i].p0]] as [V2, V2][]) {
      let k = i, cur = t;
      while (k + 1 < n && curve(k + 1)) {
        const e = entities[k + 1];
        if (near(cur, e.p0)) cur = e.p1; else if (near(cur, e.p1)) cur = e.p0; else break;
        k++;
        if (k - i >= 2 && near(cur, h)) { closed = true; break; }
      }
      if (k > j || closed) j = k;
      if (closed) break;
    }
    const cnt = j - i + 1;
    if (!closed || cnt < 3) { i++; continue; }
    const E = (k: number) => entities[i + k];
    const joined = Array.from({ length: cnt }, (_, k) => pair('coincident', i + k, i + ((k + 1) % cnt))).every(Boolean);
    const tangentJoints = Array.from({ length: cnt }, (_, k) => pair('tangent', i + k, i + ((k + 1) % cnt))).every(Boolean);
    const types = Array.from({ length: cnt }, (_, k) => E(k).type);
    const arcs = types.filter((t) => t === 'arc').length;
    const g = (kind: ShapeKind, c0: V2, c1: V2, param: number): ShapeGroup => ({ kind, begin: i, end: j + 1, c0, c1, param, helpers: [] });
    let found: ShapeGroup | null = null;
    if (joined && cnt === 4 && types.join() === 'line,arc,line,arc' && tangentJoints && Math.abs(E(1).radius - E(3).radius) <= 0.02 * Math.max(E(1).radius, 1e-6)) {
      found = g('slot', E(3).center, E(1).center, E(1).radius);
    } else if (joined && cnt === 4 && arcs === 4 && tangentJoints && near(E(0).center, E(2).center) && E(0).radius > E(2).radius
      && Math.abs(E(1).radius - E(3).radius) <= 0.02 * Math.max(E(1).radius, 1e-6)) {
      found = g('arc-slot', E(0).center, E(3).center, E(3).radius);
    } else if (joined && cnt === 8 && types.join() === 'line,arc,line,arc,line,arc,line,arc' && tangentJoints) {
      const r = E(1).radius;
      if (r > 1e-6 && [3, 5, 7].every((k) => Math.abs(E(k).radius - r) <= 0.02 * Math.max(r, 1e-6)) && [3, 5, 7].every((k) => pair('equal_radius', i + 1, i + k))) {
        const cs = [1, 3, 5, 7].map((k) => E(k).center);
        found = g('rounded-rect', [Math.min(...cs.map((c) => c[0])) - r, Math.min(...cs.map((c) => c[1])) - r], [Math.max(...cs.map((c) => c[0])) + r, Math.max(...cs.map((c) => c[1])) + r], r);
      }
    } else if (joined && arcs === 0) {
      const len = types.map((_, k) => Math.hypot(E(k).p1[0] - E(k).p0[0], E(k).p1[1] - E(k).p0[1]));
      const lmin = Math.min(...len), lmax = Math.max(...len);
      const allRight = types.every((_, k) => {
        const u = sub(E(k).p1, E(k).p0), v = sub(E((k + 1) % cnt).p1, E((k + 1) % cnt).p0);
        const lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]);
        return lu > 1e-9 && lv > 1e-9 && Math.abs((u[0] * v[0] + u[1] * v[1]) / (lu * lv)) <= 0.06;
      });
      const c: V2 = [0, 0];
      for (let k = 0; k < cnt; k++) { c[0] += E(k).p0[0] / cnt; c[1] += E(k).p0[1] / cnt; }
      // A rectangle stays one by H / V on every edge (corner / centre rectangle) or by Perpendicular + 2 × Parallel (oblique).
      const hv = (k: number) => on('horizontal', i + k) || on('vertical', i + k);
      const kept = [0, 1, 2, 3].every(hv) || (pair('perpendicular', i, i + 1) && pair('parallel', i, i + 2) && pair('parallel', i + 1, i + 3));
      if (cnt === 4 && allRight && kept) found = g('rect', E(0).p0, E(2).p0, 0);
      else if (lmin > 1e-6 && (lmax - lmin) / lmax < 0.02 && types.every((_, k) => k === 0 || pair('equal_length', i, i + k))) {
        found = g('polygon', c, E(0).p0, Math.hypot(E(0).p0[0] - c[0], E(0).p0[1] - c[1]));
      }
    }
    if (found) {
      // Construction entities tied to the shape by constraints (through other construction entities).
      const inShape = (e: number) => e >= found!.begin && e < found!.end;
      const reach = new Set<number>();
      let grew = true;
      while (grew) {
        grew = false;
        for (const c of constraints) {
          const refs = [c.ea, c.eb, c.ec].filter((e) => e >= 0 && entities[e]);
          if (!refs.some((e) => inShape(e) || reach.has(e))) continue;
          for (const e of refs) if (!inShape(e) && !reach.has(e) && entities[e].construction) { reach.add(e); grew = true; }
        }
      }
      found.helpers = [...reach].sort((a, b) => a - b);
      out.push(found);
    }
    i = j + 1;
  }
  return out;
}

const sameRefs = (a: SkConstraint, b: SkConstraint) => a.type === b.type && ((a.ea === b.ea && a.ra === b.ra && a.eb === b.eb && a.rb === b.rb) || (a.ea === b.eb && a.ra === b.rb && a.eb === b.ea && a.rb === b.ra));

/** The labels of a grouped shape (Orca's `render_live_quotes`, the Feature cases). */
function shapeQuotes(entities: readonly SkEntity[], constraints: readonly SkConstraint[], g: ShapeGroup, th: number): LiveQuote[] {
  const out: LiveQuote[] = [];
  const drivenBy = (...cs: SkConstraint[]) => constraints.some((x) => cs.some((c) => sameRefs(x, c)));
  const radiusDriven = (...es: number[]) => constraints.some((x) => (x.type === 'radius' || x.type === 'diameter') && es.includes(x.ea));
  const add_ = (q: Omit<LiveQuote, 'text'>) => out.push({ ...q, text: quoteText(q.kind, q.value) });
  const turn = { ents: [...Array.from({ length: g.end - g.begin }, (_, k) => g.begin + k), ...g.helpers] };
  const b = g.begin;
  if (g.kind === 'rect') {
    // Width = the first edge, Height = the second, on opposite sides: the entity Length quote.
    for (const [k, side, title] of [[0, 1, 'Width'], [1, -1, 'Height']] as const) {
      const q = lineLength(entities[b + k], b + k, side, th);
      if (q && !drivenBy(cons('distance', b + k, 'p0', b + k, 'p1'))) out.push({ ...q, title });
    }
    const e0 = entities[b], d0 = sub(e0.p1, e0.p0), L0 = Math.hypot(d0[0], d0[1]);
    const a = deg(Math.atan2(d0[1], d0[0])), off = ((a % 90) + 90) % 90;
    if (L0 > 1e-6 && off > 2 && off < 88) {
      const nrm: V2 = [-d0[1] / L0, d0[0] / L0];
      add_({ kind: 'angle', e: b, value: norm360(a), lines: [], label: add(scale(add(e0.p0, e0.p1), 0.5), scale(nrm, th * 1.4)), rotate: { ...turn, pivot: g.c0 }, title: 'Angle (°)' });
    }
  } else if (g.kind === 'slot') {
    const u0 = sub(g.c1, g.c0), Lc = Math.hypot(u0[0], u0[1]), w = g.param;
    if (Lc > 1e-9) {
      const u: V2 = [u0[0] / Lc, u0[1] / Lc], n: V2 = [-u[1], u[0]];
      // The tool's own size fields: the centre line's Length (or the caps' centres), the caps' size.
      const cl = g.helpers.find((h) => entities[h].type === 'line' && ((near(entities[h].p0, g.c0) && near(entities[h].p1, g.c1)) || (near(entities[h].p0, g.c1) && near(entities[h].p1, g.c0))));
      const lenDim = cl !== undefined ? cons('distance', cl, 'p0', cl, 'p1', Lc) : cons('distance', b + 3, 'center', b + 1, 'center', Lc);
      // Orca's set_slot: the start cap's centre (c0) and the centre line's direction stay; a new
      // Length keeps the width, a new Width keeps both caps' centres.
      const lenDriven = drivenBy(lenDim, cons('distance', b + 3, 'center', b + 1, 'center')), wDriven = radiusDriven(b + 1, b + 3);
      const wDim = cons('diameter', b + 1, 'center', -1, 'p0', 2 * w), fix0 = cons('fix', b + 3, 'center');
      if (!lenDriven) add_({ kind: 'length', e: b, value: Lc, lines: [], label: add(scale(add(g.c0, g.c1), 0.5), scale(n, w + th * 2)), dim: lenDim, title: 'Length', hold: [fix0, ...(wDriven ? [] : [wDim])] });
      if (!wDriven) add_({ kind: 'length', e: b + 1, value: 2 * w, lines: [], label: add(g.c1, scale(u, w + th * 2)), dim: wDim, title: 'Width', hold: [fix0, ...(lenDriven ? [] : [cons('fix', b + 1, 'center')])] });
      add_({ kind: 'angle', e: b, value: norm360(deg(Math.atan2(u0[1], u0[0]))), lines: [], label: sub(g.c0, scale(u, w + th * 2)), rotate: { ...turn, pivot: g.c0 }, title: 'Angle (°)' });
    }
  } else if (g.kind === 'polygon') {
    const e0 = entities[b], m0 = scale(add(e0.p0, e0.p1), 0.5), d = sub(e0.p1, e0.p0), L = Math.hypot(d[0], d[1]);
    if (L > 1e-9) {
      const n0: V2 = [-d[1] / L, d[0] / L];
      const side = Math.hypot(...sub(add(m0, n0), g.c0)) >= Math.hypot(...sub(m0, g.c0)) ? 1 : -1;
      const q = lineLength(e0, b, side, th);
      // Orca's set_polygon_side scales the polygon about its centre: the centre is held.
      const circ = g.helpers.find((h) => entities[h].type === 'circle' && near(entities[h].center, g.c0));
      if (q && !drivenBy(cons('distance', b, 'p0', b, 'p1'))) out.push({ ...q, title: 'Side', dim: cons('distance', b, 'p0', b, 'p1', L), ...(circ !== undefined ? { hold: [cons('fix', circ, 'center')] } : {}) });
    }
    const sp = sub(e0.p0, g.c0), R = Math.hypot(sp[0], sp[1]);
    if (R > 1e-6) {
      const av = Math.atan2(sp[1], sp[0]), rr = R + th * 2.5;
      add_({ kind: 'angle', e: b, value: norm360(deg(av)), lines: [[g.c0, add(g.c0, [rr, 0])], [g.c0, onCircle(g.c0, rr, av)], arcPoints(g.c0, rr, 0, av, 20)],
        label: onCircle(g.c0, rr + th * 1.2, av / 2), rotate: { ...turn, pivot: g.c0 }, title: 'Angle (°)' });
    }
  } else if (g.kind === 'rounded-rect') {
    const [xmin, ymin] = g.c0, [xmax, ymax] = g.c1, w = xmax - xmin, h = ymax - ymin, r = g.param, off = th * 2;
    const yb = ymin - off, xl = xmin - off, rc: V2 = [xmax - r, ymax - r], diag: V2 = [Math.SQRT1_2, Math.SQRT1_2];
    const wDim = cons('distance_x', b + 6, 'p0', b + 2, 'p0', w), hDim = cons('distance_y', b, 'p0', b + 4, 'p0', h), rDim = cons('radius', b + 1, 'center', -1, 'p0', r);
    const wOn = !drivenBy(wDim), hOn = !drivenBy(hDim), rOn = !radiusDriven(b + 1, b + 3, b + 5, b + 7);
    // Orca's set_rounded_rect(w, h, r): the min corner stays, and the sizes not typed keep their values.
    const corner = [cons('lock_x', b + 6, 'p0', -1, 'p0', xmin), cons('lock_y', b, 'p0', -1, 'p0', ymin)];
    const hold = (skip: SkConstraint) => [...corner, ...([[wOn, wDim], [hOn, hDim], [rOn, rDim]] as const).filter(([on, c]) => on && c !== skip).map(([, c]) => c)];
    const check = (nw: number, nh: number, nr: number) => (!(nw > 0 && nh > 0 && nr > 0) ? 'Enter a value above 0' : nr >= Math.min(nw, nh) / 2 ? 'The corner radius must be less than half the shorter side' : null);
    if (wOn) add_({ kind: 'length', e: b, value: w, lines: [[[xmin, ymin], [xmin, yb]], [[xmax, ymin], [xmax, yb]], [[xmin, yb], [xmax, yb]]], label: [(xmin + xmax) / 2, yb - th * 0.8], dim: wDim, title: 'Width', hold: hold(wDim), check: (v) => check(v, h, r) });
    if (hOn) add_({ kind: 'length', e: b + 2, value: h, lines: [[[xmin, ymin], [xl, ymin]], [[xmin, ymax], [xl, ymax]], [[xl, ymin], [xl, ymax]]], label: [xl - th * 0.8, (ymin + ymax) / 2], dim: hDim, title: 'Height', hold: hold(hDim), check: (v) => check(w, v, r) });
    if (rOn) add_({ kind: 'radius', e: b + 1, value: r, lines: [[rc, add(rc, scale(diag, r))]], label: add(rc, scale(diag, r + th * 1.2)), dim: rDim, title: 'Radius', hold: hold(rDim), check: (v) => check(w, h, v) });
  } else if (g.kind === 'arc-slot') {
    const c = g.c0, ds = sub(g.c1, c), Rc = Math.hypot(ds[0], ds[1]), w = g.param, de = sub(entities[b + 1].center, c), lde = Math.hypot(de[0], de[1]);
    if (Rc > 1e-6 && lde > 1e-6) {
      const dirS: V2 = [ds[0] / Rc, ds[1] / Rc], aS = Math.atan2(dirS[1], dirS[0]);
      let sweep = Math.atan2(de[1], de[0]) - aS;
      while (sweep < 0) sweep += 2 * Math.PI;
      const uMid: V2 = [Math.cos(aS + sweep / 2), Math.sin(aS + sweep / 2)];
      const rDim = cons('distance', b, 'center', b + 3, 'center', Rc), wDim = cons('diameter', b + 1, 'center', -1, 'p0', 2 * w);
      // Orca's set_arc_slot: the centre and the centre line's directions stay; a new Radius keeps
      // the width, a new Width keeps the radius (the start cap's centre held).
      const rDriven = drivenBy(rDim), wDriven = radiusDriven(b + 1, b + 3), fixC = cons('fix', b, 'center');
      const tooWide = 'The slot is too wide for its radius — the width must be less than twice the radius';
      if (!rDriven) add_({ kind: 'radius', e: b, value: Rc, lines: [[c, add(c, scale(uMid, Rc))]], label: add(add(c, scale(uMid, Rc * 0.5)), [0, th]), dim: rDim, title: 'Radius', hold: [fixC, ...(wDriven ? [] : [wDim])], check: (v) => (w >= v ? tooWide : null) });
      if (!wDriven) add_({ kind: 'length', e: b + 1, value: 2 * w, lines: [[add(c, scale(dirS, Rc + w)), add(c, scale(dirS, Rc - w))]], label: add(c, scale(dirS, Rc + w + th * 1.2)), dim: wDim, title: 'Width', hold: [fixC, ...(rDriven ? [] : [cons('fix', b + 3, 'center')])], check: (v) => (v / 2 >= Rc ? tooWide : null) });
    }
  }
  return out;
}

/** Orca's `draw_dim_quote` for a line's Length on `side` (+1 left of p0 → p1, −1 right). */
function lineLength(e: SkEntity, ei: number, side: number, th: number): LiveQuote | null {
  const d = sub(e.p1, e.p0), L = Math.hypot(d[0], d[1]);
  if (L < 1e-6) return null;
  const u: V2 = [d[0] / L, d[1] / L], n: V2 = [-u[1] * side, u[0] * side];
  // Offset max(L·0.18, 8 mm), label beside its middle.
  const off = Math.max(L * 0.18, 8);
  const A2 = add(e.p0, scale(n, off)), B2 = add(e.p1, scale(n, off));
  const as = Math.max(L * 0.04, 2);
  const arrow = (tip: V2, dir: V2): V2[] => { const back = add(tip, scale(dir, as)); return [add(back, scale(n, as * 0.5)), tip, sub(back, scale(n, as * 0.5))]; };
  return { kind: 'length', e: ei, value: L, text: quoteText('length', L), lines: [[A2, B2], arrow(A2, u), arrow(B2, scale(u, -1))], label: add(scale(add(A2, B2), 0.5), scale(n, th * 0.7 + 1.5)) };
}

const deg = (r: number) => (r * 180) / Math.PI;
// 0–360 (Orca's); a hair under 0 (rounding: a polygon pointing along +X) reads 0°, not 360°.
const norm360 = (d: number) => { const v = d < 0 ? d + 360 : d; return v >= 359.995 ? 0 : v; };

function arcPoints(c: V2, r: number, a0: number, sweep: number, n: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i <= n; i++) out.push(onCircle(c, r, a0 + (sweep * i) / n));
  return out;
}

/**
 * The live quotes of entity `ei`. `th` is Orca's label height (15 px) in plane mm; it sets the
 * label offsets and wedge radii as Orca's do.
 */
export function liveQuotes(entities: readonly SkEntity[], constraints: readonly SkConstraint[], ei: number, th: number, groups: readonly ShapeGroup[] = shapeGroups(entities, constraints)): LiveQuote[] {
  const e = entities[ei];
  if (!e) return [];
  // A member of a grouped shape shows the shape's labels, not its own (Orca: the Feature cases win).
  const g = groupOf(groups, ei);
  if (g) return shapeQuotes(entities, constraints, g, th);
  const out: LiveQuote[] = [];
  const driven = (kind: 'length' | 'radius') => constraints.some((c) => (kind === 'length'
    ? c.type === 'distance' && c.ea === ei && c.eb === ei && c.ra !== c.rb
    : c.type === 'radius' && c.ea === ei));
  const q = (kind: QuoteKind, value: number, lines: V2[][], label: V2) => out.push({ kind, e: ei, value, text: quoteText(kind, value), lines, label });

  if (e.type === 'line') {
    const d = sub(e.p1, e.p0), L = Math.hypot(d[0], d[1]);
    if (L < 1e-6) return out;
    if (!driven('length')) out.push(lineLength(e, ei, 1, th)!); // draw_dim_quote (Length, side +1)
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

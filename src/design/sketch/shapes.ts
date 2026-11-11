/**
 * Drawing tools: Orca's sketch tool set (DesignSketchTool modes), each a click sequence that
 * builds kernel entities + the constraints that keep the shape what it is (a rectangle stays a
 * rectangle, a slot's caps stay tangent). Composite shapes are GUI-level in Orca too: the kernel
 * only knows lines, arcs, circles, points, ellipses, elliptical arcs and splines.
 *
 * `build(pts, o)` gets the clicked points (plus the cursor while rubber-banding) and returns the
 * entities, their constraints (absolute indices from `o.base`), which built point each click
 * became (so the click's snap turns into a Coincident / Midpoint / Point-on-object), and the
 * dimension queue the inline editor walks after the shape lands (Orca's draw-then-edit:
 * rectangle Width then Height, line Length, circle Diameter …).
 */
import {
  add, angleOf, arc, arcThrough, circle, circleThrough, cons, cross, dist, dot, endTangent, ends, entity, line, mid, norm, onEllipse, perp,
  point, rolePoint, scale, sub, tangentArc,
  type Role, type SkConstraint, type SkEntity, type V2,
} from './model';
import { snapPoint, type Snap } from './infer';

export type DrawToolId =
  | 'line' | 'polyline' | 'rect' | 'rect-center' | 'rect-3pt' | 'rect-rounded' | 'circle' | 'circle-2pt' | 'circle-3pt'
  | 'arc-3pt' | 'arc-tangent' | 'arc-center' | 'ellipse' | 'ellipse-arc' | 'polygon' | 'slot' | 'arc-slot' | 'spline' | 'point';

/** A click's target in the built shape: a point role of a new entity, or its rim (circle / arc). */
export interface Anchor { click: number; ent: number; role: Role | 'rim' }
export interface DimSpec { label: string; constraint: SkConstraint }
export interface Built { entities: SkEntity[]; constraints: SkConstraint[]; anchors: Anchor[]; dims: DimSpec[] }

export interface BuildOpts {
  /** Index the first new entity gets. */
  base: number;
  /** Existing entities (tangent arc reads the one it starts from). */
  entities: readonly SkEntity[];
  /** The snap recorded for each click. */
  snaps: ReadonlyArray<Snap | null>;
  /** H / V inferred for the segment ending at each click (lines). */
  axes: ReadonlyArray<'horizontal' | 'vertical' | null>;
  construction: boolean;
  polygonSides: number;
  polygonCircumscribed: boolean;
  /** Final build (commit) vs rubber band. */
  final: boolean;
}

export interface DrawTool {
  id: DrawToolId;
  title: string;
  icon: string;
  /** Orca's key (sketch mode); only the family's main tool has one. */
  key?: string;
  family: 'line' | 'rect' | 'circle' | 'arc' | 'slot' | 'ellipse' | 'polygon' | 'spline' | 'point';
  /** Orca's flyout hint. */
  hint: string;
  /** Status prompt for each click. */
  prompts: string[];
  /** Number of clicks, or a chain ended by Enter / double-click / right-click. */
  clicks: number | 'chain';
  /**
   * Which clicks snap (Orca's `click_snaps`), by the number of clicks already made; every click
   * when absent. A click that only sets a size or a direction is placed freely.
   */
  snapClick?(n: number): boolean;
  build(pts: readonly V2[], o: BuildOpts): Built | null;
}

const TOL = 1e-6;
const dimDist = (label: string, ea: number, ra: Role, eb: number, rb: Role, v: number): DimSpec => ({ label, constraint: cons('distance', ea, ra, eb, rb, v) });

/** Rectangle q0..q3 (CCW or not): 4 lines i: q_i → q_{i+1}, coincident corners. */
function quad(q: V2[], b: number, constr: boolean): { entities: SkEntity[]; constraints: SkConstraint[] } {
  const entities = [0, 1, 2, 3].map((i) => line(q[i], q[(i + 1) % 4], constr));
  const constraints = [0, 1, 2, 3].map((i) => cons('coincident', b + i, 'p1', b + ((i + 1) % 4), 'p0'));
  return { entities, constraints };
}

function axisRect(a: V2, c: V2, b: number, constr: boolean): { entities: SkEntity[]; constraints: SkConstraint[] } | null {
  if (Math.abs(a[0] - c[0]) < TOL || Math.abs(a[1] - c[1]) < TOL) return null;
  const q: V2[] = [a, [c[0], a[1]], c, [a[0], c[1]]];
  const r = quad(q, b, constr);
  r.constraints.push(cons('horizontal', b, 'p0', b, 'p1'), cons('vertical', b + 1, 'p0', b + 1, 'p1'), cons('horizontal', b + 2, 'p0', b + 2, 'p1'), cons('vertical', b + 3, 'p0', b + 3, 'p1'));
  return r;
}

export const DRAW_TOOLS: DrawTool[] = [
  {
    id: 'line', title: 'Line', icon: 'i-lucide-slash', key: 'l', family: 'line',
    hint: 'Click start, then end — then set the exact length', prompts: ['Click the start of the line', 'Click the end of the line'], clicks: 2,
    build: (p, o) => {
      if (p.length < 2 || dist(p[0], p[1]) < TOL) return null;
      const b = o.base, ax = o.axes[1];
      return { entities: [line(p[0], p[1], o.construction)], constraints: ax ? [cons(ax, b, 'p0', b, 'p1')] : [],
        anchors: [{ click: 0, ent: b, role: 'p0' }, { click: 1, ent: b, role: 'p1' }], dims: [dimDist('Length', b, 'p0', b, 'p1', dist(p[0], p[1]))] };
    },
  },
  {
    id: 'polyline', title: 'Polyline', icon: 'i-lucide-spline-pointer', family: 'line',
    hint: 'Click the first point to close the loop, right-click or Enter to end the chain', prompts: ['Click the first point', 'Click the next point — Enter, right-click or double-click ends the chain'], clicks: 'chain',
    // A chain is committed segment by segment (one line per click; see the tool driver).
    build: (p, o) => {
      if (p.length < 2) return null;
      const a = p[p.length - 2], c = p[p.length - 1];
      if (dist(a, c) < TOL) return null;
      const b = o.base, ax = o.axes[p.length - 1];
      return { entities: [line(a, c, o.construction)], constraints: ax ? [cons(ax, b, 'p0', b, 'p1')] : [],
        anchors: [{ click: p.length - 2, ent: b, role: 'p0' }, { click: p.length - 1, ent: b, role: 'p1' }], dims: [] };
    },
  },
  {
    id: 'rect', title: 'Corner rectangle', icon: 'i-lucide-rectangle-horizontal', key: 'r', family: 'rect',
    hint: 'Click two opposite corners', prompts: ['Click the first corner', 'Click the opposite corner'], clicks: 2,
    build: (p, o) => {
      if (p.length < 2) return null;
      const r = axisRect(p[0], p[1], o.base, o.construction);
      if (!r) return null;
      const b = o.base;
      return { ...r, anchors: [{ click: 0, ent: b, role: 'p0' }, { click: 1, ent: b + 1, role: 'p1' }],
        dims: [dimDist('Width', b, 'p0', b, 'p1', Math.abs(p[1][0] - p[0][0])), dimDist('Height', b + 1, 'p0', b + 1, 'p1', Math.abs(p[1][1] - p[0][1]))] };
    },
  },
  {
    id: 'rect-center', title: 'Center rectangle', icon: 'i-lucide-square-dot', family: 'rect',
    hint: 'Click the centre, then a corner', prompts: ['Click the centre', 'Click a corner'], clicks: 2,
    build: (p, o) => {
      if (p.length < 2) return null;
      const c = p[0], k = p[1], a: V2 = [2 * c[0] - k[0], 2 * c[1] - k[1]];
      const r = axisRect(a, k, o.base, o.construction);
      if (!r) return null;
      const b = o.base;
      r.entities.push(line(a, k, true), point(c, true));
      r.constraints.push(cons('coincident', b + 4, 'p0', b, 'p0'), cons('coincident', b + 4, 'p1', b + 2, 'p0'), cons('midpoint', b + 5, 'p0', b + 4));
      return { ...r, anchors: [{ click: 0, ent: b + 5, role: 'p0' }, { click: 1, ent: b + 2, role: 'p0' }],
        dims: [dimDist('Width', b, 'p0', b, 'p1', Math.abs(k[0] - a[0])), dimDist('Height', b + 1, 'p0', b + 1, 'p1', Math.abs(k[1] - a[1]))] };
    },
  },
  {
    id: 'rect-3pt', title: 'Oblique rectangle', icon: 'i-lucide-rectangle-ellipsis', family: 'rect',
    hint: 'Click two corners of one edge, then the width', prompts: ['Click the first corner', 'Click the second corner of the edge', 'Click to set the width'], clicks: 3,
    build: (p, o) => {
      if (p.length < 3 || dist(p[0], p[1]) < TOL) return null;
      const n = perp(norm(sub(p[1], p[0]))), w = dot(sub(p[2], p[0]), n);
      if (Math.abs(w) < TOL) return null;
      const q: V2[] = [p[0], p[1], add(p[1], scale(n, w)), add(p[0], scale(n, w))];
      const b = o.base, r = quad(q, b, o.construction);
      r.constraints.push(cons('perpendicular', b, 'p0', b + 1, 'p0'), cons('parallel', b, 'p0', b + 2, 'p0'), cons('parallel', b + 1, 'p0', b + 3, 'p0'));
      return { ...r, anchors: [{ click: 0, ent: b, role: 'p0' }, { click: 1, ent: b, role: 'p1' }],
        dims: [dimDist('Length', b, 'p0', b, 'p1', dist(p[0], p[1])), dimDist('Width', b + 1, 'p0', b + 1, 'p1', Math.abs(w))] };
    },
  },
  {
    id: 'rect-rounded', title: 'Rounded rectangle', icon: 'i-lucide-square-round-corner', family: 'rect',
    hint: 'Click two opposite corners, then the corner radius', prompts: ['Click the first corner', 'Click the opposite corner', 'Click to set the corner radius'], clicks: 3,
    build: (p, o) => {
      if (p.length < 2) return null;
      const x0 = Math.min(p[0][0], p[1][0]), x1 = Math.max(p[0][0], p[1][0]), y0 = Math.min(p[0][1], p[1][1]), y1 = Math.max(p[0][1], p[1][1]);
      const w = x1 - x0, h = y1 - y0;
      if (w < TOL || h < TOL) return null;
      const cap = Math.min(w, h) / 2 - 1e-3;
      const r = Math.max(1e-3, Math.min(cap, p.length >= 3 ? Math.min(...[[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((c) => dist(c as V2, p[2]))) : Math.min(w, h) * 0.2));
      const b = o.base, C = o.construction, H = Math.PI / 2;
      const entities = [
        line([x0 + r, y0], [x1 - r, y0], C), arc([x1 - r, y0 + r], r, -H, 0, C),
        line([x1, y0 + r], [x1, y1 - r], C), arc([x1 - r, y1 - r], r, 0, H, C),
        line([x1 - r, y1], [x0 + r, y1], C), arc([x0 + r, y1 - r], r, H, 2 * H, C),
        line([x0, y1 - r], [x0, y0 + r], C), arc([x0 + r, y0 + r], r, 2 * H, 3 * H, C),
      ];
      const constraints: SkConstraint[] = [];
      for (let i = 0; i < 8; i++) constraints.push(cons('coincident', b + i, 'p1', b + ((i + 1) % 8), 'p0'));
      for (let i = 0; i < 8; i += 2) constraints.push(cons('tangent', b + i, 'p0', b + i + 1, 'p0'), cons('tangent', b + ((i + 7) % 8), 'p0', b + i, 'p0'));
      constraints.push(cons('horizontal', b, 'p0', b, 'p1'), cons('vertical', b + 2, 'p0', b + 2, 'p1'), cons('horizontal', b + 4, 'p0', b + 4, 'p1'), cons('vertical', b + 6, 'p0', b + 6, 'p1'));
      constraints.push(cons('equal_radius', b + 1, 'p0', b + 3, 'p0'), cons('equal_radius', b + 1, 'p0', b + 5, 'p0'), cons('equal_radius', b + 1, 'p0', b + 7, 'p0'));
      return { entities, constraints, anchors: [],
        dims: [{ label: 'Width', constraint: cons('distance_x', b + 6, 'p0', b + 2, 'p0', w) }, { label: 'Height', constraint: cons('distance_y', b, 'p0', b + 4, 'p0', h) },
          { label: 'Radius', constraint: cons('radius', b + 1, 'center', -1, 'p0', r) }] };
    },
  },
  {
    id: 'circle', title: 'Center circle', icon: 'i-lucide-circle', key: 'c', family: 'circle',
    hint: 'Click the centre, then a point on the circle', prompts: ['Click the centre', 'Click a point on the circle'], clicks: 2,
    build: (p, o) => {
      if (p.length < 2 || dist(p[0], p[1]) < TOL) return null;
      const b = o.base, r = dist(p[0], p[1]);
      return { entities: [circle(p[0], r, o.construction)], constraints: [], anchors: [{ click: 0, ent: b, role: 'center' }, { click: 1, ent: b, role: 'rim' }],
        dims: [{ label: 'Diameter', constraint: cons('diameter', b, 'center', -1, 'p0', 2 * r) }] };
    },
  },
  {
    id: 'circle-2pt', title: '2-point circle', icon: 'i-lucide-circle-dashed', family: 'circle',
    hint: 'Click the two ends of a diameter', prompts: ['Click one end of the diameter', 'Click the other end'], clicks: 2,
    build: (p, o) => {
      if (p.length < 2 || dist(p[0], p[1]) < TOL) return null;
      const b = o.base, r = dist(p[0], p[1]) / 2;
      return { entities: [circle(mid(p[0], p[1]), r, o.construction)], constraints: [], anchors: [{ click: 0, ent: b, role: 'rim' }, { click: 1, ent: b, role: 'rim' }],
        dims: [{ label: 'Diameter', constraint: cons('diameter', b, 'center', -1, 'p0', 2 * r) }] };
    },
  },
  {
    id: 'circle-3pt', title: '3-point circle', icon: 'i-lucide-circle-ellipsis', family: 'circle',
    hint: 'Click three points on the circle', prompts: ['Click a point on the circle', 'Click a second point', 'Click a third point'], clicks: 3,
    build: (p, o) => {
      if (p.length < 2) return null;
      const c = p.length >= 3 ? circleThrough(p[0], p[1], p[2]) : { center: mid(p[0], p[1]), radius: dist(p[0], p[1]) / 2 };
      if (!c || c.radius < TOL) return null;
      const b = o.base;
      return { entities: [circle(c.center, c.radius, o.construction)], constraints: [], anchors: [0, 1, 2].map((k) => ({ click: k, ent: b, role: 'rim' as const })),
        dims: [{ label: 'Diameter', constraint: cons('diameter', b, 'center', -1, 'p0', 2 * c.radius) }] };
    },
  },
  {
    id: 'arc-3pt', title: '3-point arc', icon: 'i-lucide-chevron-up', key: 'a', family: 'arc',
    hint: 'Click the start, the end, then a point on the arc', prompts: ['Click the start of the arc', 'Click the end of the arc', 'Click a point on the arc'], clicks: 3,
    build: (p, o) => {
      if (p.length < 2) return null;
      if (p.length < 3) return dist(p[0], p[1]) < TOL ? null : { entities: [line(p[0], p[1], true)], constraints: [], anchors: [], dims: [] };
      const a = arcThrough(p[0], p[1], p[2]);
      if (!a) return null;
      a.construction = o.construction;
      const b = o.base;
      return { entities: [a], constraints: [], anchors: [{ click: 0, ent: b, role: 'p0' }, { click: 1, ent: b, role: 'p1' }, { click: 2, ent: b, role: 'rim' }],
        dims: [{ label: 'Radius', constraint: cons('radius', b, 'center', -1, 'p0', a.radius) }] };
    },
  },
  {
    id: 'arc-tangent', title: 'Tangent arc', icon: 'i-lucide-redo', family: 'arc',
    hint: 'Start on the end of a line or arc, then click the end of the arc', prompts: ['Click the end of a line or an arc', 'Click the end of the arc'], clicks: 2,
    build: (p, o) => {
      const s = o.snaps[0];
      if (p.length < 2 || !s || s.kind !== 'end' || s.entity < 0 || !s.role) return null;
      const from = o.entities[s.entity];
      const t = from ? endTangent(from, s.role) : null;
      if (!t) return null;
      const a = tangentArc(s.p, t, p[1]);
      if (!a || a.radius > 1e5) return null;
      a.construction = o.construction;
      const b = o.base;
      return { entities: [a], constraints: o.final ? [cons('tangent', s.entity, 'p0', b, 'p0')] : [], anchors: [{ click: 0, ent: b, role: 'p0' }, { click: 1, ent: b, role: 'p1' }],
        dims: [{ label: 'Radius', constraint: cons('radius', b, 'center', -1, 'p0', a.radius) }] };
    },
  },
  {
    id: 'arc-center', title: 'Center-point arc', icon: 'i-lucide-rotate-ccw', family: 'arc',
    hint: 'Click the centre, the start, then the end (counter-clockwise)', prompts: ['Click the centre', 'Click the start of the arc', 'Click the end of the arc'], clicks: 3,
    build: (p, o) => {
      if (p.length < 2 || dist(p[0], p[1]) < TOL) return null;
      const b = o.base, r = dist(p[0], p[1]);
      if (p.length < 3) return { entities: [circle(p[0], r, true)], constraints: [], anchors: [], dims: [] };
      const a0 = angleOf(sub(p[1], p[0]));
      let sw = angleOf(sub(p[2], p[0])) - a0;
      if (sw <= 1e-6) sw += 2 * Math.PI;
      return { entities: [arc(p[0], r, a0, a0 + sw, o.construction)], constraints: [], anchors: [{ click: 0, ent: b, role: 'center' }, { click: 1, ent: b, role: 'p0' }, { click: 2, ent: b, role: 'rim' }],
        dims: [{ label: 'Radius', constraint: cons('radius', b, 'center', -1, 'p0', r) }] };
    },
  },
  {
    id: 'slot', title: 'Slot', icon: 'i-lucide-pill', key: 's', family: 'slot',
    hint: 'Click the two ends of the centre line, then the width', prompts: ['Click one end of the slot’s centre line', 'Click the other end', 'Click to set the width'], clicks: 3,
    build: (p, o) => {
      if (p.length < 2 || dist(p[0], p[1]) < TOL) return null;
      const A = p[0], B = p[1], d = norm(sub(B, A)), n = perp(d);
      const r = p.length >= 3 ? Math.abs(cross(d, sub(p[2], A))) : dist(A, B) * 0.15;
      if (r < TOL) return null;
      const C = o.construction, an = angleOf(n), b = o.base;
      const entities = [
        line(sub(A, scale(n, r)), sub(B, scale(n, r)), C), arc(B, r, an - Math.PI, an, C),
        line(add(B, scale(n, r)), add(A, scale(n, r)), C), arc(A, r, an, an + Math.PI, C),
        line(A, B, true),
      ];
      const constraints: SkConstraint[] = [];
      for (let i = 0; i < 4; i++) constraints.push(cons('coincident', b + i, 'p1', b + ((i + 1) % 4), 'p0'));
      constraints.push(cons('tangent', b, 'p0', b + 1, 'p0'), cons('tangent', b + 2, 'p0', b + 1, 'p0'), cons('tangent', b + 2, 'p0', b + 3, 'p0'), cons('tangent', b, 'p0', b + 3, 'p0'));
      constraints.push(cons('coincident', b + 1, 'center', b + 4, 'p1'), cons('coincident', b + 3, 'center', b + 4, 'p0'), cons('equal_radius', b + 1, 'p0', b + 3, 'p0'));
      return { entities, constraints, anchors: [{ click: 0, ent: b + 4, role: 'p0' }, { click: 1, ent: b + 4, role: 'p1' }],
        dims: [dimDist('Length', b + 4, 'p0', b + 4, 'p1', dist(A, B)), { label: 'Radius', constraint: cons('radius', b + 1, 'center', -1, 'p0', r) }] };
    },
  },
  {
    // Orca's make_arc_slot: an outer arc (Rc + w), the cap at the end, the inner arc (Rc − w, run
    // backwards) and the cap at the start — a closed chain of four arcs. Only the start snaps
    // (click_snaps: the centre and the end direction are free, the width is a size).
    id: 'arc-slot', title: 'Arc slot', icon: 'i-lucide-rainbow', family: 'slot',
    hint: 'Click the centre, the start and the end of the centre line, then the width',
    prompts: ['Click the centre the slot curves about', 'Click the start of the centre line (this sets the radius)', 'Click the end of the centre line', 'Click to set the width'], clicks: 4,
    snapClick: (n) => n === 1,
    build: (p, o) => {
      if (p.length < 2 || dist(p[0], p[1]) < TOL) return null;
      const c = p[0], Rc = dist(c, p[1]), aS = angleOf(sub(p[1], c));
      // Rubber band: the centre-line circle, then the centre-line arc (counter-clockwise from the start).
      if (p.length < 3) return { entities: [circle(c, Rc, true)], constraints: [], anchors: [], dims: [] };
      if (dist(c, p[2]) < TOL) return null;
      let sw = angleOf(sub(p[2], c)) - aS;
      while (sw < 0) sw += 2 * Math.PI;
      while (sw >= 2 * Math.PI) sw -= 2 * Math.PI;
      if (sw < 1e-6) return null;
      const aE = aS + sw;
      if (p.length < 4) return { entities: [arc(c, Rc, aS, aE, true)], constraints: [], anchors: [], dims: [] };
      const w = Math.abs(dist(c, p[3]) - Rc);
      if (w < TOL || w >= Rc) return null; // make_arc_slot needs 0 < w < Rc
      const C = o.construction, b = o.base, H = Math.PI;
      const Sc: V2 = [c[0] + Rc * Math.cos(aS), c[1] + Rc * Math.sin(aS)], Ec: V2 = [c[0] + Rc * Math.cos(aE), c[1] + Rc * Math.sin(aE)];
      const entities = [arc(c, Rc + w, aS, aE, C), arc(Ec, w, aE, aE + H, C), arc(c, Rc - w, aE, aS, C), arc(Sc, w, aS + H, aS + 2 * H, C)];
      // The chain closed end to end, tangent at every joint, inner and outer concentric: the four
      // arcs stay an arc slot (6 degrees of freedom: centre, radius, width, start and end angle).
      // Equal caps and the caps' centres on the centre line follow from the tangents.
      const constraints: SkConstraint[] = [];
      for (let i = 0; i < 4; i++) constraints.push(cons('coincident', b + i, 'p1', b + ((i + 1) % 4), 'p0'));
      for (let i = 0; i < 4; i++) constraints.push(cons('tangent', b + i, 'p0', b + ((i + 1) % 4), 'p0'));
      constraints.push(cons('coincident', b + 2, 'center', b, 'center'));
      return { entities, constraints, anchors: [{ click: 1, ent: b + 3, role: 'center' }],
        // Orca's size fields: the centre-line Radius, then the full Width.
        dims: [{ label: 'Radius', constraint: cons('distance', b, 'center', b + 3, 'center', Rc) }, { label: 'Width', constraint: cons('diameter', b + 1, 'center', -1, 'p0', 2 * w) }] };
    },
  },
  {
    id: 'polygon', title: 'Polygon', icon: 'i-lucide-hexagon', key: 'g', family: 'polygon',
    hint: 'Click the centre, then a corner (inscribed) or the middle of a side (circumscribed)', prompts: ['Click the centre of the polygon', 'Click a corner'], clicks: 2,
    build: (p, o) => {
      if (p.length < 2 || dist(p[0], p[1]) < TOL) return null;
      const n = Math.max(3, Math.min(64, Math.round(o.polygonSides))), c = p[0];
      let R = dist(c, p[1]), a0 = angleOf(sub(p[1], c));
      if (o.polygonCircumscribed) { R /= Math.cos(Math.PI / n); a0 += Math.PI / n; }
      const v: V2[] = [];
      for (let i = 0; i < n; i++) v.push([c[0] + R * Math.cos(a0 + (2 * Math.PI * i) / n), c[1] + R * Math.sin(a0 + (2 * Math.PI * i) / n)]);
      const b = o.base;
      const entities = v.map((q, i) => line(q, v[(i + 1) % n], o.construction));
      entities.push(circle(c, R, true));
      const constraints: SkConstraint[] = [];
      for (let i = 0; i < n; i++) constraints.push(cons('coincident', b + i, 'p1', b + ((i + 1) % n), 'p0'));
      for (let i = 1; i < n; i++) constraints.push(cons('equal_length', b, 'p0', b + i, 'p0'));
      for (let i = 0; i < n; i++) constraints.push(cons('point_on_object', b + i, 'p0', b + n));
      return { entities, constraints, anchors: [{ click: 0, ent: b + n, role: 'center' }],
        dims: [{ label: 'Diameter', constraint: cons('diameter', b + n, 'center', -1, 'p0', 2 * R) }] };
    },
  },
  {
    id: 'ellipse', title: 'Ellipse', icon: 'i-lucide-egg', key: 'e', family: 'ellipse',
    hint: 'Click the centre, the end of the major axis, then the minor radius', prompts: ['Click the centre', 'Click the end of the major axis', 'Click to set the minor radius'], clicks: 3,
    build: (p, o) => {
      if (p.length < 2 || dist(p[0], p[1]) < TOL) return null;
      const R = dist(p[0], p[1]), rot = angleOf(sub(p[1], p[0]));
      const b = p.length >= 3 ? Math.abs(cross(norm(sub(p[1], p[0])), sub(p[2], p[0]))) : R / 2;
      if (b < TOL) return null;
      return { entities: [entity('ellipse', { center: p[0], radius: R, rminor: b, rotation: rot, construction: o.construction })], constraints: [], anchors: [{ click: 0, ent: o.base, role: 'center' }], dims: [] };
    },
  },
  {
    id: 'ellipse-arc', title: 'Elliptical arc', icon: 'i-lucide-egg-fried', family: 'ellipse',
    hint: 'Click the centre, the major axis end, the minor radius, then the start and end', prompts: ['Click the centre', 'Click the end of the major axis', 'Click to set the minor radius', 'Click the start of the arc', 'Click the end of the arc'], clicks: 5,
    build: (p, o) => {
      if (p.length < 2 || dist(p[0], p[1]) < TOL) return null;
      const R = dist(p[0], p[1]), rot = angleOf(sub(p[1], p[0]));
      const bm = p.length >= 3 ? Math.abs(cross(norm(sub(p[1], p[0])), sub(p[2], p[0]))) : R / 2;
      if (bm < TOL) return null;
      const e = { center: p[0], radius: R, rminor: bm, rotation: rot };
      if (p.length < 4) return { entities: [entity('ellipse', { ...e, construction: true })], constraints: [], anchors: [], dims: [] };
      const param = (q: V2) => {
        const d = sub(q, p[0]), c = Math.cos(-rot), s = Math.sin(-rot);
        return Math.atan2((d[0] * s + d[1] * c) / bm, (d[0] * c - d[1] * s) / R);
      };
      const t0 = param(p[3]);
      let t1 = p.length >= 5 ? param(p[4]) : t0 + Math.PI / 2;
      if (t1 <= t0 + 1e-6) t1 += 2 * Math.PI;
      const ea = entity('ellipse_arc', { ...e, start_angle: t0, end_angle: t1, construction: o.construction });
      ea.p0 = onEllipse(e, t0); ea.p1 = onEllipse(e, t1);
      return { entities: [ea], constraints: [], anchors: [{ click: 0, ent: o.base, role: 'center' }], dims: [] };
    },
  },
  {
    id: 'spline', title: 'Spline', icon: 'i-lucide-spline', key: 'b', family: 'spline',
    hint: 'Click the control points; double-click, right-click or Enter to finish', prompts: ['Click the first control point', 'Click the next control point — Enter, right-click or double-click finishes'], clicks: 'chain',
    build: (p, o) => {
      if (p.length < 2) return null;
      return { entities: [entity('spline', { ctrl: p.map((q) => [q[0], q[1]] as V2), construction: o.construction })], constraints: [],
        anchors: [{ click: 0, ent: o.base, role: 'p0' }, { click: p.length - 1, ent: o.base, role: 'p1' }], dims: [] };
    },
  },
  {
    id: 'point', title: 'Point', icon: 'i-lucide-dot', key: 'p', family: 'point',
    hint: 'Click to place a point', prompts: ['Click to place a point'], clicks: 1,
    build: (p, o) => (p.length < 1 ? null : { entities: [point(p[0], o.construction)], constraints: [], anchors: [{ click: 0, ent: o.base, role: 'p0' }], dims: [] }),
  },
];
export const DRAW_TOOL_BY_ID = new Map(DRAW_TOOLS.map((t) => [t.id, t]));

/** "Exactly" for a scripted add: equal up to float noise (an arc's ends come from cos / sin). */
const EXACT = 1e-9;

/**
 * A scripted draw's inference (the MCP bridge's `design_sketch_add` with a tool and `infer`): what
 * the mouse would have recorded had each click landed exactly on what it touches, at zero
 * tolerance as Orca's scripted add — an existing end / centre or the origin (snapping clicks only),
 * and an exactly level / plumb segment for the line tools.
 */
export function exactClickInference(t: DrawTool, pts: readonly V2[], entities: readonly SkEntity[]): { snaps: Array<Snap | null>; axes: Array<'horizontal' | 'vertical' | null> } {
  const snaps = pts.map((p, i) => {
    if (t.snapClick && !t.snapClick(i)) return null;
    const s = snapPoint(entities, p, EXACT, { edges: false });
    return s.kind === 'end' || s.kind === 'center' || s.kind === 'origin' ? s : null;
  });
  const lineish = t.id === 'line' || t.id === 'polyline';
  const axes = pts.map((p, i): 'horizontal' | 'vertical' | null => {
    if (!lineish || i === 0) return null;
    const a = pts[i - 1];
    if (Math.abs(p[1] - a[1]) <= EXACT && Math.abs(p[0] - a[0]) > EXACT) return 'horizontal';
    if (Math.abs(p[0] - a[0]) <= EXACT && Math.abs(p[1] - a[1]) > EXACT) return 'vertical';
    return null;
  });
  return { snaps, axes };
}

/**
 * The rest of Orca's scripted-add joins: a Coincident for each other end of the new shape that lies
 * exactly on an existing end. One join per location — a corner the shape already joins internally,
 * or one a click anchor (`anchored`) already pinned, is not joined twice (that would be redundant
 * and the solver refuses redundant systems).
 */
export function exactJoins(b: Built, base: number, anchored: readonly SkConstraint[], entities: readonly SkEntity[]): SkConstraint[] {
  const out: SkConstraint[] = [];
  const done: V2[] = [];
  const near = (p: V2, q: V2) => Math.abs(p[0] - q[0]) <= EXACT && Math.abs(p[1] - q[1]) <= EXACT;
  for (const c of anchored) {
    const e = b.entities[c.ea - base];
    if (e && c.ea >= base) done.push(rolePoint(e, c.ra));
  }
  b.entities.forEach((e, k) => {
    for (const end of ends(e)) {
      if (done.some((p) => near(p, end.p))) continue;
      let hit = -1, role: Role = 'p0';
      entities.forEach((o, j) => { if (hit < 0) for (const oe of ends(o)) if (hit < 0 && near(oe.p, end.p)) { hit = j; role = oe.role; } });
      if (hit < 0) continue;
      out.push(cons('coincident', base + k, end.role, hit, role));
      done.push(end.p);
    }
  });
  return out;
}

/** Constraints the clicks' snaps make on the built shape (anchors → Coincident / Midpoint / Point on object). */
export function anchorConstraints(b: Built, snaps: ReadonlyArray<Snap | null>, entities: readonly SkEntity[]): SkConstraint[] {
  const out: SkConstraint[] = [];
  for (const a of b.anchors) {
    const s = snaps[a.click];
    if (!s || s.kind === 'none') continue;
    if (a.role === 'rim') {
      // A rim through an existing point: that point on the new curve.
      if ((s.kind === 'end' || s.kind === 'center') && s.entity >= 0) out.push(cons('point_on_object', s.entity, s.role ?? 'p0', a.ent));
      continue;
    }
    switch (s.kind) {
      case 'end': case 'center': out.push(cons('coincident', a.ent, a.role, s.entity, s.role ?? 'p0')); break;
      case 'origin': out.push(cons('coincident', a.ent, a.role, -2, 'p0')); break;
      case 'midpoint': out.push(entities[s.entity]?.type === 'line' ? cons('midpoint', a.ent, a.role, s.entity) : cons('point_on_object', a.ent, a.role, s.entity)); break;
      case 'edge': out.push(cons('point_on_object', a.ent, a.role, s.entity)); break;
    }
  }
  return out;
}

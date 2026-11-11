<script setup lang="ts">
/**
 * The live sketch drawn over the Design view (Orca's DesignSketchTool overlay): entities
 * coloured by constraint state (under-constrained blue, fully constrained white, conflicting red;
 * construction dashed; selected / hovered highlighted), closed regions shaded, vertices, the
 * sketch axes, the rubber band and snap hints of the active tool, constraint badges and
 * dimensions (click a dimension to edit it, a badge to delete its constraint — Shift+click selects it),
 * Orca's live measurement labels on the dragged / lone selected entity (click one: it becomes a dimension),
 * the outlines' move / scale handles (Text / SVG), and the inline
 * value editor (Orca's SketchInlineEditor: Enter applies, Tab applies and moves on, Esc keeps
 * the geometry as drawn; numbers or expressions over the design's variables).
 *
 * Geometry is projected through the 3D camera every frame the scene renders, so it stays on the
 * plane however the view moves. Pointer input on the canvas is routed to the driver while the
 * session is open (left button / one finger; right-drag and two fingers still navigate).
 */
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { DesignScene, SketchPointer } from '../scene/DesignScene';
import { design } from '../session';
import {
  add, dist, ends, hasCenter, isDimension, midpointOf, norm, onCircle, perp, rolePoint, sample, scale, sub, toWorld,
  type SkConstraint, type SkEntity, type V2,
} from '../sketch/model';
import { CONSTRAINT_BY_TYPE, constraintEntities, describeConstraint, dimensionText, fromWire } from '../sketch/constraints';
import { sk, setConstraintValue, requestValue, deleteConstraints, toggleConstruction, deleteSelection, finishSketch, cancelSketch, applyConstraint, badgeClick, regionCorners, dragRegionHandle, regionPoint, promoteQuote } from '../sketch/session';
import { liveQuotes, quotedEntity, shapeGroups, type LiveQuote, type ShapeGroup } from '../sketch/quotes';
import { live, pointerContext, pointerDbl, pointerDown, pointerMove, pointerUp, setTool, type PointerCtx } from '../sketch/driver';
import { evalValue } from '../sketch/expr';
import { SNAP_LABEL } from '../sketch/infer';

const props = defineProps<{ scene: DesignScene | null }>();

const tick = ref(0);
const size = ref({ w: 1, h: 1 });
let offView: (() => void) | null = null;
watch(() => props.scene, (s, _o, onCleanup) => {
  offView?.(); offView = null;
  if (!s) return;
  offView = s.onView(() => {
    const el = s.renderer.domElement;
    if (el.clientWidth !== size.value.w || el.clientHeight !== size.value.h) size.value = { w: el.clientWidth, h: el.clientHeight };
    tick.value++;
  });
  onCleanup(() => { offView?.(); offView = null; });
}, { immediate: true });
onBeforeUnmount(() => { offView?.(); props.scene?.setSketchInput(null); });

// ---- projection ----------------------------------------------------------------------------
const plane = computed(() => sk.plane);
function P(p: V2): [number, number] {
  const s = props.scene, f = plane.value;
  if (!s || !f) return [0, 0];
  const [x, y] = s.project(toWorld(f, p));
  return [x, y];
}
/** Plane mm per screen px around the plane origin (offsets of glyphs and dimension lines). */
const mmPerPx = computed(() => {
  void tick.value;
  const a = P([0, 0]), b = P([10, 0]), c = P([0, 10]);
  const px = Math.max(dist(a, b), dist(a, c)) / 10;
  return px > 1e-9 ? 1 / px : 1;
});
const path = (pts: readonly V2[], close = false) => {
  if (!pts.length) return '';
  let d = '';
  for (let i = 0; i < pts.length; i++) { const [x, y] = P(pts[i]); d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }
  return close ? `${d}Z` : d;
};

// ---- entity styling ---------------------------------------------------------------------------
const badEntities = computed(() => new Set(sk.bad.flatMap((i) => (sk.constraints[i] ? constraintEntities(sk.constraints[i]) : []))));
const selEntities = computed(() => new Set(sk.sel.map((s) => s.e)));
const consEntities = computed(() => new Set(sk.selCons.flatMap((i) => (sk.constraints[i] ? constraintEntities(sk.constraints[i]) : []))));
const stateClass = computed(() => (!sk.solveOk ? 'bad' : sk.dof === 0 ? 'fixed' : 'free'));

const entityPaths = computed(() => {
  void tick.value;
  return sk.entities.map((e, i) => ({
    i, d: e.type === 'point' ? '' : path(sample(e, 72)), construction: e.construction,
    cls: badEntities.value.has(i) ? 'bad' : selEntities.value.has(i) || consEntities.value.has(i) ? 'sel' : live.hover?.e === i && live.hover.role === undefined ? 'hover' : stateClass.value,
  }));
});

/** Closed regions (the loop report), shaded: each loop chained end to end, holes by even-odd. */
const regionPath = computed(() => {
  void tick.value;
  const loops = sk.loops?.closed_loops ?? [];
  let d = '';
  for (const l of loops) {
    if (!l.closed) continue;
    const pts: V2[] = [];
    for (const ei of l.entities) {
      const e = sk.entities[ei];
      if (!e) continue;
      let s = sample(e, 48);
      if (pts.length && s.length > 1 && dist(pts[pts.length - 1], s[s.length - 1]) < dist(pts[pts.length - 1], s[0])) s = s.slice().reverse();
      pts.push(...s);
    }
    d += path(pts, true);
  }
  return d;
});

/** Text / SVG outlines waiting for Finish (rigid regions). */
const outlinePath = computed(() => {
  void tick.value;
  const r = sk.regions;
  if (!r) return '';
  return r.regions.map((reg) => reg.map((loop) => path(loop.map((p) => regionPoint(p, r)), true)).join('')).join('');
});

/**
 * Orca's TransformArt gizmo on the outlines: their box, a handle on each corner (drag: scale,
 * the opposite corner stays) and one in the centre (drag: move). Handles take their own pointer
 * (captured), so the sketch tools never see the drag.
 */
const xform = computed(() => {
  void tick.value;
  const c = regionCorners();
  if (!c) return null;
  const s = c.map((p) => P(p));
  const mid: [number, number] = [(s[0][0] + s[2][0]) / 2, (s[0][1] + s[2][1]) / 2];
  return { box: `M${s.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}Z`, handles: [...s, mid] };
});
let xfDrag: { h: number; anchor: V2 } | null = null;
const xfActive = ref(-1);
function planeAt(ev: PointerEvent): V2 | null { return props.scene && sk.plane ? props.scene.planePoint(ev.clientX, ev.clientY, sk.plane) : null; }
function xfDown(h: number, ev: PointerEvent) {
  const q = planeAt(ev), c = regionCorners();
  if (!q || !c) return;
  (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
  xfDrag = { h, anchor: h === 4 ? q : c[(h + 2) % 4] };
  xfActive.value = h;
}
function xfMove(ev: PointerEvent) {
  if (!xfDrag) return;
  const q = planeAt(ev);
  if (!q) return;
  dragRegionHandle(xfDrag.h, xfDrag.anchor, q);
  if (xfDrag.h === 4) xfDrag.anchor = q; // the centre moves by the travel since the last event
}
function xfUp() { xfDrag = null; xfActive.value = -1; }

const vertices = computed(() => {
  void tick.value;
  const out: Array<{ key: string; x: number; y: number; kind: 'end' | 'point' | 'center'; cls: string }> = [];
  sk.entities.forEach((e, i) => {
    const sel = (role?: string) => sk.sel.some((s) => s.e === i && (s.role === role || (e.type === 'point' && s.role === undefined)));
    const hov = (role?: string) => live.hover?.e === i && live.hover.role === role;
    for (const end of ends(e)) { const [x, y] = P(end.p); out.push({ key: `${i}${end.role}`, x, y, kind: e.type === 'point' ? 'point' : 'end', cls: sel(e.type === 'point' ? undefined : end.role) ? 'sel' : hov(e.type === 'point' ? undefined : end.role) ? 'hover' : badEntities.value.has(i) ? 'bad' : stateClass.value }); }
    if (hasCenter(e)) { const [x, y] = P(e.center); out.push({ key: `${i}c`, x, y, kind: 'center', cls: sel('center') ? 'sel' : hov('center') ? 'hover' : stateClass.value }); }
  });
  return out;
});
const openEnds = computed(() => { void tick.value; return (sk.loops?.open_ends ?? []).map((p) => P(p)); });

const previewPaths = computed(() => { void tick.value; return live.preview.map((e) => ({ d: e.type === 'point' ? '' : path(sample(e, 72)), pt: e.type === 'point' ? P(e.p0) : null, construction: e.construction })); });
const clicks = computed(() => { void tick.value; return live.pts.map((p) => P(p)); });

const axes = computed(() => {
  void tick.value;
  const L = 2000;
  return { x: path([[-L, 0], [L, 0]]), y: path([[0, -L], [0, L]]), o: P([0, 0]) };
});

const snapHint = computed(() => {
  void tick.value;
  const c = live.cursor;
  if (!c) return null;
  const [x, y] = P(c);
  const s = live.snap;
  return { x, y, kind: s?.kind ?? 'none', label: s && s.kind !== 'none' ? SNAP_LABEL[s.kind] : live.axis === 'horizontal' ? 'Horizontal' : live.axis === 'vertical' ? 'Vertical' : '' };
});
const band = computed(() => {
  void tick.value;
  const b = live.band;
  if (!b) return null;
  const a = P(b.a), c = P(b.b);
  return { x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), w: Math.abs(c[0] - a[0]), h: Math.abs(c[1] - a[1]), crossing: b.b[0] < b.a[0] };
});

// ---- dimensions ------------------------------------------------------------------------------------
interface DimDraw { i: number; lines: string; arrows: string; x: number; y: number; text: string; bad: boolean; sel: boolean; title: string }
const dims = computed<DimDraw[]>(() => {
  void tick.value;
  const out: DimDraw[] = [];
  const off = 18 * mmPerPx.value;
  const ent = (i: number) => sk.entities[i];
  sk.constraints.forEach((c, i) => {
    if (!isDimension(c)) return;
    const d = dimGeometry(c, off, ent);
    if (!d) return;
    const [x, y] = P(d.label);
    out.push({ i, lines: d.lines.map((l) => path(l)).join(''), arrows: d.arrows.map((a) => path(a)).join(''), x, y, text: dimensionText(c), bad: sk.bad.includes(i), sel: sk.selCons.includes(i), title: describeConstraint(c, sk.entities, i) });
  });
  return out;
});

function arrowHead(tip: V2, from: V2, s: number): V2[] { const d = norm(sub(tip, from)), n = perp(d); return [add(sub(tip, scale(d, s)), scale(n, s * 0.45)), tip, sub(sub(tip, scale(d, s)), scale(n, s * 0.45))]; }

function dimGeometry(c: SkConstraint, off: number, ent: (i: number) => SkEntity | undefined): { lines: V2[][]; arrows: V2[][]; label: V2 } | null {
  const a = ent(c.ea);
  if (!a) return null;
  const ah = 7 * mmPerPx.value;
  if (c.type === 'radius' || c.type === 'diameter') {
    const ang = a.type === 'arc' ? (a.start_angle + a.end_angle) / 2 : Math.PI / 4;
    const rim = onCircle(a.center, a.radius, ang), dir = norm(sub(rim, a.center));
    if (c.type === 'radius') return { lines: [[a.center, rim]], arrows: [arrowHead(rim, a.center, ah)], label: add(rim, scale(dir, off)) };
    const other = onCircle(a.center, a.radius, ang + Math.PI);
    return { lines: [[other, rim]], arrows: [arrowHead(rim, other, ah), arrowHead(other, rim, ah)], label: add(rim, scale(dir, off)) };
  }
  if (c.type === 'lock_x' || c.type === 'lock_y') { const p = rolePoint(a, c.ra); return { lines: [], arrows: [], label: add(p, [off, off]) }; }
  if (c.type === 'angle') {
    const b = ent(c.eb);
    if (!b || a.type !== 'line' || b.type !== 'line') return null;
    const da = sub(a.p1, a.p0), db = sub(b.p1, b.p0), den = da[0] * db[1] - da[1] * db[0];
    if (Math.abs(den) < 1e-12) return null;
    const t = ((b.p0[0] - a.p0[0]) * db[1] - (b.p0[1] - a.p0[1]) * db[0]) / den;
    const X = add(a.p0, scale(da, t));
    const far = (l: SkEntity) => (dist(l.p0, X) > dist(l.p1, X) ? l.p0 : l.p1);
    const ua = norm(sub(far(a), X)), ub = norm(sub(far(b), X));
    const r = 34 * mmPerPx.value;
    const a0 = Math.atan2(ua[1], ua[0]);
    let sw = Math.atan2(ub[1], ub[0]) - a0;
    while (sw > Math.PI) sw -= 2 * Math.PI;
    while (sw < -Math.PI) sw += 2 * Math.PI;
    const arcPts: V2[] = [];
    for (let k = 0; k <= 24; k++) arcPts.push(onCircle(X, r, a0 + (sw * k) / 24));
    return { lines: [arcPts], arrows: [], label: onCircle(X, r + off, a0 + sw / 2) };
  }
  if (c.type === 'point_on_line') {
    const b = ent(c.eb);
    if (!b || b.type !== 'line') return null;
    const p = rolePoint(a, c.ra), d = norm(sub(b.p1, b.p0));
    const foot = add(b.p0, scale(d, (p[0] - b.p0[0]) * d[0] + (p[1] - b.p0[1]) * d[1]));
    return { lines: [[p, foot]], arrows: [arrowHead(p, foot, ah), arrowHead(foot, p, ah)], label: add(midOf(p, foot), scale(perp(d), off * 0.6)) };
  }
  // distance / distance_x / distance_y between two points (a line's own length when ea == eb).
  const b = ent(c.eb);
  if (!b) return null;
  const A = rolePoint(a, c.ra), B = rolePoint(b, c.rb);
  let A2: V2, B2: V2;
  if (c.type === 'distance_x') { const y = Math.max(A[1], B[1]) + off; A2 = [A[0], y]; B2 = [B[0], y]; }
  else if (c.type === 'distance_y') { const x = Math.max(A[0], B[0]) + off; A2 = [x, A[1]]; B2 = [x, B[1]]; }
  else {
    let n = perp(norm(sub(B, A)));
    // Put a line's own length on the outside of a closed shape: away from the sketch centre.
    const ctr = centroid();
    if (ctr && (midOf(A, B)[0] - ctr[0]) * n[0] + (midOf(A, B)[1] - ctr[1]) * n[1] < 0) n = scale(n, -1);
    A2 = add(A, scale(n, off)); B2 = add(B, scale(n, off));
  }
  if (dist(A2, B2) < 1e-9) return null;
  return { lines: [[A, A2], [B, B2], [A2, B2]], arrows: [arrowHead(A2, B2, ah), arrowHead(B2, A2, ah)], label: midOf(A2, B2) };
}
const midOf = (a: V2, b: V2): V2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
let ctrCache: { ents: SkEntity[]; c: V2 | null } | null = null;
function centroid(): V2 | null {
  if (ctrCache?.ents === sk.entities) return ctrCache.c;
  let x = 0, y = 0, n = 0;
  for (const e of sk.entities) for (const p of sample(e, 8)) { x += p[0]; y += p[1]; n++; }
  ctrCache = { ents: sk.entities, c: n ? [x / n, y / n] : null };
  return ctrCache.c;
}

// ---- live measurement labels (Orca's render_live_quotes) ----------------------------------------------
interface QuoteDraw { key: string; q: LiveQuote; lines: string; x: number; y: number }
// Grouped shapes (rectangles, slots, polygons…), recognised once per entity / constraint list.
let groupCache: { ents: SkEntity[]; cons: unknown; g: ShapeGroup[] } | null = null;
function groups(): ShapeGroup[] {
  if (groupCache?.ents !== sk.entities || groupCache.cons !== sk.constraints) groupCache = { ents: sk.entities, cons: sk.constraints, g: shapeGroups(sk.entities, sk.constraints) };
  return groupCache.g;
}
const quotes = computed<QuoteDraw[]>(() => {
  void tick.value;
  const ei = quotedEntity(sk.sel, sk.tool, groups());
  if (ei < 0) return [];
  // Orca's label height, 15 px, in plane mm: it sets the offsets and wedge radii.
  return liveQuotes(sk.entities, sk.constraints, ei, 15 * mmPerPx.value, groups()).map((q) => {
    const [x, y] = P(q.label);
    return { key: `${q.e}${q.kind}${q.title ?? ''}`, q, lines: q.lines.map((l) => path(l)).join(''), x, y };
  });
});
function clickQuote(d: QuoteDraw) { void promoteQuote(d.q, [d.x, d.y]); }
const quoteTitle = (q: LiveQuote) => `${q.title ? `${q.title.replace(' (°)', '')} ` : ''}${q.dim || (!q.rotate && (q.kind === 'length' || q.kind === 'radius')) ? `${q.text} — click to make it a dimension` : `${q.text} — click to type a value`}`;

// ---- constraint badges -------------------------------------------------------------------------------
interface Badge { key: string; i: number; x: number; y: number; glyph: string; bad: boolean; sel: boolean; title: string }
const badges = computed<Badge[]>(() => {
  void tick.value;
  const out: Badge[] = [];
  const stack = new Map<string, number>();
  sk.constraints.forEach((c, i) => {
    if (isDimension(c)) return;
    const def = CONSTRAINT_BY_TYPE.get(c.type);
    if (!def) return;
    const title = describeConstraint(c, sk.entities, i);
    if (c.type === 'coincident') {
      // A join is drawn as the vertex itself; its badge only while it is selected or conflicting.
      if (!sk.selCons.includes(i) && !sk.bad.includes(i)) return;
    }
    const targets = c.type === 'coincident' || c.type === 'fix' || c.type === 'midpoint' || c.type === 'point_on_object' || c.type === 'point_on_line'
      ? [{ p: sk.entities[c.ea] ? rolePoint(sk.entities[c.ea], c.ra) : null, key: `${c.ea}${c.ra}` }]
      : constraintEntities(c).slice(0, c.type === 'horizontal' || c.type === 'vertical' ? 1 : 2).map((e) => ({ p: sk.entities[e] ? anchor(sk.entities[e]) : null, key: `e${e}` }));
    // Tiny on screen: no badges (they would hide the geometry), unless selected / conflicting.
    const small = !sk.selCons.includes(i) && !sk.bad.includes(i) && constraintEntities(c).every((e) => screenSize(sk.entities[e]) < 36);
    if (small) return;
    for (const t of targets) {
      if (!t.p) continue;
      const k = stack.get(t.key) ?? 0;
      stack.set(t.key, k + 1);
      const [x, y] = P(t.p);
      out.push({ key: `${i}:${t.key}`, i, x: x + 10 + k * 19, y: y - 16, glyph: def.glyph, bad: sk.bad.includes(i), sel: sk.selCons.includes(i), title });
    }
  });
  return out;
});
function screenSize(e: SkEntity | undefined): number {
  if (!e) return 0;
  if (e.type === 'line') return dist(P(e.p0), P(e.p1));
  if (e.type === 'point' || e.type === 'spline') return 999;
  return (2 * e.radius) / mmPerPx.value;
}
function anchor(e: SkEntity): V2 {
  // A third of the way along (the dimension label sits at the middle).
  if (e.type === 'line') return [e.p0[0] + (e.p1[0] - e.p0[0]) * 0.3, e.p0[1] + (e.p1[1] - e.p0[1]) * 0.3];
  const m = midpointOf(e);
  if (m) return m;
  if (e.type === 'circle' || e.type === 'ellipse') return onCircle(e.center, e.radius, Math.PI / 2);
  if (e.type === 'spline' && e.ctrl.length) return e.ctrl[Math.floor(e.ctrl.length / 2)];
  return e.p0;
}

/** Orca's badge click: Select tool → deletes the constraint; Shift / Ctrl (or another tool) → selects it. */
function clickBadge(i: number, ev: MouseEvent) { void badgeClick(i, ev.shiftKey || ev.ctrlKey || ev.metaKey); }
const badgeTitle = (b: Badge) => (sk.tool === 'select' ? `${b.title} — click to delete (Shift+click selects)` : b.title);

function editDim(i: number) {
  const c = sk.constraints[i];
  if (!c) return;
  sk.selCons = [i]; sk.sel = [];
  const at = dims.value.find((d) => d.i === i);
  requestValue({ label: CONSTRAINT_BY_TYPE.get(c.type)?.label ?? 'Value', value: +fromWire(c.type, c.value).toFixed(4), unit: c.type === 'angle' ? '°' : 'mm', at: null,
    ...(at ? { screen: [at.x, at.y] as [number, number] } : {}), submit: (v) => setConstraintValue(i, v) });
}

// ---- inline value editor ---------------------------------------------------------------------------
const text = ref('');
const err = ref('');
const input = ref<HTMLInputElement | null>(null);
const valuePos = computed(() => {
  void tick.value;
  const v = sk.value;
  if (!v) return null;
  const at = v.screen ?? (v.at ? P(v.at) : [size.value.w / 2, size.value.h / 2]);
  return { x: Math.min(Math.max(at[0], 90), size.value.w - 90), y: Math.min(Math.max(at[1] + 18, 10), size.value.h - 70) };
});
watch(() => sk.value, (v) => {
  err.value = '';
  if (!v) return;
  text.value = String(+v.value.toFixed(v.int ? 0 : 3));
  void nextTick(() => { input.value?.focus(); input.value?.select(); });
});
async function submitValue() {
  const v = sk.value;
  if (!v) return;
  const r = evalValue(text.value, design.variableValues);
  if ('error' in r) { err.value = r.error; return; }
  const n = v.int ? Math.round(r.value) : r.value;
  if (v.min !== undefined && n < v.min) { err.value = `At least ${v.min}`; return; }
  const res = await v.submit(n);
  // A refused constraint: the panel's conflict box (Replace / Keep both) takes over.
  if (res && !sk.conflict) { err.value = res; return; }
  if (sk.value === v) sk.value = null;
}
function cancelValue() { const v = sk.value; sk.value = null; v?.cancel?.(); }
function onValueKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); void submitValue(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelValue(); }
  else if (/^[a-z]$/i.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && sk.value && text.value === String(+sk.value.value.toFixed(sk.value.int ? 0 : 3)) && input.value?.selectionStart === 0 && input.value?.selectionEnd === text.value.length) {
    // Orca: a tool letter while the field is untouched keeps the shape as drawn and switches tool.
    e.preventDefault();
    cancelValue();
    input.value?.blur();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, code: e.code, shiftKey: e.shiftKey, bubbles: true }));
  }
}

// ---- pointer routing ----------------------------------------------------------------------------------
function ctx(e: SketchPointer): { q: V2 | null; c: PointerCtx } {
  const s = props.scene!, f = sk.plane!;
  const q = s.planePoint(e.clientX, e.clientY, f);
  const q1 = s.planePoint(e.clientX + 1, e.clientY, f);
  const mm = q && q1 ? Math.max(1e-6, dist(q, q1)) : mmPerPx.value;
  return { q, c: { mmPerPx: mm, touch: e.touch, shift: e.shift, ctrl: e.ctrl, clientX: e.clientX, clientY: e.clientY, pickEdge: () => { const pe = s.pickEdgeAt(e.clientX, e.clientY, 14); return pe ? { ...pe, generation: design.generation } : null; } } };
}
const menu = shallowRef<{ x: number; y: number } | null>(null);
watch([() => props.scene, () => sk.open], ([s, open]) => {
  if (!s) return;
  if (!open) { s.setSketchInput(null); return; }
  s.setSketchInput({
    // A click in the view while the value field is open keeps the geometry as drawn (Orca's Esc).
    down: (e) => { menu.value = null; if (sk.value) cancelValue(); const { q, c } = ctx(e); pointerDown(q, c); },
    move: (e, b) => { const { q, c } = ctx(e); pointerMove(q, c, b); },
    up: (e) => { const { q, c } = ctx(e); void pointerUp(q, c); },
    dbl: (e) => { const { q, c } = ctx(e); pointerDbl(q, c); },
    context: (e) => {
      if (pointerContext()) return;
      const r = s.renderer.domElement.getBoundingClientRect();
      menu.value = { x: e.clientX - r.left, y: e.clientY - r.top };
    },
    cancel: () => { live.band = null; },
    leave: () => { live.cursor = null; live.hover = null; },
  });
  s.requestRender();
}, { immediate: true });
// Redraw on any state change (the scene renders on demand).
watch([() => sk.regions, () => sk.entities, () => sk.constraints, () => live.preview, () => live.cursor, () => sk.sel, () => sk.selCons, () => live.hover, () => live.band], () => props.scene?.requestRender());

const menuItems = computed(() => {
  const has = sk.sel.length > 0 || sk.selCons.length > 0;
  return [
    { label: 'Line', icon: 'i-lucide-slash', run: () => setTool('line') },
    { label: 'Rectangle', icon: 'i-lucide-rectangle-horizontal', run: () => setTool('rect') },
    { label: 'Circle', icon: 'i-lucide-circle', run: () => setTool('circle') },
    { label: 'Arc', icon: 'i-lucide-chevron-up', run: () => setTool('arc-3pt') },
    { label: 'Dimension', icon: 'i-lucide-ruler-dimension-line', run: () => setTool('dimension') },
    ...(sk.sel.length >= 2 ? [{ label: 'Coincident', icon: 'i-lucide-merge', run: () => { void applyConstraint('coincident'); } }] : []),
    ...(has ? [{ label: 'Construction on / off', icon: 'i-lucide-square-dashed', run: () => { void toggleConstruction(); } },
      { label: sk.selCons.length && !sk.sel.length ? 'Delete constraint' : 'Delete', icon: 'i-lucide-trash-2', run: () => { void (sk.selCons.length && !sk.sel.length ? deleteConstraints(sk.selCons) : deleteSelection()); } }] : []),
    { label: 'Finish sketch', icon: 'i-lucide-check', run: () => { void finishSketch(); } },
    { label: 'Cancel sketch', icon: 'i-lucide-x', run: () => { void cancelSketch(); } },
  ];
});
</script>

<template>
  <div v-if="sk.open && plane" class="sko" data-testid="sketch-overlay" :data-entities="sk.entities.length" :data-constraints="sk.constraints.length" :data-dof="sk.dof">
    <svg class="sko__svg" :width="size.w" :height="size.h" :viewBox="`0 0 ${size.w} ${size.h}`" aria-hidden="true">
      <path :d="axes.x" class="sko__axis sko__axis--x" />
      <path :d="axes.y" class="sko__axis sko__axis--y" />
      <circle :cx="axes.o[0]" :cy="axes.o[1]" r="3.5" class="sko__origin" />
      <path v-if="regionPath" :d="regionPath" class="sko__region" fill-rule="evenodd" />
      <path v-if="outlinePath" :d="outlinePath" class="sko__outline" fill-rule="evenodd" data-testid="sketch-outline" />
      <path v-if="xform" :d="xform.box" class="sko__xbox" />
      <path v-for="p in entityPaths" :key="`e${p.i}`" :d="p.d" class="sko__ent" :class="[`is-${p.cls}`, { 'is-cons': p.construction }]" />
      <g class="sko__dims">
        <g v-for="d in dims" :key="`d${d.i}`" :class="{ 'is-bad': d.bad, 'is-sel': d.sel }">
          <path :d="d.lines" class="sko__dimline" />
          <path :d="d.arrows" class="sko__dimarrow" />
        </g>
      </g>
      <g class="sko__quotes">
        <path v-for="d in quotes" :key="`q${d.key}`" :d="d.lines" class="sko__quoteline" />
      </g>
      <template v-for="v in vertices" :key="v.key">
        <circle v-if="v.kind !== 'center'" :cx="v.x" :cy="v.y" :r="v.kind === 'point' ? 3.6 : 2.8" class="sko__vtx" :class="[`is-${v.cls}`, { 'is-point': v.kind === 'point' }]" />
        <path v-else :d="`M${v.x - 4} ${v.y}H${v.x + 4}M${v.x} ${v.y - 4}V${v.y + 4}`" class="sko__ctr" :class="`is-${v.cls}`" />
      </template>
      <circle v-for="(p, k) in openEnds" :key="`o${k}`" :cx="p[0]" :cy="p[1]" r="5.5" class="sko__open" />
      <g class="sko__preview">
        <template v-for="(p, k) in previewPaths" :key="`p${k}`">
          <path v-if="p.d" :d="p.d" :class="{ 'is-cons': p.construction }" />
          <circle v-else-if="p.pt" :cx="p.pt[0]" :cy="p.pt[1]" r="3.5" />
        </template>
        <circle v-for="(c, k) in clicks" :key="`c${k}`" :cx="c[0]" :cy="c[1]" r="3" class="sko__click" />
      </g>
      <rect v-if="band" :x="band.x" :y="band.y" :width="band.w" :height="band.h" class="sko__band" :class="{ 'is-crossing': band.crossing }" />
      <g v-if="snapHint && snapHint.kind !== 'none'" class="sko__snap">
        <rect v-if="snapHint.kind === 'end'" :x="snapHint.x - 5" :y="snapHint.y - 5" width="10" height="10" />
        <circle v-else-if="snapHint.kind === 'center' || snapHint.kind === 'origin'" :cx="snapHint.x" :cy="snapHint.y" r="6" />
        <path v-else-if="snapHint.kind === 'midpoint'" :d="`M${snapHint.x} ${snapHint.y - 7}L${snapHint.x + 6} ${snapHint.y + 4}L${snapHint.x - 6} ${snapHint.y + 4}Z`" />
        <path v-else :d="`M${snapHint.x - 5} ${snapHint.y - 5}L${snapHint.x + 5} ${snapHint.y + 5}M${snapHint.x + 5} ${snapHint.y - 5}L${snapHint.x - 5} ${snapHint.y + 5}`" />
      </g>
    </svg>

    <div v-if="snapHint && snapHint.label" class="sko__hint" :style="{ left: `${snapHint.x + 12}px`, top: `${snapHint.y + 10}px` }" data-testid="sketch-snap-hint">{{ snapHint.label }}</div>

    <template v-if="xform">
      <span v-for="(h, k) in xform.handles" :key="`x${k}`" class="sko__xh" :class="{ 'is-move': k === 4, 'is-on': xfActive === k }"
            :style="{ left: `${h[0]}px`, top: `${h[1]}px` }" :title="k === 4 ? 'Drag to move the outline' : 'Drag to scale the outline (the opposite corner stays)'"
            :data-testid="k === 4 ? 'sketch-outline-move' : `sketch-outline-corner-${k}`"
            @pointerdown.stop.prevent="xfDown(k, $event)" @pointermove.stop="xfMove" @pointerup.stop="xfUp" @pointercancel.stop="xfUp" />
    </template>

    <button v-for="b in badges" :key="b.key" type="button" class="sko__badge" :class="{ 'is-bad': b.bad, 'is-sel': b.sel }"
            :style="{ left: `${b.x}px`, top: `${b.y}px` }" :title="badgeTitle(b)" :aria-label="badgeTitle(b)" :data-constraint="b.i" data-testid="sketch-badge" @click.stop="clickBadge(b.i, $event)">{{ b.glyph }}</button>

    <button v-for="d in dims" :key="`l${d.i}`" type="button" class="sko__dimlabel" :class="{ 'is-bad': d.bad, 'is-sel': d.sel }"
            :style="{ left: `${d.x}px`, top: `${d.y}px` }" :title="`${d.title} — click to edit`" data-testid="sketch-dimension" @click.stop="editDim(d.i)">{{ d.text }}</button>

    <button v-for="d in quotes" :key="`ql${d.key}`" type="button" class="sko__dimlabel sko__quote" :style="{ left: `${d.x}px`, top: `${d.y}px` }"
            :title="quoteTitle(d.q)" :data-kind="d.q.kind" data-testid="sketch-quote" @click.stop="clickQuote(d)">{{ d.q.text }}</button>

    <form v-if="sk.value && valuePos" class="sko__val" :style="{ left: `${valuePos.x}px`, top: `${valuePos.y}px` }" data-testid="sketch-value" @submit.prevent="submitValue">
      <label class="sko__vallabel" for="sko-value">{{ sk.value.label }}</label>
      <div class="sko__valrow">
        <input id="sko-value" ref="input" v-model="text" class="sko__input" inputmode="decimal" autocomplete="off" spellcheck="false" :aria-invalid="!!err" @keydown="onValueKey" />
        <span v-if="sk.value.unit" class="sko__unit">{{ sk.value.unit }}</span>
        <button type="submit" class="sko__ok" aria-label="Apply">↵</button>
      </div>
      <span v-if="err" class="sko__err" role="alert">{{ err }}</span>
      <span v-else class="sko__tip">Enter applies · Esc keeps as drawn · variables allowed</span>
    </form>

    <div v-if="menu" class="sko__menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" role="menu" @pointerdown.stop>
      <button v-for="m in menuItems" :key="m.label" type="button" role="menuitem" class="sko__mi" @click="menu = null; m.run()">
        <UIcon :name="m.icon" class="size-4" /><span>{{ m.label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.sko { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.sko__svg { position: absolute; inset: 0; overflow: visible; }
.sko__axis { fill: none; stroke-width: 1; stroke-dasharray: 2 5; opacity: 0.75; }
.sko__axis--x { stroke: var(--vp-sketch-axis-x); }
.sko__axis--y { stroke: var(--vp-sketch-axis-y); }
.sko__origin { fill: var(--vp-sketch-glyph-bg); stroke: var(--fg-0); stroke-width: 1.4; }
.sko__region { fill: var(--vp-sketch-region); stroke: none; }
.sko__outline { fill: color-mix(in srgb, var(--vp-sketch-fixed) 18%, transparent); stroke: var(--vp-sketch-fixed); stroke-width: 1.2; }
.sko__xbox { fill: none; stroke: var(--vp-sketch-fixed); stroke-width: 1; stroke-dasharray: 4 3; opacity: 0.9; }
.sko__xh {
  position: absolute; pointer-events: auto; touch-action: none; width: 12px; height: 12px; transform: translate(-50%, -50%); cursor: nwse-resize;
  background: var(--vp-sketch-fixed); border: 1px solid var(--vp-sketch-glyph-bg); border-radius: 2px;
}
.sko__xh.is-move { cursor: move; border-radius: 50%; }
.sko__xh.is-on { background: var(--vp-sketch-hover); }
.sko__ent { fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.sko__ent.is-free, .sko__vtx.is-free, .sko__ctr.is-free { stroke: var(--vp-sketch-free); }
.sko__ent.is-fixed, .sko__vtx.is-fixed, .sko__ctr.is-fixed { stroke: var(--vp-sketch-fixed); }
.sko__ent.is-bad, .sko__vtx.is-bad, .sko__ctr.is-bad { stroke: var(--vp-sketch-bad); }
.sko__ent.is-sel, .sko__vtx.is-sel, .sko__ctr.is-sel { stroke: var(--vp-sketch-sel); }
.sko__ent.is-sel { stroke-width: 3.2; }
.sko__ent.is-hover, .sko__vtx.is-hover, .sko__ctr.is-hover { stroke: var(--vp-sketch-hover); }
.sko__ent.is-hover { stroke-width: 3; }
.sko__ent.is-cons { stroke-width: 1.4; stroke-dasharray: 7 5; opacity: 0.9; }
.sko__vtx { fill: var(--vp-sketch-glyph-bg); stroke-width: 1.6; }
.sko__vtx.is-point { fill: currentColor; }
.sko__vtx.is-point.is-free { fill: var(--vp-sketch-free); }
.sko__vtx.is-point.is-fixed { fill: var(--vp-sketch-fixed); }
.sko__vtx.is-sel { fill: var(--vp-sketch-sel); }
.sko__ctr { stroke-width: 1.4; fill: none; }
.sko__open { fill: none; stroke: var(--warn); stroke-width: 1.6; stroke-dasharray: 2 2; }
.sko__dimline { fill: none; stroke: var(--vp-sketch-dim); stroke-width: 1; opacity: 0.9; }
.sko__dimarrow { fill: var(--vp-sketch-dim); stroke: var(--vp-sketch-dim); stroke-width: 1; }
.sko__dims .is-bad .sko__dimline, .sko__dims .is-bad .sko__dimarrow { stroke: var(--vp-sketch-bad); fill: var(--vp-sketch-bad); }
.sko__dims .is-sel .sko__dimline, .sko__dims .is-sel .sko__dimarrow { stroke: var(--vp-sketch-sel); fill: var(--vp-sketch-sel); }
.sko__preview path { fill: none; stroke: var(--vp-sketch-preview); stroke-width: 1.8; stroke-dasharray: 6 4; }
.sko__preview path.is-cons { stroke-dasharray: 3 4; }
.sko__preview circle { fill: var(--vp-sketch-preview); }
.sko__click { fill: var(--vp-sketch-preview); }
.sko__band { fill: color-mix(in srgb, var(--vp-sketch-sel) 10%, transparent); stroke: var(--vp-sketch-sel); stroke-width: 1; }
.sko__band.is-crossing { stroke-dasharray: 5 3; fill: color-mix(in srgb, var(--vp-sketch-preview) 10%, transparent); stroke: var(--vp-sketch-preview); }
.sko__snap rect, .sko__snap circle, .sko__snap path { fill: none; stroke: var(--vp-sketch-preview); stroke-width: 2; }
.sko__hint {
  position: absolute; z-index: 3; padding: 1px 6px; font: 600 var(--fs-xs) var(--font); color: var(--vp-sketch-preview); white-space: nowrap;
  background: var(--vp-sketch-glyph-bg); border: 1px solid color-mix(in srgb, var(--vp-sketch-preview) 55%, transparent); border-radius: 4px;
}
.sko__badge, .sko__dimlabel {
  position: absolute; pointer-events: auto; transform: translate(-50%, -50%); cursor: pointer; font-family: var(--font); line-height: 1;
}
.sko__badge {
  min-width: 18px; height: 18px; padding: 0 4px; font-size: 11px; font-weight: 700; color: var(--fg-0);
  background: var(--vp-sketch-glyph-bg); border: 1px solid var(--line-strong); border-radius: 4px;
}
.sko__badge:hover { border-color: var(--vp-sketch-hover); }
.sko__badge.is-sel { color: var(--accent-fg); background: var(--vp-sketch-sel); border-color: var(--vp-sketch-sel); }
.sko__badge.is-bad { color: #fff; background: var(--vp-sketch-bad); border-color: var(--vp-sketch-bad); }
.sko__dimlabel {
  padding: 2px 5px; font-size: var(--fs-sm); font-weight: 600; font-variant-numeric: tabular-nums; color: var(--vp-sketch-dim);
  background: var(--vp-sketch-glyph-bg); border: 1px solid color-mix(in srgb, var(--vp-sketch-dim) 40%, transparent); border-radius: 4px;
}
.sko__dimlabel:hover { border-color: var(--vp-sketch-dim); }
.sko__quoteline { fill: none; stroke: var(--vp-sketch-quote); stroke-width: 1; opacity: 0.9; }
.sko__quote { color: var(--vp-sketch-quote); border-color: color-mix(in srgb, var(--vp-sketch-quote) 40%, transparent); }
.sko__quote:hover { border-color: var(--vp-sketch-quote); }
.sko__dimlabel.is-sel { border-color: var(--vp-sketch-sel); color: var(--vp-sketch-sel); }
.sko__dimlabel.is-bad { border-color: var(--vp-sketch-bad); color: var(--vp-sketch-bad); }
.sko__val {
  position: absolute; pointer-events: auto; transform: translateX(-50%); z-index: 3; display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; min-width: 170px;
  background: var(--bg-1); border: 1px solid var(--vp-sketch-dim); border-radius: 8px; box-shadow: var(--shadow);
}
.sko__vallabel { font: 600 var(--fs-xs) var(--font); color: var(--fg-1); }
.sko__valrow { display: flex; align-items: center; gap: 4px; }
.sko__input {
  width: 110px; height: 28px; padding: 0 6px; font: 600 var(--fs-md) var(--mono); color: var(--fg-0); background: var(--bg-2);
  border: 1px solid var(--line-strong); border-radius: 4px; outline: none;
}
.sko__input:focus { border-color: var(--vp-sketch-dim); }
.sko__input[aria-invalid='true'] { border-color: var(--danger); }
.sko__unit { font-size: var(--fs-sm); color: var(--fg-2); }
.sko__ok { width: 28px; height: 28px; color: var(--fg-0); background: var(--bg-3); border-radius: 4px; }
.sko__err { font-size: var(--fs-xs); color: var(--danger); max-width: 220px; }
.sko__tip { font-size: 10px; color: var(--fg-2); }
.sko__menu {
  position: absolute; pointer-events: auto; z-index: 4; display: flex; flex-direction: column; min-width: 180px; padding: 4px;
  background: var(--bg-1); border: 1px solid var(--line-strong); border-radius: 8px; box-shadow: var(--shadow);
}
.sko__mi { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 8px; font-size: var(--fs-sm); color: var(--fg-0); border-radius: 4px; text-align: left; }
.sko__mi:hover { background: var(--bg-3); }
@media (pointer: coarse) {
  .sko__badge { min-width: 24px; height: 24px; font-size: 13px; }
  .sko__xh { width: 22px; height: 22px; }
  .sko__dimlabel { padding: 5px 8px; font-size: var(--fs-md); }
  .sko__mi { height: 40px; }
}
</style>

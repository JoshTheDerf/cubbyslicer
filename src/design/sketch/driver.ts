/**
 * The sketcher's pointer / key driver (Orca's ModalOperator per tool): turns pointer events in
 * plane coordinates into selections, solver drags, drawn shapes and edit operations.
 *
 * - **Select**: click picks an entity, a vertex (an end / centre) or nothing; Shift / Ctrl add;
 *   a drag on a vertex or an entity drags it under the solver (one undo entry per drag); a drag
 *   on empty space is a rubber band (left → right: enclosed, right → left: crossing, Orca's
 *   proposal); double-click picks the connected loop.
 * - **Drawing tools** (shapes.ts): click sequences with live rubber-banding; every click snaps
 *   (infer.ts) and the hint shown before the click is the constraint applied on it. A press →
 *   drag → release on the first click counts as two clicks (touch drawing). After the shape
 *   lands its dimension queue opens in the inline editor (Tab: next, Esc: keep as drawn).
 * - **Dimension / edit tools**: Orca's click flows (point → point / line, line → length, circle
 *   → diameter, arc → radius; trim / extend on the picked side; fillet / chamfer on a corner or
 *   two lines; offset / mirror / move / rotate / scale / arrays on the selection).
 */
import { markRaw, reactive } from 'vue';
import {
  add, dist, ends, hasCenter, nearestOn, rolePoint, sample, sub,
  type SkConstraint, type SkEntity, type V2,
} from './model';
import { applyAxis, axisHint, snapPoint, SNAP_LABEL, type Snap } from './infer';
import { anchorConstraints, DRAW_TOOL_BY_ID, type Built, type DimSpec, type DrawTool } from './shapes';
import { planLocal, type SelItem } from './constraints';
import {
  addConstraints, addEntities, arrayEntities, beginGesture, drag, endGesture, filletLines, mirrorEntities, offsetEntities, requestValue, sk,
  transformEntities, trimExtend, useEdges, type SketchToolId,
} from './session';
import { setStatus } from '../session';

export interface PointerCtx {
  /** Plane mm per screen px at the cursor. */
  mmPerPx: number;
  touch: boolean;
  shift: boolean;
  ctrl: boolean;
  clientX: number;
  clientY: number;
  /** A body edge under the cursor (Use edges). */
  pickEdge?: () => { body: number; edge: number; generation: number } | null;
}

export const live = reactive({
  /** The (snapped) cursor, plane mm. */
  cursor: null as V2 | null,
  snap: null as Snap | null,
  axis: null as 'horizontal' | 'vertical' | null,
  /** Clicks so far of the drawing tool. */
  pts: [] as V2[],
  snaps: [] as Array<Snap | null>,
  axes: [] as Array<'horizontal' | 'vertical' | null>,
  /** Rubber band shape. */
  preview: markRaw([]) as SkEntity[],
  hover: null as SelItem | null,
  band: null as null | { a: V2; b: V2 },
  /** Dimension tool's first pick / edit tools' picks. */
  first: null as SelItem | null,
  picks: [] as V2[],
  prompt: '',
  /** First point of the chain being drawn (clicking it again closes the loop). */
  chainStart: null as V2 | null,
});

const PX = (c: PointerCtx) => (c.touch ? 22 : 10);
let press: null | { q: V2; x: number; y: number; hit: SelItem | null; mode: 'click' | 'drag' | 'band'; start: V2; ents?: SkEntity[] } = null;
let dimQueue: DimSpec[] = [];

export function resetLive(): void {
  live.pts = []; live.snaps = []; live.axes = []; live.preview = markRaw([]); live.first = null; live.picks = []; live.band = null; live.snap = null; live.axis = null; live.chainStart = null;
  press = null;
  live.prompt = promptFor(sk.tool);
}

export function setTool(t: SketchToolId): void {
  sk.tool = t;
  resetLive();
  const draw = DRAW_TOOL_BY_ID.get(t as never);
  setStatus('info', draw ? `${draw.title}: ${draw.hint}.` : promptFor(t));
}

function promptFor(t: SketchToolId): string {
  const draw = DRAW_TOOL_BY_ID.get(t as never);
  if (draw) return draw.prompts[Math.min(live.pts.length, draw.prompts.length - 1)] ?? '';
  switch (t) {
    case 'select': return 'Click to select; Shift to add; drag a point to move it; double-click for a whole loop';
    case 'dimension': return live.first ? 'Click a second point, or a line (distance to the line)' : 'Click a line (length), a circle / arc (diameter / radius), or a point';
    case 'trim': return 'Click the part of a line, arc or circle to trim away';
    case 'extend': return 'Click near the end of a line or arc to extend it';
    case 'fillet': case 'chamfer': return live.first ? 'Click the second line' : 'Click a corner where two lines meet, or the first line';
    case 'offset': return 'Click a curve (its connected chain is offset), or select entities first';
    case 'mirror': return sk.sel.length ? 'Click the mirror line' : 'Select the entities to mirror, then pick Mirror again — or click them now and then the mirror line';
    case 'move': return live.picks.length ? 'Click the target point (Ctrl copies)' : 'Click the base point of the move';
    case 'rotate': case 'scale': case 'polar': return 'Click the pivot point';
    case 'array': return live.picks.length ? 'Click where the first copy goes' : 'Click the base point';
    case 'use-edges': return 'Click body edges to use them in the sketch';
  }
  return '';
}

// ---- hit testing ---------------------------------------------------------------------------------

/** The entity / vertex under the cursor: vertices first, then the nearest curve. */
export function hitTest(q: V2, tol: number): SelItem | null {
  let best: SelItem | null = null, bd = tol;
  sk.entities.forEach((e, i) => {
    for (const end of ends(e)) { const d = dist(end.p, q); if (d < bd) { bd = d; best = { e: i, role: e.type === 'point' ? undefined : end.role }; } }
    if (hasCenter(e)) { const d = dist(e.center, q); if (d < bd) { bd = d; best = { e: i, role: 'center' }; } }
  });
  if (best) return best;
  bd = tol;
  sk.entities.forEach((e, i) => { if (e.type === 'point') return; const d = nearestOn(e, q).d; if (d < bd) { bd = d; best = { e: i }; } });
  return best;
}

const sameItem = (a: SelItem, b: SelItem) => a.e === b.e && a.role === b.role;

function select(item: SelItem | null, additive: boolean): void {
  sk.selCons = additive ? sk.selCons : [];
  if (!item) { if (!additive) sk.sel = []; return; }
  if (additive) sk.sel = sk.sel.some((s) => sameItem(s, item)) ? sk.sel.filter((s) => !sameItem(s, item)) : [...sk.sel, item];
  else sk.sel = [item];
}

/** Entities chained to `start` by shared ends (double-click: the whole loop). */
export function connected(start: number): number[] {
  const out = new Set([start]);
  const tol = 1e-3;
  let grew = true;
  while (grew) {
    grew = false;
    sk.entities.forEach((e, i) => {
      if (out.has(i)) return;
      for (const j of out) {
        const a = sk.entities[j];
        if (ends(e).some((x) => ends(a).some((y) => dist(x.p, y.p) < tol))) { out.add(i); grew = true; break; }
      }
    });
  }
  return [...out];
}

// ---- drawing ---------------------------------------------------------------------------------------

function drawTool(): DrawTool | null { return DRAW_TOOL_BY_ID.get(sk.tool as never) ?? null; }

function buildOpts(final: boolean) {
  return { base: sk.entities.length, entities: sk.entities, snaps: live.snaps, axes: live.axes, construction: sk.construction, polygonSides: sk.polygonSides, polygonCircumscribed: sk.polygonCircumscribed, final };
}

/** The snapped point for a drawing click at `q` (point snaps beat the H / V snap; Shift suppresses both). */
function snapAt(q: V2, c: PointerCtx): { p: V2; snap: Snap | null; axis: 'horizontal' | 'vertical' | null } {
  if (c.shift) return { p: q, snap: null, axis: null };
  const t = drawTool();
  const s = snapPoint(sk.entities, q, PX(c) * c.mmPerPx);
  const prev = live.pts[live.pts.length - 1];
  const lineish = t && (t.id === 'line' || t.id === 'polyline') && prev;
  // A snapped end within 3° of level / plumb is H / V too (the solver straightens it on the click; the hint says so).
  if (s.kind !== 'none') return { p: s.p, snap: s, axis: lineish ? axisHint(prev, s.p) : null };
  const ax = lineish ? axisHint(prev, q) : null;
  return { p: ax ? applyAxis(prev, q, ax) : q, snap: null, axis: ax };
}

function updatePreview(cursor: V2 | null): void {
  const t = drawTool();
  if (!t || !cursor || !live.pts.length) { live.preview = markRaw([]); return; }
  const pts = [...live.pts, cursor];
  const saveAxes = live.axes, saveSnaps = live.snaps;
  live.axes = [...live.axes, live.axis]; live.snaps = [...live.snaps, live.snap];
  const b = t.build(pts, buildOpts(false));
  live.axes = saveAxes; live.snaps = saveSnaps;
  live.preview = markRaw(b?.entities ?? []);
}

async function clickDraw(p: V2, snap: Snap | null, axis: 'horizontal' | 'vertical' | null): Promise<void> {
  const t = drawTool()!;
  if (t.id === 'arc-tangent' && !live.pts.length && (!snap || snap.kind !== 'end' || !['line', 'arc'].includes(sk.entities[snap.entity]?.type ?? ''))) {
    setStatus('info', 'Tangent arc: start on the end of a line or an arc.');
    return;
  }
  // Chains: clicking the first point again closes the loop and ends the chain.
  const closing = t.id === 'polyline' && !!live.chainStart && live.pts.length >= 1 && snap?.kind === 'end' && dist(snap.p, live.chainStart) < 1e-9;
  if (!live.pts.length) live.chainStart = p;
  live.pts = [...live.pts, p]; live.snaps = [...live.snaps, snap]; live.axes = [...live.axes, axis];
  if (t.id === 'polyline' && live.pts.length >= 2) {
    const b = t.build(live.pts, buildOpts(true));
    if (b) await commitBuilt(b, false, live.snaps.slice());
    // The next segment starts at this one's end, joined to it.
    const lastIndex = sk.entities.length - 1;
    const start = live.chainStart;
    live.pts = [p]; live.snaps = [{ kind: 'end', p, entity: lastIndex, role: 'p1' }]; live.axes = [null];
    live.chainStart = start;
    if (closing) { resetLive(); setStatus('ok', 'Loop closed.'); }
  } else if (typeof t.clicks === 'number' && live.pts.length >= t.clicks) {
    const b = t.build(live.pts, buildOpts(true));
    const snaps = live.snaps.slice();
    resetLive();
    if (b) await commitBuilt(b, true, snaps);
    else setStatus('info', `${t.title}: those points don’t make a shape — try again.`);
  }
  live.prompt = promptFor(sk.tool);
  updatePreview(live.cursor);
}

/** End a chain (Enter / double-click / right-click). */
export async function finishChain(): Promise<boolean> {
  const t = drawTool();
  if (!t || t.clicks !== 'chain') return false;
  if (t.id === 'spline' && live.pts.length >= 2) {
    const b = t.build(live.pts, buildOpts(true));
    const snaps = live.snaps.slice();
    resetLive();
    if (b) await commitBuilt(b, false, snaps);
    return true;
  }
  const had = live.pts.length > 0;
  resetLive();
  return had;
}

async function commitBuilt(b: Built, dims: boolean, snaps: ReadonlyArray<Snap | null>): Promise<void> {
  const extra = anchorConstraints(b, snaps, sk.entities);
  const r = await addEntities(b.entities, [...b.constraints, ...extra], drawTool()?.title ?? 'Draw');
  sk.sel = b.entities.map((_, i) => ({ e: r.first + i })).filter((s) => !sk.entities[s.e]?.construction || b.entities.length === 1);
  if (dims && b.dims.length) { dimQueue = b.dims.slice(); nextDim(); }
}

/** Orca's draw-then-edit queue: the next characteristic dimension in the inline editor. */
function nextDim(): void {
  const d = dimQueue.shift();
  if (!d) { sk.value = null; return; }
  const c = d.constraint;
  const at = labelAnchor(c);
  requestValue({
    label: d.label, value: c.value, unit: c.type === 'angle' ? '°' : 'mm', at,
    submit: async (v) => {
      if (!(v > 0)) return 'Enter a value above 0';
      const err = await addConstraints([{ ...c, value: v }]);
      if (err) return err;
      queueMicrotask(nextDim);
      return null;
    },
    cancel: () => { dimQueue = []; },
  });
}

function labelAnchor(c: SkConstraint): V2 | null {
  const e = sk.entities[c.ea];
  if (!e) return null;
  if (c.type === 'distance' && c.ea === c.eb && e.type === 'line') return [(e.p0[0] + e.p1[0]) / 2, (e.p0[1] + e.p1[1]) / 2];
  if (c.type === 'distance' || c.type === 'distance_x' || c.type === 'distance_y') { const a = rolePoint(e, c.ra), b2 = sk.entities[c.eb] ? rolePoint(sk.entities[c.eb], c.rb) : a; return [(a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2]; }
  return e.type === 'line' ? e.p0 : e.center;
}

// ---- pointer events (plane coordinates) ---------------------------------------------------------------

export function pointerMove(q: V2 | null, c: PointerCtx, pressed: boolean): void {
  if (!q) { live.cursor = null; live.hover = null; return; }
  const tol = PX(c) * c.mmPerPx;
  if (pressed && press) {
    const moved = Math.hypot(c.clientX - press.x, c.clientY - press.y) > (c.touch ? 10 : 4);
    if (press.mode === 'click' && moved) {
      if (sk.tool === 'select') {
        if (press.hit) { press.mode = 'drag'; beginGesture('Drag'); if (!sk.sel.some((s) => sameItem(s, press!.hit!))) select(press.hit, false); press.ents = sk.entities.slice(); }
        else press.mode = 'band';
      }
    }
    if (press.mode === 'drag' && press.hit) { dragTo(press.hit, q, press); return; }
    if (press.mode === 'band') { live.band = { a: press.start, b: q }; return; }
  }
  const draw = drawTool();
  if (draw) {
    const s = snapAt(q, c);
    live.cursor = s.p; live.snap = s.snap; live.axis = s.axis;
    updatePreview(s.p);
    live.hover = null;
    return;
  }
  live.cursor = q;
  live.snap = sk.tool === 'dimension' || sk.tool === 'move' || sk.tool === 'array' || sk.tool === 'rotate' || sk.tool === 'scale' || sk.tool === 'polar' ? (() => { const s = snapPoint(sk.entities, q, tol, { edges: false }); return s.kind === 'none' ? null : s; })() : null;
  live.hover = sk.tool === 'use-edges' ? null : hitTest(q, tol);
}

function dragTo(hit: SelItem, q: V2, p: NonNullable<typeof press>): void {
  const e0 = p.ents?.[hit.e];
  if (!e0) return;
  const d = sub(q, p.start);
  if (hit.role && e0.type !== 'point') { drag({ kind: 'point', entity: hit.e, role: hit.role, to: q }); return; }
  if (e0.type === 'point') { drag({ kind: 'point', entity: hit.e, role: 'p0', to: q }); return; }
  if (e0.type === 'line') { drag({ kind: 'line', index: hit.e, p0: add(e0.p0, d), p1: add(e0.p1, d) }); return; }
  if (e0.type === 'circle' || e0.type === 'arc' || e0.type === 'ellipse' || e0.type === 'ellipse_arc') {
    // Dragging the rim changes the radius (the centre stays).
    const r = Math.max(1e-3, dist(q, e0.center));
    const ne: SkEntity = { ...e0, radius: e0.type === 'ellipse' || e0.type === 'ellipse_arc' ? r : r, rminor: e0.type.startsWith('ellipse') ? e0.rminor * (r / (e0.radius || 1)) : e0.rminor };
    if (e0.type === 'arc') { ne.p0 = [e0.center[0] + r * Math.cos(e0.start_angle), e0.center[1] + r * Math.sin(e0.start_angle)]; ne.p1 = [e0.center[0] + r * Math.cos(e0.end_angle), e0.center[1] + r * Math.sin(e0.end_angle)]; }
    drag({ kind: 'entity', index: hit.e, entity: ne });
    return;
  }
  if (e0.type === 'spline') drag({ kind: 'entity', index: hit.e, entity: { ...e0, ctrl: e0.ctrl.map((v) => add(v, d)), p0: add(e0.p0, d), p1: add(e0.p1, d) } });
}

export function pointerDown(q: V2 | null, c: PointerCtx): void {
  if (!q) return;
  const tol = PX(c) * c.mmPerPx;
  press = { q, x: c.clientX, y: c.clientY, hit: sk.tool === 'select' ? hitTest(q, tol) : null, mode: 'click', start: q };
  if (drawTool() && !live.pts.length) {
    // Touch: the press is the first click (a drag then lands the second on release).
    const s = snapAt(q, c);
    live.cursor = s.p; live.snap = s.snap; live.axis = s.axis;
  }
}

export async function pointerUp(q: V2 | null, c: PointerCtx): Promise<void> {
  const p = press;
  press = null;
  if (!p) return;
  if (p.mode === 'drag') { await endGesture(); return; }
  if (p.mode === 'band') {
    const band = live.band;
    live.band = null;
    if (band) bandSelect(band.a, band.b, c.shift || c.ctrl);
    return;
  }
  if (!q) return;
  const tol = PX(c) * c.mmPerPx;
  const moved = Math.hypot(c.clientX - p.x, c.clientY - p.y) > (c.touch ? 10 : 4);
  const draw = drawTool();
  if (draw) {
    if (moved && !live.pts.length) {
      // Press → drag → release: two clicks.
      const s0 = snapAt(p.q, c);
      await clickDraw(s0.p, s0.snap, null);
      live.cursor = null;
      const s1 = snapAt(q, c);
      if (live.pts.length) await clickDraw(s1.p, s1.snap, s1.axis);
      return;
    }
    const s = snapAt(q, c);
    await clickDraw(s.p, s.snap, s.axis);
    return;
  }
  await clickTool(q, tol, c);
}

function bandSelect(a: V2, b: V2, additive: boolean): void {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const crossing = b[0] < a[0];
  const inside = (p: V2) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const hits: SelItem[] = [];
  sk.entities.forEach((e, i) => { const pts = sample(e, 32); if (crossing ? pts.some(inside) : pts.every(inside)) hits.push({ e: i }); });
  sk.sel = additive ? [...sk.sel, ...hits.filter((h) => !sk.sel.some((s) => sameItem(s, h)))] : hits;
  sk.selCons = [];
  setStatus('info', `${hits.length} entit${hits.length === 1 ? 'y' : 'ies'} ${crossing ? 'crossing' : 'inside'} the box.`);
}

export function pointerDbl(q: V2 | null, c: PointerCtx): void {
  if (!q) return;
  if (drawTool()?.clicks === 'chain') { void finishChain(); return; }
  if (sk.tool !== 'select') return;
  const h = hitTest(q, PX(c) * c.mmPerPx);
  if (h) { sk.sel = connected(h.e).map((e) => ({ e })); sk.selCons = []; }
}

/** Right click: end a chain, else step out of the tool. */
export function pointerContext(): boolean {
  const t = drawTool();
  if (t?.clicks === 'chain' && live.pts.length) { void finishChain(); return true; }
  if (live.pts.length || live.first || live.picks.length) { resetLive(); return true; }
  return false;
}

const selEntities = () => [...new Set(sk.sel.map((s) => s.e))];
const snapOrQ = (q: V2) => (live.snap && live.snap.kind !== 'none' ? live.snap.p : q);

async function clickTool(q: V2, tol: number, c: PointerCtx): Promise<void> {
  const hit = hitTest(q, tol);
  switch (sk.tool) {
    case 'select': select(hit, c.shift || c.ctrl); return;
    case 'dimension': return dimensionClick(hit, q);
    case 'trim': case 'extend':
      if (!hit) { setStatus('info', promptFor(sk.tool)); return; }
      await trimExtend(sk.tool, hit.e, nearestOn(sk.entities[hit.e], q).p);
      return;
    case 'fillet': case 'chamfer': return filletClick(hit, q);
    case 'offset': {
      // The clicked curve's chain; a click on empty space offsets the selection.
      const ents = hit ? connected(hit.e) : sk.sel.length ? selEntities() : [];
      if (!ents.length) { setStatus('info', promptFor('offset')); return; }
      sk.sel = ents.map((e) => ({ e }));
      requestValue({ label: 'Offset (negative: other side)', value: 2, unit: 'mm', at: q, submit: (v) => offsetEntities(ents, v) });
      return;
    }
    case 'mirror': {
      if (!hit || sk.entities[hit.e]?.type !== 'line') { if (hit) select(hit, true); setStatus('info', promptFor('mirror')); return; }
      if (!sk.sel.filter((s) => s.e !== hit.e).length) { select(hit, true); setStatus('info', 'Selected. Click more entities, then the mirror line.'); return; }
      await mirrorEntities(selEntities(), hit.e);
      return;
    }
    case 'move': case 'array': {
      const ents = selEntities();
      if (!ents.length) { select(hit, true); setStatus('info', 'Select what to move first (click entities), then click the base point.'); return; }
      const p = snapOrQ(q);
      if (!live.picks.length) { live.picks = [p]; live.prompt = promptFor(sk.tool); return; }
      const step = sub(p, live.picks[0]);
      live.picks = [];
      if (sk.tool === 'move') { await transformEntities(ents, { move: step, copy: c.ctrl }); setStatus('ok', `${c.ctrl ? 'Copied' : 'Moved'} ${ents.length} entit${ents.length > 1 ? 'ies' : 'y'}.`); return; }
      requestValue({ label: 'Count (with the original)', value: 3, unit: '', int: true, min: 2, at: p, submit: (v) => arrayEntities(ents, v, { step }) });
      return;
    }
    case 'rotate': case 'scale': case 'polar': {
      const ents = selEntities();
      if (!ents.length) { select(hit, true); setStatus('info', 'Select the entities first, then click the pivot.'); return; }
      const pivot = snapOrQ(q);
      if (sk.tool === 'rotate') requestValue({ label: 'Rotate by', value: 90, unit: '°', at: pivot, submit: (v) => transformEntities(ents, { angle: v, pivot }) });
      else if (sk.tool === 'scale') requestValue({ label: 'Scale by', value: 2, unit: '×', at: pivot, submit: (v) => (v > 0 ? transformEntities(ents, { scale: v, pivot }) : Promise.resolve('Enter a factor above 0')) });
      else requestValue({ label: 'Count around 360°', value: 6, unit: '', int: true, min: 2, at: pivot, submit: (v) => arrayEntities(ents, v, { angleStep: 360 / Math.round(v), pivot }) });
      return;
    }
    case 'use-edges': {
      const pe = c.pickEdge?.();
      if (!pe) { setStatus('info', 'No body edge there — click closer to an edge.'); return; }
      await useEdges(pe.body, [pe.edge], pe.generation);
      return;
    }
  }
}

async function dimensionClick(hit: SelItem | null, q: V2): Promise<void> {
  const v = live.snap && (live.snap.kind === 'end' || live.snap.kind === 'center' || live.snap.kind === 'origin') ? live.snap : null;
  const vertex: SelItem | null = v ? (v.entity === -2 ? null : { e: v.entity, role: sk.entities[v.entity]?.type === 'point' ? undefined : v.role }) : hit?.role || (hit && sk.entities[hit.e]?.type === 'point') ? hit : null;
  const first = live.first;
  if (!first) {
    if (vertex) { live.first = vertex; live.prompt = promptFor('dimension'); return; }
    if (!hit) return;
    const plan = planLocal('distance', [hit], sk.entities);
    if (plan?.kind === 'ask_value') return askDimension(plan.constraints[0], plan.prefill, q);
    setStatus('info', 'That entity has no dimension of its own — click a point first.');
    return;
  }
  live.first = null;
  live.prompt = promptFor('dimension');
  const second = vertex ?? hit;
  if (!second || sameItem(second, first)) return;
  const plan = planLocal('distance', [first, second], sk.entities);
  if (!plan || plan.kind !== 'ask_value') { setStatus('info', plan?.kind === 'reject' ? `${plan.reason}.` : 'Click a point, or a line.'); return; }
  askDimension(plan.constraints[0], plan.prefill, q);
}

function askDimension(c: SkConstraint, prefill: number, at: V2): void {
  const label = c.type === 'diameter' ? 'Diameter' : c.type === 'radius' ? 'Radius' : c.type === 'point_on_line' ? 'Distance to line' : c.ea === c.eb ? 'Length' : 'Distance';
  requestValue({ label, value: prefill, unit: 'mm', at, submit: (v) => (v > 0 || c.type === 'point_on_line' ? addConstraints([{ ...c, value: v }]) : Promise.resolve('Enter a value above 0')) });
}

/** The two lines meeting at a vertex (a fillet corner), or null. */
function cornerAt(q: V2, tol: number): [number, number] | null {
  const lines: number[] = [];
  sk.entities.forEach((e, i) => { if (e.type === 'line' && (dist(e.p0, q) < tol || dist(e.p1, q) < tol)) lines.push(i); });
  return lines.length === 2 ? [lines[0], lines[1]] : null;
}

async function filletClick(hit: SelItem | null, q: V2): Promise<void> {
  const op = sk.tool as 'fillet' | 'chamfer';
  const corner = hit?.role ? cornerAt(rolePoint(sk.entities[hit.e], hit.role), 1e-3) : null;
  let pair: [number, number] | null = corner;
  if (!pair) {
    if (!hit || sk.entities[hit.e]?.type !== 'line') { setStatus('info', promptFor(op)); return; }
    if (!live.first) { live.first = { e: hit.e }; live.prompt = promptFor(op); return; }
    if (live.first.e === hit.e) return;
    pair = [live.first.e, hit.e];
  }
  live.first = null;
  const [a, b] = pair;
  const la = sk.entities[a], lb = sk.entities[b];
  const short = Math.min(dist(la.p0, la.p1), dist(lb.p0, lb.p1));
  requestValue({
    label: op === 'fillet' ? 'Fillet radius' : 'Chamfer distance', value: +(short * 0.2).toFixed(2), unit: 'mm', at: q,
    submit: (v) => filletLines(op, a, b, v),
  });
}

/** Enter: finish a chain; else nothing to apply (returns false: the caller may finish the sketch). */
export async function enterKey(): Promise<boolean> {
  if (await finishChain()) return true;
  return false;
}

/** Esc ladder (Orca): the gesture, then the tool (back to Select), then the selection. False: nothing left. */
export function escapeKey(): boolean {
  if (live.pts.length || live.first || live.picks.length || live.band) { resetLive(); updatePreview(null); return true; }
  if (sk.tool !== 'select') { setTool('select'); return true; }
  if (sk.sel.length || sk.selCons.length) { sk.sel = []; sk.selCons = []; return true; }
  return false;
}

export { SNAP_LABEL };

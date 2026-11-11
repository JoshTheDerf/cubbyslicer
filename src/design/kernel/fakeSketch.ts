/**
 * FakeKernel's sketch session (unit tests): the contract's `sketch_*` result shapes on a toy
 * solver. Geometry is never moved by constraints (except `sketch_drag` / `set_entity`, which
 * move what they're told); the DOF count is natural DOF minus one per constraint (−1 with no
 * constraints, as the kernel). Conflicts: two valued constraints of one type on the same refs
 * with different values, an exact duplicate (redundant), or anything marked `value: -999`. Loops: a set of non-construction
 * entities whose ends all pair up is one closed loop; circles are loops. Undo / redo snapshot
 * the session (one step per successful mutating call, as the real kernel).
 */
type V2 = [number, number];
interface Ent { type: string; p0: V2; p1: V2; center: V2; radius: number; start_angle: number; end_angle: number; construction: boolean; rminor: number; rotation: number; ctrl: V2[] }
interface Con { type: string; ea: number; ra: string; eb: number; rb: string; value: number; ec: number; rc: string }
export interface FakeSession { plane: Record<string, unknown>; feature: number; entities: Ent[]; constraints: Con[]; undo: string[]; redo: string[]; selection: number[]; forcedBad: number[] }

class Fail extends Error { constructor(readonly code: number, m: string) { super(m); } }

const PLANES: Record<string, Record<string, unknown>> = {
  XY: { origin: [0, 0, 0], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] },
  XZ: { origin: [0, 0, 0], normal: [0, 1, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1] },
  YZ: { origin: [0, 0, 0], normal: [1, 0, 0], x_axis: [0, 1, 0], y_axis: [0, 0, 1] },
};
const NAT: Record<string, number> = { line: 4, point: 2, circle: 3, arc: 5, ellipse: 2, ellipse_arc: 6 };

function ent(e: Partial<Ent> & { type: string; p?: V2; centre?: V2 }): Ent {
  const center = (e.center ?? e.centre ?? [0, 0]) as V2;
  const out: Ent = { type: e.type === 'bspline' ? 'spline' : e.type, p0: (e.p0 ?? e.p ?? [0, 0]) as V2, p1: (e.p1 ?? [0, 0]) as V2, center, radius: e.radius ?? 0, start_angle: e.start_angle ?? 0, end_angle: e.end_angle ?? 0,
    construction: !!e.construction, rminor: e.rminor ?? 0, rotation: e.rotation ?? 0, ctrl: (e.ctrl ?? []) as V2[] };
  if (out.type === 'arc') { out.p0 = [center[0] + out.radius * Math.cos(out.start_angle), center[1] + out.radius * Math.sin(out.start_angle)]; out.p1 = [center[0] + out.radius * Math.cos(out.end_angle), center[1] + out.radius * Math.sin(out.end_angle)]; }
  if (out.type === 'circle' || out.type === 'ellipse') out.p0 = center;
  if (out.type === 'spline' && out.ctrl.length) { out.p0 = out.ctrl[0]; out.p1 = out.ctrl[out.ctrl.length - 1]; }
  return out;
}
const con = (c: Partial<Con> & { type: string }): Con => ({ type: c.type, ea: c.ea ?? -1, ra: c.ra ?? 'p0', eb: c.eb ?? -1, rb: c.rb ?? 'p0', value: c.value ?? 0, ec: c.ec ?? -1, rc: c.rc ?? 'p0' });
const pt = (e: Ent, r: string): V2 => (r === 'center' || e.type === 'circle' ? e.center : r === 'p1' ? e.p1 : e.p0);
const same = (a: V2, b: V2) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const VALUED = new Set(['distance', 'distance_x', 'distance_y', 'angle', 'radius', 'diameter', 'lock_x', 'lock_y', 'point_on_line']);

function solve(s: FakeSession) {
  const bad: number[] = [...s.forcedBad.filter((i) => i < s.constraints.length)];
  s.constraints.forEach((c, i) => {
    if (VALUED.has(c.type) && s.constraints.some((o, j) => j < i && o.type === c.type && o.ea === c.ea && o.eb === c.eb && o.ra === c.ra && o.rb === c.rb && o.value !== c.value)) bad.push(i);
    // A second copy of a constraint is redundant, which SolveSpace refuses (both orders of a pair).
    else if (s.constraints.some((o, j) => j < i && o.type === c.type && o.ec === c.ec && o.value === c.value
      && ((o.ea === c.ea && o.ra === c.ra && o.eb === c.eb && o.rb === c.rb) || (o.ea === c.eb && o.ra === c.rb && o.eb === c.ea && o.rb === c.ra)))) bad.push(i);
  });
  const nat = s.entities.reduce((n, e) => n + (e.type === 'spline' ? 2 * e.ctrl.length : NAT[e.type] ?? 2), 0);
  const dof = s.constraints.length ? Math.max(0, nat - s.constraints.length * 2 + s.constraints.filter((c) => c.type !== 'coincident' && c.type !== 'fix').length) : -1;
  return { solve_ok: bad.length === 0, dof, result: bad.length ? 1 : 0, bad: [...new Set(bad)], skipped: [] as number[] };
}

function loops(s: FakeSession) {
  const live = s.entities.map((e, i) => ({ e, i })).filter(({ e }) => !e.construction && e.type !== 'point');
  const closed_loops: Array<{ entities: number[]; holes: number[]; closed: boolean; area: number; defect: boolean }> = [];
  for (const { e, i } of live) if (e.type === 'circle') closed_loops.push({ entities: [i], holes: [], closed: true, area: Math.PI * e.radius * e.radius, defect: false });
  const chain = live.filter(({ e }) => e.type !== 'circle' && e.type !== 'ellipse');
  const endPts = chain.flatMap(({ e }) => [e.p0, e.p1]);
  const open = endPts.filter((p) => endPts.filter((q) => same(p, q)).length < 2);
  if (chain.length && !open.length) closed_loops.push({ entities: chain.map(({ i }) => i), holes: [], closed: true, area: 1, defect: false });
  return { closed_loops, open_ends: open, defects: [] as V2[], buildable: closed_loops.length > 0 && !open.length };
}

export class FakeSketches {
  sessions = new Map<number, FakeSession>();
  /** Refused `sketch_constrain` calls: the real kernel runs its conflict search (a failing solve per constraint) on each. */
  conflictSearches = 0;

  private s(doc: number): FakeSession {
    const s = this.sessions.get(doc);
    if (!s) throw new Fail(-32022, 'no sketch is open — call sketch_begin first');
    return s;
  }
  private snap(s: FakeSession) { s.undo.push(JSON.stringify({ e: s.entities, c: s.constraints, b: s.forcedBad })); s.redo = []; }
  private state(s: FakeSession) { return { ok: true, entities: s.entities, constraints: s.constraints, ...solve(s) }; }
  describe(s: FakeSession) { return { ...this.state(s), ...loops(s), plane: s.plane, feature: s.feature, selection: s.selection }; }

  /** Returns undefined when `method` isn't a sketch method. `features` / `commit` reach the document. */
  dispatch(method: string, p: Record<string, unknown>, doc: { features: Array<Record<string, unknown>>; commit: (f: Record<string, unknown>, index: number) => Record<string, unknown> }): unknown {
    const d = Number(p.doc);
    switch (method) {
      case 'sketch_begin': {
        if (this.sessions.has(d)) throw new Fail(-32022, 'a sketch is already open');
        let plane: Record<string, unknown>, feature = -1, entities: Ent[] = [], constraints: Con[] = [];
        if (p.feature !== undefined) {
          feature = Number(p.feature);
          const f = doc.features[feature];
          if (!f || f.type !== 'Sketch') throw new Fail(-32602, 'not a sketch feature');
          plane = typeof f.plane === 'object' && f.plane ? f.plane as Record<string, unknown> : PLANES[String(f.plane ?? 'XY')] ?? PLANES.XY;
          entities = ((f.entities as Ent[] | undefined) ?? []).map((e) => ({ ...e }));
          constraints = ((f.entity_constraints as Con[] | undefined) ?? []).map((c) => ({ ...c }));
        } else if (p.face) plane = { origin: [0, 0, 10], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] };
        else plane = typeof p.plane === 'object' ? p.plane as Record<string, unknown> : PLANES[String(p.plane ?? 'XY')] ?? PLANES.XY;
        const s: FakeSession = { plane, feature, entities, constraints, undo: [], redo: [], selection: [], forcedBad: [] };
        this.sessions.set(d, s);
        return this.describe(s);
      }
      case 'sketch_cancel': this.sessions.delete(d); return { ok: true };
      case 'sketch_describe': case 'sketch_solve': case 'sketch_validate': return this.describe(this.s(d));
      case 'sketch_add': {
        const s = this.s(d);
        this.snap(s);
        const first = s.entities.length;
        const list = Array.isArray(p.entities) ? (p.entities as Array<Partial<Ent> & { type: string }>) : Array.isArray(p.rect)
          ? (() => { const [x0, y0, x1, y1] = p.rect as number[]; const q: V2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; return [0, 1, 2, 3].map((i) => ({ type: 'line', p0: q[i], p1: q[(i + 1) % 4] })); })()
            : [p as Partial<Ent> & { type: string }];
        for (const e of list) s.entities.push(ent(e));
        if (p.infer !== false) {
          for (let i = first; i < s.entities.length; i++) {
            const e = s.entities[i];
            for (let j = 0; j < i; j++) for (const ra of ['p0', 'p1']) for (const rb of ['p0', 'p1']) if (e.type === 'line' && s.entities[j].type === 'line' && same(pt(e, ra), pt(s.entities[j], rb))) s.constraints.push(con({ type: 'coincident', ea: j, ra: rb, eb: i, rb: ra }));
            if (e.type === 'line' && Math.abs(e.p0[1] - e.p1[1]) < 1e-9) s.constraints.push(con({ type: 'horizontal', ea: i, ra: 'p0', eb: i, rb: 'p1' }));
            if (e.type === 'line' && Math.abs(e.p0[0] - e.p1[0]) < 1e-9) s.constraints.push(con({ type: 'vertical', ea: i, ra: 'p0', eb: i, rb: 'p1' }));
          }
        }
        return { ok: true, first_index: first, added: list.length, entities: s.entities.length, constraints: s.constraints.length, ...solve(s) };
      }
      case 'sketch_constrain': {
        const s = this.s(d);
        const list = (Array.isArray(p.constraints) ? p.constraints : p.constraint ? [p.constraint] : [p]) as Array<Partial<Con> & { type: string }>;
        for (const c of list) if ([c.ea, c.eb].some((i) => i !== undefined && i >= s.entities.length)) throw new Fail(-32602, 'entity index out of range');
        const before = JSON.stringify({ e: s.entities, c: s.constraints, b: s.forcedBad });
        const at = s.constraints.length;
        for (const c of list) s.constraints.push(con(c));
        const r = solve(s);
        if (!r.solve_ok || list.some((c) => c.value === -999)) {
          if (p.force) { s.forcedBad = [...s.forcedBad, ...list.map((_, k) => at + k)]; s.undo.push(before); s.redo = []; return { ...this.state(s), added: list.length, index: at }; }
          s.constraints.length = at;
          this.conflictSearches++;
          return { ok: false, error: 'the constraint conflicts with the sketch (over-constrained) or cannot be satisfied', bad: [at], dof: r.dof, result: 1, skipped: [], solve_ok: false };
        }
        s.undo.push(before); s.redo = [];
        return { ...this.state(s), added: list.length, index: at };
      }
      case 'sketch_set_constraint': {
        const s = this.s(d);
        const c = s.constraints[Number(p.index)];
        if (!c) throw new Fail(-32602, 'constraint index out of range');
        if (Number(p.value) === -999) return { ok: false, bad: [Number(p.index)], error: 'cannot be satisfied' };
        this.snap(s); c.value = Number(p.value);
        return { ...this.state(s), index: Number(p.index) };
      }
      case 'sketch_delete_constraint': {
        const s = this.s(d);
        const i = Number(p.index);
        if (!s.constraints[i]) throw new Fail(-32602, 'constraint index out of range');
        this.snap(s); s.constraints.splice(i, 1); s.forcedBad = s.forcedBad.filter((b) => b !== i).map((b) => (b > i ? b - 1 : b));
        return this.state(s);
      }
      case 'sketch_set_entity': {
        const s = this.s(d);
        this.snap(s); s.entities[Number(p.index)] = ent(p.entity as Ent);
        return this.state(s);
      }
      case 'sketch_drag': {
        const s = this.s(d);
        const e = s.entities[Number(p.entity)];
        if (!e) throw new Fail(-32602, 'entity index out of range');
        this.snap(s);
        const to = p.to as V2, r = String(p.role);
        if (r === 'center' || e.type === 'circle') e.center = to; else if (r === 'p1') e.p1 = to; else e.p0 = to;
        return this.state(s);
      }
      case 'sketch_delete': {
        const s = this.s(d);
        const del = new Set(((p.entities as number[] | undefined) ?? s.selection).map(Number));
        this.snap(s);
        const map = s.entities.map((_, i) => (del.has(i) ? -1 : i - [...del].filter((x) => x < i).length));
        s.entities = s.entities.filter((_, i) => !del.has(i));
        s.constraints = s.constraints.filter((c) => ![c.ea, c.eb, c.ec].some((i) => i >= 0 && del.has(i))).map((c) => ({ ...c, ea: c.ea >= 0 ? map[c.ea] : c.ea, eb: c.eb >= 0 ? map[c.eb] : c.eb, ec: c.ec >= 0 ? map[c.ec] : c.ec }));
        return { ok: true, removed: del.size, entities: s.entities.length, ...solve(s) };
      }
      case 'sketch_select': { const s = this.s(d); s.selection = (p.entities as number[]).slice(); return { ok: true, selected: s.selection.length, any: s.selection.length > 0 }; }
      case 'sketch_construction': {
        const s = this.s(d);
        const list = (p.entities as number[] | undefined) ?? s.selection;
        this.snap(s);
        for (const i of list) s.entities[i].construction = !s.entities[i].construction;
        return { ok: true, changed: list.length };
      }
      case 'sketch_offset': case 'sketch_mirror': {
        const s = this.s(d);
        const list = ((p.entities as number[] | undefined) ?? s.selection).filter((i) => s.entities[i]?.type === 'line');
        if (!list.length) return { ok: true, added: 0, first_index: s.entities.length, dof: solve(s).dof };
        this.snap(s);
        const first = s.entities.length;
        const k = method === 'sketch_offset' ? Number(p.distance) : 0;
        for (const i of list) { const e = s.entities[i]; s.entities.push(method === 'sketch_offset' ? ent({ type: 'line', p0: [e.p0[0], e.p0[1] + k], p1: [e.p1[0], e.p1[1] + k] }) : ent({ type: 'line', p0: [-e.p1[0], e.p1[1]], p1: [-e.p0[0], e.p0[1]] })); }
        return { ok: true, added: list.length, first_index: first, dof: solve(s).dof };
      }
      case 'sketch_ops': {
        const s = this.s(d);
        const op = String(p.op);
        if (op === 'fillet' || op === 'chamfer') {
          const a = s.entities[Number(p.a)], b = s.entities[Number(p.b)];
          if (a?.type !== 'line' || b?.type !== 'line') return { ok: false, error: 'fillet / chamfer join two lines' };
          this.snap(s);
          const first = s.entities.length;
          s.entities.push(ent(op === 'fillet' ? { type: 'arc', center: a.p1, radius: Number(p.radius), start_angle: 0, end_angle: Math.PI / 2 } : { type: 'line', p0: a.p1, p1: b.p0 }));
          return { ...this.state(s), first_index: first };
        }
        if (op === 'trim' || op === 'extend') {
          const e = s.entities[Number(p.entity)];
          if (!e || e.type !== 'line') return { ok: false, error: `${op} found no intersection to ${op} to` };
          this.snap(s);
          const pick = p.pick as V2;
          if (op === 'trim') { if (Math.hypot(pick[0] - e.p0[0], pick[1] - e.p0[1]) < Math.hypot(pick[0] - e.p1[0], pick[1] - e.p1[1])) e.p0 = pick; else e.p1 = pick; }
          else e.p1 = [e.p1[0] + (e.p1[0] - e.p0[0]), e.p1[1] + (e.p1[1] - e.p0[1])];
          return this.state(s);
        }
        if (op === 'array' || op === 'transform') {
          const list = ((p.entities as number[] | undefined) ?? s.selection);
          this.snap(s);
          const first = s.entities.length;
          if (op === 'array') for (let k = 1; k < Number(p.count); k++) for (const i of list) s.entities.push({ ...s.entities[i] });
          else {
            // Rotate by `angle` (radians) about `pivot`, then move (the kernel's order; no scale here).
            const m = (p.move as V2) ?? [0, 0], a = Number(p.angle ?? 0), pv = (p.pivot as V2) ?? [0, 0], ca = Math.cos(a), sa = Math.sin(a);
            const tf = (q: V2): V2 => { const x = q[0] - pv[0], y = q[1] - pv[1]; return [pv[0] + x * ca - y * sa + m[0], pv[1] + x * sa + y * ca + m[1]]; };
            for (const i of list) { const e = s.entities[i]; e.p0 = tf(e.p0); e.p1 = tf(e.p1); e.center = tf(e.center); if (e.type === 'arc') { e.start_angle += a; e.end_angle += a; } }
          }
          return { ...this.state(s), first_index: first, added: s.entities.length - first };
        }
        throw new Fail(-32602, `unknown op ${op}`);
      }
      case 'sketch_plan': {
        const s = this.s(d);
        const ents = (p.entities as number[]).map((i) => s.entities[i]);
        const t = String(p.type);
        const lines = ents.filter((e) => e?.type === 'line').length, rounds = ents.filter((e) => e?.type === 'circle' || e?.type === 'arc').length;
        const ids = p.entities as number[];
        if ((t === 'horizontal' || t === 'vertical') && ents.length === 1 && lines === 1) return { kind: 'apply', reason: 'none', prefill: 0, constraints: [con({ type: t, ea: ids[0], ra: 'p0', eb: ids[0], rb: 'p1' })] };
        if ((t === 'parallel' || t === 'perpendicular' || t === 'equal_length' || t === 'collinear') && lines === 2) return { kind: 'apply', reason: 'none', prefill: 0, constraints: [con({ type: t, ea: ids[0], eb: ids[1] })] };
        if (t === 'angle' && lines === 2) return { kind: 'ask_value', reason: 'none', prefill: 90, constraints: [con({ type: t, ea: ids[0], eb: ids[1] })] };
        if ((t === 'radius' || t === 'diameter') && rounds === 1 && ents.length === 1) return { kind: 'ask_value', reason: 'none', prefill: t === 'radius' ? ents[0].radius : 2 * ents[0].radius, constraints: [con({ type: t, ea: ids[0], ra: 'center' })] };
        if ((t === 'concentric' || t === 'equal_radius') && rounds === 2) return { kind: 'apply', reason: 'none', prefill: 0, constraints: [con({ type: t, ea: ids[0], eb: ids[1] })] };
        if (t === 'tangent' && lines + rounds === 2 && rounds >= 1) return { kind: 'apply', reason: 'none', prefill: 0, constraints: [con({ type: t, ea: ids[0], eb: ids[1] })] };
        if (t === 'coincident' && ents.length === 2) return { kind: 'apply', reason: 'none', prefill: 0, constraints: [con({ type: t, ea: ids[0], ra: 'p1', eb: ids[1], rb: 'p0' })] };
        return { kind: 'reject', reason: ents.length === 1 ? 'need_two_entities' : 'unsupported', prefill: 0, constraints: [] };
      }
      case 'sketch_undo': case 'sketch_redo': {
        const s = this.s(d);
        const from = method === 'sketch_undo' ? s.undo : s.redo, to = method === 'sketch_undo' ? s.redo : s.undo;
        const snap = from.pop();
        if (!snap) return { ok: false, error: 'nothing to undo' };
        to.push(JSON.stringify({ e: s.entities, c: s.constraints, b: s.forcedBad }));
        const v = JSON.parse(snap) as { e: Ent[]; c: Con[]; b: number[] };
        s.entities = v.e; s.constraints = v.c; s.forcedBad = v.b;
        return { ...this.state(s), can_undo: s.undo.length > 0, can_redo: s.redo.length > 0 };
      }
      case 'sketch_commit': {
        const s = this.s(d);
        this.sessions.delete(d);
        const extra = (p.fields && typeof p.fields === 'object' ? p.fields : {}) as Record<string, unknown>;
        const fields = { ...extra, plane: s.plane, entities: s.entities, entity_constraints: s.constraints };
        return { ...doc.commit(fields, s.feature), fields_applied: Object.keys(extra).length > 0 };   // kernel v1.2
      }
    }
    return undefined;
  }
}

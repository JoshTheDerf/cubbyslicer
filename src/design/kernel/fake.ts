/**
 * A tiny in-process stand-in for the CAD kernel, for unit tests (`new CadKernel(() => new FakeKernel())`).
 * It speaks the same envelope and result shapes as the real module for the methods the Design
 * tab uses, with a toy geometry model:
 *
 * - Every enabled feature of type Extrude (or Revolve / Import) makes a body: an axis-aligned box
 *   `width` × `height` × `distance` at `x`, 6 faces, 12 edges. Fillet / Chamfer change nothing
 *   but fail the rebuild when `dressup_size` > `FAIL_SIZE` (Orca's "radius too large").
 * - The rebuild replays the history and stops at the first failing feature: no bodies, as in Orca.
 *   History edits are transactional (rolled back on failure) unless `force`.
 * - The "recipe" is JSON behind a magic header; version > 6 opens read-only; garbage is -32030.
 * - Mesh blobs use the contract's layout (display: positions/normals/indices/triFace/edges; plate:
 *   positions/indices/triFace).
 * - Creation: `add_feature` (any type), the `extrude` / `revolve` verbs (a Sketch + the feature),
 *   `import_mesh` / `import_step` (an Import feature); Boolean consumes its tool body unless kept,
 *   Mirror (New) and a two-sided Cut add one. Box faces: 0 bottom, 1 top, 2 front (−Y), 3 right,
 *   4 back, 5 left; planar, except that every face of a Revolve body is reported as a cylinder.
 * - Kernel undo (`undo`) restores the state before the last successful mutating call.
 */
import type { KernelBackend } from './client';
import type { CadEnvelope, RawReply, StartProgress } from './protocol';
import type { CadKernelVersion, FeatureType } from './types';
import { FakeSketches } from './fakeSketch';

export const FAIL_SIZE = 10;
/** A Shell with this wall thickness "changes nothing": refused like kernel v1.2 refuses a no-op shell. */
export const NOOP_SHELL = 7.77;
const MAGIC = 'FAKECAD';

interface FakeFeature { type: FeatureType; name: string; enabled: boolean; expr: Record<string, string>; [k: string]: unknown }
interface FakeDoc {
  version: number;
  features: FakeFeature[];
  variables: Record<string, string>;
  bodyNames: Record<number, string>;
  bodyColors: Record<number, [number, number, number, number]>;
  undo: string[];
  origin: [number, number, number];
  generation: number;
  ok: boolean;
  error: string;
  /** Kernel v1.1: the feature the last rebuild failed at (-1 none). */
  failedAt: number;
  bodies: FakeBody[];
  dirty: boolean;
  original: Uint8Array | null;
}
interface FakeBody { source: number; x: number; w: number; h: number; d: number; revolve?: boolean }

const DEFAULTS: Record<string, unknown> = { width: 20, height: 10, distance: 10, x: 0, dressup_size: 1, mode: 'New', extrude_end: 'Blind', flip: false, sketch_ref: -1, target_body: -1 };

class Fail extends Error { constructor(readonly code: number, m: string) { super(m); } }

export class FakeKernel implements KernelBackend {
  docs = new Map<number, FakeDoc>();
  calls: string[] = [];
  /** The params of the last call of each method. */
  lastParams: Record<string, unknown> = {};
  private next = 1;
  /** Makes the next call of this method trap (crash) instead of answering. */
  trapOn: string | null = null;
  /** Delay every call by this many ms (to test cancel / queueing). */
  delayMs = 0;
  /** Kernel v1.2 primitive verbs (box / cylinder / cone / sphere / torus); false = an older kernel (-32601). */
  primitives = true;

  async start(onProgress: (p: StartProgress) => void): Promise<{ version: CadKernelVersion; heapBytes: number }> {
    onProgress({ stage: 'init', loaded: 0, total: 1 });
    return { version: { module: 'orca-cad', orca: '2.5.0', occt: 'fake', abi: 1, recipeVersion: 6, build: 'fake' }, heapBytes: 128 << 20 };
  }

  /** Sketch sessions per document (fakeSketch.ts). */
  sketches = new FakeSketches();

  terminate(): void { this.docs.clear(); this.sketches.sessions.clear(); }

  async call(method: string, params: unknown, blob: Uint8Array | null): Promise<RawReply> {
    this.calls.push(method);
    this.lastParams[method] = params;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.trapOn === method) { this.trapOn = null; this.docs.clear(); throw new Error('RuntimeError: unreachable'); }
    let envelope: CadEnvelope;
    let out: Uint8Array | null = null;
    try {
      const r = this.dispatch(method, (params ?? {}) as Record<string, unknown>, blob);
      envelope = { ok: true, result: r.result };
      out = r.blob ?? null;
    } catch (e) {
      envelope = { ok: false, error: { code: e instanceof Fail ? e.code : -32000, message: e instanceof Error ? e.message : String(e) } };
    }
    return { rc: envelope.ok ? 0 : 1, envelope, blob: out, heapBytes: 128 << 20 };
  }

  // ---- model -------------------------------------------------------------------

  /** A recipe the fake reads: `features` as partial feature records. */
  static recipe(features: Array<Partial<FakeFeature> & { type: FeatureType }>, opts: { version?: number; variables?: Record<string, string> } = {}): Uint8Array {
    const body = JSON.stringify({ version: opts.version ?? 6, features: features.map((f, i) => ({ name: `${f.type} ${i + 1}`, enabled: true, expr: {}, ...f })), variables: opts.variables ?? {} });
    return new TextEncoder().encode(MAGIC + body);
  }

  private doc(p: Record<string, unknown>): FakeDoc {
    const d = this.docs.get(Number(p.doc));
    if (!d) throw new Fail(-32021, `no such document ${String(p.doc)}`);
    return d;
  }

  private writable(d: FakeDoc): void {
    if (d.version > 6) throw new Fail(-32020, 'the document is read-only: saved with a newer version of the Design tab');
  }

  private evalExpr(d: FakeDoc, e: string): number {
    const src = e.replace(/[A-Za-z_]\w*/g, (n) => {
      if (!(n in d.variables)) throw new Error(`unknown identifier: ${n}`);
      return `(${d.variables[n]})`;
    });
    if (!/^[\d\s+\-*/().]+$/.test(src)) throw new Error(`bad expression: ${e}`);
    return Number(Function(`"use strict"; return (${src});`)());
  }

  /** Replay the history; returns whether it succeeded. */
  private rebuild(d: FakeDoc): boolean {
    d.generation++;
    const bodies: FakeBody[] = [];
    let x = 0;
    let at = -1;
    try {
      d.features.forEach((f, i) => {
        if (!f.enabled) return;
        at = i;
        for (const [k, e] of Object.entries(f.expr ?? {})) f[k] = this.evalExpr(d, e);
        const num = (k: string) => Number(f[k] ?? DEFAULTS[k]);
        if ((f.type === 'Extrude' && f.extrude_src_face === undefined) || f.type === 'Revolve' || f.type === 'Import') {
          if (num('distance') <= 0) throw new Error('extrude distance must be positive');
          if (f.mode === 'Add' || f.mode === 'Cut') { if (!bodies.length) throw new Error('nothing to join'); return; }
          bodies.push({ source: i, x, w: num('width'), h: num('height'), d: num('distance'), revolve: f.type === 'Revolve' });
          x += num('width') + 5;
        } else if (f.type === 'Fillet' || f.type === 'Chamfer') {
          if (!bodies.length) throw new Error(`${f.type.toLowerCase()} needs a body`);
          if (num('dressup_size') > FAIL_SIZE) throw new Error('fillet radius too large for this geometry');
        } else if (f.type === 'Boolean') {
          const t = Number(f.target_body ?? 0), tool = Number(f.bool_tool_body ?? 1);
          if (!bodies[t] || !bodies[tool] || t === tool) throw new Error('boolean needs two bodies');
          if (!f.bool_keep_tool) bodies.splice(tool, 1);
        } else if (f.type === 'Mirror' || f.type === 'Cut') {
          const t = Number(f.target_body ?? -1), b = bodies[t < 0 ? bodies.length - 1 : t];
          if (!b) throw new Error(`${f.type.toLowerCase()} needs a body`);
          const adds = f.type === 'Mirror' ? f.mode !== 'Add' : f.cut_keep_upper !== false && !!f.cut_keep_lower;
          if (adds) { bodies.push({ ...b, source: i, x }); x += b.w + 5; }
        } else if (['Shell', 'Hole', 'Thread', 'Draft', 'Pattern', 'Transform', 'Thicken', 'DeleteFace'].includes(f.type)) {
          if (!bodies.length) throw new Error(`${f.type.toLowerCase()} needs a body`);
          if (f.type === 'Shell' && num('shell_thickness') <= 0) throw new Error('shell thickness must be positive');
          if (f.type === 'Shell' && num('shell_thickness') === NOOP_SHELL) throw new Error('the shell changed nothing: OCCT could not hollow the body with that open face');
        }
      });
      d.bodies = bodies; d.ok = true; d.error = ''; d.failedAt = -1;
    } catch (e) {
      d.bodies = []; d.ok = false; d.error = e instanceof Error ? e.message : String(e); d.failedAt = at;
    }
    return d.ok;
  }

  /** Orca's transactional edit: apply, rebuild, roll back on failure (unless `force`). */
  private transact(d: FakeDoc, edit: () => void, force = false): { ok: boolean; error: string; kept?: boolean } {
    this.writable(d);
    const before = JSON.stringify({ f: d.features, v: d.variables });
    edit();
    d.dirty = true;
    if (this.rebuild(d)) { d.undo.push(before); return { ok: true, error: '' }; }
    const error = d.error;
    if (force) return { ok: false, error, kept: true };
    const b = JSON.parse(before) as { f: FakeFeature[]; v: Record<string, string> };
    d.features = b.f; d.variables = b.v;
    this.rebuild(d);
    return { ok: false, error };
  }

  private scene(d: FakeDoc) {
    return {
      modeling_origin: d.origin,
      features: d.features.map((f, index) => ({ index, type: f.type, name: f.name, enabled: f.enabled })),
      bodies: d.bodies.map((b, index) => ({
        index, name: d.bodyNames[index] ?? d.features[b.source].name, user_name: index in d.bodyNames, has_color: index in d.bodyColors,
        ...(index in d.bodyColors ? { color: d.bodyColors[index] } : {}),
        source_feature: b.source, is_solid: true, face_count: 6, edge_count: 12,
        bbox: { min: [b.x, 0, 0], max: [b.x + b.w, b.h, b.d] }, center: [b.x + b.w / 2, b.h / 2, b.d / 2],
      })),
      error: d.error, generation: d.generation, read_only: d.version > 6, dirty: d.dirty, can_undo: false, can_redo: false,
      variables: { ...d.variables }, mate_conflicts: [], auto_close_loops: true, sketch_open: this.sketches.sessions.has([...this.docs.entries()].find(([, x]) => x === d)?.[0] ?? -1),
      rebuild_ok: d.ok, failed_feature: d.failedAt, failed_feature_name: d.features[d.failedAt]?.name ?? '',
      variable_values: Object.fromEntries(Object.keys(d.variables).flatMap((k) => { try { return [[k, this.evalExpr(d, k)]]; } catch { return []; } })),
    };
  }

  private dispatch(method: string, p: Record<string, unknown>, blob: Uint8Array | null): { result: unknown; blob?: Uint8Array } {
    if (method.startsWith('sketch_')) {
      const d = this.doc(p);
      const r = this.sketches.dispatch(method, p, {
        features: d.features,
        commit: (fields, index) => {
          let at = index;
          const res = this.transact(d, () => {
            if (index >= 0) Object.assign(d.features[index], fields);
            else { d.features.push({ type: 'Sketch', name: String(p.name ?? `Sketch ${d.features.length + 1}`), enabled: true, expr: {}, ...fields }); at = d.features.length - 1; }
          });
          return { ...res, sketch_index: res.ok ? at : -1, features: d.features.length, generation: d.generation, failed_feature: -1, failed_feature_name: '', cancelled: false };
        },
      });
      if (r === undefined) throw new Fail(-32601, `unknown method ${method}`);
      return { result: r };
    }
    switch (method) {
      case 'describe_tools':
        return { result: {
          module: 'orca-cad', methods: ['doc_new', 'doc_open'], feature_types: ['Sketch', 'Extrude'], id_lifetime: '',
          fields: [
            { name: 'type', type: 'enum', enum: ['Sketch', 'Extrude'] }, { name: 'name', type: 'string' }, { name: 'enabled', type: 'bool' },
            { name: 'width', type: 'number' }, { name: 'height', type: 'number' }, { name: 'distance', type: 'number' }, { name: 'distance2', type: 'number' },
            { name: 'taper_deg', type: 'number' }, { name: 'flip', type: 'bool' }, { name: 'sketch_ref', type: 'int' }, { name: 'dressup_size', type: 'number' },
            { name: 'mode', type: 'enum', enum: ['New', 'Add', 'Cut', 'Intersect'] }, { name: 'extrude_end', type: 'enum', enum: ['Blind', 'Symmetric', 'TwoSided', 'ThroughAll', 'UpToFace', 'UpToVertex'] },
            { name: 'face_group', type: 'enum', enum: ['Top', 'Bottom', 'Lateral', 'All'] }, { name: 'pattern_count', type: 'int' }, { name: 'expr', type: 'map<string,string>' },
          ],
          bindable_fields: ['width', 'height', 'distance', 'distance2', 'taper_deg', 'dressup_size'],
        } };
      case 'doc_new': {
        const id = this.next++;
        const d: FakeDoc = { version: 6, features: [], variables: {}, bodyNames: {}, bodyColors: {}, undo: [], origin: (p.modeling_origin as [number, number, number]) ?? [0, 0, 0], generation: 0, ok: true, error: '', failedAt: -1, bodies: [], dirty: false, original: null };
        this.docs.set(id, d);
        this.rebuild(d);
        return { result: { doc: id, generation: d.generation } };
      }
      case 'doc_open': {
        const text = new TextDecoder().decode(blob ?? new Uint8Array());
        if (!text.startsWith(MAGIC)) throw new Fail(-32030, 'CAD data could not be read');
        const j = JSON.parse(text.slice(MAGIC.length)) as { version: number; features: FakeFeature[]; variables: Record<string, string>; bodyNames?: Record<number, string>; bodyColors?: Record<number, [number, number, number, number]> };
        if (j.version < 4) throw new Fail(-32030, 'This file was saved by an older version');
        const id = this.next++;
        const d: FakeDoc = { version: j.version, features: j.features, variables: j.variables ?? {}, bodyNames: j.bodyNames ?? {}, bodyColors: j.bodyColors ?? {}, undo: [], origin: [0, 0, 0], generation: 0, ok: true, error: '', failedAt: -1, bodies: [], dirty: false, original: blob!.slice() };
        this.docs.set(id, d);
        this.rebuild(d);
        return { result: {
          doc: id, version: d.version, read_only: d.version > 6, ...(d.version > 6 ? { read_only_reason: `saved with a newer version of the Design tab (format v${d.version})` } : {}),
          ok: d.ok, error: d.error, failed_feature: d.failedAt, failed_feature_name: d.features[d.failedAt]?.name ?? '', features: d.features.length, bodies: d.bodies.length, generation: d.generation, ms: 1,
        } };
      }
      case 'doc_save': {
        const d = this.doc(p);
        if (d.original && (!d.dirty || d.version > 6)) return { result: { bytes: d.original.length, version: d.version, verbatim: true }, blob: d.original.slice() };
        const out = new TextEncoder().encode(MAGIC + JSON.stringify({ version: 6, features: d.features, variables: d.variables, bodyNames: d.bodyNames, bodyColors: d.bodyColors }));
        return { result: { bytes: out.length, version: 6, verbatim: false }, blob: out };
      }
      case 'doc_close': this.docs.delete(Number(p.doc)); return { result: {} };
      case 'describe_scene': return { result: this.scene(this.doc(p)) };
      case 'list_features': return { result: { features: this.scene(this.doc(p)).features, generation: this.doc(p).generation } };
      case 'get_feature': {
        const d = this.doc(p), f = d.features[Number(p.index)];
        if (!f) throw new Fail(-32602, `index ${String(p.index)} out of range`);
        return { result: { feature: { ...DEFAULTS, ...f }, brep_bytes: 0 } };
      }
      case 'set_feature': {
        const d = this.doc(p), i = Number(p.index), f = d.features[i];
        if (!f) throw new Fail(-32602, `index ${i} out of range`);
        const r = this.transact(d, () => {
          const fields = { ...(p.fields as Record<string, unknown>) };
          delete fields.type;
          Object.assign(f, fields);
          if (fields.expr) f.expr = { ...(fields.expr as Record<string, string>) };
        });
        return { result: { ...r, index: i, bodies: d.bodies.length, generation: d.generation } };
      }
      case 'rename_feature': {
        const d = this.doc(p); this.writable(d);
        const f = d.features[Number(p.index)];
        if (!f) throw new Fail(-32602, 'index out of range');
        f.name = String(p.name); d.dirty = true;
        return { result: { ok: true, index: p.index, name: f.name } };
      }
      case 'suppress_feature': {
        const d = this.doc(p);
        const list = Array.isArray(p.indices) ? (p.indices as number[]) : [Number(p.index)];
        for (const i of list) if (!d.features[i]) throw new Fail(-32602, `index ${i} out of range`);
        const r = this.transact(d, () => { for (const i of list) d.features[i].enabled = !p.suppressed; }, !!p.force);
        return { result: { ...r, index: list[0], indices: list, enabled: !p.suppressed, bodies: d.bodies.length, generation: d.generation } };
      }
      case 'move_feature': {
        const d = this.doc(p), i = Number(p.index), to = p.to !== undefined ? Number(p.to) : i + Number(p.delta ?? 0);
        if (!d.features[i] || to < 0 || to >= d.features.length) throw new Fail(-32602, 'index out of range');
        const r = this.transact(d, () => { const [f] = d.features.splice(i, 1); d.features.splice(to, 0, f); });
        return { result: { ...r, index: r.ok ? to : i, bodies: d.bodies.length, generation: d.generation } };
      }
      case 'delete_feature': {
        const d = this.doc(p), i = Number(p.index);
        if (!d.features[i]) throw new Fail(-32602, 'index out of range');
        // A Sketch cascades to the features that use it (sketch_ref).
        const removed = [i, ...d.features.flatMap((f, j) => (d.features[i].type === 'Sketch' && f.sketch_ref === i ? [j] : []))].sort((a, b) => a - b);
        const r = this.transact(d, () => { d.features = d.features.filter((_, j) => !removed.includes(j)); });
        return { result: { ...r, removed: r.ok ? removed : [], bodies: d.bodies.length, generation: d.generation } };
      }
      case 'set_variable': {
        const d = this.doc(p), name = String(p.name), e = String(p.expr ?? '');
        const r = this.transact(d, () => { if (e) d.variables[name] = e; else delete d.variables[name]; });
        return { result: { ...r, name, generation: d.generation } };
      }
      case 'set_feature_expr': {
        const d = this.doc(p), i = Number(p.feature), field = String(p.field), e = String(p.expr ?? '');
        const r = this.transact(d, () => { const f = d.features[i]; f.expr = { ...f.expr }; if (e) f.expr[field] = e; else delete f.expr[field]; });
        return { result: { ...r, feature: i, field, generation: d.generation } };
      }
      case 'set_body': {
        const d = this.doc(p); this.writable(d);
        const b = Number(p.body);
        if (typeof p.name === 'string' && p.name) d.bodyNames[b] = p.name; else if (p.name === null) delete d.bodyNames[b];
        if (Array.isArray(p.color)) d.bodyColors[b] = p.color as [number, number, number, number]; else if (p.color === null) delete d.bodyColors[b];
        d.dirty = true;
        return { result: { ok: true, bodies: this.scene(d).bodies } };
      }
      case 'faces_made_by': {
        const d = this.doc(p);
        const b = d.bodies.findIndex((x) => x.source === Number(p.index));
        return { result: { faces: b < 0 ? [] : [0, 1, 2, 3, 4, 5].map((f) => [b, f]), generation: d.generation } };
      }
      case 'add_feature': {
        const d = this.doc(p);
        const type = String(p.type) as FeatureType;
        let index = -1;
        const r = this.transact(d, () => {
          d.features.push({ type, name: String(p.name ?? type), enabled: true, expr: {}, ...(p.fields as Record<string, unknown> ?? {}) });
          index = d.features.length - 1;
        });
        return { result: { ...r, index: r.ok ? index : -1, bodies: d.bodies.length, generation: d.generation } };
      }
      case 'extrude': case 'revolve': {
        const d = this.doc(p);
        let index = -1;
        const r = this.transact(d, () => {
          d.features.push({ type: 'Sketch', name: `Sketch ${d.features.length + 1}`, enabled: true, expr: {}, width: p.width ?? 20, height: p.height ?? 10 });
          const mode = ({ union: 'Add', subtract: 'Cut', intersect: 'Intersect' } as Record<string, string>)[String(p.boolean)] ?? 'New';
          d.features.push({ type: method === 'extrude' ? 'Extrude' : 'Revolve', name: String(p.name ?? (method === 'extrude' ? 'Extrude' : 'Revolve')), enabled: true, expr: {},
            sketch_ref: d.features.length - 1, distance: p.distance ?? 10, width: p.width ?? 20, height: p.height ?? 10, mode, target_body: p.body ?? -1 });
          index = d.features.length - 1;
        });
        return { result: { ...r, sketch_index: index - 1, [`${method}_index`]: index, bodies: d.bodies.length, generation: d.generation } };
      }
      case 'box': case 'cylinder': case 'cone': case 'sphere': case 'torus': {
        if (!this.primitives) throw new Fail(-32601, `unknown method ${method}`);
        const d = this.doc(p), n = (k: string, v: number) => (typeof p[k] === 'number' ? (p[k] as number) : v);
        const r0 = n('radius', n('radius1', n('major_radius', 10)));
        const size = method === 'box' ? [n('width', 20), n('depth', 20), n('height', 20)] : [2 * r0, 2 * r0, n('height', 2 * r0)];
        let index = -1;
        const r = this.transact(d, () => {
          d.features.push({ type: 'Import', name: String(p.name ?? method), enabled: true, expr: {}, width: size[0], height: size[1], distance: size[2] });
          index = d.features.length - 1;
        });
        return { result: { ...r, primitive_index: r.ok ? index : -1, body: r.ok ? d.bodies.length - 1 : -1, bodies: d.bodies.length, generation: d.generation } };
      }
      case 'import_mesh': case 'import_step': {
        const d = this.doc(p);
        if (!blob?.length) throw new Fail(-32602, 'no data');
        let index = -1;
        const r = this.transact(d, () => { d.features.push({ type: 'Import', name: method === 'import_step' ? 'STEP1' : `Mesh${d.features.length + 1}`, enabled: true, expr: {} }); index = d.features.length - 1; });
        return { result: { ...r, first_feature: index, imported: 1, watertight: true, is_solid: true, bodies: d.bodies.length, generation: d.generation } };
      }
      case 'export_step': {
        const d = this.doc(p);
        const out = new TextEncoder().encode(`ISO-10303-21;\nFAKE ${JSON.stringify(p.bodies ?? d.bodies.map((_, i) => i))}\nEND-ISO-10303-21;\n`);
        return { result: { bytes: out.length, bodies: d.bodies.length }, blob: out };
      }
      case 'undo': {
        const d = this.doc(p);
        const prev = d.undo.pop();
        if (prev) { const b = JSON.parse(prev) as { f: FakeFeature[]; v: Record<string, string> }; d.features = b.f; d.variables = b.v; this.rebuild(d); }
        return { result: { ok: !!prev, can_undo: d.undo.length > 0, can_redo: false, generation: d.generation, error: '' } };
      }
      case 'feature_preview': {
        const d = this.doc(p);
        const saved = JSON.stringify(d.features), gen = d.generation;
        d.features.push({ type: String(p.type) as FeatureType, name: 'preview', enabled: true, expr: {}, ...(p.fields as Record<string, unknown> ?? {}) });
        const ok = this.rebuild(d), error = d.error;
        const m = ok ? this.meshes(d, undefined, false) : null;
        d.features = JSON.parse(saved) as FakeFeature[];
        this.rebuild(d); d.generation = gen;
        return m ? { result: { ok: true, error: '', meshes: (m.result as { meshes: unknown[] }).meshes }, blob: m.blob } : { result: { ok: false, error, meshes: [] } };
      }
      case 'datums': {
        const d = this.doc(p), o = d.origin;
        const P = (n: number[], x: number[], y: number[]) => ({ origin: o, normal: n, x_axis: x, y_axis: y });
        return { result: {
          base_planes: [{ name: 'XY', plane: P([0, 0, 1], [1, 0, 0], [0, 1, 0]) }, { name: 'XZ', plane: P([0, 1, 0], [1, 0, 0], [0, 0, 1]) }, { name: 'YZ', plane: P([1, 0, 0], [0, 1, 0], [0, 0, 1]) }],
          planes: d.features.filter((f) => f.type === 'Plane' && f.enabled).map((f) => ({ name: f.name, plane: P([0, 0, 1], [1, 0, 0], [0, 1, 0]) })),
          axes: d.features.filter((f) => f.type === 'Axis' && f.enabled).map((f) => ({ name: f.name, origin: o, direction: [0, 0, 1], error: '' })), coordsys: [],
        } };
      }
      case 'face_info': case 'plane_of_face': {
        const d = this.doc(p);
        if (p.generation !== undefined && Number(p.generation) !== d.generation) throw new Fail(-32010, `stale ids: the model was rebuilt since generation ${String(p.generation)} (now ${d.generation})`);
        const b = d.bodies[Number(p.body)], f = Number(p.face);
        if (!b || f < 0 || f > 5) throw new Fail(-32602, 'no such face');
        const n = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0]][f];
        const c = [b.x + b.w / 2 + (n[0] * b.w) / 2, b.h / 2 + (n[1] * b.h) / 2, b.d / 2 + (n[2] * b.d) / 2];
        const plane = { origin: c, normal: n, x_axis: Math.abs(n[2]) > 0.5 ? [1, 0, 0] : [0, 0, 1], y_axis: Math.abs(n[2]) > 0.5 ? [0, n[2], 0] : [-n[1], n[0], 0] };
        if (method === 'plane_of_face') return { result: b.revolve ? { ok: false, error: 'face is not planar' } : { ok: true, plane } };
        return { result: {
          id: f, surface: b.revolve ? 'cylinder' : 'plane', area: 100, centroid: c, normal: n, generation: d.generation, edges: [0, 1, 2, 3],
          ...(b.revolve ? { cylinder: { axis: [0, 0, 1], base: [b.x + b.w / 2, b.h / 2, 0], height: b.d, internal: false, radius: b.w / 2 } } : { plane }),
        } };
      }
      case 'edge_info': {
        const d = this.doc(p);
        return { result: { id: Number(p.edge), curve: 'line', length: 10, p0: [0, 0, 0], p1: [10, 0, 0], faces: [0, 2], generation: d.generation } };
      }
      case 'body_touching_sketch': return { result: { body: -1 } };
      case 'mass_properties': {
        const b = this.doc(p).bodies[Number(p.body ?? 0)];
        if (!b) throw new Fail(-32602, 'no such body');
        return { result: { volume: b.w * b.h * b.d, surface_area: 2 * (b.w * b.h + b.h * b.d + b.w * b.d), center_of_mass: [b.x + b.w / 2, b.h / 2, b.d / 2], is_solid: true, valid: true } };
      }
      case 'check_interference': {
        // Boxes at [x, x+w] × [0, h] × [0, d]: the overlap of two is a box too.
        const bs = this.doc(p).bodies, min = Number(p.min_volume ?? 1e-6);
        const interferences: Array<{ body_a: number; body_b: number; volume: number }> = [];
        for (let a = 0; a < bs.length; a++) for (let b = a + 1; b < bs.length; b++) {
          const A = bs[a], B = bs[b];
          const v = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x)) * Math.min(A.h, B.h) * Math.min(A.d, B.d);
          if (v > min) interferences.push({ body_a: a, body_b: b, volume: v });
        }
        return { result: { ok: true, count: interferences.length, interferences } };
      }
      case 'thread_standards': return { result: { threads: [
        { name: 'M6', major_diameter: 6, pitch: 1, series: 'metric_coarse', depth: 0.6134, minor_diameter: 4.917, internal_depth: 0.541 },
        { name: 'M8', major_diameter: 8, pitch: 1.25, series: 'metric_coarse', depth: 0.767, minor_diameter: 6.647, internal_depth: 0.677 },
      ] } };
      case 'hole_standards': return { result: { holes: [{ designation: 'M3', clearance: 3.4, cbore_diameter: 6.5, cbore_depth: 3.4, csink_diameter: 6.7, csink_angle: 90 }] } };
      case 'get_mesh': return this.meshes(this.doc(p), p.bodies as number[] | undefined, true);
      case 'export_mesh': return this.meshes(this.doc(p), p.bodies as number[] | undefined, false);
      default: throw new Fail(-32601, `unknown method ${method}`);
    }
  }

  /** Box meshes in the contract's blob layouts (display: unshared vertices per face + edges; plate: welded). */
  private meshes(d: FakeDoc, which: number[] | undefined, display: boolean): { result: unknown; blob: Uint8Array } {
    const chunks: ArrayBufferView[] = [];
    let offset = 0;
    const put = (a: Float32Array | Uint32Array | Int32Array) => { const o = offset; chunks.push(a); offset += a.byteLength; return { offset: o, count: a.length }; };
    const meshes = d.bodies.map((b, body) => ({ b, body })).filter(({ body }) => !which || which.includes(body)).map(({ b, body }) => {
      const c = [[b.x, 0, 0], [b.x + b.w, 0, 0], [b.x + b.w, b.h, 0], [b.x, b.h, 0], [b.x, 0, b.d], [b.x + b.w, 0, b.d], [b.x + b.w, b.h, b.d], [b.x, b.h, b.d]];
      const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
      if (!display) {
        const pos = new Float32Array(c.flat());
        const idx = new Uint32Array(quads.flatMap((q) => [q[0], q[1], q[2], q[0], q[2], q[3]]));
        const tf = new Int32Array(quads.flatMap((_, f) => [f, f]));
        return { body, positions: put(pos), indices: put(idx), triFace: put(tf), triangles: 12, vertices: 8 };
      }
      const pos: number[] = [], nrm: number[] = [], idx: number[] = [], tf: number[] = [];
      const normals = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0]];
      quads.forEach((q, f) => {
        const base = pos.length / 3;
        for (const v of q) { pos.push(...c[v]); nrm.push(...normals[f]); }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        tf.push(f, f);
      });
      const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      return {
        body, faces: 6, edges: 12,
        positions: put(new Float32Array(pos)), normals: put(new Float32Array(nrm)), indices: put(new Uint32Array(idx)), triFace: put(new Int32Array(tf)),
        edgeIds: put(new Int32Array(edges.map((_, i) => i))), edgeStarts: put(new Uint32Array(edges.map((_, i) => i * 2).concat([edges.length * 2]))),
        edgePoints: put(new Float32Array(edges.flatMap(([a, z]) => [...c[a], ...c[z]]))), edgeFlags: [],
      };
    });
    const blob = new Uint8Array(offset);
    let o = 0;
    for (const ch of chunks) { blob.set(new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength), o); o += ch.byteLength; }
    return { result: { meshes, generation: d.generation }, blob };
  }
}

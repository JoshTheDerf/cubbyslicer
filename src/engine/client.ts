/**
 * Page-side engine client. The only module that talks to engine workers.
 *
 * One Worker per engine. The worker compiles slicer.wasm once and
 * instantiates a fresh module for every request (see engine.worker.ts), so a
 * trap or leak in one slice can't poison the next. Cancelling terminates the
 * worker; it's recreated lazily on the next call.
 *
 * Multi-threading: when this page is cross-origin isolated (COOP same-origin +
 * COEP, see vite.config.ts / the Caddy config) the worker runs the engine's
 * pthreads build (`wasm/<engine>/mt/`) and reuses one instance, whose thread
 * pool lives in nested Workers. Terminating the engine worker (cancel, fatal
 * error) tears all of those down too.
 */
import { readString, removeKey, writeString } from '../lib/storage';
import type {
  ArrangeArgs, ArrangeResult, ConfigSchema, EngineId, EngineVersion, FlatConfig, PaintMap, SliceJob, SliceObjectInput, SliceProgress, SliceReport,
  SliceResult, ToolMesh, WorkerRequest, WorkerResponse,
} from './types';
import type {
  MixedPreviewResult, MixedRecommendResult, MixedValidateResult, ResolveVariantsResult, ToolArgs, ToolOp, ToolResult,
} from './tools';

export { ENGINE_LABELS } from './capabilities';

export class SliceError extends Error {
  constructor(message: string, readonly report: SliceReport | null, readonly fatal: boolean) {
    super(message);
    this.name = 'SliceError';
  }
}

export class SliceCancelled extends Error {
  constructor() { super('Slice cancelled'); this.name = 'SliceCancelled'; }
}

const THREADS_KEY = 'cubby-slicer:engine-threads';
/** Engine thread preference (localStorage `cubby-slicer:engine-threads`): 0 = auto, 1 = single-threaded, N = N threads. */
export function engineThreadsPref(): number {
  const n = Number(readString(THREADS_KEY));
  return Number.isFinite(n) && n >= 0 ? Math.min(64, Math.floor(n)) : 0;
}
/** Set the thread preference (Preferences); idle engines restart so the next slice uses it. */
export function setEngineThreadsPref(n: number): void {
  if (n > 0) writeString(THREADS_KEY, String(Math.min(64, Math.floor(n)))); else removeKey(THREADS_KEY);
  for (const w of workers.values()) if (w.idle) w.reset(null);
}

export function artifactBase(engine: EngineId): string {
  return `${import.meta.env.BASE_URL}wasm/${engine}/`;
}

/** Whether engines can use their multi-threaded builds on this page (needs SharedArrayBuffer). */
export function engineThreadsAvailable(): boolean {
  return globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
}

interface Pending {
  resolve: (v: WorkerResponse) => void;
  reject: (e: unknown) => void;
  onProgress?: (p: SliceProgress) => void;
}

/**
 * Something that attaches to every engine worker while it lives (the plugin runtime's
 * slicing-pipeline HookChannel, src/plugins). Called for workers that already exist too;
 * the returned function runs when that worker is terminated (cancel, crash, restart).
 */
export type EngineWorkerAttach = (worker: Worker, engine: EngineId) => (() => void) | void;
const attachers = new Set<EngineWorkerAttach>();
const liveWorkers = new Map<Worker, { engine: EngineId; detach: Array<() => void> }>();

export function onEngineWorker(fn: EngineWorkerAttach): () => void {
  attachers.add(fn);
  for (const [w, e] of liveWorkers) { const d = fn(w, e.engine); if (d) e.detach.push(d); }
  return () => { attachers.delete(fn); };
}

function workerStarted(w: Worker, engine: EngineId): void {
  const entry = { engine, detach: [] as Array<() => void> };
  liveWorkers.set(w, entry);
  for (const fn of attachers) { const d = fn(w, engine); if (d) entry.detach.push(d); }
}

function workerStopped(w: Worker | null): void {
  const e = w ? liveWorkers.get(w) : undefined;
  if (!w || !e) return;
  liveWorkers.delete(w);
  for (const d of e.detach) { try { d(); } catch { /* ignore */ } }
}

/**
 * Engine lanes. 'main' runs slices, painting sessions and the quick tools.
 * 'background' is a second, single-threaded Orca instance for long tool runs
 * (texture displacement preview / bake, 10-20 s each): they don't hold up a
 * slice or a brush stroke queued on the main lane, and cancelling one only
 * terminates this lane's worker. Single-threaded because the texture op gains
 * nothing from the pthreads build (measured: the same 13-17 s on both for a
 * 20 mm cube), and a second thread pool would compete with slicing.
 */
export type EngineLane = 'main' | 'background';

class EngineWorker {
  private worker: Worker | null = null;
  /** The multi-threaded engine stalled once this session: new workers start single-threaded. */
  noMt = false;
  /** Terminate the worker once nothing is pending (frees its instance's heap). */
  releaseWhenIdle = false;
  /** How long the last warm-up (a fresh worker's first, cheap request) took: the engine's startup, ms. */
  startupMs = 0;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor(readonly engine: EngineId, readonly lane: EngineLane = 'main') {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./engine.worker.ts', import.meta.url), {
      type: 'module',
      name: this.lane === 'main' ? `cubby-engine-${this.engine}` : `cubby-engine-${this.engine}-${this.lane}`,
    });
    w.postMessage({
      type: 'init', engine: this.engine, base: new URL(artifactBase(this.engine), location.href).href, noMt: this.noMt,
      threads: this.lane === 'main' ? engineThreadsPref() : 1,
    });
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') { p.onProgress?.({ percent: msg.percent, message: msg.message }); return; }
      this.pending.delete(msg.id);
      p.resolve(msg);
      if (this.releaseWhenIdle && !this.pending.size) this.reset(null);
    };
    w.onerror = (ev) => {
      // A load-level failure (bad artifact URL, syntax error). Fail everything
      // in flight and drop the worker so the next call starts clean.
      ev.preventDefault();
      this.reset(new SliceError(ev.message || 'Engine worker crashed', null, true));
    };
    this.worker = w;
    workerStarted(w, this.engine);
    return w;
  }

  get idle(): boolean { return this.pending.size === 0; }
  get started(): boolean { return this.worker !== null; }

  reset(reason: unknown): void {
    this.releaseWhenIdle = false;
    this.worker?.terminate();
    workerStopped(this.worker);
    this.worker = null;
    const pend = [...this.pending.values()];
    this.pending.clear();
    for (const p of pend) p.reject(reason);
  }

  request(req: WorkerRequest, transfer: Transferable[] = [], onProgress?: (p: SliceProgress) => void,
          signal?: AbortSignal): Promise<WorkerResponse> {
    if (signal?.aborted) return Promise.reject(new SliceCancelled());
    this.releaseWhenIdle = false;
    const w = this.ensure();
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject, onProgress });
      signal?.addEventListener('abort', () => {
        if (this.pending.has(req.id)) this.reset(new SliceCancelled());
      }, { once: true });
      w.postMessage(req, transfer);
    });
  }

  nextId(): number { return ++this.seq; }
}

const workers = new Map<string, EngineWorker>();
function workerFor(engine: EngineId, lane: EngineLane = 'main'): EngineWorker {
  const key = lane === 'main' ? engine : `${engine}:${lane}`;
  let w = workers.get(key);
  if (!w) { w = new EngineWorker(engine, lane); workers.set(key, w); }
  return w;
}

/**
 * Start a lane's engine instance ahead of its first request (a cheap tool
 * call), so a run queued right after a cancel doesn't also pay the startup.
 */
export function warmEngineLane(lane: EngineLane): void {
  const w = workerFor('orca', lane);
  if (w.started) return;
  const t0 = performance.now();
  void w.request({ type: 'tool', id: w.nextId(), op: 'paint_from_states', args: { states: [[0, 1]] }, meshes: [TRIANGLE] })
    .then(() => { w.startupMs = performance.now() - t0; }).catch(() => {});
}
const TRIANGLE: ToolMesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };

/** What starting the lane's engine took last time (ms; 0 = not measured yet). */
export function engineLaneStartupMs(lane: EngineLane): number {
  return workers.get(lane === 'main' ? 'orca' : `orca:${lane}`)?.startupMs ?? 0;
}

/** Let a lane's worker go once its queue is empty (the tool that used it closed). */
export function releaseEngineLane(lane: EngineLane): void {
  if (lane === 'main') return;
  const w = workers.get(`orca:${lane}`);
  if (!w?.started) return;
  if (w.idle) w.reset(null); else w.releaseWhenIdle = true;
}

/**
 * Slice a job. Mesh buffers are *copied* into a single transferable blob, so
 * callers keep ownership of their Float32Array/Uint32Array.
 */
export async function sliceJob(
  job: SliceJob,
  onProgress?: (p: SliceProgress) => void,
  signal?: AbortSignal,
): Promise<SliceResult> {
  const w = workerFor(job.engine);
  let res = await w.request({ type: 'slice', id: w.nextId(), job }, [], onProgress, signal);
  if (res.type === 'error' && res.stalled) {
    // The multi-threaded engine hung: restart the worker single-threaded and retry once.
    console.warn(`[${job.engine}] ${res.message}; retrying single-threaded`);
    w.noMt = true;
    w.reset(new SliceError(res.message, null, true));
    onProgress?.({ percent: 0, message: 'Retrying with the single-threaded engine' });
    res = await w.request({ type: 'slice', id: w.nextId(), job }, [], onProgress, signal);
  }
  if (res.type === 'result') {
    return { engine: job.engine, gcode: new Uint8Array(res.gcode), report: res.report };
  }
  if (res.type === 'error') {
    if (res.fatal) w.reset(new SliceError(res.message, res.report ?? null, true));
    throw new SliceError(res.message, res.report ?? null, res.fatal);
  }
  throw new SliceError(`Unexpected engine response: ${res.type}`, null, false);
}

const schemaCache = new Map<EngineId, Promise<ConfigSchema>>();

/**
 * The engines also report `enums` (coEnums: z_hop_types, nozzle_volume_type,
 * extruder_type, …) and `pointsGroups` (extruder_printable_area). The app has
 * no editor for either: both are per-extruder / per-variant string vectors,
 * the shape the generated fixture gives them, so treat them as `strings`
 * (otherwise a per-extruder value collapses to its first element on load).
 */
export function normalizeSchema(s: ConfigSchema): ConfigSchema {
  for (const def of Object.values(s.options ?? {})) {
    const t = def.type as string;
    if (t === 'enums' || t === 'pointsGroups') def.type = 'strings';
  }
  return s;
}

/** Engine config schema. Prefers the build-time schema.json; falls back to asking the engine. */
export function getSchema(engine: EngineId): Promise<ConfigSchema> {
  let p = schemaCache.get(engine);
  if (!p) {
    p = (async () => {
      try {
        const rsp = await fetch(`${artifactBase(engine)}schema.json`);
        if (rsp.ok) return normalizeSchema((await rsp.json()) as ConfigSchema);
      } catch { /* fall through */ }
      const w = workerFor(engine);
      const res = await w.request({ type: 'describe', id: w.nextId() });
      if (res.type === 'schema') return normalizeSchema(res.schema);
      throw new SliceError(res.type === 'error' ? res.message : 'describe failed', null, false);
    })();
    p.catch(() => schemaCache.delete(engine));
    schemaCache.set(engine, p);
  }
  return p;
}

export async function getEngineVersion(engine: EngineId): Promise<EngineVersion | null> {
  try {
    const rsp = await fetch(`${artifactBase(engine)}version.json`);
    return rsp.ok ? ((await rsp.json()) as EngineVersion) : null;
  } catch { return null; }
}

/** Evaluate a compatible_*_condition expression. null = could not evaluate. */
export async function evalCondition(engine: EngineId, expr: string, config: FlatConfig): Promise<boolean | null> {
  if (!expr.trim()) return true;
  const w = workerFor(engine);
  try {
    const res = await w.request({ type: 'evalCondition', id: w.nextId(), expr, config });
    return res.type === 'condition' ? res.value : null;
  } catch { return null; }
}

/**
 * OrcaSlicer's Auto Orient for one object. `object.transform` should carry the
 * object's current rotation * scale (translation is ignored). Resolves to a
 * row-major 3x3 rotation to PRE-multiply onto the object's rotation; the
 * caller then drops the object to the bed. Always runs on the Orca engine
 * (preFlight has no FFF auto-orient).
 */
export async function autoOrient(object: SliceObjectInput, signal?: AbortSignal): Promise<number[]> {
  const w = workerFor('orca');
  const res = await w.request({ type: 'orient', id: w.nextId(), object }, [], undefined, signal);
  if (res.type === 'orient') return res.rotation;
  throw new SliceError(res.type === 'error' ? res.message : 'auto-orient failed', null, res.type === 'error' && res.fatal);
}

/**
 * OrcaSlicer's auto arrange (ArrangeJob: Arrange all / Arrange plate) over the
 * project's objects. `objects` are slice-job inputs (transforms plate-local for
 * objects on a plate); `args.items` is parallel to them. Always runs on the
 * Orca engine.
 */
export async function orcaArrange(config: FlatConfig, objects: SliceObjectInput[], args: ArrangeArgs, signal?: AbortSignal): Promise<ArrangeResult> {
  const w = workerFor('orca');
  const res = await w.request({ type: 'arrange', id: w.nextId(), config, objects, args }, [], undefined, signal);
  if (res.type === 'tool') return res.result as ArrangeResult;
  throw new SliceError(res.type === 'error' ? res.message : 'arrange failed', null, res.type === 'error' && res.fatal);
}

// ---- engine tools (cs_tool) --------------------------------------------------------

/**
 * Run an engine tool (see docs/ENGINE-CONTRACT.md "Tools", ops in tools.ts).
 * Tools run on a long-lived Orca instance in the worker (painting sessions
 * keep state there); mesh arrays are copied, callers keep theirs. `signal`
 * cancels by terminating the lane's worker (painting sessions on it go too,
 * so long cancellable runs use the 'background' lane).
 */
export async function engineTool<K extends ToolOp>(op: K, args: ToolArgs<K>, meshes: ToolMesh[] = [],
                                                   signal?: AbortSignal, lane: EngineLane = 'main'): Promise<{ result: ToolResult<K>; meshes: ToolMesh[] }> {
  const w = workerFor('orca', lane);
  const res = await w.request({ type: 'tool', id: w.nextId(), op, args, meshes }, [], undefined, signal);
  if (res.type === 'tool') return { result: res.result as ToolResult<K>, meshes: res.meshes };
  throw new SliceError(res.type === 'error' ? res.message : `${op} failed`, null, res.type === 'error' && res.fatal);
}

/** Orca "Adaptive" variable layer height: profile [z0,h0,…] for an object (mesh + mesh→bed transform). */
export async function adaptiveLayerProfile(mesh: ToolMesh, transform: number[], config: FlatConfig, quality: number): Promise<number[]> {
  return (await engineTool('layer_profile_adaptive', { transform, config, quality }, [mesh])).result.profile;
}

/** Orca "Smooth" variable layer height (HeightProfileSmoothingParams). */
export async function smoothLayerProfile(mesh: ToolMesh, transform: number[], config: FlatConfig, profile: number[],
                                         radius: number, keepMin: boolean): Promise<number[]> {
  return (await engineTool('layer_profile_smooth', { transform, config, profile, radius, keepMin }, [mesh])).result.profile;
}

/**
 * Per-triangle states → Orca paint strings (e.g. OBJ face colours → color
 * painting): `states` are sparse [triangleIndex, state] pairs, state 1..32 =
 * filament (color) or 1 enforcer / 2 blocker (support, seam).
 */
export async function paintFromStates(mesh: ToolMesh, states: Array<[number, number]>): Promise<PaintMap> {
  if (!states.length) return [];
  return (await engineTool('paint_from_states', { states }, [mesh])).result.paint;
}

// ---- mixed filaments / extruder variants (orca 2.5) ------------------------------------

/** Orca's blend of `components` (1-based into `colors`) at `ratios` (weights), with the lab-measured colour when known. */
export async function mixedPreview(colors: string[], components: number[], ratios: number[]): Promise<MixedPreviewResult> {
  return (await engineTool('mixed_filament', { action: 'preview', colors, components, ratios })).result as MixedPreviewResult;
}

/** Desktop's colour-match recipe for `target` from the physical filaments (or a standard CMYW / RYBW set). */
export async function mixedRecommend(args: Omit<Extract<ToolArgs<'mixed_filament'>, { action: 'recommend' }>, 'action'>): Promise<MixedRecommendResult> {
  return (await engineTool('mixed_filament', { action: 'recommend', ...args })).result as MixedRecommendResult;
}

/** Orca's validate_mixed_filament_params on a config's mix keys: { key: message } (empty = valid). */
export async function mixedValidate(config: FlatConfig): Promise<Record<string, string>> {
  return ((await engineTool('mixed_filament', { action: 'validate', config })).result as MixedValidateResult).errors ?? {};
}

/** What each extruder / filament uses of the extruder-variant vectors in a job config (no slice). */
export async function resolveVariants(config: FlatConfig): Promise<ResolveVariantsResult> {
  return (await engineTool('resolve_variants', { config })).result;
}

/** Probe whether an engine's artifacts are deployed. */
export async function isEngineAvailable(engine: EngineId): Promise<boolean> {
  try {
    const rsp = await fetch(`${artifactBase(engine)}slicer.wasm`, { method: 'HEAD' });
    return rsp.ok;
  } catch { return false; }
}

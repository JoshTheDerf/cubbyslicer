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
import type {
  ArrangeArgs, ArrangeResult, ConfigSchema, EngineId, EngineVersion, FlatConfig, PaintMap, SliceJob, SliceObjectInput, SliceProgress, SliceReport,
  SliceResult, ToolMesh, WorkerRequest, WorkerResponse,
} from './types';

export class SliceError extends Error {
  constructor(message: string, readonly report: SliceReport | null, readonly fatal: boolean) {
    super(message);
    this.name = 'SliceError';
  }
}

export class SliceCancelled extends Error {
  constructor() { super('Slice cancelled'); this.name = 'SliceCancelled'; }
}

/** Engine thread preference (localStorage `cubby-slicer:engine-threads`): 0 = auto, 1 = single-threaded, N = N threads. */
export function engineThreadsPref(): number {
  try { const n = Number(localStorage.getItem('cubby-slicer:engine-threads')); return Number.isFinite(n) && n >= 0 ? Math.min(64, Math.floor(n)) : 0; } catch { return 0; }
}

export const ENGINE_LABELS: Record<EngineId, string> = {
  orca: 'OrcaSlicer',
  preflight: 'preFlight',
  fullspectrum: 'Full Spectrum',
};

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

class EngineWorker {
  private worker: Worker | null = null;
  /** The multi-threaded engine stalled once this session: new workers start single-threaded. */
  noMt = false;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor(readonly engine: EngineId) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./engine.worker.ts', import.meta.url), {
      type: 'module',
      name: `cubby-engine-${this.engine}`,
    });
    w.postMessage({ type: 'init', engine: this.engine, base: new URL(artifactBase(this.engine), location.href).href, noMt: this.noMt, threads: engineThreadsPref() });
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') { p.onProgress?.({ percent: msg.percent, message: msg.message }); return; }
      this.pending.delete(msg.id);
      p.resolve(msg);
    };
    w.onerror = (ev) => {
      // A load-level failure (bad artifact URL, syntax error). Fail everything
      // in flight and drop the worker so the next call starts clean.
      ev.preventDefault();
      this.reset(new SliceError(ev.message || 'Engine worker crashed', null, true));
    };
    this.worker = w;
    return w;
  }

  reset(reason: unknown): void {
    this.worker?.terminate();
    this.worker = null;
    const pend = [...this.pending.values()];
    this.pending.clear();
    for (const p of pend) p.reject(reason);
  }

  request(req: WorkerRequest, transfer: Transferable[] = [], onProgress?: (p: SliceProgress) => void,
          signal?: AbortSignal): Promise<WorkerResponse> {
    if (signal?.aborted) return Promise.reject(new SliceCancelled());
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

const workers = new Map<EngineId, EngineWorker>();
function workerFor(engine: EngineId): EngineWorker {
  let w = workers.get(engine);
  if (!w) { w = new EngineWorker(engine); workers.set(engine, w); }
  return w;
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

/** Engine config schema. Prefers the build-time schema.json; falls back to asking the engine. */
export function getSchema(engine: EngineId): Promise<ConfigSchema> {
  let p = schemaCache.get(engine);
  if (!p) {
    p = (async () => {
      try {
        const rsp = await fetch(`${artifactBase(engine)}schema.json`);
        if (rsp.ok) return (await rsp.json()) as ConfigSchema;
      } catch { /* fall through */ }
      const w = workerFor(engine);
      const res = await w.request({ type: 'describe', id: w.nextId() });
      if (res.type === 'schema') return res.schema;
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
 * Run an engine tool (see docs/ENGINE-CONTRACT.md "Tools"). Tools run on a
 * long-lived instance in the worker (painting sessions keep state there);
 * mesh arrays are copied, callers keep theirs.
 */
export async function engineTool<T>(op: string, args: unknown, meshes: ToolMesh[] = [], engine: EngineId = 'orca',
                                    signal?: AbortSignal): Promise<{ result: T; meshes: ToolMesh[] }> {
  const w = workerFor(engine);
  const res = await w.request({ type: 'tool', id: w.nextId(), op, args, meshes }, [], undefined, signal);
  if (res.type === 'tool') return { result: res.result as T, meshes: res.meshes };
  throw new SliceError(res.type === 'error' ? res.message : `${op} failed`, null, res.type === 'error' && res.fatal);
}

/** Orca "Adaptive" variable layer height: profile [z0,h0,…] for an object (mesh + mesh→bed transform). */
export async function adaptiveLayerProfile(mesh: ToolMesh, transform: number[], config: FlatConfig, quality: number): Promise<number[]> {
  return (await engineTool<{ profile: number[] }>('layer_profile_adaptive', { transform, config, quality }, [mesh])).result.profile;
}

/** Orca "Smooth" variable layer height (HeightProfileSmoothingParams). */
export async function smoothLayerProfile(mesh: ToolMesh, transform: number[], config: FlatConfig, profile: number[],
                                         radius: number, keepMin: boolean): Promise<number[]> {
  return (await engineTool<{ profile: number[] }>('layer_profile_smooth', { transform, config, profile, radius, keepMin }, [mesh])).result.profile;
}

/**
 * Per-triangle states → Orca paint strings (e.g. OBJ face colours → color
 * painting): `states` are sparse [triangleIndex, state] pairs, state 1..16 =
 * extruder (color) or 1 enforcer / 2 blocker (support, seam).
 */
export async function paintFromStates(mesh: ToolMesh, states: Array<[number, number]>): Promise<PaintMap> {
  return (await engineTool<{ paint: PaintMap }>('paint_from_states', { states }, [mesh])).result.paint;
}

/** Probe whether an engine's artifacts are deployed. */
export async function isEngineAvailable(engine: EngineId): Promise<boolean> {
  try {
    const rsp = await fetch(`${artifactBase(engine)}slicer.wasm`, { method: 'HEAD' });
    return rsp.ok;
  } catch { return false; }
}

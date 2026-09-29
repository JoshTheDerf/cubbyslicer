/// <reference lib="webworker" />
/**
 * Engine worker: hosts one WASM slicing engine (see docs/ENGINE-CONTRACT.md).
 *
 * Two builds of an engine may be deployed:
 *  - single-threaded (`<base>slicer.*`) — always available;
 *  - multi-threaded (`<base>mt/slicer.*`, Emscripten pthreads + oneTBB) — used
 *    when the page is cross-origin isolated (SharedArrayBuffer available) and
 *    the artifacts load; otherwise we fall back to the single-threaded build.
 *
 * Memory-safety rules followed here:
 *  - `slicer.wasm` is compiled ONCE (WebAssembly.Module).
 *  - Single-threaded build: a FRESH instance per request. Heap fragmentation,
 *    engine globals and any state left behind by a trap never carry over.
 *  - Multi-threaded build: ONE instance is reused for every request, because
 *    each instance owns a pool of pthread Workers (one per core) that takes
 *    hundreds of ms to spin up. Requests are serialised; every buffer we
 *    allocate is freed; the instance (and its Workers) is recycled once its
 *    heap passes RECYCLE_HEAP_BYTES. A trap anywhere — including on an engine
 *    thread — is reported as fatal, and the client then terminates this whole
 *    worker (which also terminates the nested pthread Workers).
 *  - Heap views are never cached across calls into the engine: memory growth
 *    replaces them (in the MT build another thread may grow the heap, so views
 *    are re-synced with `csSyncHeap()` before every access).
 *  - All pointers from the engine are treated as unsigned (heap may exceed
 *    2 GB), and every (ptr, len) pair is bounds-checked against the current
 *    heap before it's read.
 *  - Output is copied out of the heap before the instance is dropped/reused.
 */
import type {
  ConfigSchema, EngineId, FlatConfig, SliceJob, SliceReport, ToolMesh, WorkerRequest, WorkerResponse,
} from './types';

interface EngineModule {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _cs_version(): number;
  _cs_describe_config(outPtr: number, outLen: number): number;
  _cs_slice(job: number, jobLen: number, blob: number, blobLen: number,
            outG: number, outGLen: number, outR: number, outRLen: number): number;
  _cs_eval_condition(expr: number, exprLen: number, cfg: number, cfgLen: number): number;
  _cs_orient?(job: number, jobLen: number, blob: number, blobLen: number, outJ: number, outJLen: number): number;
  _cs_tool?(job: number, jobLen: number, blob: number, blobLen: number, outJ: number, outJLen: number, outB: number, outBLen: number): number;
  _cs_free(p: number): void;
  UTF8ToString(p: number, maxBytes?: number): string;
  // Multi-threaded build only (wasm/mt_post.js + cs_bridge.cpp in orcaslicer-wasm).
  _cs_slice_start?(job: number, jobLen: number, blob: number, blobLen: number,
                   outG: number, outGLen: number, outR: number, outRLen: number, state: number): number;
  _cs_thread_count?(): number;
  csTerminateThreads?(): void;
  csSyncHeap?(): void;
}

type Factory = (opts: Record<string, unknown>) => Promise<EngineModule>;

interface Artifacts {
  mt: boolean;
  dir: string;
  factory: Factory;
  wasm: WebAssembly.Module;
  data: ArrayBuffer | null;
}

/** Engines that ship a pthreads build in `<base>mt/`. */
const MT_ENGINES: ReadonlySet<EngineId> = new Set<EngineId>(['orca']);
/** Recycle the shared MT instance once its heap grows past this (fragmentation / high-water). */
const RECYCLE_HEAP_BYTES = 1536 * 1024 * 1024;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let engine: EngineId = 'orca';
let base = '';
let artifactsP: Promise<Artifacts> | null = null;

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

/** Set when the MT engine stalled / failed to start in this or a previous worker: stay single-threaded. */
let mtDisabled = false;
/** Thread count override for the MT engine (0 = hardwareConcurrency, capped at 16 by the engine). */
let mtThreads = 0;
/** A stalled multi-threaded engine (no progress): the client restarts the worker single-threaded. */
class EngineStall extends Error { constructor(m: string) { super(m); this.name = 'EngineStall'; } }
const MT_START_TIMEOUT_MS = 20_000;
/** No progress at all after starting a MT slice / between progress reports. */
const MT_FIRST_PROGRESS_MS = 45_000, MT_PROGRESS_GAP_MS = 180_000;
let lastProgressAt = 0, sawProgress = false, lastProgressKey = '';

function mtSupported(): boolean {
  return !mtDisabled && MT_ENGINES.has(engine) && ctx.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
}

async function loadArtifactsFrom(dir: string, mt: boolean): Promise<Artifacts> {
  const compile = async (): Promise<WebAssembly.Module> => {
    const url = `${dir}slicer.wasm`;
    if (typeof WebAssembly.compileStreaming === 'function') {
      try { return await WebAssembly.compileStreaming(fetch(url)); } catch { /* wrong MIME etc. */ }
    }
    const rsp = await fetch(url);
    if (!rsp.ok) throw new Error(`Failed to fetch ${url}: HTTP ${rsp.status}`);
    return WebAssembly.compile(await rsp.arrayBuffer());
  };
  // Optional Emscripten preload package (resources the engine reads at slice time).
  const data = fetch(`${dir}slicer.data`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  const [factory, wasm, dataBuf] = await Promise.all([
    import(/* @vite-ignore */ `${dir}slicer.mjs`).then((m) => m.default as Factory),
    compile(),
    data,
  ]);
  return { mt, dir, factory, wasm, data: dataBuf };
}

function useSingleThreaded(reason: string): Promise<Artifacts> {
  console.info(`[${engine}] engine: single-threaded (${reason})`);
  artifactsP = loadArtifactsFrom(base, false);
  artifactsP.catch(() => { artifactsP = null; });
  return artifactsP;
}

async function loadArtifacts(): Promise<Artifacts> {
  if (artifactsP) return artifactsP;
  if (!mtSupported()) {
    return useSingleThreaded(MT_ENGINES.has(engine) ? 'page is not cross-origin isolated' : 'no multi-threaded build');
  }
  artifactsP = loadArtifactsFrom(`${base}mt/`, true).catch((e: unknown) => {
    console.warn(`[${engine}] multi-threaded engine unavailable:`, e);
    return useSingleThreaded('multi-threaded artifacts failed to load');
  });
  return artifactsP;
}

// Progress sink of the request currently running (the MT instance is shared).
let progressSink: ((pct: number, msg: string) => void) | undefined;
// Fails the in-flight MT wait when an engine thread traps / aborts.
let failInflight: ((e: Error) => void) | null = null;

async function instantiate(art: Artifacts, onProgress?: (pct: number, msg: string) => void): Promise<EngineModule> {
  return art.factory({
    locateFile: (f: string) => `${art.dir}${f}`,
    ...(art.mt ? { mainScriptUrlOrBlob: `${art.dir}slicer.mjs`, ...(mtThreads > 0 ? { csThreads: mtThreads } : {}) } : {}),
    instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
      WebAssembly.instantiate(art.wasm, imports).then((inst) => done(inst, art.wasm));
      return {};
    },
    getPreloadedPackage: (name: string) => (art.data && name.endsWith('.data') ? art.data.slice(0) : undefined),
    print: () => {},
    printErr: (m: string) => { if (!/^\s*$/.test(m)) console.debug(`[${engine}]`, m); },
    onAbort: (what: unknown) => failInflight?.(new WebAssembly.RuntimeError(`engine aborted: ${String(what)}`)),
    csProgress: (pct: number, msg: string) => (onProgress ?? progressSink)?.(pct, msg),
  });
}

// ---- multi-threaded instance (shared) -------------------------------------------

let mtModP: Promise<EngineModule> | null = null;

function dropMt(mod: EngineModule | null): void {
  mtModP = null;
  try { mod?.csTerminateThreads?.(); } catch { /* already gone */ }
}

async function mtModule(art: Artifacts): Promise<EngineModule> {
  if (!mtModP) {
    const t0 = performance.now();
    // Creating the pthread pool can hang on some machines / browsers (e.g. many
    // cores, memory pressure): give up after a while and run single-threaded.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`multi-threaded engine did not start within ${MT_START_TIMEOUT_MS / 1000} s`)), MT_START_TIMEOUT_MS);
    });
    mtModP = Promise.race([instantiate(art), timeout]).then((mod) => {
      clearTimeout(timer);
      console.info(`[${engine}] engine: multi-threaded, ${mod._cs_thread_count?.() ?? '?'} threads `
        + `(instance ready in ${Math.round(performance.now() - t0)} ms)`);
      return mod;
    }, (e: unknown) => {
      clearTimeout(timer);
      mtDisabled = true;
      throw e;
    });
    mtModP.catch(() => { mtModP = null; });
  }
  return mtModP;
}

/**
 * The module a request runs on. `shared` = the MT instance (caller must free
 * what it allocates); otherwise a fresh single-use instance.
 */
async function moduleFor(onProgress?: (pct: number, msg: string) => void): Promise<{ mod: EngineModule; shared: boolean }> {
  const art = await loadArtifacts();
  if (art.mt) {
    try {
      return { mod: await mtModule(art), shared: true };
    } catch (e) {
      // e.g. the browser can't reserve a 4 GB shared heap, or Workers are blocked.
      console.warn(`[${engine}] multi-threaded engine failed to start:`, e);
      const st = await useSingleThreaded('multi-threaded engine failed to start');
      return { mod: await instantiate(st, onProgress), shared: false };
    }
  }
  return { mod: await instantiate(art, onProgress), shared: false };
}

// ---- heap helpers ---------------------------------------------------------------

function u32(mod: EngineModule, ptr: number): number {
  mod.csSyncHeap?.();
  const p = ptr >>> 0;
  if (p % 4 !== 0 || p + 4 > mod.HEAPU8.byteLength) throw new Error('engine returned an invalid pointer');
  return mod.HEAPU32[p >>> 2] >>> 0;
}

function copyOut(mod: EngineModule, ptr: number, len: number): Uint8Array {
  mod.csSyncHeap?.();
  const p = ptr >>> 0, n = len >>> 0;
  if (!p || p + n > mod.HEAPU8.byteLength) throw new Error('engine returned an out-of-bounds buffer');
  return mod.HEAPU8.slice(p, p + n); // copy: survives the instance
}

function writeIn(mod: EngineModule, bytes: Uint8Array): number {
  const p = mod._malloc(Math.max(1, bytes.byteLength)) >>> 0;
  if (!p) throw new Error('Out of memory in engine (malloc failed)');
  mod.csSyncHeap?.();
  mod.HEAPU8.set(bytes, p); // fresh HEAPU8 read after malloc (growth may have replaced it)
  return p;
}

/** malloc `words` zeroed u32 slots (out-params / state). */
function allocWords(mod: EngineModule, words: number): number {
  const p = mod._malloc(words * 4) >>> 0;
  if (!p) throw new Error('Out of memory in engine (malloc failed)');
  mod.csSyncHeap?.();
  mod.HEAPU32.fill(0, p >>> 2, (p >>> 2) + words);
  return p;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

type WaitAsync = (a: Int32Array, i: number, v: number, t?: number) => { async: boolean; value: unknown };
const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;

/**
 * Wait (without blocking this worker's event loop — Emscripten needs it to
 * start pthread Workers and to deliver progress) until cs_slice_start's
 * state[0] flips to 1; resolves with state[1] (cs_slice's return code).
 */
function waitForSlice(mod: EngineModule, state: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, rc = 0) => {
      if (settled) return;
      settled = true;
      failInflight = null;
      ctx.removeEventListener('error', onError);
      if (err) reject(err); else resolve(rc);
    };
    // An engine thread that traps surfaces as an uncaught error in this worker
    // (Emscripten rethrows it from the pthread Worker's onerror).
    const onError = (ev: ErrorEvent) => {
      ev.preventDefault();
      finish(new WebAssembly.RuntimeError(`engine thread crashed: ${ev.message || 'unknown error'}`));
    };
    ctx.addEventListener('error', onError);
    failInflight = (e) => finish(e);
    const i = state >>> 2;
    lastProgressAt = performance.now();
    sawProgress = false;
    lastProgressKey = '';
    void (async () => {
      while (!settled) {
        mod.csSyncHeap?.();
        const heap = mod.HEAP32;
        if (Atomics.load(heap, i) !== 0) { finish(null, Atomics.load(heap, i + 1)); return; }
        const idle = performance.now() - lastProgressAt;
        if (idle > (sawProgress ? MT_PROGRESS_GAP_MS : MT_FIRST_PROGRESS_MS)) {
          finish(new EngineStall(`the multi-threaded engine stopped responding (${Math.round(idle / 1000)} s without progress)`));
          return;
        }
        const w = waitAsync?.(heap, i, 0, 500);
        if (w?.async) await w.value;
        else if (!w) await new Promise((r) => setTimeout(r, 10));
      }
    })().catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
  });
}

// ---- requests ---------------------------------------------------------------------

/** Pack meshes into one blob; returns job JSON with byte offsets. */
function packJob(job: SliceJob): { json: Uint8Array; blob: Uint8Array } {
  // Instances share their mesh arrays: pack each distinct array once.
  let size = 0;
  const offsets = new Map<ArrayBufferView, number>();
  const chunks: ArrayBufferView[] = [];
  const place = (a: Float32Array | Uint32Array): number => {
    let off = offsets.get(a);
    if (off === undefined) { off = size; size += a.byteLength; offsets.set(a, off); chunks.push(a); }
    return off;
  };
  const entry = (name: string, positions: Float32Array, indices: Uint32Array, transform: number[]) => {
    if (positions.length % 3 !== 0 || indices.length % 3 !== 0) throw new Error(`${name}: malformed mesh arrays`);
    return {
      name,
      vertexOffset: place(positions),
      vertexCount: positions.length / 3,
      indexOffset: place(indices),
      triangleCount: indices.length / 3,
      transform,
    };
  };
  const objects = job.objects.map((o) => ({
    ...entry(o.name, o.positions, o.indices, o.transform),
    config: o.config ?? {},
    ...(o.parts?.length ? {
      parts: o.parts.map((p) => ({
        ...entry(p.name, p.positions, p.indices, p.transform), type: p.type, config: p.config ?? {}, ...(p.paint ? { paint: p.paint } : {}),
      })),
    } : {}),
    ...(o.paint ? { paint: o.paint } : {}),
    ...(o.layerHeightProfile?.length ? { layerHeightProfile: o.layerHeightProfile } : {}),
    ...(o.layerRanges?.length ? { layerRanges: o.layerRanges } : {}),
    ...(o.brimPoints?.length ? { brimPoints: o.brimPoints } : {}),
  }));
  const blob = new Uint8Array(size);
  for (const a of chunks) blob.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offsets.get(a)!);
  const payload = { config: job.config, options: { validate: true, dropToBed: true, ...job.options }, objects };
  return { json: enc.encode(JSON.stringify(payload)), blob };
}

function isTrap(e: unknown): boolean {
  return e instanceof WebAssembly.RuntimeError
    || (typeof e === 'object' && e !== null && 'name' in e && (e as Error).name === 'RuntimeError')
    || (e instanceof Error && /abort|unreachable|out of bounds|memory access/i.test(e.message));
}

async function doSlice(id: number, job: SliceJob): Promise<void> {
  let lastPct = -1;
  const onProgress = (pct: number, message: string) => {
    // Only real progress counts for the stall watchdog: a stuck engine can keep
    // repeating the same (or an empty) status.
    const key = `${pct}|${message}`;
    if (message && key !== lastProgressKey) {
      lastProgressKey = key;
      lastProgressAt = performance.now();
      if (pct > 0) sawProgress = true;
    }
    if (pct === lastPct && pct < 100) return;
    lastPct = pct;
    post({ type: 'progress', id, percent: pct, message });
  };
  const { mod, shared } = await moduleFor(onProgress);
  const { json, blob } = packJob(job);
  const allocs: number[] = [];
  let gPtr = 0, rPtr = 0;
  progressSink = shared ? onProgress : undefined;
  try {
    const jobPtr = writeIn(mod, json); allocs.push(jobPtr);
    const blobPtr = writeIn(mod, blob); allocs.push(blobPtr);
    const outs = allocWords(mod, 4); allocs.push(outs); // gcodePtr, gcodeLen, reportPtr, reportLen
    let rc: number;
    let threads = 1;
    if (shared && typeof mod._cs_slice_start === 'function') {
      const state = allocWords(mod, 2); allocs.push(state);
      if (mod._cs_slice_start(jobPtr, json.byteLength, blobPtr, blob.byteLength, outs, outs + 4, outs + 8, outs + 12, state) === 0) {
        rc = await waitForSlice(mod, state);
        threads = mod._cs_thread_count?.() ?? 1;
      } else {
        rc = mod._cs_slice(jobPtr, json.byteLength, blobPtr, blob.byteLength, outs, outs + 4, outs + 8, outs + 12);
      }
    } else {
      rc = mod._cs_slice(jobPtr, json.byteLength, blobPtr, blob.byteLength, outs, outs + 4, outs + 8, outs + 12);
    }
    gPtr = u32(mod, outs); rPtr = u32(mod, outs + 8);
    const gLen = u32(mod, outs + 4), rLen = u32(mod, outs + 12);

    let report: SliceReport = { ok: false, error: `engine returned ${rc} without a report`, warnings: [], stats: null };
    if (rPtr && rLen) {
      try { report = JSON.parse(dec.decode(copyOut(mod, rPtr, rLen))) as SliceReport; } catch { /* keep default */ }
    }
    report.threads = threads;
    if (report.timings) {
      console.info(`[${engine}] slice: ${threads} thread${threads === 1 ? '' : 's'}, process `
        + `${Math.round(report.timings.processMs)} ms, export ${Math.round(report.timings.exportMs)} ms`);
    }
    if (rc !== 0 || !report.ok) {
      post({ type: 'error', id, message: report.error ?? `Slicing failed (code ${rc})`, report, fatal: false });
      return;
    }
    if (!gPtr || !gLen) {
      post({ type: 'error', id, message: 'Engine produced no G-code', report, fatal: false });
      return;
    }
    const gcode = copyOut(mod, gPtr, gLen);
    post({ type: 'result', id, gcode: gcode.buffer as ArrayBuffer, report }, [gcode.buffer as ArrayBuffer]);
  } finally {
    progressSink = undefined;
    // Single-use instances are simply dropped; the shared one must be cleaned.
    // (After a trap this throws or is skipped; the client restarts the worker.)
    if (shared) {
      try {
        if (gPtr) mod._cs_free(gPtr);
        if (rPtr) mod._cs_free(rPtr);
        for (const p of allocs) mod._free(p);
        mod.csSyncHeap?.();
        if (mod.HEAPU8.byteLength > RECYCLE_HEAP_BYTES) dropMt(mod);
      } catch { dropMt(mod); }
    }
  }
}

async function doDescribe(id: number): Promise<void> {
  const { mod, shared } = await moduleFor();
  const outs = allocWords(mod, 2);
  try {
    const rc = mod._cs_describe_config(outs, outs + 4);
    if (rc !== 0) throw new Error(`cs_describe_config failed (${rc})`);
    const p = u32(mod, outs);
    const schema = JSON.parse(dec.decode(copyOut(mod, p, u32(mod, outs + 4)))) as ConfigSchema;
    if (shared) mod._cs_free(p);
    post({ type: 'schema', id, schema });
  } finally {
    if (shared) mod._free(outs);
  }
}

// Conditions are evaluated in bursts (one per preset); reuse one instance for
// them — cs_eval_condition is side-effect free — but drop it after a trap.
// (The MT build reuses its shared instance for everything anyway.)
let condModule: Promise<EngineModule> | null = null;
async function doCondition(id: number, expr: string, config: FlatConfig): Promise<void> {
  const art = await loadArtifacts();
  let mod: EngineModule;
  if (art.mt) ({ mod } = await moduleFor());
  else mod = await (condModule ??= instantiate(art));
  const e = enc.encode(expr), c = enc.encode(JSON.stringify(config));
  const ep = writeIn(mod, e), cp = writeIn(mod, c);
  try {
    const rc = mod._cs_eval_condition(ep, e.byteLength, cp, c.byteLength);
    post({ type: 'condition', id, value: rc < 0 ? null : rc === 1 });
  } finally {
    mod._free(ep); mod._free(cp);
  }
}

async function doOrient(id: number, object: SliceJob['objects'][number]): Promise<void> {
  const { mod, shared } = await moduleFor();
  if (typeof mod._cs_orient !== 'function') throw new Error(`${engine} engine does not support auto-orient`);
  const { json, blob } = packJob({ engine, config: {}, objects: [object] });
  const jp = writeIn(mod, json), bp = writeIn(mod, blob);
  const outs = allocWords(mod, 2);
  let p = 0;
  try {
    mod._cs_orient(jp, json.byteLength, bp, blob.byteLength, outs, outs + 4);
    p = u32(mod, outs);
    const r = JSON.parse(dec.decode(copyOut(mod, p, u32(mod, outs + 4)))) as { ok: boolean; error: string | null; rotation?: number[] };
    if (!r.ok || !r.rotation || r.rotation.length !== 9 || !r.rotation.every(Number.isFinite)) throw new Error(r.error ?? 'auto-orient failed');
    post({ type: 'orient', id, rotation: r.rotation });
  } finally {
    if (shared) {
      if (p) mod._cs_free(p);
      mod._free(jp); mod._free(bp); mod._free(outs);
    }
  }
}

// Tools (painting sessions, cut, layer profiles) run on one long-lived
// instance: painting sessions keep their TriangleSelector state in it. The MT
// build uses its shared instance; ST keeps a dedicated one.
let toolModule: Promise<EngineModule> | null = null;
async function doTool(id: number, op: string, args: unknown, meshes: ToolMesh[]): Promise<void> {
  const art = await loadArtifacts();
  let mod: EngineModule;
  if (art.mt) ({ mod } = await moduleFor());
  else mod = await (toolModule ??= instantiate(art));
  if (typeof mod._cs_tool !== 'function') throw new Error(`${engine} engine does not support ${op}`);
  // Pack meshes (shared arrays once).
  let size = 0;
  const offsets = new Map<ArrayBufferView, number>();
  const chunks: ArrayBufferView[] = [];
  const place = (a: Float32Array | Uint32Array) => {
    let off = offsets.get(a);
    if (off === undefined) { off = size; size += a.byteLength; offsets.set(a, off); chunks.push(a); }
    return off;
  };
  const entries = meshes.map((m) => ({ vertexOffset: place(m.positions), vertexCount: m.positions.length / 3, indexOffset: place(m.indices), triangleCount: m.indices.length / 3 }));
  const blob = new Uint8Array(size);
  for (const a of chunks) blob.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offsets.get(a)!);
  const json = enc.encode(JSON.stringify({ op, args, meshes: entries }));
  const jp = writeIn(mod, json), bp = writeIn(mod, blob);
  const outs = allocWords(mod, 4);
  let pj = 0, pb = 0;
  try {
    mod._cs_tool(jp, json.byteLength, bp, blob.byteLength, outs, outs + 4, outs + 8, outs + 12);
    pj = u32(mod, outs); pb = u32(mod, outs + 8);
    const r = JSON.parse(dec.decode(copyOut(mod, pj, u32(mod, outs + 4)))) as {
      ok: boolean; error: string | null; result: unknown;
      meshes: Array<{ vertexOffset: number; vertexCount: number; indexOffset: number; triangleCount: number }>;
    };
    if (!r.ok) throw new Error(r.error ?? `${op} failed`);
    const blobLen = u32(mod, outs + 12);
    const bytes = r.meshes.length && pb ? copyOut(mod, pb, blobLen) : new Uint8Array(0);
    const out: ToolMesh[] = r.meshes.map((m) => {
      if (m.vertexOffset + m.vertexCount * 12 > bytes.byteLength || m.indexOffset + m.triangleCount * 12 > bytes.byteLength) throw new Error('engine returned an out-of-bounds mesh');
      const positions = new Float32Array(m.vertexCount * 3);
      new Uint8Array(positions.buffer).set(bytes.subarray(m.vertexOffset, m.vertexOffset + m.vertexCount * 12));
      const indices = new Uint32Array(m.triangleCount * 3);
      new Uint8Array(indices.buffer).set(bytes.subarray(m.indexOffset, m.indexOffset + m.triangleCount * 12));
      return { positions, indices };
    });
    const transfer: Transferable[] = [];
    for (const m of out) transfer.push(m.positions.buffer, m.indices.buffer);
    post({ type: 'tool', id, result: r.result, meshes: out }, transfer);
  } finally {
    if (pj) mod._cs_free(pj);
    if (pb) mod._cs_free(pb);
    mod._free(jp); mod._free(bp); mod._free(outs);
  }
}

async function handle(msg: WorkerRequest): Promise<void> {
  try {
    if (msg.type === 'slice') await doSlice(msg.id, msg.job);
    else if (msg.type === 'describe') await doDescribe(msg.id);
    else if (msg.type === 'evalCondition') await doCondition(msg.id, msg.expr, msg.config);
    else if (msg.type === 'orient') await doOrient(msg.id, msg.object);
    else if (msg.type === 'tool') await doTool(msg.id, msg.op, msg.args, msg.meshes);
  } catch (e) {
    if (e instanceof EngineStall) {
      mtDisabled = true;
      mtModP = null;
      post({ type: 'error', id: msg.id, fatal: true, stalled: true, message: e.message });
      return;
    }
    const fatal = isTrap(e);
    if (msg.type === 'evalCondition') condModule = null;
    if (msg.type === 'tool' && fatal) toolModule = null;
    if (fatal) mtModP = null; // never reuse a trapped instance (the client restarts us anyway)
    const message = e instanceof Error ? e.message : String(e);
    post({
      type: 'error', id: msg.id, fatal,
      message: fatal ? `The ${engine} engine crashed (${message}). This is an engine bug; the engine has been restarted.` : message,
    });
  }
}

// Requests run one at a time, in arrival order. (The MT slice awaits instead
// of blocking this thread, so without the queue a condition/describe request
// could otherwise enter the shared instance mid-slice.)
let queue: Promise<void> = Promise.resolve();

ctx.onmessage = (ev: MessageEvent<WorkerRequest | { type: 'init'; engine: EngineId; base: string; noMt?: boolean; threads?: number }>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    engine = msg.engine; base = msg.base;
    if (msg.noMt) mtDisabled = true;
    if (msg.threads && msg.threads > 0) { if (msg.threads === 1) mtDisabled = true; else mtThreads = msg.threads; }
    return;
  }
  // A request that never settles (e.g. an engine instance that never finishes
  // starting) must not hold up everything queued behind it: non-slice
  // requests get a deadline; slices have their own stall watchdog.
  const run = () => {
    if (msg.type === 'slice') return handle(msg);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[${engine}] ${msg.type} request timed out`);
        post({ type: 'error', id: msg.id, fatal: false, message: `The ${engine} engine did not answer in time (${msg.type}).` });
        resolve();
      }, 60_000);
    });
    return Promise.race([handle(msg), deadline]).finally(() => clearTimeout(timer));
  };
  queue = queue.then(run);
};

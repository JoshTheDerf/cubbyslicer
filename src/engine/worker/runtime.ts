/**
 * Engine instances for the worker.
 *
 * Two builds of an engine may be deployed:
 *  - single-threaded (`<base>slicer.*`) — always available;
 *  - multi-threaded (`<base>mt/slicer.*`, Emscripten pthreads + oneTBB) — used
 *    when the page is cross-origin isolated (SharedArrayBuffer available) and
 *    the artifacts load; otherwise we fall back to the single-threaded build.
 *
 * Memory-safety rules followed here:
 *  - `slicer.wasm` is compiled ONCE (WebAssembly.Module).
 *  - Single-threaded build: a FRESH instance per slice. Heap fragmentation,
 *    engine globals and any state left behind by a trap never carry over.
 *  - Multi-threaded build: ONE instance is reused for every request, because
 *    each instance owns a pool of pthread Workers (one per core) that takes
 *    hundreds of ms to spin up. Requests are serialised; every buffer we
 *    allocate is freed; the instance (and its Workers) is recycled once its
 *    heap passes RECYCLE_HEAP_BYTES. A trap anywhere — including on an engine
 *    thread — is reported as fatal, and the client then terminates this whole
 *    worker (which also terminates the nested pthread Workers).
 *  - Output is copied out of the heap before the instance is dropped/reused.
 */
import { bridgeAbiError, engineCaps } from '../capabilities';
import type { EngineId } from '../types';
import { isObject, type EngineModule } from './heap';
import { runPluginHook } from '../../plugins/runtime/hookClient';

type Factory = (opts: Record<string, unknown>) => Promise<EngineModule>;

interface Artifacts {
  mt: boolean;
  dir: string;
  factory: Factory;
  wasm: WebAssembly.Module;
  data: ArrayBuffer | null;
}

/** Recycle the shared MT instance once its heap grows past this (fragmentation / high-water). */
const RECYCLE_HEAP_BYTES = 1536 * 1024 * 1024;
const MT_START_TIMEOUT_MS = 20_000;
/** No progress at all after starting a MT slice / between progress reports. */
const MT_FIRST_PROGRESS_MS = 45_000, MT_PROGRESS_GAP_MS = 180_000;

export const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** A stalled multi-threaded engine (no progress): the client restarts the worker single-threaded. */
export class EngineStall extends Error { constructor(m: string) { super(m); this.name = 'EngineStall'; } }

export const rt = {
  engine: 'orca' as EngineId,
  base: '',
  /** Why this worker stays single-threaded ('' = MT allowed): thread preference 1, or the MT engine
   *  stalled / failed to start in this or a previous worker. Logged as the single-threaded reason. */
  mtDisabled: '',
  /** Thread count override for the MT engine (0 = hardwareConcurrency, capped at 16 by the engine). */
  mtThreads: 0,
  /** Progress sink of the request currently running on the shared MT instance. */
  progressSink: undefined as ((pct: number, msg: string) => void) | undefined,
  /** Stall watchdog state (updated by the slice's progress callback). */
  lastProgressAt: 0,
  sawProgress: false,
  lastProgressKey: '',
};

let artifactsP: Promise<Artifacts> | null = null;
// Fails the in-flight MT wait when an engine thread traps / aborts.
let failInflight: ((e: Error) => void) | null = null;
let abiChecked = false;

function mtSupported(): boolean {
  return !rt.mtDisabled && engineCaps(rt.engine).multiThreaded && ctx.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
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
  console.info(`[${rt.engine}] engine: single-threaded (${reason})`);
  artifactsP = loadArtifactsFrom(rt.base, false);
  artifactsP.catch(() => { artifactsP = null; });
  return artifactsP;
}

export async function loadArtifacts(): Promise<Artifacts> {
  if (artifactsP) return artifactsP;
  if (!mtSupported()) {
    const reason = !engineCaps(rt.engine).multiThreaded ? 'no multi-threaded build'
      : rt.mtDisabled || 'page is not cross-origin isolated';
    return useSingleThreaded(reason);
  }
  artifactsP = loadArtifactsFrom(`${rt.base}mt/`, true).catch((e: unknown) => {
    console.warn(`[${rt.engine}] multi-threaded engine unavailable:`, e);
    return useSingleThreaded('multi-threaded artifacts failed to load');
  });
  return artifactsP;
}

/** Refuse an engine whose bridge ABI this app doesn't speak (once per worker; not a trap). */
function checkAbi(mod: EngineModule): void {
  if (abiChecked) return;
  let info: unknown = null;
  try { info = JSON.parse(mod.UTF8ToString(mod._cs_version())); } catch { /* reported below */ }
  const err = bridgeAbiError(rt.engine, isObject(info) ? info.bridge : undefined);
  if (err) throw new Error(err);
  abiChecked = true;
}

export async function instantiate(art: Artifacts, onProgress?: (pct: number, msg: string) => void): Promise<EngineModule> {
  const holder = { mod: undefined as EngineModule | undefined };
  const progress = (pct: number, msg: string) => (onProgress ?? rt.progressSink)?.(pct, msg);
  const mod = await art.factory({
    locateFile: (f: string) => `${art.dir}${f}`,
    ...(art.mt ? { mainScriptUrlOrBlob: `${art.dir}slicer.mjs`, ...(rt.mtThreads > 0 ? { csThreads: rt.mtThreads } : {}) } : {}),
    instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
      WebAssembly.instantiate(art.wasm, imports).then((inst) => done(inst, art.wasm));
      return {};
    },
    getPreloadedPackage: (name: string) => (art.data && name.endsWith('.data') ? art.data.slice(0) : undefined),
    print: () => {},
    printErr: (m: string) => { if (!/^\s*$/.test(m)) console.debug(`[${rt.engine}]`, m); },
    onAbort: (what: unknown) => failInflight?.(new WebAssembly.RuntimeError(`engine aborted: ${String(what)}`)),
    csProgress: progress,
    // Orca 2.5 slicing-pipeline plugins (ENGINE-CONTRACT "Plugin hooks"); inert unless the
    // config selects capabilities. Served by the plugin runtime: src/plugins/runtime/hookClient.ts.
    csHook: (kind: string, begin: string) => runPluginHook(holder.mod, kind, begin,
      (msg) => progress(Number(rt.lastProgressKey.split('|')[0]) || 0, msg)),
  });
  holder.mod = mod;
  checkAbi(mod);
  return mod;
}

// ---- multi-threaded instance (shared) -------------------------------------------

let mtModP: Promise<EngineModule> | null = null;

export function dropMt(mod: EngineModule | null): void {
  mtModP = null;
  try { mod?.csTerminateThreads?.(); } catch { /* already gone */ }
}

/** Forget the shared instance (after a trap / stall: never reuse it). */
export function forgetMt(): void { mtModP = null; }

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
      console.info(`[${rt.engine}] engine: multi-threaded, ${mod._cs_thread_count?.() ?? '?'} threads `
        + `(instance ready in ${Math.round(performance.now() - t0)} ms)`);
      return mod;
    }, (e: unknown) => {
      clearTimeout(timer);
      rt.mtDisabled = 'multi-threaded engine failed to start';
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
export async function moduleFor(onProgress?: (pct: number, msg: string) => void): Promise<{ mod: EngineModule; shared: boolean }> {
  const art = await loadArtifacts();
  if (art.mt) {
    try {
      return { mod: await mtModule(art), shared: true };
    } catch (e) {
      // e.g. the browser can't reserve a 4 GB shared heap, or Workers are blocked.
      console.warn(`[${rt.engine}] multi-threaded engine failed to start:`, e);
      const st = await useSingleThreaded('multi-threaded engine failed to start');
      return { mod: await instantiate(st, onProgress), shared: false };
    }
  }
  return { mod: await instantiate(art, onProgress), shared: false };
}

/**
 * A long-lived instance for requests that keep state or come in bursts
 * (tool sessions, condition evaluation): the shared MT instance, or `slot`'s
 * own single-threaded one.
 */
export async function longLived(slot: { mod: Promise<EngineModule> | null }): Promise<EngineModule> {
  const art = await loadArtifacts();
  if (art.mt) return (await moduleFor()).mod;
  const p = slot.mod ??= instantiate(art);
  p.catch(() => { if (slot.mod === p) slot.mod = null; });
  return p;
}

/** Recycle the shared instance once its heap is past the high-water mark. */
export function maybeRecycle(mod: EngineModule): void {
  try {
    mod.csSyncHeap?.();
    if (mod.HEAPU8.byteLength > RECYCLE_HEAP_BYTES) dropMt(mod);
  } catch { dropMt(mod); }
}

type WaitAsync = (a: Int32Array, i: number, v: number, t?: number) => { async: boolean; value: unknown };
const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;

/**
 * Wait (without blocking this worker's event loop — Emscripten needs it to
 * start pthread Workers and to deliver progress) until cs_slice_start's (or
 * cs_tool_start's) state[0] flips to 1; resolves with state[1] (the call's
 * return code). `poll` runs on every wake-up (at least every 500 ms).
 */
export function waitForSlice(mod: EngineModule, state: number, poll?: () => void): Promise<number> {
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
    rt.lastProgressAt = performance.now();
    rt.sawProgress = false;
    rt.lastProgressKey = '';
    void (async () => {
      while (!settled) {
        poll?.();
        mod.csSyncHeap?.();
        const heap = mod.HEAP32;
        if (Atomics.load(heap, i) !== 0) { finish(null, Atomics.load(heap, i + 1)); return; }
        const idle = performance.now() - rt.lastProgressAt;
        if (idle > (rt.sawProgress ? MT_PROGRESS_GAP_MS : MT_FIRST_PROGRESS_MS)) {
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

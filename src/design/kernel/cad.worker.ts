/// <reference lib="webworker" />
/**
 * Hosts OrcaSlicer's CAD kernel (public/wasm/cad/, docs/CAD-KERNEL-CONTRACT.md) in its own
 * Worker: one module instance for the worker's life, because the documents live inside it.
 * Calls are serialised by the client; each runs to completion here (the module is
 * single-threaded). A trap (RuntimeError) poisons the instance: the worker reports it as
 * fatal and the client terminates it and reopens the document in a fresh one.
 *
 * Heap rules (as src/engine/worker/heap.ts): views are re-read after every call into the
 * module (memory growth replaces them), pointers are unsigned and bounds-checked, every
 * buffer we malloc is freed and outputs are copied out before cad_free.
 */
import type { FromWorker, RawReply, StartProgress, ToWorker } from './protocol';
import type { CadKernelVersion } from './types';

interface CadModule {
  /** Kernel v1.1: called before each replayed feature; truthy = cancel (when cancellable). */
  cadProgress?: (index: number, count: number, name: string, cancellable: boolean) => boolean;
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _cad_version(): number;
  _cad_call(m: number, ml: number, j: number, jl: number, b: number, bl: number, oj: number, ojl: number, ob: number, obl: number): number;
  _cad_free(p: number): void;
  UTF8ToString(p: number): string;
}
type Factory = (opts: Record<string, unknown>) => Promise<CadModule>;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const enc = new TextEncoder();
const dec = new TextDecoder();
let mod: CadModule | null = null;

function post(msg: FromWorker, transfer: Transferable[] = []): void { ctx.postMessage(msg, transfer); }

async function fetchWasm(url: string, onProgress: (p: StartProgress) => void): Promise<Uint8Array> {
  const rsp = await fetch(url);
  if (!rsp.ok) throw new Error(`Couldn't load the CAD kernel (${url}: HTTP ${rsp.status}).`);
  // Content-Length is the compressed size when the server compresses: only a hint.
  const total = Number(rsp.headers.get('content-length')) || 0;
  if (!rsp.body) return new Uint8Array(await rsp.arrayBuffer());
  const reader = rsp.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - last > 100) { last = now; onProgress({ stage: 'download', loaded, total: Math.max(total, loaded) }); }
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  onProgress({ stage: 'download', loaded, total: loaded });
  return out;
}

let cancelFlag: Int32Array | null = null;

async function start(base: string): Promise<void> {
  const progress = (p: StartProgress) => post({ type: 'progress', progress: p });
  const [factory, bytes] = await Promise.all([
    import(/* @vite-ignore */ `${base}cad.mjs`).then((m) => m.default as Factory),
    fetchWasm(`${base}cad.wasm`, progress),
  ]);
  progress({ stage: 'compile', loaded: 0, total: 1 });
  const wasm = await WebAssembly.compile(bytes as BufferSource);
  progress({ stage: 'init', loaded: 0, total: 1 });
  mod = await factory({
    locateFile: (f: string) => `${base}${f}`,
    instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
      void WebAssembly.instantiate(wasm, imports).then((inst) => done(inst, wasm));
      return {};
    },
    // OCCT's STEP writer prints transfer statistics: keep stdout quiet, stderr at debug level.
    print: () => {},
    printErr: (m: string) => { if (!/^\s*$/.test(m)) console.debug('[cad]', m); },
  });
  // Progress + cooperative cancel: the call runs synchronously, so cancel is read from shared memory.
  mod.cadProgress = (index, count, name, cancellable) => {
    post({ type: 'rebuild', index, count, name });
    return cancellable && !!cancelFlag && Atomics.load(cancelFlag, 0) !== 0;
  };
  const version = JSON.parse(mod.UTF8ToString(mod._cad_version())) as CadKernelVersion;
  post({ type: 'ready', version, heapBytes: mod.HEAPU8.byteLength });
}

function copyIn(m: CadModule, bytes: Uint8Array): number {
  const p = m._malloc(Math.max(1, bytes.byteLength)) >>> 0;
  if (!p) throw new WebAssembly.RuntimeError('CAD kernel out of memory (malloc failed)');
  m.HEAPU8.set(bytes, p);
  return p;
}

function copyOut(m: CadModule, ptr: number, len: number): Uint8Array {
  const p = ptr >>> 0, n = len >>> 0;
  if (!p || p + n > m.HEAPU8.byteLength) throw new WebAssembly.RuntimeError('CAD kernel returned an out-of-bounds buffer');
  return m.HEAPU8.slice(p, p + n);
}

function call(m: CadModule, method: string, params: unknown, blob: Uint8Array | null): RawReply {
  const mb = enc.encode(method), jb = enc.encode(JSON.stringify(params ?? {})), bb = blob ?? new Uint8Array(0);
  const mp = copyIn(m, mb), jp = copyIn(m, jb), bp = copyIn(m, bb);
  const outs = m._malloc(16) >>> 0;
  try {
    new Uint32Array(m.HEAPU8.buffer, outs, 4).fill(0);
    const rc = m._cad_call(mp, mb.byteLength, jp, jb.byteLength, bp, bb.byteLength, outs, outs + 4, outs + 8, outs + 12);
    const o = new Uint32Array(m.HEAPU8.buffer, outs, 4); // re-read: the call may have grown memory
    const pj = o[0] >>> 0, lj = o[1] >>> 0, pb = o[2] >>> 0, lb = o[3] >>> 0;
    try {
      const envelope = pj ? JSON.parse(dec.decode(copyOut(m, pj, lj))) : { ok: false, error: { code: -32000, message: 'The CAD kernel returned no reply.' } };
      return { rc, envelope, blob: pb ? copyOut(m, pb, lb) : null, heapBytes: m.HEAPU8.byteLength };
    } finally {
      if (pj) m._cad_free(pj);
      if (pb) m._cad_free(pb);
    }
  } finally {
    m._free(mp); m._free(jp); m._free(bp); m._free(outs);
  }
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    cancelFlag = msg.cancel ? new Int32Array(msg.cancel) : null;
    start(msg.base).catch((e: unknown) => post({ type: 'fatal', message: e instanceof Error ? e.message : String(e), trap: false }));
    return;
  }
  if (!mod) { post({ type: 'fatal', id: msg.id, message: 'The CAD kernel is not loaded.', trap: false }); return; }
  try {
    const reply = call(mod, msg.method, msg.params, msg.blob);
    post({ type: 'reply', id: msg.id, reply }, reply.blob ? [reply.blob.buffer] : []);
  } catch (e) {
    // A trap, abort or bad pointer: the instance and every document in it are gone.
    mod = null;
    post({ type: 'fatal', id: msg.id, message: e instanceof Error ? e.message : String(e), trap: true });
  }
};

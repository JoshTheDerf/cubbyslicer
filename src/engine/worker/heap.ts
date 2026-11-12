/**
 * Engine heap access for the worker: the Emscripten module surface the
 * worker uses, bounds-checked copies in and out, and `callJson`, the
 * "inputs in → call → JSON reply out → free" sequence every JSON-returning
 * entry point (cs_describe_config, cs_orient, cs_tool) shares.
 *
 * Heap views are never cached across calls into the engine: memory growth
 * replaces them (in the MT build another thread may grow the heap, so views
 * are re-synced with `csSyncHeap()` before every access). Pointers from the
 * engine are treated as unsigned (heap may exceed 2 GB) and every (ptr, len)
 * pair is checked against the current heap before it's read.
 */

export interface EngineModule {
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
  _cs_tool_start?(job: number, jobLen: number, blob: number, blobLen: number,
                  outJ: number, outJLen: number, outB: number, outBLen: number, state: number): number;
  _cs_thread_count?(): number;
  /** Polled by long tool runs on the main runtime thread (single-threaded build): true = stop. */
  csCancelled?: () => boolean;
  csTerminateThreads?(): void;
  csSyncHeap?(): void;
}

export const enc = new TextEncoder();
const dec = new TextDecoder();

/** Read a u32 out-param. */
export function u32(mod: EngineModule, ptr: number): number {
  mod.csSyncHeap?.();
  const p = ptr >>> 0;
  if (p % 4 !== 0 || p + 4 > mod.HEAPU8.byteLength) throw new Error('engine returned an invalid pointer');
  return mod.HEAPU32[p >>> 2] >>> 0;
}

/** Copy (ptr, len) out of the heap: the copy survives the instance. */
export function copyOut(mod: EngineModule, ptr: number, len: number): Uint8Array {
  mod.csSyncHeap?.();
  const p = ptr >>> 0, n = len >>> 0;
  if (!p || p + n > mod.HEAPU8.byteLength) throw new Error('engine returned an out-of-bounds buffer');
  return mod.HEAPU8.slice(p, p + n);
}

/** malloc + copy `bytes` into the heap. */
export function writeIn(mod: EngineModule, bytes: Uint8Array): number {
  const p = mod._malloc(Math.max(1, bytes.byteLength)) >>> 0;
  if (!p) throw new Error('Out of memory in engine (malloc failed)');
  mod.csSyncHeap?.();
  mod.HEAPU8.set(bytes, p); // fresh HEAPU8 read after malloc (growth may have replaced it)
  return p;
}

/** malloc `words` zeroed u32 slots (out-params / state). */
export function allocWords(mod: EngineModule, words: number): number {
  const p = mod._malloc(words * 4) >>> 0;
  if (!p) throw new Error('Out of memory in engine (malloc failed)');
  mod.csSyncHeap?.();
  mod.HEAPU32.fill(0, p >>> 2, (p >>> 2) + words);
  return p;
}

export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(dec.decode(bytes));
}

/** Free without throwing: after a trap the instance may be unusable (the client restarts the worker). */
export function safeFree(mod: EngineModule, ptr: number, engineOwned = false): void {
  if (!ptr) return;
  try { if (engineOwned) mod._cs_free(ptr); else mod._free(ptr); } catch { /* trapped instance */ }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Run an engine entry point that returns JSON (and optionally a blob):
 * copies `inputs` into the heap, passes their (ptr, len) pairs followed by
 * the out-params (json ptr/len, then blob ptr/len when `withBlob`), parses
 * the JSON reply and frees everything, also on failure.
 */
export function callJson(
  mod: EngineModule, inputs: Uint8Array[], withBlob: boolean,
  call: (args: number[]) => number,
): { rc: number; json: unknown; blob: Uint8Array | null } {
  const c = new JsonCall(mod, inputs, withBlob);
  try { return c.collect(call(c.args)); } finally { c.free(); }
}

/** callJson for an entry point that runs on an engine thread (cs_tool_start): `call` resolves with its return code. */
export async function callJsonAsync(
  mod: EngineModule, inputs: Uint8Array[], withBlob: boolean,
  call: (args: number[]) => Promise<number>,
): Promise<{ rc: number; json: unknown; blob: Uint8Array | null }> {
  const c = new JsonCall(mod, inputs, withBlob);
  try { return c.collect(await call(c.args)); } finally { c.free(); }
}

class JsonCall {
  readonly args: number[] = [];
  private owned: number[] = [];
  private outs = 0;
  private pj = 0;
  private pb = 0;
  constructor(private mod: EngineModule, inputs: Uint8Array[], private withBlob: boolean) {
    try {
      for (const b of inputs) { const p = writeIn(mod, b); this.owned.push(p); this.args.push(p, b.byteLength); }
      this.outs = allocWords(mod, withBlob ? 4 : 2);
    } catch (e) { this.free(); throw e; }
    this.args.push(this.outs, this.outs + 4);
    if (withBlob) this.args.push(this.outs + 8, this.outs + 12);
  }
  collect(rc: number): { rc: number; json: unknown; blob: Uint8Array | null } {
    const { mod, outs } = this;
    this.pj = u32(mod, outs);
    if (this.withBlob) this.pb = u32(mod, outs + 8);
    const jsonLen = u32(mod, outs + 4);
    const json = this.pj && jsonLen ? decodeJson(copyOut(mod, this.pj, jsonLen)) : null;
    const blobLen = this.withBlob ? u32(mod, outs + 12) : 0;
    const blob = this.pb && blobLen ? copyOut(mod, this.pb, blobLen) : null;
    return { rc, json, blob };
  }
  free(): void {
    safeFree(this.mod, this.pj, true);
    safeFree(this.mod, this.pb, true);
    safeFree(this.mod, this.outs);
    for (const p of this.owned) safeFree(this.mod, p);
    this.owned = []; this.outs = this.pj = this.pb = 0;
  }
}

/** A cs_tool / cs_orient reply `{ ok, error, … }`: throws the engine's error, or a shape error. */
export function okReply(json: unknown, what: string): Record<string, unknown> {
  if (!isObject(json) || typeof json.ok !== 'boolean') throw new Error(`${what}: malformed engine reply`);
  if (!json.ok) throw new Error(typeof json.error === 'string' && json.error ? json.error : `${what} failed`);
  return json;
}

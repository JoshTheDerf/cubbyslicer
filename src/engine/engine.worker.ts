/// <reference lib="webworker" />
/**
 * Engine worker: hosts one WASM slicing engine (see docs/ENGINE-CONTRACT.md).
 * Instances and the multi-threaded runtime live in worker/runtime.ts, heap
 * access in worker/heap.ts, mesh packing in worker/pack.ts; this file runs the
 * requests, one at a time.
 */
import type { ArrangeArgs, ConfigSchema, EngineId, FlatConfig, SliceJob, SliceReport, WorkerRequest, WorkerResponse } from './types';
import { allocWords, callJson, copyOut, decodeJson, enc, isObject, okReply, safeFree, u32, writeIn, type EngineModule } from './worker/heap';
import { packJob, packPayload, packTool, unpackMeshes } from './worker/pack';
import { ctx, EngineStall, forgetMt, longLived, maybeRecycle, moduleFor, rt, waitForSlice } from './worker/runtime';
import { installPluginHooks } from '../plugins/runtime/hookClient';

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function isTrap(e: unknown): boolean {
  return e instanceof WebAssembly.RuntimeError
    || (typeof e === 'object' && e !== null && 'name' in e && (e as Error).name === 'RuntimeError')
    || (e instanceof Error && /abort|unreachable|out of bounds|memory access/i.test(e.message));
}

function isReport(v: unknown): v is SliceReport {
  return isObject(v) && typeof v.ok === 'boolean' && Array.isArray(v.warnings);
}

async function doSlice(id: number, job: SliceJob): Promise<void> {
  let lastPct = -1;
  const onProgress = (pct: number, message: string) => {
    // Only real progress counts for the stall watchdog: a stuck engine can keep
    // repeating the same (or an empty) status.
    const key = `${pct}|${message}`;
    if (message && key !== rt.lastProgressKey) {
      rt.lastProgressKey = key;
      rt.lastProgressAt = performance.now();
      if (pct > 0) rt.sawProgress = true;
    }
    if (pct === lastPct && pct < 100) return;
    lastPct = pct;
    post({ type: 'progress', id, percent: pct, message });
  };
  const { mod, shared } = await moduleFor(onProgress);
  const { json, blob } = packJob(job);
  const allocs: number[] = [];
  let gPtr = 0, rPtr = 0;
  rt.progressSink = shared ? onProgress : undefined;
  try {
    const jobPtr = writeIn(mod, json); allocs.push(jobPtr);
    const blobPtr = writeIn(mod, blob); allocs.push(blobPtr);
    const outs = allocWords(mod, 4); allocs.push(outs); // gcodePtr, gcodeLen, reportPtr, reportLen
    const sliceSync = () => mod._cs_slice(jobPtr, json.byteLength, blobPtr, blob.byteLength, outs, outs + 4, outs + 8, outs + 12);
    let rc: number;
    let threads = 1;
    if (shared && typeof mod._cs_slice_start === 'function') {
      const state = allocWords(mod, 2); allocs.push(state);
      if (mod._cs_slice_start(jobPtr, json.byteLength, blobPtr, blob.byteLength, outs, outs + 4, outs + 8, outs + 12, state) === 0) {
        rc = await waitForSlice(mod, state);
        threads = mod._cs_thread_count?.() ?? 1;
      } else rc = sliceSync();
    } else rc = sliceSync();
    gPtr = u32(mod, outs); rPtr = u32(mod, outs + 8);
    const gLen = u32(mod, outs + 4), rLen = u32(mod, outs + 12);

    let report: SliceReport = { ok: false, error: `engine returned ${rc} without a report`, warnings: [], stats: null };
    if (rPtr && rLen) {
      try { const r = decodeJson(copyOut(mod, rPtr, rLen)); if (isReport(r)) report = r; } catch { /* keep default */ }
    }
    report.threads = threads;
    if (report.timings) {
      console.info(`[${rt.engine}] slice: ${threads} thread${threads === 1 ? '' : 's'}, process `
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
    rt.progressSink = undefined;
    // Single-use instances are simply dropped; the shared one must be cleaned.
    // (After a trap this is skipped or fails; the client restarts the worker.)
    if (shared) {
      safeFree(mod, gPtr, true);
      safeFree(mod, rPtr, true);
      for (const p of allocs) safeFree(mod, p);
      maybeRecycle(mod);
    }
  }
}

async function doDescribe(id: number): Promise<void> {
  const { mod } = await moduleFor();
  const { rc, json } = callJson(mod, [], false, ([o, ol]) => mod._cs_describe_config(o, ol));
  if (rc !== 0 || !isObject(json) || !isObject(json.options)) throw new Error(`cs_describe_config failed (${rc})`);
  post({ type: 'schema', id, schema: json as unknown as ConfigSchema });
}

// Conditions are evaluated in bursts (one per preset) and tools keep session
// state: both reuse a long-lived instance (cs_eval_condition is side-effect
// free), dropped after a trap. The MT build reuses its shared instance anyway.
const condSlot = { mod: null as Promise<EngineModule> | null };
const toolSlot = { mod: null as Promise<EngineModule> | null };

async function doCondition(id: number, expr: string, config: FlatConfig): Promise<void> {
  const mod = await longLived(condSlot);
  const e = enc.encode(expr), c = enc.encode(JSON.stringify(config));
  const ep = writeIn(mod, e), cp = writeIn(mod, c);
  try {
    const rc = mod._cs_eval_condition(ep, e.byteLength, cp, c.byteLength);
    post({ type: 'condition', id, value: rc < 0 ? null : rc === 1 });
  } finally {
    safeFree(mod, ep); safeFree(mod, cp);
  }
}

async function doOrient(id: number, object: SliceJob['objects'][number]): Promise<void> {
  const { mod } = await moduleFor();
  const orient = mod._cs_orient;
  if (typeof orient !== 'function') throw new Error(`${rt.engine} engine does not support auto-orient`);
  const { json, blob } = packJob({ engine: rt.engine, config: {}, objects: [object] });
  const r = okReply(callJson(mod, [json, blob], false, (a) => orient.call(mod, a[0], a[1], a[2], a[3], a[4], a[5])).json, 'auto-orient');
  const rot = r.rotation;
  if (!Array.isArray(rot) || rot.length !== 9 || !rot.every(Number.isFinite)) throw new Error('auto-orient failed');
  post({ type: 'orient', id, rotation: rot as number[] });
}

/** cs_tool with a packed request; returns the reply's result + meshes. */
function runTool(mod: EngineModule, what: string, json: Uint8Array, blob: Uint8Array) {
  const tool = mod._cs_tool;
  if (typeof tool !== 'function') throw new Error(`${rt.engine} engine does not support ${what}`);
  const out = callJson(mod, [json, blob], true, (a) => tool.call(mod, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]));
  const r = okReply(out.json, what);
  return { result: r.result, meshes: unpackMeshes(r.meshes, out.blob) };
}

async function doTool(id: number, op: string, args: unknown, meshes: Parameters<typeof packTool>[2]): Promise<void> {
  const mod = await longLived(toolSlot);
  const { json, blob } = packTool(op, args, meshes);
  const r = runTool(mod, op, json, blob);
  const transfer: Transferable[] = [];
  for (const m of r.meshes) transfer.push(m.positions.buffer, m.indices.buffer);
  post({ type: 'tool', id, result: r.result, meshes: r.meshes }, transfer);
}

// Orca auto arrange: a cs_tool call whose request also carries the slice-job
// `config` + `objects` (packed like a slice job).
async function doArrange(id: number, config: FlatConfig, objects: SliceJob['objects'], args: ArrangeArgs): Promise<void> {
  const { mod } = await moduleFor();
  const { payload, blob } = packPayload({ engine: rt.engine, config, objects });
  const r = runTool(mod, 'arrange', enc.encode(JSON.stringify({ ...payload, op: 'arrange', args })), blob);
  post({ type: 'tool', id, result: r.result, meshes: [] });
}

async function handle(msg: WorkerRequest): Promise<void> {
  try {
    if (msg.type === 'slice') await doSlice(msg.id, msg.job);
    else if (msg.type === 'describe') await doDescribe(msg.id);
    else if (msg.type === 'evalCondition') await doCondition(msg.id, msg.expr, msg.config);
    else if (msg.type === 'orient') await doOrient(msg.id, msg.object);
    else if (msg.type === 'tool') await doTool(msg.id, msg.op, msg.args, msg.meshes);
    else if (msg.type === 'arrange') await doArrange(msg.id, msg.config, msg.objects, msg.args);
  } catch (e) {
    if (e instanceof EngineStall) {
      rt.mtDisabled = 'multi-threaded engine stalled';
      forgetMt();
      post({ type: 'error', id: msg.id, fatal: true, stalled: true, message: e.message });
      return;
    }
    const fatal = isTrap(e);
    if (msg.type === 'evalCondition') condSlot.mod = null;
    if (msg.type === 'tool' && fatal) toolSlot.mod = null;
    if (fatal) forgetMt(); // never reuse a trapped instance (the client restarts us anyway)
    const message = e instanceof Error ? e.message : String(e);
    post({
      type: 'error', id: msg.id, fatal,
      message: fatal ? `The ${rt.engine} engine crashed (${message}). This is an engine bug; the engine has been restarted.` : message,
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
    rt.engine = msg.engine; rt.base = msg.base;
    if (msg.noMt) rt.mtDisabled = 'multi-threaded engine stalled earlier this session';
    if (msg.threads && msg.threads > 0) {
      if (msg.threads === 1) rt.mtDisabled ||= 'engine threads set to 1';
      else rt.mtThreads = msg.threads;
    }
    return;
  }
  // The plugin runtime's HookChannel for Module.csHook (src/plugins/runtime/hookClient.ts).
  if ((msg as { type: string }).type === 'pluginHooks') { installPluginHooks(msg as unknown as Parameters<typeof installPluginHooks>[0]); return; }
  // A request that never settles (e.g. an engine instance that never finishes
  // starting) must not hold up everything queued behind it: non-slice
  // requests get a deadline; slices have their own stall watchdog.
  const run = () => {
    if (msg.type === 'slice') return handle(msg);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[${rt.engine}] ${msg.type} request timed out`);
        post({ type: 'error', id: msg.id, fatal: false, message: `The ${rt.engine} engine did not answer in time (${msg.type}).` });
        resolve();
      }, 60_000);
    });
    return Promise.race([handle(msg), deadline]).finally(() => clearTimeout(timer));
  };
  queue = queue.then(run);
};

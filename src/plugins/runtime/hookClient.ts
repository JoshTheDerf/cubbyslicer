/**
 * The engine worker's `Module.csHook` (docs/ENGINE-CONTRACT.md "Plugin hooks").
 *
 * Runs inside the engine worker, on the thread that owns Module (the pthreads
 * build proxies the call there and parks the slicing thread). It hands the step
 * to the plugin runtime over the HookChannel and blocks until the runtime is
 * done, serving the runtime's graph queries with `cs_hook_query` meanwhile (the
 * Print is still live and the slicing thread parked, so this is race-free).
 * Heartbeats go through Module.csProgress so the stall watchdog and the UI see
 * the plugin working.
 *
 * Imported by src/engine/engine.worker.ts and worker/runtime.ts; no plugin code
 * runs here.
 */
import { callJson, type EngineModule } from '../../engine/worker/heap';
import { HOOK, HOOK_STATE, HookFrames } from './hookChannel';

let frames: HookFrames | null = null;
let port: MessagePort | null = null;
let seq = 0;

/** The main thread connected this engine worker to the plugin runtime. */
export function installPluginHooks(msg: { sab: SharedArrayBuffer; port: MessagePort }): void {
  frames = new HookFrames(msg.sab);
  port = msg.port;
}

export function pluginHooksInstalled(): boolean { return !!frames; }

const enc = new TextEncoder();
/** Wait for the runtime to pick up the hook before giving up (it boots on demand). */
const PICKUP_TIMEOUT_MS = 60_000;

function serveQuery(mod: EngineModule, f: HookFrames): void {
  const { json, blob } = f.readPair();
  let reply: string, out: Uint8Array | null = null;
  try {
    const r = callJson(mod, [enc.encode(json), blob], true,
      (a) => (mod as unknown as { _cs_hook_query(...x: number[]): number })._cs_hook_query(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]));
    if (r.json === null) reply = JSON.stringify({ ok: false, error: `cs_hook_query returned ${r.rc} (not inside a hook?)`, results: [] });
    else { reply = JSON.stringify(r.json); out = r.blob; }
  } catch (e) {
    reply = JSON.stringify({ ok: false, error: `cs_hook_query failed: ${(e as Error).message}`, results: [] });
  }
  if (!f.writePair(reply, out)) {
    f.writePair(JSON.stringify({ ok: false, error: `query result too large (${((out?.byteLength ?? 0) / 1048576).toFixed(1)} MB); query fewer layers / regions at a time`, results: [] }), null);
  }
  f.setState(HOOK_STATE.REPLY);
}

/**
 * `Module.csHook(kind, beginJson, blob)`. Returns the result object for the engine
 * (`{status, capability, message}`) or null (= success).
 */
export function runPluginHook(mod: EngineModule | undefined, kind: string, begin: string, heartbeat: (msg: string) => void): unknown {
  if (kind !== 'pipeline') return null;
  if (!mod) return { status: 'FatalError', capability: '', message: 'engine module not ready' };
  if (!frames || !port) {
    return { status: 'FatalError', capability: '', message: 'Python plugins are not running in CubbySlicer. Open File ▸ Plugins and activate the selected plugins, then slice again.' };
  }
  const f = frames;
  if (f.cancelled) return { status: 'Cancelled' };
  let step = '';
  try { step = String((JSON.parse(begin) as { step?: string }).step ?? ''); } catch { /* engine JSON */ }
  const id = ++seq;
  f.writeText(begin);
  Atomics.store(f.ctrl, HOOK.SEQ, id);
  f.setState(HOOK_STATE.BEGIN);
  port.postMessage({ t: 'hookBegin', seq: id });
  const t0 = performance.now();
  let lastBeat = t0;
  for (;;) {
    const s = f.state;
    if (s === HOOK_STATE.QUERY) { serveQuery(mod, f); continue; }
    if (s === HOOK_STATE.DONE) {
      const text = f.readText();
      f.setState(HOOK_STATE.IDLE);
      try { return JSON.parse(text); } catch { return { status: 'Exception', capability: '', message: 'malformed plugin result' }; }
    }
    if (f.cancelled) { f.setState(HOOK_STATE.IDLE); return { status: 'Cancelled' }; }
    const now = performance.now();
    if (s === HOOK_STATE.BEGIN && now - t0 > PICKUP_TIMEOUT_MS) {
      f.setState(HOOK_STATE.IDLE);
      return { status: 'FatalError', capability: '', message: 'The Python plugin runtime did not answer. Check File ▸ Plugins (Diagnostics).' };
    }
    if (now - lastBeat >= 1000) {
      lastBeat = now;
      // A distinct message each second keeps the slice stall watchdog and the progress bar alive.
      heartbeat(`Plugin step ${step} · ${Math.round((now - t0) / 1000)} s`);
    }
    Atomics.wait(f.ctrl, HOOK.STATE, s, 250);
  }
}

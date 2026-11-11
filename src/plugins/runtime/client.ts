/**
 * Main-thread side of the plugin runtime worker: lazy boot, request/reply
 * plumbing and the host-call dispatcher. Nothing here loads Pyodide until
 * `ensureRuntime()` is called (a plugin is enabled, or the Plugins dialog
 * needs it).
 */
import { shallowRef } from 'vue';
import type { CapabilityId, FromRuntime, HostMethod, PluginPermissions, ScriptCompletion, ToRuntime } from '../types';
import { createHostChannel, HostChannelServer, type ReplyPayload } from './hostChannel';
import { HOOK, createHookChannel } from './hookChannel';

export const PYODIDE_VERSION = '0.27.8';

export interface RuntimeState {
  phase: 'off' | 'booting' | 'ready' | 'failed';
  error?: string;
  pythonVersion?: string;
  bootMs?: number;
  isolated: boolean;
}

export const runtimeState = shallowRef<RuntimeState>({ phase: 'off', isolated: false });

export type HostCallHandler = (method: HostMethod, pluginKey: string, capability: string, args: unknown) => Promise<ReplyPayload>;
export type HostPostHandler = (method: HostMethod, pluginKey: string, capability: string, args: unknown) => void;

export interface RuntimeHooks {
  hostCall: HostCallHandler;
  hostPost: HostPostHandler;
  log(level: 'debug' | 'info' | 'warn' | 'error', text: string, pluginKey?: string): void;
  permissionRequest(pluginKey: string, request: PluginPermissions): Promise<{ granted: boolean; grants?: PluginPermissions }>;
  permissionDenied(msg: Extract<FromRuntime, { t: 'permissionDenied' }>): void;
  appInfo(): Record<string, unknown>;
}

let hooks: RuntimeHooks | null = null;
let worker: Worker | null = null;
let port: MessagePort | null = null;
let server: HostChannelServer | null = null;
let booting: Promise<void> | null = null;
let reqSeq = 0;
const waiting = new Map<number, { resolve: (m: FromRuntime) => void }>();
const scriptWaiters = new Map<number, (c: ScriptCompletion) => void>();

export function setRuntimeHooks(h: RuntimeHooks): void { hooks = h; }

export const pyodideBase = (): string => `${import.meta.env.BASE_URL}pyodide/${PYODIDE_VERSION}/`;

/** Boot the runtime (once). Resolves when Python is ready; rejects if it can't start. */
export function ensureRuntime(): Promise<void> {
  if (booting) return booting;
  booting = new Promise<void>((resolve, reject) => {
    if (!hooks) { reject(new Error('Plugin runtime hooks are not set')); return; }
    const hostChannel = createHostChannel();
    const isolated = !!hostChannel;
    runtimeState.value = { phase: 'booting', isolated };
    const interrupt = isolated ? new SharedArrayBuffer(4) : null;
    interruptBuffer = interrupt ? new Int32Array(interrupt) : null;
    server = hostChannel ? new HostChannelServer(hostChannel) : null;
    worker = new Worker(new URL('./worker/prw.worker.ts', import.meta.url), { type: 'module', name: 'cubby-plugins' });
    const ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = (e) => onMessage(e.data as FromRuntime, resolve, reject);
    worker.onerror = (e) => {
      const error = e.message || 'The plugin runtime crashed';
      runtimeState.value = { phase: 'failed', error, isolated };
      reject(new Error(error));
    };
    worker.postMessage({
      t: 'init', pyodideBase: pyodideBase(), hostChannel, hookChannel: null, interrupt, appInfo: hooks.appInfo(),
    } satisfies ToRuntime, [ch.port2]);
  });
  booting.catch(() => { /* surfaced through runtimeState */ });
  return booting;
}

let interruptBuffer: Int32Array | null = null;

/** Raise KeyboardInterrupt in a synchronous plugin call that is still running (needs isolation). */
export function interruptPython(): boolean {
  if (!interruptBuffer) return false;
  Atomics.store(interruptBuffer, 0, 2);
  return true;
}

export function runtimeRunning(): boolean { return runtimeState.value.phase === 'ready'; }

function onMessage(m: FromRuntime, resolve: () => void, reject: (e: Error) => void): void {
  switch (m.t) {
    case 'ready':
      runtimeState.value = { phase: 'ready', pythonVersion: m.pythonVersion, bootMs: m.bootMs, isolated: m.isolated };
      hooks!.log('info', `Python ${m.pythonVersion} ready in ${m.bootMs} ms${m.isolated ? '' : ' (not cross-origin isolated: host reads and message boxes are unavailable)'}`);
      flushHookChannels();
      resolve();
      return;
    case 'bootFailed':
      runtimeState.value = { phase: 'failed', error: m.error, isolated: runtimeState.value.isolated };
      reject(new Error(m.error));
      return;
    case 'hostCall':
      void hooks!.hostCall(m.method, m.pluginKey, m.capability, m.args)
        .catch((e: Error) => ({ error: { type: (e as { pyType?: string }).pyType ?? 'RuntimeError', message: e.message } }) as ReplyPayload)
        .then((r) => server?.reply(m.callId, r));
      return;
    case 'hostChunk': server?.nextChunk(m.callId); return;
    case 'hostPost':
      try { hooks!.hostPost(m.method, m.pluginKey, m.capability, m.args); } catch (e) { hooks!.log('warn', `${m.method}: ${(e as Error).message}`, m.pluginKey); }
      return;
    case 'log': hooks!.log(m.level, m.text, m.pluginKey); return;
    case 'permissionRequest':
      void hooks!.permissionRequest(m.pluginKey, m.request).then((a) => send({ t: 'permissionAnswer', reqId: m.reqId, granted: a.granted, grants: a.grants }));
      return;
    case 'permissionDenied': hooks!.permissionDenied(m); return;
    case 'scriptDone': {
      const w = scriptWaiters.get(m.runId);
      scriptWaiters.delete(m.runId);
      w?.(m.completion);
      return;
    }
    case 'loaded': case 'loadFailed': case 'unloaded': case 'reply': {
      const w = waiting.get(m.reqId);
      waiting.delete(m.reqId);
      w?.resolve(m);
      return;
    }
    default: return;
  }
}

/** Fields that carry buffers (transferred / shared) and are never reactive. */
const BINARY_FIELDS = new Set(['gcode', 'files', 'hostChannel', 'hookChannel', 'interrupt', 'sab', 'port']);

export function send(msg: ToRuntime, transfer: Transferable[] = []): void {
  // Ids, grants and capability lists often come straight from reactive state; Vue proxies
  // can't be structured-cloned, so plain-JSON every other field.
  const plain: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(msg)) plain[k] = v && typeof v === 'object' && !BINARY_FIELDS.has(k) ? JSON.parse(JSON.stringify(v)) : v;
  port?.postMessage(plain, transfer);
}

/** Send a request that is answered by `{reqId}` and wait for it. */
export async function request<T = FromRuntime>(build: (reqId: number) => ToRuntime, transfer: Transferable[] = []): Promise<T> {
  await ensureRuntime();
  const reqId = ++reqSeq;
  const p = new Promise<FromRuntime>((resolve) => waiting.set(reqId, { resolve }));
  send(build(reqId), transfer);
  return (await p) as unknown as T;
}

let runSeq = 0;
export async function runScript(id: CapabilityId): Promise<ScriptCompletion> {
  await ensureRuntime();
  const runId = ++runSeq;
  const p = new Promise<ScriptCompletion>((resolve) => scriptWaiters.set(runId, resolve));
  send({ t: 'runScript', runId, id });
  return p;
}

/** Stop the runtime (tests / a fatal error). Loaded plugins are gone; the next use boots again. */
export function stopRuntime(): void {
  worker?.terminate();
  worker = null; port = null; server = null; booting = null;
  for (const w of scriptWaiters.values()) w({ cancelled: true });
  scriptWaiters.clear();
  runtimeState.value = { phase: 'off', isolated: false };
}

// ---- slicing-pipeline HookChannels (one per orca engine worker) -------------------------------

const unsentChannels = new Map<number, { sab: SharedArrayBuffer; port: MessagePort }>();
let hookSeq = 0;

function flushHookChannels(): void {
  if (runtimeState.value.phase !== 'ready') return;
  for (const [id, c] of unsentChannels) send({ t: 'hookChannel', id, sab: c.sab, port: c.port }, [c.port]);
  unsentChannels.clear();
}

/**
 * Connect an engine worker to the plugin runtime: the engine gets the channel for Module.csHook,
 * the runtime gets the other end (now, or when it has booted). Returns the detach function the
 * engine client calls when that worker is terminated: it sets CANCEL, so a hook in flight ends.
 */
export function connectEngineWorker(worker: Worker): (() => void) | undefined {
  const sab = createHookChannel();
  if (!sab) return undefined;   // not cross-origin isolated: slicing hooks report "not running"
  const id = ++hookSeq;
  const ch = new MessageChannel();
  worker.postMessage({ type: 'pluginHooks', sab, port: ch.port1 }, [ch.port1]);
  unsentChannels.set(id, { sab, port: ch.port2 });
  flushHookChannels();
  return () => {
    const ctrl = new Int32Array(sab, 0, 16);
    Atomics.store(ctrl, HOOK.CANCEL, 1);
    Atomics.notify(ctrl, HOOK.STATE);
    if (unsentChannels.delete(id)) return;
    send({ t: 'hookChannelClosed', id });
  };
}

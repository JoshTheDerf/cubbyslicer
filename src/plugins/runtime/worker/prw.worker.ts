/// <reference lib="webworker" />
/**
 * The plugin runtime worker (PRW): one Pyodide interpreter holding every
 * loaded Orca plugin, like OrcaSlicer's single embedded CPython.
 *
 * Boot: capture what the runtime itself needs (the private message port, the
 * OPFS folder for plugin_data, fetch), load Pyodide from the app's own origin,
 * install the `orca` shim and the runtime module, add the audit hook, then
 * lock the globals down (lockdown.ts) and gate the network (netGate.ts).
 * Nothing of a plugin runs before that.
 */
import type { CapabilityId, FromRuntime, PluginPermissions, RuntimeInit, ToRuntime } from '../../types';
import { HostChannelClient } from '../hostChannel';
import { installNetGate } from './netGate';
import { lockDownGlobals } from './lockdown';
import { attachHookChannel, detachHookChannel, hookCancelled, hookQuery, setPipelineRunner } from './hookServer';

const pySources = import.meta.glob('../python/**/*.py', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Py = any;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let port: MessagePort | null = null;
let py: Py = null;
let runtime: Py = null;
let channel: HostChannelClient | null = null;
let trusted = 0;
let opfsPluginData: FileSystemDirectoryHandle | null = null;
const grants = new Map<string, PluginPermissions>();
const mounts = new Map<string, { syncfs(): Promise<void> }>();
const permissionWaiters = new Map<number, { resolve: (v: string) => void; key: string }>();
let permissionSeq = 0;
let currentGetter: (() => any) | null = null;
let isolated = false;
let pyodideBase = '';

function send(msg: FromRuntime, transfer: Transferable[] = []): void {
  port!.postMessage(msg, transfer);
}

function log(level: 'debug' | 'info' | 'warn' | 'error', text: string, pluginKey?: string): void {
  send({ t: 'log', level, text, pluginKey: pluginKey || undefined });
}

function currentPlugin(): { key: string; capability: string } | null {
  if (!currentGetter) return null;
  try {
    const v = currentGetter();
    if (!v) return null;
    const arr = typeof v.toJs === 'function' ? v.toJs() : v;
    v.destroy?.();
    return arr && arr[0] ? { key: String(arr[0]), capability: String(arr[2] ?? '') } : null;
  } catch { return null; }
}

/** The JS module the Python side imports as `_cubby_host`. */
const hostModule = {
  call(method: string, argsJson: string, pluginKey: string, capability: string) {
    if (!channel) {
      return { error: { type: 'RuntimeError', message: `orca.host: "${method}" needs CubbySlicer to run cross-origin isolated (SharedArrayBuffer), and this page is not. Windows, notifications and post-processing still work; host reads and message boxes do not.` } };
    }
    const r = channel.call({ method, pluginKey, capability, args: JSON.parse(argsJson) });
    if (r.error) return { error: r.error };
    return { json: r.json, blobs: r.blobs };
  },
  post(method: string, argsJson: string, pluginKey: string, capability: string) {
    send({ t: 'hostPost', method: method as never, pluginKey, capability, args: JSON.parse(argsJson) });
  },
  log(level: string, text: string, key: string) { log(level as 'info', text, key); },
  permissionDenied(pluginKey: string, capability: string, category: string, event: string, target: string, persistable: boolean, message: string) {
    send({ t: 'permissionDenied', pluginKey, capability, category, event, target, persistable, message });
  },
  requestPermissions(pluginKey: string, json: string): Promise<string> {
    const reqId = ++permissionSeq;
    send({ t: 'permissionRequest', reqId, pluginKey, request: JSON.parse(json) });
    return new Promise((resolve) => permissionWaiters.set(reqId, { resolve, key: pluginKey }));
  },
  setTrusted(on: boolean) { trusted = Math.max(0, trusted + (on ? 1 : -1)); },
  /** Slicing graph access inside a pipeline hook (hookServer.ts). `blob` is Python bytes or None. */
  hookQuery(json: string, blob: any) {
    let b: Uint8Array | null = null;
    if (blob && typeof blob.getBuffer === 'function') {
      const buf = blob.getBuffer('u8');
      try { b = (buf.data as Uint8Array).slice(); } finally { buf.release(); }
    } else if (blob instanceof Uint8Array) b = blob;
    return hookQuery(json, b);
  },
  hookCancelled() { return hookCancelled(); },
};

async function writeFile(path: string, data: Uint8Array): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  py.FS.mkdirTree(dir);
  py.FS.writeFile(path, data);
}

async function boot(init: RuntimeInit): Promise<void> {
  const t0 = performance.now();
  pyodideBase = new URL(init.pyodideBase, scope.location.href).href;
  isolated = !!init.hostChannel;
  if (init.hostChannel) channel = new HostChannelClient(init.hostChannel, (m) => port!.postMessage(m));
  // Capture the OPFS plugin_data folder before navigator.storage is removed.
  try {
    const root = await navigator.storage.getDirectory();
    const plugins = await (await root.getDirectoryHandle('cubby-plugins', { create: true })).getDirectoryHandle('orca_plugins', { create: true });
    opfsPluginData = await plugins.getDirectoryHandle('plugin_data', { create: true });
  } catch { opfsPluginData = null; }

  const mod = await import(/* @vite-ignore */ `${pyodideBase}pyodide.mjs`);
  py = await mod.loadPyodide({
    indexURL: pyodideBase,
    stdout: (s: string) => log('info', s, currentPlugin()?.key),
    stderr: (s: string) => log('warn', s, currentPlugin()?.key),
  });
  if (init.interrupt) py.setInterruptBuffer(new Int32Array(init.interrupt));
  for (const [rel, src] of Object.entries(pySources)) {
    const path = '/orca/runtime/' + rel.replace(/^\.\.\/python\//, '');
    py.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    py.FS.writeFile(path, src);
  }
  py.registerJsModule('_cubby_host', hostModule);
  py.runPython(`
import sys
sys.path.insert(0, '/orca/runtime')
import orca, _cubby_runtime
orca._ORCA_VERSION = ${JSON.stringify(String(init.appInfo.version ?? '2.5.0'))}
_cubby_runtime.install()
`);
  runtime = py.pyimport('_cubby_runtime');
  setPipelineRunner((begin) => runtime.safe_run_pipeline(begin) as string, (level, text) => log(level, text));
  currentGetter = py.runPython('lambda: __import__("orca._bridge", fromlist=["CURRENT"]).CURRENT.get()');

  installNetGate(scope as unknown as typeof globalThis, {
    base: pyodideBase,
    currentPlugin,
    grants: (k) => grants.get(k),
    trusted: () => trusted > 0,
    denied: (key, capability, url) => send({ t: 'permissionDenied', pluginKey: key, capability, category: 'Http', event: 'fetch', target: url, persistable: true, message: `Plugin attempted network access to ${url} without permission` }),
  });
  const failed = lockDownGlobals(scope as unknown as typeof globalThis);
  if (failed.length) log('warn', `Could not remove from the plugin runtime: ${failed.join(', ')}`);
  const version = py.runPython('import sys; sys.version.split()[0]');
  send({ t: 'ready', pythonVersion: version, bootMs: Math.round(performance.now() - t0), isolated });
}

async function mountPluginData(key: string): Promise<void> {
  const path = `/orca/data/orca_plugins/plugin_data/${key}`;
  py.FS.mkdirTree(path);
  if (mounts.has(key) || !opfsPluginData) return;
  try {
    const dir = await opfsPluginData.getDirectoryHandle(key, { create: true });
    mounts.set(key, await py.mountNativeFS(path, dir));
  } catch (e) {
    log('warn', `plugin storage() for ${key} is not persistent in this browser (${(e as Error).message})`, key);
  }
}

async function syncStorage(): Promise<void> {
  for (const [key, m] of mounts) {
    try { await m.syncfs(); } catch (e) { log('warn', `Couldn't save plugin storage: ${(e as Error).message}`, key); }
  }
}

const capArgs = (id: CapabilityId) => [id.pluginKey, id.type, id.name] as const;

async function handle(msg: ToRuntime): Promise<void> {
  switch (msg.t) {
    case 'load': {
      const t0 = performance.now();
      const d = msg.descriptor;
      try {
        const root = `/orca/data/orca_plugins/${d.root}`;
        // Fresh files on every load ("Reload" and "Delete cache and reload" behave the same here).
        py.runPython(`import shutil; shutil.rmtree(${JSON.stringify(root)}, ignore_errors=True)`);
        for (const f of msg.files) await writeFile(`${root}/${f.path}`, new Uint8Array(f.data));
        grants.set(d.pluginKey, msg.grants);
        if (d.kind === 'py') {
          const src = new TextDecoder().decode(new Uint8Array(msg.files.find((f) => f.path === d.entryFile)!.data));
          trusted++;
          try { await py.loadPackagesFromImports(src, { messageCallback: (m: string) => log('info', m, d.pluginKey) }); } finally { trusted--; }
          if (/\b(Polygon|ExPolygon)\b/.test(src)) await py.loadPackage('pyclipper').catch(() => {});
        }
        if (d.dependencies.length && !msg.skipDeps) {
          trusted++;
          try { await py.loadPackage('micropip', { messageCallback: () => {} }); } finally { trusted--; }
        }
        await mountPluginData(d.pluginKey);
        const r = JSON.parse(await runtime.safe_load(JSON.stringify(d), JSON.stringify(msg.enable), JSON.stringify(msg.grants), !!msg.skipDeps));
        if (!r.ok) { send({ t: 'loadFailed', reqId: msg.reqId, pluginKey: d.pluginKey, error: r.error, traceback: r.traceback }); break; }
        send({ t: 'loaded', reqId: msg.reqId, pluginKey: d.pluginKey, capabilities: r.caps, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        send({ t: 'loadFailed', reqId: msg.reqId, pluginKey: d.pluginKey, error: pyMessage(e) });
      }
      break;
    }
    case 'unload':
      try { runtime.unload(msg.pluginKey); } catch (e) { log('warn', pyMessage(e), msg.pluginKey); }
      await syncStorage();
      send({ t: 'unloaded', reqId: msg.reqId, pluginKey: msg.pluginKey });
      break;
    case 'setEnabled': runtime.set_enabled(...capArgs(msg.id), msg.enabled); break;
    case 'setGrants':
      grants.set(msg.pluginKey, msg.grants);
      runtime.set_grants(msg.pluginKey, JSON.stringify(msg.grants));
      break;
    case 'runScript': {
      // Not awaited by the queue: an async execute() may wait for its own window's callbacks.
      const id = msg.id, runId = msg.runId;
      void (async () => {
        let completion;
        try { completion = JSON.parse(await runtime.run_script(runId, id.pluginKey, id.name)); }
        catch (e) { completion = { cancelled: false, error: pyMessage(e) }; }
        await syncStorage();
        send({ t: 'scriptDone', runId, completion });
      })();
      break;
    }
    case 'cancelScripts': runtime.cancel_scripts(msg.pluginKey); break;
    case 'lifecycle': runtime.lifecycle(msg.event, JSON.stringify(msg.ctx)); break;
    case 'uiEvent':
      runtime.ui_event(Number(msg.handle), msg.kind, msg.data === undefined ? '' : JSON.stringify(msg.data));
      await syncStorage();
      break;
    case 'configUi': {
      const r = JSON.parse(runtime.safe_call(runtime.config_ui, ...capArgs(msg.id)));
      send({ t: 'reply', reqId: msg.reqId, ok: r.ok, value: r.value, error: r.error });
      break;
    }
    case 'pageUi': {
      const r = JSON.parse(runtime.safe_call(runtime.page_ui, ...capArgs(msg.id)));
      send({ t: 'reply', reqId: msg.reqId, ok: r.ok, value: r.value, error: r.error });
      break;
    }
    case 'pageMessage':
      runtime.page_message(msg.id.pluginKey, msg.id.name, msg.data === undefined ? '' : JSON.stringify(msg.data));
      await syncStorage();
      break;
    case 'defaultConfig': {
      const r = JSON.parse(runtime.safe_call(runtime.default_config, ...capArgs(msg.id)));
      send({ t: 'reply', reqId: msg.reqId, ok: r.ok, value: r.ok ? JSON.parse(r.value) : undefined, error: r.error });
      break;
    }
    case 'postProcess': {
      try {
        const res = runtime.safe_post_process(JSON.stringify(msg.caps), new Uint8Array(msg.gcode), msg.host, msg.outputName, JSON.stringify(msg.fullConfig));
        const [out, err] = res.toJs({ depth: 1 });
        res.destroy();
        await syncStorage();
        if (err || !out) { out?.destroy?.(); send({ t: 'reply', reqId: msg.reqId, ok: false, error: String(err || 'Post-processing failed') }); break; }
        const bytes: Uint8Array = out.toJs();
        out.destroy();
        const buf = bytes.slice().buffer;
        send({ t: 'reply', reqId: msg.reqId, ok: true, gcode: buf }, [buf]);
      } catch (e) {
        send({ t: 'reply', reqId: msg.reqId, ok: false, error: pyMessage(e) });
      }
      break;
    }
    case 'permissionAnswer': {
      const w = permissionWaiters.get(msg.reqId);
      permissionWaiters.delete(msg.reqId);
      if (w && msg.grants) grants.set(w.key, msg.grants);
      w?.resolve(JSON.stringify({ granted: msg.granted, grants: msg.grants ?? null }));
      break;
    }
    case 'configs': runtime.set_configs(JSON.stringify(msg.entries)); break;
    case 'hookChannel': attachHookChannel(msg.id, msg.sab, msg.port); break;
    case 'hookChannelClosed': detachHookChannel(msg.id); break;
    default: break;
  }
}

/** A Python exception's last line ("RuntimeError: message" → "message" for our own RuntimeErrors). */
function pyMessage(e: unknown): string {
  const s = String((e as Error)?.message ?? e);
  if ((e as { type?: string })?.type) {
    const lines = s.trim().split('\n');
    const last = lines[lines.length - 1] ?? s;
    if (/^(RuntimeError|PostProcessError): /.test(last)) return lines.slice(lines.findIndex((l) => /^(RuntimeError|PostProcessError): /.test(l))).join('\n').replace(/^(RuntimeError|PostProcessError): /, '');
    return last;
  }
  return s;
}

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as RuntimeInit;
  if (msg?.t !== 'init' || port) return;
  port = ev.ports[0];
  port.onmessage = (e: MessageEvent<ToRuntime>) => {
    const m = e.data;
    // Loads are serialized (Orca serializes them too); everything else runs as it arrives so UI
    // callbacks are never stuck behind a load waiting for a dependency download.
    if (m.t === 'load' || m.t === 'unload') queue = queue.then(() => handle(m)).catch((err) => log('error', String((err as Error)?.stack ?? err)));
    else void handle(m).catch((err) => log('error', String((err as Error)?.stack ?? err)));
  };
  boot(msg).catch((e) => send({ t: 'bootFailed', error: String((e as Error)?.message ?? e) }));
};

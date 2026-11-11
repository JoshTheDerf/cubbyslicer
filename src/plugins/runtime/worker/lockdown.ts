/**
 * Lock down the plugin runtime worker's globals before any plugin code runs.
 *
 * Plugins are arbitrary Python, and Pyodide gives Python the worker's whole
 * JavaScript scope (`import js`). This worker runs on the app's origin (for
 * now), so without this a plugin could read the app's IndexedDB (presets,
 * autosaved projects, File System Access handles), Cache Storage and OPFS, or
 * open WebSockets anywhere. This is defence in depth, not a sandbox: moving
 * the worker to its own origin (report §B9, phase 4) is the real boundary, and
 * nothing here depends on being same-origin, so that move is a deployment
 * change.
 */
export const REMOVED_GLOBALS = [
  'indexedDB', 'caches', 'WebSocket', 'WebTransport', 'EventSource', 'BroadcastChannel', 'Worker', 'SharedWorker',
  'importScripts', 'IDBFactory', 'CacheStorage', 'FileSystemSyncAccessHandle', 'cookieStore',
] as const;

export function lockDownGlobals(scope: typeof globalThis): string[] {
  const failed: string[] = [];
  for (const name of REMOVED_GLOBALS) {
    try {
      Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false });
    } catch { failed.push(name); }
  }
  // navigator.storage (OPFS, persistence) lives on WorkerNavigator.prototype.
  try {
    const proto = Object.getPrototypeOf(scope.navigator);
    Object.defineProperty(proto, 'storage', { get: () => undefined, configurable: false });
  } catch { failed.push('navigator.storage'); }
  // Messages to the app go over a private MessagePort captured at init; the
  // worker's own postMessage / onmessage are ignored by the app after init.
  try { Object.defineProperty(scope, 'postMessage', { value: () => {}, writable: false, configurable: false }); } catch { failed.push('postMessage'); }
  return failed;
}

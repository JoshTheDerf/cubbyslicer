/**
 * Browser I/O for the print host drivers.
 *
 * The app is served over HTTPS; printers usually speak plain http:// on the
 * LAN. What can work:
 *
 *  - Chrome's Local Network Access (LNA): a secure page may fetch
 *    http://<local address> when the request declares
 *    `targetAddressSpace: 'local'` (older builds: 'private') — or when the
 *    host is a private-IP literal / *.local name — and the user allows the
 *    "access other devices on your local network" prompt. We feature-detect
 *    the option by constructing a Request (an unknown enum value throws).
 *  - Everything else (Firefox, Safari, public http:// hosts): mixed content is
 *    blocked; only https:// hosts work.
 *  - Every host must answer CORS for this origin (the dialog shows the exact
 *    setting per host type). CORS responses also satisfy the app's
 *    Cross-Origin-Embedder-Policy, so no CORP header is needed.
 *
 * Uploads use XMLHttpRequest for upload progress. XHR can't pass
 * `targetAddressSpace`, so for a hostname (not an IP literal / .local) reached
 * from HTTPS we fall back to fetch() with indeterminate progress.
 */
import { HostError, type HostEnv, type HostRequest, type HostResponse, type RequestOptions, type Transport, type WsLike } from './types';
import { isLocalHostname } from './url';

const DEFAULT_TIMEOUT = 15_000;

function pageIsSecure(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

let lnaValue: string | null | undefined;
/** The `targetAddressSpace` value this browser accepts ('local' | 'private'), or null. */
export function lnaAddressSpace(): string | null {
  if (lnaValue !== undefined) return lnaValue;
  lnaValue = null;
  if (typeof Request === 'undefined') return lnaValue;
  for (const v of ['local', 'private']) {
    try {
      // Browsers that don't know the member ignore it (no error, no effect).
      new Request('http://192.168.0.1/', { targetAddressSpace: v } as RequestInit);
      lnaValue = v;
      break;
    } catch { /* unknown enum value in this build */ }
  }
  return lnaValue;
}

/** A plain-http request from this HTTPS page (mixed content unless LNA applies). */
export function isInsecureFromSecure(url: string): boolean {
  return pageIsSecure() && url.startsWith('http:');
}

/** Actionable text for a request that failed before any HTTP response. */
export function networkFailureMessage(url: string): string {
  let host = url;
  try { const u = new URL(url); host = u.host; } catch { /* keep */ }
  const origin = typeof location !== 'undefined' ? location.origin : 'this site';
  const lines = [`Couldn’t reach ${host}.`];
  if (isInsecureFromSecure(url)) {
    lines.push(
      'This page is HTTPS and the printer is plain http://, so the browser may have blocked it:',
      '• Chrome/Edge: allow “Access other devices on your local network” when asked (padlock → Site settings → Local network access).',
      '• Firefox/Safari block http:// printers from HTTPS pages — give the printer (or a reverse proxy) an https:// address.',
    );
  }
  lines.push(
    `• The printer must allow requests from ${origin} (CORS) — see the setup hint for this host type.`,
    '• Check the address and that the printer is on and on the same network.',
    'You can always Export G-code and copy it to the printer instead.',
  );
  return lines.join('\n');
}

function parseHeaders(raw: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const i = line.indexOf(':');
    if (i > 0) m.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return m;
}

function xhrRequest(req: HostRequest, opts: RequestOptions): Promise<HostResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(req.method, req.url, true);
    for (const [k, v] of Object.entries(req.headers ?? {})) xhr.setRequestHeader(k, v);
    if (req.timeoutMs) xhr.timeout = req.timeoutMs;
    if (opts.onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => opts.onProgress!(e.loaded, e.lengthComputable ? e.total : 0);
    }
    const onAbort = () => xhr.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => opts.signal?.removeEventListener('abort', onAbort);
    xhr.onload = () => {
      done();
      const h = parseHeaders(xhr.getAllResponseHeaders());
      resolve({ status: xhr.status, header: (n) => h.get(n.toLowerCase()) ?? null, text: xhr.responseText ?? '' });
    };
    xhr.onerror = () => { done(); reject(new HostError('network', networkFailureMessage(req.url))); };
    xhr.ontimeout = () => { done(); reject(new HostError('timeout', `The printer at ${new URL(req.url).host} didn’t answer in time.`)); };
    xhr.onabort = () => { done(); reject(new HostError('cancelled', 'Cancelled.')); };
    xhr.send((req.body ?? null) as XMLHttpRequestBodyInit | null);
  });
}

async function fetchRequest(req: HostRequest, opts: RequestOptions): Promise<HostResponse> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(new HostError('cancelled', 'Cancelled.'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = req.timeoutMs ? setTimeout(() => { timedOut = true; ctrl.abort(); }, req.timeoutMs) : null;
  const init: RequestInit & { targetAddressSpace?: string } = {
    method: req.method, headers: req.headers, body: req.body ?? undefined, signal: ctrl.signal,
    mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow',
  };
  const lna = isInsecureFromSecure(req.url) ? lnaAddressSpace() : null;
  if (lna) init.targetAddressSpace = lna;
  try {
    opts.onProgress?.(0, 0);
    const r = await fetch(req.url, init);
    const text = await r.text();
    if (req.body && opts.onProgress) { const n = req.body instanceof Blob ? req.body.size : 0; opts.onProgress(n, n); }
    return { status: r.status, header: (n) => r.headers.get(n), text };
  } catch (e) {
    if (opts.signal?.aborted) throw new HostError('cancelled', 'Cancelled.');
    if (timedOut) throw new HostError('timeout', `The printer at ${new URL(req.url).host} didn’t answer in time.`);
    throw new HostError('network', networkFailureMessage(req.url), (e as Error)?.message);
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Prefer XHR (upload progress) unless the request needs fetch's LNA option. */
export const browserTransport: Transport = (req, opts = {}) => {
  const r = { ...req, timeoutMs: req.timeoutMs ?? (req.body instanceof Blob || req.body instanceof FormData ? 0 : DEFAULT_TIMEOUT) };
  let needsLnaFetch = false;
  if (isInsecureFromSecure(r.url) && lnaAddressSpace()) {
    try { needsLnaFetch = !isLocalHostname(new URL(r.url).hostname); } catch { needsLnaFetch = true; }
  }
  const useXhr = !!opts.onProgress && typeof XMLHttpRequest !== 'undefined' && !needsLnaFetch;
  return useXhr ? xhrRequest(r, opts) : fetchRequest(r, opts);
};

export function browserWs(url: string): WsLike {
  return new WebSocket(url) as unknown as WsLike;
}

export function browserEnv(): HostEnv {
  return {
    http: browserTransport,
    ws: browserWs,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    uuid: () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`),
  };
}

/** Shared helpers for the host drivers. */
import { HostError, type HostContext, type HostEnv, type HostRequest, type HostResponse, type RequestOptions, type WsLike } from './types';
import { parseHost, type ParsedHost } from './url';

export const is2xx = (r: HostResponse) => r.status >= 200 && r.status < 300;

export function tryJson<T = Record<string, unknown>>(text: string): T | null {
  try { return JSON.parse(text) as T; } catch { return null; }
}

function trimBody(text: string): string {
  const t = (text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

/** Orca PrintHost::format_error(): "HTTP <status>: <body>"; 401/403 become 'auth'. */
export function httpError(r: HostResponse, what: string): HostError {
  const body = trimBody(r.text);
  const auth = r.status === 401 || r.status === 403;
  const hint = auth ? ' Check the API key / password.' : r.status === 404 ? ' Is the host type right?' : '';
  return new HostError(auth ? 'auth' : 'http', `${what}: HTTP ${r.status}.${hint}`, body || undefined, r.status);
}

export function expectOk(r: HostResponse, what: string): HostResponse {
  if (!is2xx(r)) throw httpError(r, what);
  return r;
}

/** Host + auth helpers bound to one config. */
export interface Client {
  host: ParsedHost;
  url(path: string): string;
  send(req: HostRequest, opts?: RequestOptions): Promise<HostResponse>;
}

export function client(ctx: HostContext, env: HostEnv, headers: () => Record<string, string> = () => ({})): Client {
  const host = parseHost(ctx.host);
  return {
    host,
    url: (path) => host.base + path.replace(/^\/+/, ''),
    send: (req, opts) => {
      const h: Record<string, string> = { ...headers(), ...(req.headers ?? {}) };
      if (host.basicAuth && !h.Authorization) h.Authorization = host.basicAuth;
      return env.http({ ...req, headers: h }, opts);
    },
  };
}

/** `{ [name]: prefix + value }` when value is set, else `{}`. */
export function headerIf(name: string, value: string, prefix = ''): Record<string, string> {
  return value ? { [name]: prefix + value } : {};
}

export function formFile(fields: Record<string, string>, fileField: string, file: Blob, filename: string): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append(fileField, file, filename);
  return fd;
}

/** Local time "YYYY-MM-DDTHH:MM:SS" (Duet `time=` parameter). */
export function localTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HostError('cancelled', 'Cancelled.');
}

// ---- WebSocket session (Elegoo SDCP, Creality) ----------------------------------------

export interface WsSession {
  send(obj: unknown): void;
  /** Next message matching `pick` (JSON-parsed when possible) within `timeoutMs`. */
  next<T = unknown>(pick: (msg: unknown) => T | undefined, timeoutMs: number): Promise<T>;
  close(): void;
}

export function openWs(env: HostEnv, url: string, timeoutMs = 8000): Promise<WsSession> {
  return new Promise((resolve, reject) => {
    let ws: WsLike;
    try { ws = env.ws(url); } catch (e) {
      reject(new HostError('network', `Couldn’t open ${url}.`, (e as Error)?.message));
      return;
    }
    const failMsg = `Couldn’t connect to ${url}. From an HTTPS page most browsers block insecure ws:// connections to printers.`;
    const queue: unknown[] = [];
    let pending: { offer(m: unknown): boolean; fail(e: HostError): void } | null = null;
    let opened = false;
    let closed = false;
    const timer = setTimeout(() => { if (!opened) { try { ws.close(); } catch { /* ignore */ } reject(new HostError('network', failMsg)); } }, timeoutMs);
    ws.onopen = () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
        next: <T>(pick: (msg: unknown) => T | undefined, ms: number) => new Promise<T>((res, rej) => {
          const t = setTimeout(() => { pending = null; rej(new HostError('timeout', 'The printer didn’t answer in time.')); }, ms);
          const offer = (m: unknown): boolean => {
            const v = pick(m);
            if (v === undefined) return false;
            clearTimeout(t); pending = null; res(v); return true;
          };
          while (queue.length) { if (offer(queue.shift())) return; }
          if (closed) { clearTimeout(t); rej(new HostError('network', 'The printer closed the connection.')); return; }
          pending = { offer, fail: (e) => { clearTimeout(t); pending = null; rej(e); } };
        }),
        close: () => { try { ws.close(); } catch { /* ignore */ } },
      });
    };
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      const msg = tryJson(raw) ?? raw;
      if (!pending || !pending.offer(msg)) { if (!pending) queue.push(msg); }
    };
    ws.onerror = () => { if (!opened) { clearTimeout(timer); reject(new HostError('network', failMsg)); } };
    ws.onclose = () => {
      closed = true;
      if (!opened) { clearTimeout(timer); reject(new HostError('network', failMsg)); return; }
      pending?.fail(new HostError('network', 'The printer closed the connection.'));
    };
  });
}

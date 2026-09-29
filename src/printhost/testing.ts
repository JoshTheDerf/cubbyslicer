/** Test helpers: a scripted fake transport + WebSocket for the host drivers. */
import { emptyConfig } from './config';
import { HostError, type HostContext, type HostEnv, type HostRequest, type HostResponse, type RequestOptions, type WsLike } from './types';

export interface Reply { status?: number; body?: unknown; headers?: Record<string, string> }
export type Route = (req: HostRequest) => Reply | 'network' | undefined;

export interface Recorded extends HostRequest { opts?: RequestOptions }

export function reply(r: Reply): HostResponse {
  const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { status: r.status ?? 200, header: (n) => h.get(n.toLowerCase()) ?? null, text: typeof r.body === 'string' ? r.body : r.body === undefined ? '' : JSON.stringify(r.body) };
}

export class FakeWs implements WsLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  constructor(public url: string, private onSend: (ws: FakeWs, msg: Record<string, unknown>) => void, fail = false) {
    queueMicrotask(() => {
      if (fail) { this.onerror?.({}); this.onclose?.({ code: 1006 }); return; }
      this.readyState = 1; this.onopen?.({});
    });
  }
  send(data: string) { const m = JSON.parse(data); this.sent.push(m); queueMicrotask(() => this.onSend(this, m)); }
  push(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

export function fakeEnv(route: Route, ws?: (url: string) => WsLike) {
  const calls: Recorded[] = [];
  const env: HostEnv = {
    http: async (req, opts) => {
      calls.push({ ...req, opts });
      const r = route(req);
      if (r === 'network') throw new HostError('network', `Couldn’t reach ${new URL(req.url).host}.`);
      if (!r) return reply({ status: 404, body: 'not found' });
      if (opts?.onProgress && req.body && typeof req.body !== 'string') { const n = req.body instanceof Blob ? req.body.size : 1; opts.onProgress(n, n); }
      return reply(r);
    },
    ws: ws ?? (() => { throw new Error('no ws'); }),
    sleep: async () => {},
    now: () => Date.now(),
    uuid: () => '0000-1111-2222',
  };
  return { env, calls };
}

export function ctx(over: Partial<HostContext> = {}): HostContext {
  return { ...emptyConfig(), host: '192.168.1.5', ...over };
}

export const gcode = (s = 'G28\nG1 X10\n') => new Blob([s], { type: 'text/x-gcode' });

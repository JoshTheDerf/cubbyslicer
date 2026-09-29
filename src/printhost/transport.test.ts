import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserTransport, lnaAddressSpace, networkFailureMessage } from './transport';
import { HostError } from './types';

class FakeXhr {
  static last: FakeXhr | null = null;
  method = ''; url = ''; headers: Record<string, string> = {}; body: unknown; timeout = 0; status = 200; responseText = '{"ok":true}';
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; ontimeout: (() => void) | null = null; onabort: (() => void) | null = null;
  constructor() { FakeXhr.last = this; }
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  getAllResponseHeaders() { return 'content-type: application/json\r\nx-thing: 1\r\n'; }
  abort() { this.onabort?.(); }
  send(b: unknown) {
    this.body = b;
    queueMicrotask(() => {
      if (this.url.includes('fail')) { this.onerror?.(); return; }
      this.upload.onprogress?.({ loaded: 5, total: 10, lengthComputable: true });
      this.onload?.();
    });
  }
}

describe('browser transport', () => {
  const g = globalThis as Record<string, unknown>;
  let saved: Record<string, unknown>;
  beforeEach(() => {
    saved = { location: g.location, fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest };
    g.location = { protocol: 'https:', origin: 'https://cubbycad.com' };
    g.XMLHttpRequest = FakeXhr;
  });
  afterEach(() => { Object.assign(g, saved); vi.restoreAllMocks(); });

  it('detects a usable targetAddressSpace value', () => {
    expect(['local', 'private', null]).toContain(lnaAddressSpace());
  });

  it('uses fetch with targetAddressSpace for a LAN hostname from HTTPS', async () => {
    const fetchMock = vi.fn(async () => new Response('{"api":"0.1"}', { status: 200 }));
    g.fetch = fetchMock;
    const r = await browserTransport({ method: 'POST', url: 'http://octopi.lan/api/files/local', body: new Blob(['x']) }, { onProgress: () => {} });
    expect(r.status).toBe(200);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit & { targetAddressSpace?: string }])[1];
    expect(init.mode).toBe('cors');
    expect(init.credentials).toBe('omit');
    if (lnaAddressSpace()) expect(init.targetAddressSpace).toBe(lnaAddressSpace());
  });

  it('uses XHR (upload progress) for private IP literals', async () => {
    const progress: Array<[number, number]> = [];
    const r = await browserTransport({ method: 'POST', url: 'http://192.168.1.5/upload', headers: { 'X-Api-Key': 'k' }, body: new Blob(['abc']) },
      { onProgress: (l, t) => progress.push([l, t]) });
    expect(FakeXhr.last!.headers['X-Api-Key']).toBe('k');
    expect(progress).toEqual([[5, 10]]);
    expect(r.header('X-Thing')).toBe('1');
    expect(r.text).toBe('{"ok":true}');
  });

  it('turns a blocked request into actionable guidance', async () => {
    await expect(browserTransport({ method: 'POST', url: 'http://192.168.1.5/fail', body: new Blob(['a']) }, { onProgress: () => {} }))
      .rejects.toBeInstanceOf(HostError);
    g.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const err = await browserTransport({ method: 'GET', url: 'http://192.168.1.5/api/version' }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'network' });
    expect(err.message).toContain('Local network access');
    expect(err.message).toContain('https://cubbycad.com');
  });

  it('omits the mixed-content advice for https hosts', () => {
    const m = networkFailureMessage('https://printer.example.com/api/version');
    expect(m).not.toContain('Firefox');
    expect(m).toContain('CORS');
  });
});

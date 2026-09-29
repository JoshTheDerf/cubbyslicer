/**
 * Duet — Duet.cpp. `printhost_apikey` is the board password (default "reprap").
 *
 * Standalone RepRapFirmware (RRF):
 *   connect: GET  rr_connect?password=<pw>&time=<local>   → { err: 0|1|2, sessionKey? }
 *   upload:  POST rr_upload?name=0:/gcodes/<path>&time=…  body = G-code → { err: 0 }
 *   print:   GET  rr_gcode?gcode=M32 "0:/gcodes/<path>"
 *   done:    GET  rr_disconnect
 * Duet Software Framework (SBC):
 *   connect: GET  machine/connect?password=<pw> → { sessionKey }  (DSF 3.5+), else GET machine/status (3.4)
 *   upload:  PUT  machine/file/gcodes/<path>     → 201
 *   print:   POST machine/code   body: M32 "0:/gcodes/<path>"
 * RRF 3.5 returns a sessionKey that must be sent as X-Session-Key.
 */
import { HostError, type HostContext, type PrintHostDriver } from '../types';
import { escapePath, joinRemote } from '../url';
import { client, expectOk, is2xx, localTimestamp, throwIfAborted, tryJson, type Client } from '../util';

type Conn = { kind: 'rrf' | 'dsf'; session?: string };

function password(ctx: HostContext): string { return ctx.apiKey || 'reprap'; }

async function connect(c: Client, ctx: HostContext, signal?: AbortSignal): Promise<Conn> {
  let rrfError: HostError | null = null;
  try {
    const r = await c.send({ method: 'GET', url: c.url(`rr_connect?password=${encodeURIComponent(password(ctx))}&time=${localTimestamp()}`) }, { signal });
    if (is2xx(r)) {
      const j = tryJson<{ err?: number; sessionKey?: number | string }>(r.text);
      if (j) {
        const err = j.err ?? 0;
        if (err === 0) return { kind: 'rrf', session: j.sessionKey !== undefined ? String(j.sessionKey) : undefined };
        if (err === 1) throw new HostError('auth', 'Wrong password.');
        if (err === 2) throw new HostError('http', 'Could not get resources to create a new connection.');
        throw new HostError('protocol', 'Unknown error occurred.');
      }
    }
  } catch (e) {
    if (e instanceof HostError && (e.kind === 'auth' || e.kind === 'cancelled')) throw e;
    rrfError = e instanceof HostError ? e : null;
  }
  // Duet Software Framework (SBC).
  const cr = await c.send({ method: 'GET', url: c.url(`machine/connect?password=${encodeURIComponent(password(ctx))}`) }, { signal }).catch((e) => { throw rrfError ?? e; });
  if (is2xx(cr)) {
    const j = tryJson<{ sessionKey?: string | number }>(cr.text);
    return { kind: 'dsf', session: j?.sessionKey !== undefined ? String(j.sessionKey) : undefined };
  }
  if (cr.status === 403) throw new HostError('auth', 'Wrong password.');
  const sr = await c.send({ method: 'GET', url: c.url('machine/status') }, { signal });
  if (is2xx(sr)) return { kind: 'dsf' };
  throw rrfError ?? new HostError('protocol', `Could not connect to Duet (HTTP ${sr.status}).`);
}

async function disconnect(c: Client, conn: Conn): Promise<void> {
  const headers = conn.session ? { 'X-Session-Key': conn.session } : undefined;
  try {
    if (conn.kind === 'rrf') await c.send({ method: 'GET', url: c.url('rr_disconnect'), headers });
    else if (conn.session) await c.send({ method: 'GET', url: c.url('machine/disconnect'), headers });
  } catch { /* the board drops idle sessions anyway */ }
}

export const duet: PrintHostDriver = {
  async test(ctx, env, signal) {
    const c = client(ctx, env);
    const conn = await connect(c, ctx, signal);
    await disconnect(c, conn);
    return { message: 'Connection to Duet is working correctly.', detail: conn.kind === 'rrf' ? 'RepRapFirmware (standalone)' : 'Duet Software Framework (SBC)' };
  },
  async upload(ctx, job, env, cb = {}) {
    const c = client(ctx, env);
    cb.onStatus?.('Connecting');
    const conn = await connect(c, ctx, cb.signal);
    const headers: Record<string, string> = conn.session ? { 'X-Session-Key': conn.session } : {};
    const remote = joinRemote(job.folder, job.filename);
    try {
      cb.onStatus?.('Uploading');
      if (conn.kind === 'dsf') {
        const r = await c.send({ method: 'PUT', url: c.url(`machine/file/gcodes/${escapePath(remote)}`), headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: job.file },
          { onProgress: cb.onProgress, signal: cb.signal });
        expectOk(r, 'Upload failed');
      } else {
        const r = await c.send({ method: 'POST', url: c.url(`rr_upload?name=${encodeURIComponent(`0:/gcodes/${remote}`)}&time=${localTimestamp()}`), headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: job.file },
          { onProgress: cb.onProgress, signal: cb.signal });
        expectOk(r, 'Upload failed');
        const j = tryJson<{ err?: number }>(r.text);
        if (j && (j.err ?? 0) !== 0) throw new HostError('http', 'Upload failed: the board reported an error.', r.text);
      }
      if (!job.print) return { message: 'Uploaded to Duet.', printed: false, path: `0:/gcodes/${remote}` };
      throwIfAborted(cb.signal);
      cb.onStatus?.('Starting print');
      const m32 = `M32 "0:/gcodes/${remote}"`;
      const r = conn.kind === 'dsf'
        ? await c.send({ method: 'POST', url: c.url('machine/code'), headers: { ...headers, 'Content-Type': 'text/plain' }, body: m32 })
        : await c.send({ method: 'GET', url: c.url(`rr_gcode?gcode=${encodeURIComponent(m32)}`), headers });
      expectOk(r, 'Uploaded, but starting the print failed');
      return { message: 'Uploaded to Duet and started printing.', printed: true, path: `0:/gcodes/${remote}` };
    } finally {
      await disconnect(c, conn);
    }
  },
};

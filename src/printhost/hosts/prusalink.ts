/**
 * PrusaLink — PrusaLink in OctoPrint.cpp.
 *   auth:   X-Api-Key (authType 'key') or HTTP digest (authType 'user')
 *   test:   GET api/version → { api, text: "PrusaLink …", capabilities: { "upload-by-put": bool } }
 *   upload (upload-by-put): PUT api/v1/files<storage>/<path>  body = G-code,
 *           Content-Type: text/x.gcode, Overwrite: ?1, Print-After-Upload: ?1 (print only)
 *           storage from GET api/v1/storage (first writable), default /usb
 *   upload (legacy): POST api/files/local multipart: path, print, file
 */
import { digestAuthorization, parseChallenge, type DigestChallenge } from '../digest';
import { HostError, type HostContext, type HostEnv, type HostRequest, type PrintHostDriver, type RequestOptions } from '../types';
import { escapePath, joinRemote } from '../url';
import { client, expectOk, formFile, is2xx, tryJson } from '../util';

interface VersionReply { api?: string; text?: string; capabilities?: Record<string, unknown> }

export function prusaLinkClient(ctx: HostContext, env: HostEnv) {
  const c = client(ctx, env);
  let challenge: DigestChallenge | null = null;
  let nc = 0;
  const digest = ctx.authType === 'user';
  const authHeaders = (req: HostRequest): Record<string, string> => {
    if (!digest) return ctx.apiKey ? { 'X-Api-Key': ctx.apiKey } : {};
    return challenge ? { Authorization: digestAuthorization(challenge, ctx.user, ctx.password, req.method, req.url, ++nc) } : {};
  };
  async function send(req: HostRequest, opts?: RequestOptions) {
    let r = await c.send({ ...req, headers: { ...req.headers, ...authHeaders(req) } }, opts);
    if (r.status !== 401 || !digest) return r;
    const ch = parseChallenge(r.header('WWW-Authenticate'));
    if (!ch) {
      throw new HostError('auth',
        'PrusaLink wants an HTTP digest login, but the browser can’t read its challenge (the printer doesn’t expose WWW-Authenticate to other sites). Use the API key authorization instead, or upload from the PrusaLink web page.',
        undefined, 401);
    }
    const retry = !challenge || challenge.nonce !== ch.nonce;
    challenge = ch; nc = 0;
    if (!retry) throw new HostError('auth', 'PrusaLink rejected the user name or password.', undefined, 401);
    r = await c.send({ ...req, headers: { ...req.headers, ...authHeaders(req) } }, opts);
    if (r.status === 401) throw new HostError('auth', 'PrusaLink rejected the user name or password.', undefined, 401);
    return r;
  }
  return { url: c.url, send };
}

async function version(p: ReturnType<typeof prusaLinkClient>, signal?: AbortSignal): Promise<{ text?: string; usePut: boolean }> {
  const r = expectOk(await p.send({ method: 'GET', url: p.url('api/version') }, { signal }), 'PrusaLink didn’t accept the request');
  const j = tryJson<VersionReply>(r.text);
  if (!j) throw new HostError('protocol', 'Could not parse the PrusaLink server response.');
  if (!j.api) throw new HostError('protocol', 'The host answered, but it doesn’t look like PrusaLink (no “api” in api/version).');
  if (!(j.text && (j.text.startsWith('PrusaLink') || j.text.startsWith('OctoPrint')))) throw new HostError('protocol', `Mismatched type of print host: ${j.text ?? 'unknown'}`);
  return { text: j.text, usePut: j.capabilities?.['upload-by-put'] === true };
}

async function storagePath(p: ReturnType<typeof prusaLinkClient>): Promise<string> {
  try {
    const r = await p.send({ method: 'GET', url: p.url('api/v1/storage') });
    if (!is2xx(r)) return '/usb';
    const j = tryJson<{ storage_list?: Array<{ path?: string; available?: boolean; read_only?: boolean; ro?: boolean; free_space?: number }> }>(r.text);
    const hit = j?.storage_list?.find((s) => s.path && s.available !== false && !(s.read_only ?? s.ro) && (s.free_space ?? 1) > 0);
    return hit?.path ?? '/usb';
  } catch { return '/usb'; }
}

export const prusalink: PrintHostDriver = {
  async test(ctx, env, signal) {
    const v = await version(prusaLinkClient(ctx, env), signal);
    return { message: 'Connection to PrusaLink is working correctly.', detail: v.text };
  },
  async upload(ctx, job, env, cb = {}) {
    const p = prusaLinkClient(ctx, env);
    cb.onStatus?.('Connecting');
    const { usePut } = await version(p, cb.signal);
    cb.onStatus?.('Uploading');
    const remote = joinRemote(job.folder, job.filename);
    if (usePut) {
      const storage = await storagePath(p);
      const url = p.url(`api/v1/files/${escapePath(storage)}/${escapePath(remote)}`);
      const headers: Record<string, string> = { 'Content-Type': 'text/x.gcode', Overwrite: '?1' };
      // PrusaLink treated any value as true; only send the header to print.
      if (job.print) headers['Print-After-Upload'] = '?1';
      expectOk(await p.send({ method: 'PUT', url, headers, body: job.file }, { onProgress: cb.onProgress, signal: cb.signal }), 'Upload failed');
      return { message: job.print ? 'Uploaded to PrusaLink and started printing.' : 'Uploaded to PrusaLink.', printed: job.print, path: `${storage}/${remote}` };
    }
    const body = formFile({ path: job.folder.replace(/^\/+|\/+$/g, ''), print: job.print ? 'true' : 'false' }, 'file', job.file, job.filename);
    expectOk(await p.send({ method: 'POST', url: p.url('api/files/local'), body }, { onProgress: cb.onProgress, signal: cb.signal }), 'Upload failed');
    return { message: job.print ? 'Uploaded to PrusaLink and started printing.' : 'Uploaded to PrusaLink.', printed: job.print, path: remote };
  },
};

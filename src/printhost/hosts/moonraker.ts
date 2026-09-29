/**
 * Moonraker (Klipper) — Moonraker.cpp. API key optional (X-Api-Key).
 *   test:   GET  server/info           → { result: { klippy_state } }
 *   upload: POST server/files/upload   multipart: root=gcodes, path=<folder>, file → { result: { item: { path } } }
 *   print:  POST printer/print/start   { filename: <item.path> }
 */
import { HostError, type PrintHostDriver, type HostContext, type HostEnv } from '../types';
import { client, expectOk, formFile, throwIfAborted, tryJson, headerIf } from '../util';

const mk = (ctx: HostContext, env: HostEnv) => client(ctx, env, () => headerIf('X-Api-Key', ctx.apiKey));

export const moonraker: PrintHostDriver = {
  async test(ctx, env, signal) {
    const c = mk(ctx, env);
    const r = expectOk(await c.send({ method: 'GET', url: c.url('server/info') }, { signal }), 'Moonraker didn’t accept the request');
    const j = tryJson<{ result?: { klippy_state?: string; moonraker_version?: string } }>(r.text);
    if (!j) throw new HostError('protocol', 'Could not parse the Moonraker server response.');
    if (!j.result?.klippy_state) throw new HostError('protocol', 'The host responded but it doesn’t look like Moonraker (missing result.klippy_state).');
    return { message: 'Connection to Moonraker is working correctly.', detail: `Klipper: ${j.result.klippy_state}${j.result.moonraker_version ? ` · Moonraker ${j.result.moonraker_version}` : ''}` };
  },
  async upload(ctx, job, env, cb = {}) {
    const c = mk(ctx, env);
    cb.onStatus?.('Uploading');
    const fields: Record<string, string> = { root: 'gcodes' };
    const folder = job.folder.replace(/^\/+|\/+$/g, '');
    if (folder) fields.path = folder;
    const r = expectOk(await c.send({ method: 'POST', url: c.url('server/files/upload'), body: formFile(fields, 'file', job.file, job.filename) },
      { onProgress: cb.onProgress, signal: cb.signal }), 'Upload failed');
    const j = tryJson<{ result?: { item?: { path?: string } }; item?: { path?: string } }>(r.text);
    // Moonraker confirms the storage-relative path (it may rename on collision).
    const path = j?.result?.item?.path ?? j?.item?.path ?? (folder ? `${folder}/${job.filename}` : job.filename);
    if (!job.print) return { message: 'Uploaded to Moonraker.', printed: false, path };
    throwIfAborted(cb.signal);
    cb.onStatus?.('Starting print');
    expectOk(await c.send({ method: 'POST', url: c.url('printer/print/start'), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: path }) }),
      'Uploaded, but starting the print failed');
    return { message: 'Uploaded to Moonraker and started printing.', printed: true, path };
  },
};

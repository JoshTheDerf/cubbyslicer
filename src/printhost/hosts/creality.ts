/**
 * Creality Print (K1 / K2 family) — CrealityPrint.cpp.
 *   test:   GET  info   (Authorization: Bearer <key> when set) → { model: "F008" … }
 *   upload: POST upload/<name>  multipart: [path=<folder>] (not on K2), file   (spaces → _)
 *   print:  WebSocket ws://<host>:9999/
 *           { method: "set", params: { opGcodeFile: "printprt:<gcodes dir>/<name>" } }
 *           K1: /usr/data/printer_data/gcodes · K2 (F008/F012/F021/F022): /mnt/UDISK/printer_data/gcodes
 *           (K2 with a CFS colour mapping is not implemented — prints from the spool holder, like Orca without a mapping.)
 */
import { HostError, type HostContext, type HostEnv, type PrintHostDriver } from '../types';
import { withPort } from '../url';
import { client, expectOk, formFile, openWs, tryJson, headerIf } from '../util';

const K2_MODELS = new Set(['F008', 'F012', 'F021', 'F022']);
export const crealitySafeName = (name: string) => name.replace(/ /g, '_');

const mk = (ctx: HostContext, env: HostEnv) => client(ctx, env, () => headerIf('Authorization', ctx.apiKey, 'Bearer '));

async function info(ctx: HostContext, env: HostEnv, signal?: AbortSignal): Promise<{ model?: string }> {
  const c = mk(ctx, env);
  const r = expectOk(await c.send({ method: 'GET', url: c.url('info'), timeoutMs: 5000 }, { signal }), 'The printer didn’t accept the request');
  return tryJson<{ model?: string }>(r.text) ?? {};
}

export const crealityprint: PrintHostDriver = {
  async test(ctx, env, signal) {
    const i = await info(ctx, env, signal);
    return { message: 'Connected to CrealityPrint successfully!', detail: i.model ? `Model ${i.model}${K2_MODELS.has(i.model) ? ' (K2 platform)' : ''}` : undefined };
  },
  async upload(ctx, job, env, cb = {}) {
    cb.onStatus?.('Connecting');
    const { model } = await info(ctx, env, cb.signal);
    const k2 = !!model && K2_MODELS.has(model);
    const name = crealitySafeName(job.filename);
    const c = mk(ctx, env);
    cb.onStatus?.('Uploading');
    const fields: Record<string, string> = k2 ? {} : { path: job.folder.replace(/^\/+|\/+$/g, '') };
    expectOk(await c.send({ method: 'POST', url: c.url(`upload/${encodeURIComponent(name)}`), body: formFile(fields, 'file', job.file, name) },
      { onProgress: cb.onProgress, signal: cb.signal }), 'Upload failed');
    if (!job.print) return { message: 'Uploaded to the Creality printer.', printed: false, path: name };
    cb.onStatus?.('Starting print');
    const dir = k2 ? '/mnt/UDISK/printer_data/gcodes' : '/usr/data/printer_data/gcodes';
    try {
      const ws = await openWs(env, ctx.wsUrl || withPort(ctx.host, 9999, 'ws:'));
      const params: Record<string, unknown> = { opGcodeFile: `printprt:${dir}/${name}` };
      if (k2) params.enableSelfTest = 0;
      ws.send({ method: 'set', params });
      // K1 firmware closes the socket right after accepting; anything (or nothing) within 3 s is fine.
      await ws.next((m) => m, 3000).catch(() => undefined);
      ws.close();
    } catch (e) {
      const he = e instanceof HostError ? e : new HostError('network', String((e as Error)?.message ?? e));
      throw new HostError(he.kind, `The file was uploaded, but the print couldn’t be started: ${he.message} Start it from the printer’s screen.`, he.detail);
    }
    return { message: 'Uploaded to the Creality printer and started printing.', printed: true, path: `${dir}/${name}` };
  },
};

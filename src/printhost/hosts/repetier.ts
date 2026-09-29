/**
 * Repetier-Server — Repetier.cpp. X-Api-Key; `printhost_port` = printer slug.
 *   test:     GET  printer/info  → { name, software: "Repetier-Server" }
 *   printers: GET  printer/list  → { data: [{ slug }] }
 *   upload:   POST printer/model/<slug>  (upload only)  multipart: a=upload, [group], filename=<file>
 *             POST printer/job/<slug>    (print)        + name=<file>, autostart=true
 */
import { HostError, type HostContext, type HostEnv, type PrintHostDriver } from '../types';
import { client, expectOk, formFile, tryJson, headerIf } from '../util';

const mk = (ctx: HostContext, env: HostEnv) => client(ctx, env, () => headerIf('X-Api-Key', ctx.apiKey));

async function listPrinters(ctx: HostContext, env: HostEnv): Promise<string[]> {
  const c = mk(ctx, env);
  const r = expectOk(await c.send({ method: 'GET', url: c.url('printer/list') }), 'Repetier didn’t list its printers');
  const j = tryJson<{ error?: string; data?: Array<{ slug?: string }> }>(r.text);
  if (!j) throw new HostError('protocol', 'Parsing of host response failed.');
  if (j.error) throw new HostError('http', j.error);
  return (j.data ?? []).map((d) => d.slug ?? '').filter(Boolean);
}

export const repetier: PrintHostDriver = {
  listPrinters,
  async test(ctx, env, signal) {
    const c = mk(ctx, env);
    const r = expectOk(await c.send({ method: 'GET', url: c.url('printer/info') }, { signal }), 'Repetier didn’t accept the request');
    const j = tryJson<{ name?: string; software?: string; version?: string }>(r.text);
    if (!j) throw new HostError('protocol', 'Could not parse the Repetier server response.');
    // "name" can be rebranded; newer servers send an invariant "software".
    const ok = j.software ? j.software === 'Repetier-Server' : j.name ? j.name.startsWith('Repetier') : true;
    if (!ok) throw new HostError('protocol', `Mismatched type of print host: ${j.software ?? j.name ?? 'Repetier'}`);
    return { message: 'Connection to Repetier is working correctly.', detail: [j.name, j.version].filter(Boolean).join(' ') || undefined };
  },
  async upload(ctx, job, env, cb = {}) {
    const c = mk(ctx, env);
    let slug = ctx.printer.trim();
    if (!slug) {
      cb.onStatus?.('Finding printer');
      const list = await listPrinters(ctx, env);
      if (list.length !== 1) throw new HostError('config', list.length ? `Repetier has ${list.length} printers. Pick one in the physical printer settings.` : 'Repetier reports no printers.');
      slug = list[0];
    }
    cb.onStatus?.('Uploading');
    const fields: Record<string, string> = {};
    const group = job.folder.trim();
    if (group && group !== 'Default') fields.group = group;
    if (job.print) { fields.name = job.filename; fields.autostart = 'true'; }
    fields.a = 'upload';
    const path = `printer/${job.print ? 'job' : 'model'}/${encodeURIComponent(slug)}`;
    expectOk(await c.send({ method: 'POST', url: c.url(path), body: formFile(fields, 'filename', job.file, job.filename) }, { onProgress: cb.onProgress, signal: cb.signal }), 'Upload failed');
    return { message: job.print ? `Uploaded to Repetier (${slug}) and started printing.` : `Uploaded to Repetier (${slug}).`, printed: job.print };
  },
};

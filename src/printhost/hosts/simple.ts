/**
 * Small SD-card style hosts: ESP3D, FlashAir, MKS.
 *
 * ESP3D — ESP3D.cpp
 *   test:   GET  command?plain=M105
 *   upload: POST upload_serial  multipart: file (8.3 name — longer names crash Marlin)
 *   print:  wait 1.5 s, GET command?plain=M23 <name>, GET command?plain=M24
 * FlashAir — FlashAir.cpp (upload only)
 *   test:   GET  command.cgi?op=118 → "1" when upload is enabled
 *   upload: GET  upload.cgi?WRITEPROTECT=ON&FTIME=<fat time>, GET upload.cgi?UPDIR=/<folder>, POST upload.cgi multipart: file
 * MKS — MKS.cpp. Upload is HTTP; Orca's test and start-print go over a raw TCP
 * console (port 8080), which browsers can't open → upload only, reachability test.
 *   upload: POST upload?X-Filename=<name>  body = G-code → { err: 0 }
 */
import { HostError, type PrintHostDriver } from '../types';
import { client, expectOk, formFile, is2xx, throwIfAborted, tryJson } from '../util';

/** ESP3D only accepts 8.3 file names (Orca ESP3D::get_short_name). */
export function shortName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).slice(0, 8);
  const ext = (dot > 0 ? base.slice(dot + 1) : '').slice(0, 3);
  return ext ? `${stem}.${ext}` : stem;
}

export const esp3d: PrintHostDriver = {
  async test(ctx, env, signal) {
    const c = client(ctx, env);
    expectOk(await c.send({ method: 'GET', url: c.url('command?plain=M105') }, { signal }), 'ESP3D didn’t accept the request');
    return { message: 'Connection to ESP3D is working correctly.' };
  },
  async upload(ctx, job, env, cb = {}) {
    const c = client(ctx, env);
    const name = shortName(job.filename);
    cb.onStatus?.('Uploading');
    expectOk(await c.send({ method: 'POST', url: c.url('upload_serial'), body: formFile({}, 'file', job.file, name) }, { onProgress: cb.onProgress, signal: cb.signal }), 'Upload failed');
    if (!job.print) return { message: `Uploaded to ESP3D as ${name}.`, printed: false, path: name };
    throwIfAborted(cb.signal);
    cb.onStatus?.('Starting print');
    // The firmware ignores G-code right after an SD transfer.
    await env.sleep(1500);
    expectOk(await c.send({ method: 'GET', url: c.url(`command?plain=${encodeURIComponent(`M23 ${name}`)}`) }), 'Uploaded, but selecting the file failed');
    expectOk(await c.send({ method: 'GET', url: c.url('command?plain=M24') }), 'Uploaded, but starting the print failed');
    return { message: `Uploaded to ESP3D as ${name} and started printing.`, printed: true, path: name };
  },
};

/** FAT timestamp as "0x…" (Orca FlashAir::timestamp_str). */
export function fatTime(d = new Date()): string {
  const v = (((d.getFullYear() - 1980) << 25) | ((d.getMonth() + 1) << 21) | (d.getDate() << 16) | (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) >>> 0;
  return `0x${v.toString(16)}`;
}

export const flashair: PrintHostDriver = {
  async test(ctx, env, signal) {
    const c = client(ctx, env);
    const r = expectOk(await c.send({ method: 'GET', url: c.url('command.cgi?op=118') }, { signal }), 'FlashAir didn’t accept the request');
    if (!r.text.startsWith('1')) throw new HostError('config', 'Upload not enabled on FlashAir card. FlashAir firmware 2.00.02 or newer with UPLOAD=1 in CONFIG is required.');
    return { message: 'Connection to FlashAir is working correctly and upload is enabled.' };
  },
  async upload(ctx, job, env, cb = {}) {
    await flashair.test(ctx, env, cb.signal);
    const c = client(ctx, env);
    const dir = `/${job.folder.trim().replace(/^\/+|\/+$/g, '')}`;
    cb.onStatus?.('Preparing card');
    expectOk(await c.send({ method: 'GET', url: c.url(`upload.cgi?WRITEPROTECT=ON&FTIME=${fatTime()}`) }), 'Preparing the card failed');
    expectOk(await c.send({ method: 'GET', url: c.url(`upload.cgi?UPDIR=${encodeURIComponent(dir)}`) }), 'Setting the upload folder failed');
    cb.onStatus?.('Uploading');
    const r = expectOk(await c.send({ method: 'POST', url: c.url('upload.cgi'), body: formFile({}, 'file', job.file, job.filename) }, { onProgress: cb.onProgress, signal: cb.signal }), 'Upload failed');
    if (/error/i.test(r.text) && !/success/i.test(r.text)) throw new HostError('http', 'FlashAir reported an upload error.', r.text);
    return { message: 'Uploaded to FlashAir.', printed: false, path: `${dir === '/' ? '' : dir}/${job.filename}` };
  },
};

export const mks: PrintHostDriver = {
  async test(ctx, env, signal) {
    const c = client(ctx, env);
    // Orca tests over the TCP console; the best a browser can do is an HTTP round trip.
    const r = await c.send({ method: 'GET', url: c.url('') }, { signal });
    return { message: `The MKS board answered over HTTP (status ${r.status}).`, detail: 'Starting prints needs the MKS TCP console (port 8080), which browsers can’t open — uploads only.' };
  },
  async upload(ctx, job, env, cb = {}) {
    if (job.print) throw new HostError('unsupported', 'MKS starts prints over a raw TCP console, which a browser can’t open. Upload the file, then start it on the printer.');
    const c = client(ctx, env);
    cb.onStatus?.('Uploading');
    const r = await c.send({ method: 'POST', url: c.url(`upload?X-Filename=${encodeURIComponent(job.filename)}`), headers: { 'Content-Type': 'application/octet-stream' }, body: job.file },
      { onProgress: cb.onProgress, signal: cb.signal });
    expectOk(r, 'Upload failed');
    const j = tryJson<{ err?: number }>(r.text);
    if (j && (j.err ?? 0) !== 0 && is2xx(r)) throw new HostError('http', 'Upload failed: the board reported an error.', r.text);
    return { message: 'Uploaded to the MKS board.', printed: false, path: job.filename };
  },
};

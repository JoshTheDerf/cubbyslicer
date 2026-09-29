/**
 * Elegoo Link — ElegooLink.cpp. The printer model (Orca `printer_model` of the
 * bound preset) picks the protocol:
 *
 *  Centauri Carbon (CC, SDCP):
 *    test:   GET / → page mentioning "ELEGOO"
 *    upload: POST uploadFile/upload, 1 MiB chunks, multipart:
 *            Check=1, S-File-MD5=<md5 of whole file>, Offset, Uuid, TotalSize, File=<chunk>
 *            → { code: "000000" }
 *    print:  WebSocket ws://<host>:3030/websocket (SDCP):
 *            Cmd 0 (status) until CurrentStatus no longer contains 8 (file check), then
 *            Cmd 128 { Filename: "/local/<name>", StartLayer 0, Calibration_switch, PrintPlatformType, Tlp_Switch }
 *            → { Data: { Cmd: 128, Data: { Ack: 0 } } }
 *  Centauri Carbon 2 (CC2): upload only (Orca offers no post-upload action)
 *    test:   GET system/info?X-Token=<code>  (X-Token header; default code 123456) → { error_code: 0 }
 *    upload: PUT upload, 1 MiB chunks, body = bytes, headers Content-Range, X-File-Name, X-File-MD5, X-Token
 *  Other Elegoo printers (OctoPrint-compatible firmware): OctoPrint API.
 */
import { md5Blob } from '../md5';
import { HostError, type HostContext, type HostEnv, type PrintHostDriver, type UploadCallbacks, type UploadJob } from '../types';
import { withPort } from '../url';
import { client, expectOk, formFile, openWs, throwIfAborted, tryJson } from '../util';
import { octoprint } from './octoprint';

export const CHUNK = 1024 * 1024;
const CC2_DEFAULT_TOKEN = '123456';

export type ElegooKind = 'cc' | 'cc2' | 'other';
export function elegooKind(model: string | undefined, variant?: string): ElegooKind {
  if (variant === 'cc' || variant === 'cc2' || variant === 'other') return variant;
  const m = (model ?? '').trim();
  if (!m.startsWith('Elegoo Centauri')) return 'other';
  return m.endsWith('2') ? 'cc2' : 'cc';
}

const SDCP_ACK: Record<number, string> = {
  1: 'The printer is busy. Check the device page for the file and start printing from there.',
  2: 'The file is lost, please check and try again.',
  3: 'The file is corrupted, please check and try again.',
  4: 'Transmission abnormality, please check and try again.',
  5: 'Transmission abnormality, please check and try again.',
  6: 'Transmission abnormality, please check and try again.',
  7: 'The file does not match the printer, please check and try again.',
};

function sdcp(env: HostEnv, cmd: number, data: Record<string, unknown>) {
  return { Id: '', Data: { Cmd: cmd, Data: data, RequestID: env.uuid().replace(/-/g, ''), MainboardID: '', TimeStamp: env.now(), From: 1 } };
}

async function ccStartPrint(ctx: HostContext, env: HostEnv, filename: string): Promise<void> {
  const ws = await openWs(env, ctx.wsUrl || `${withPort(ctx.host, 3030, 'ws:')}websocket`);
  try {
    // Wait while the printer is still checking the uploaded file (status 8).
    const t0 = env.now();
    for (;;) {
      ws.send(sdcp(env, 0, {}));
      const status = await ws.next((m) => {
        const s = (m as { Status?: { CurrentStatus?: number[] | number } })?.Status;
        return s ? ([] as number[]).concat(s.CurrentStatus ?? []) : undefined;
      }, 10_000).catch(() => [] as number[]);
      if (!status.includes(8)) break;
      if (env.now() - t0 > 60_000) throw new HostError('timeout', 'Start print timeout.');
      await env.sleep(1000);
    }
    ws.send(sdcp(env, 128, { Filename: `/local/${filename}`, StartLayer: 0, Calibration_switch: 0, PrintPlatformType: 0, Tlp_Switch: 0 }));
    const ack = await ws.next((m) => {
      const d = (m as { Data?: { Cmd?: number; Data?: { Ack?: number } } })?.Data;
      return d?.Cmd === 128 ? (d.Data?.Ack ?? -1) : undefined;
    }, 30_000).catch((e: HostError) => { throw e.kind === 'timeout' ? new HostError('timeout', 'Start print timeout.') : e; });
    if (ack !== 0) throw new HostError('http', `${SDCP_ACK[ack] ?? 'Unknown error.'} Error code: ${ack}`);
  } finally {
    ws.close();
  }
}

async function uploadCc(ctx: HostContext, job: UploadJob, env: HostEnv, cb: UploadCallbacks): Promise<void> {
  const c = client(ctx, env);
  cb.onStatus?.('Checksumming');
  const md5 = await md5Blob(job.file);
  const uuid = env.uuid().replace(/-/g, '');
  const size = job.file.size;
  cb.onStatus?.('Uploading');
  for (let off = 0; off < size || (size === 0 && off === 0); off += CHUNK) {
    throwIfAborted(cb.signal);
    const part = job.file.slice(off, Math.min(size, off + CHUNK));
    const body = formFile({ Check: '1', 'S-File-MD5': md5, Offset: String(off), Uuid: uuid, TotalSize: String(size) }, 'File', part, job.filename);
    const r = expectOk(await c.send({ method: 'POST', url: c.url('uploadFile/upload'), headers: { Accept: 'application/json, text/plain, */*' }, body },
      { onProgress: (l) => cb.onProgress?.(Math.min(size, off + l), size), signal: cb.signal }), 'Upload failed');
    const j = tryJson<{ code?: string; messages?: Array<{ field?: string; message?: string }> }>(r.text);
    if (!j) throw new HostError('protocol', 'Error parsing response.');
    if (j.code !== '000000') throw new HostError('http', `Error code: ${j.code}`, (j.messages ?? []).map((m) => `${m.field}: ${m.message}`).join('\n') || undefined);
    if (size === 0) break;
  }
}

async function uploadCc2(ctx: HostContext, job: UploadJob, env: HostEnv, cb: UploadCallbacks): Promise<void> {
  const c = client(ctx, env);
  const token = ctx.apiKey || CC2_DEFAULT_TOKEN;
  cb.onStatus?.('Checksumming');
  const md5 = (await md5Blob(job.file)).toLowerCase();
  const size = job.file.size;
  if (!size) throw new HostError('config', 'The file is empty.');
  cb.onStatus?.('Uploading');
  for (let off = 0; off < size; off += CHUNK) {
    throwIfAborted(cb.signal);
    const part = job.file.slice(off, Math.min(size, off + CHUNK));
    const headers = {
      Accept: 'application/json', 'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${off}-${off + part.size - 1}/${size}`, 'X-File-Name': job.filename, 'X-File-MD5': md5, 'X-Token': token,
    };
    const r = await c.send({ method: 'PUT', url: c.url('upload'), headers, body: part }, { onProgress: (l) => cb.onProgress?.(Math.min(size, off + l), size), signal: cb.signal });
    if (r.status === 401 || r.status === 403) throw new HostError('auth', 'Invalid access code.', undefined, r.status);
    expectOk(r, 'CC2 upload failed');
    checkCc2(r.text);
  }
}

function checkCc2(text: string): { system_info?: { sn?: string; model?: string } } {
  const j = tryJson<{ error_code?: number; message?: string; system_info?: { sn?: string; model?: string } }>(text);
  if (!j) throw new HostError('protocol', 'Error parsing response.');
  if (j.error_code !== 0) throw new HostError('http', `${j.message || 'Printer returned an error'} (${j.error_code ?? -1})`);
  return j;
}

export const elegoolink: PrintHostDriver = {
  async test(ctx, env, signal) {
    const kind = elegooKind(ctx.printerModel, ctx.variant);
    if (kind === 'other') return octoprint.test(ctx, env, signal);
    const c = client(ctx, env);
    if (kind === 'cc2') {
      const token = ctx.apiKey || CC2_DEFAULT_TOKEN;
      const r = await c.send({ method: 'GET', url: c.url(`system/info?X-Token=${encodeURIComponent(token)}`), headers: { 'X-Token': token, Accept: 'application/json' } }, { signal });
      if (r.status === 401 || r.status === 403) throw new HostError('auth', 'Invalid access code.', undefined, r.status);
      expectOk(r, 'The printer didn’t accept the request');
      const j = checkCc2(r.text);
      return { message: 'Connection to Elegoo Link is working correctly.', detail: j.system_info?.sn ? `Serial ${j.system_info.sn}` : undefined };
    }
    const r = expectOk(await c.send({ method: 'GET', url: c.url('') }, { signal }), 'The printer didn’t accept the request');
    if (!/elegoo/i.test(r.text)) throw new HostError('protocol', 'ElegooLink not detected.');
    return { message: 'Connection to Elegoo Link is working correctly.' };
  },
  async upload(ctx, job, env, cb = {}) {
    const kind = elegooKind(ctx.printerModel, ctx.variant);
    if (kind === 'other') return octoprint.upload(ctx, job, env, cb);
    if (kind === 'cc2') {
      if (job.print) throw new HostError('unsupported', 'Centauri Carbon 2 uploads can’t start the print remotely. Upload, then start it on the printer.');
      await uploadCc2(ctx, job, env, cb);
      return { message: 'Uploaded to the Centauri Carbon 2.', printed: false, path: job.filename };
    }
    await uploadCc(ctx, job, env, cb);
    if (!job.print) return { message: 'Uploaded to the printer.', printed: false, path: `/local/${job.filename}` };
    cb.onStatus?.('Starting print');
    try {
      await env.sleep(1000);
      await ccStartPrint(ctx, env, job.filename);
    } catch (e) {
      const he = e instanceof HostError ? e : new HostError('network', String((e as Error)?.message ?? e));
      throw new HostError(he.kind, `The file was uploaded, but the print couldn’t be started: ${he.message} Start it from the printer’s screen.`, he.detail);
    }
    return { message: 'Uploaded and started printing.', printed: true, path: `/local/${job.filename}` };
  },
};

/**
 * Flashforge local HTTP API (Adventurer 5M / 5M Pro / AD5X…) — Flashforge.cpp.
 * Needs the printer's serial number + check (access) code. Older Flashforge
 * printers only speak a raw TCP G-code console on port 8899, which browsers
 * can't open — those are not supported here.
 *   test:   POST http://<host>:8898/detail        { serialNumber, checkCode } → { code: 0 }
 *   upload: POST http://<host>:8898/uploadGcode   multipart: gcodeFile
 *           headers serialNumber, checkCode, fileSize, printNow, levelingBeforePrint, flowCalibration,
 *                   firstLayerInspection, timeLapseVideo, useMatlStation, gcodeToolCnt, materialMappings (base64 JSON)
 */
import { HostError, type HostContext, type HostEnv, type HostResponse, type PrintHostDriver } from '../types';
import { parseHost, withPort } from '../url';
import { expectOk, formFile, tryJson } from '../util';

export function flashforgeFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() || 'print.gcode');
  return base.replace(/[^A-Za-z0-9._-]/g, '_');
}

function check(r: HostResponse, what: string): void {
  expectOk(r, what);
  const j = tryJson<{ code?: number | string; err?: number | string; message?: string; msg?: string }>(r.text);
  if (!j || typeof j !== 'object') throw new HostError('protocol', 'Flashforge returned an invalid JSON response.');
  const code = Number(j.code ?? j.err ?? 0);
  if (code !== 0) throw new HostError('http', `${what}: ${j.message ?? j.msg ?? `code ${code}`}`);
}

function base(ctx: HostContext): string {
  parseHost(ctx.host); // validates
  return withPort(ctx.host, 8898, 'http:');
}

function need(ctx: HostContext): void {
  if (!ctx.serial.trim() || !ctx.apiKey.trim()) throw new HostError('config', 'The Flashforge local API needs both the serial number and the access (check) code.');
}

export const flashforge: PrintHostDriver = {
  async test(ctx, env: HostEnv, signal) {
    need(ctx);
    const r = await env.http({ method: 'POST', url: `${base(ctx)}detail`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serialNumber: ctx.serial, checkCode: ctx.apiKey }) }, { signal });
    check(r, 'Flashforge rejected the request');
    return { message: 'Connection to Flashforge is working correctly.' };
  },
  async upload(ctx, job, env, cb = {}) {
    need(ctx);
    const name = flashforgeFilename(job.filename);
    cb.onStatus?.('Uploading');
    const headers = {
      serialNumber: ctx.serial, checkCode: ctx.apiKey, fileSize: String(job.file.size), printNow: job.print ? 'true' : 'false',
      levelingBeforePrint: 'false', flowCalibration: 'false', firstLayerInspection: 'false', timeLapseVideo: 'false', useMatlStation: 'false',
      gcodeToolCnt: '0', materialMappings: btoa('[]'),
    };
    const r = await env.http({ method: 'POST', url: `${base(ctx)}uploadGcode`, headers, body: formFile({}, 'gcodeFile', job.file, name) }, { onProgress: cb.onProgress, signal: cb.signal });
    check(r, 'Upload failed');
    return { message: job.print ? 'Uploaded to Flashforge and started printing.' : 'Uploaded to Flashforge.', printed: job.print, path: name };
  },
};

/**
 * OctoPrint (Orca "Octo/Klipper") and AstroBox — OctoPrint.cpp / AstroBox.cpp.
 *   test:   GET  api/version            (X-Api-Key) → { api, server, text: "OctoPrint 1.x" }
 *   upload: POST api/files/local        multipart: print=true|false, path=<folder>, file
 */
import { HostError, type HostContext, type HostEnv, type PrintHostDriver, type UploadJob, type UploadCallbacks } from '../types';
import { client, expectOk, formFile, tryJson, headerIf } from '../util';

export function octoLikeDriver(name: string, validate: (text: string | undefined) => boolean): PrintHostDriver {
  const mk = (ctx: HostContext, env: HostEnv) => client(ctx, env, () => headerIf('X-Api-Key', ctx.apiKey));
  return {
    async test(ctx, env, signal) {
      const c = mk(ctx, env);
      const r = expectOk(await c.send({ method: 'GET', url: c.url('api/version') }, { signal }), `${name} didn’t accept the request`);
      const j = tryJson<{ api?: string; text?: string; server?: string }>(r.text);
      if (!j) throw new HostError('protocol', `Could not parse the ${name} server response.`);
      if (!j.api) throw new HostError('protocol', `The host answered, but it doesn’t look like ${name} (no “api” in api/version).`);
      if (!validate(j.text)) throw new HostError('protocol', `Mismatched type of print host: ${j.text ?? name}`);
      return { message: `Connection to ${name} is working correctly.`, detail: [j.text, j.api && `API ${j.api}`].filter(Boolean).join(' · ') };
    },
    async upload(ctx, job: UploadJob, env, cb: UploadCallbacks = {}) {
      const c = mk(ctx, env);
      cb.onStatus?.('Uploading');
      const body = formFile({ print: job.print ? 'true' : 'false', path: job.folder.replace(/^\/+|\/+$/g, '') }, 'file', job.file, job.filename);
      const r = expectOk(await c.send({ method: 'POST', url: c.url('api/files/local'), body }, { onProgress: cb.onProgress, signal: cb.signal }), 'Upload failed');
      const j = tryJson<{ files?: { local?: { path?: string } } }>(r.text);
      return { message: job.print ? `Uploaded to ${name} and started printing.` : `Uploaded to ${name}.`, printed: job.print, path: j?.files?.local?.path };
    },
  };
}

export const octoprint = octoLikeDriver('OctoPrint', (t) => (t ? t.startsWith('OctoPrint') : true));
export const astrobox = octoLikeDriver('AstroBox', (t) => (t ? t.startsWith('AstroBox') : true));

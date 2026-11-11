/**
 * Moonraker (Klipper) — Orca 2.5 Moonraker.cpp, plus the Qidi Box slot
 * mapping of QidiPrinterAgent. API key optional (X-Api-Key).
 *   test:   GET  server/info           → { result: { klippy_state } }
 *   upload: POST server/files/upload   multipart: root=gcodes, path=<folder>, print=true|false, file
 *           → { item: { path }, print_started, print_queued } (a bare object, no "result" envelope)
 *   print:  only when Moonraker neither started nor queued it:
 *           POST printer/print/start   { filename: <item.path> }
 *   Qidi Box: POST printer/gcode/script { script: SAVE_VARIABLE value_t<n>='slot<k>' … } before the start
 *   lanes:  GET  server/database/item?namespace=lane_data, else printer/objects/query?mmu (Happy Hare),
 *           else printer/objects/query?box (Creality CFS); Qidi: the Box query + its filament
 *           dictionary (filament sync, see filamentSync.ts)
 */
import { HostError, type PrintHostDriver, type HostContext, type HostEnv } from '../types';
import { client, expectOk, formFile, throwIfAborted, tryJson, headerIf } from '../util';

const mk = (ctx: HostContext, env: HostEnv) => client(ctx, env, () => headerIf('X-Api-Key', ctx.apiKey));

/** Qidi Box: the firmware has value_t0…value_t15 and slots 0…15. */
const QIDI_SLOTS = 16;

/**
 * QidiPrinterAgent::build_tool_slot_script: one SAVE_VARIABLE per filament
 * with a chosen slot, so each T<n> macro loads that Box slot. SAVE_VARIABLE
 * reads VALUE as a Python literal, so the slot name keeps its own quotes.
 */
export function qidiToolSlotScript(mapping: readonly number[]): string {
  const lines: string[] = [];
  for (let f = 0; f < mapping.length && f < QIDI_SLOTS; f++) {
    const slot = mapping[f];
    if (!Number.isInteger(slot) || slot < 0 || slot >= QIDI_SLOTS) continue;
    lines.push(`SAVE_VARIABLE VARIABLE=value_t${f} VALUE="'slot${slot}'"`);
  }
  return lines.join('\n');
}

/** Qidi printers (Orca picks the Qidi printer agent by vendor) take a Box slot mapping at print start. */
export function isQidi(printerModel: string | undefined): boolean { return /qidi/i.test(printerModel ?? ''); }

interface UploadReply {
  item?: { path?: string }; print_started?: boolean; print_queued?: boolean;
  result?: { item?: { path?: string }; print_started?: boolean; print_queued?: boolean };
}

/** Raw `lane_data` namespace of Moonraker's database, or null when the printer has none. */
export async function fetchLaneData(ctx: HostContext, env: HostEnv, signal?: AbortSignal): Promise<unknown> {
  const c = mk(ctx, env);
  const r = await c.send({ method: 'GET', url: c.url('server/database/item?namespace=lane_data'), timeoutMs: 10_000 }, { signal });
  if (r.status === 404) return null;
  return tryJson(expectOk(r, 'Reading the printer’s filament lanes failed').text);
}

/**
 * A GET whose failure (any non-2xx) means "not there" for the filament-sync fallbacks, as Orca's
 * agent treats it: Klipper objects (`printer/objects/query?…`), Moonraker's `server/info`, a config file.
 */
export async function moonrakerGet(ctx: HostContext, env: HostEnv, path: string, signal?: AbortSignal): Promise<string | null> {
  const c = mk(ctx, env);
  const r = await c.send({ method: 'GET', url: c.url(path), timeoutMs: 10_000 }, { signal });
  return r.status >= 200 && r.status < 300 ? r.text : null;
}

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
    const script = job.print && job.slotMapping ? qidiToolSlotScript(job.slotMapping) : '';
    // With a slot mapping the slots must be saved before the print starts, so start it ourselves.
    const serverStart = job.print && !script;
    cb.onStatus?.('Uploading');
    const fields: Record<string, string> = { root: 'gcodes' };
    const folder = job.folder.replace(/^\/+|\/+$/g, '');
    if (folder) fields.path = folder;
    fields.print = serverStart ? 'true' : 'false';
    const r = expectOk(await c.send({ method: 'POST', url: c.url('server/files/upload'), body: formFile(fields, 'file', job.file, job.filename) },
      { onProgress: cb.onProgress, signal: cb.signal }), 'Upload failed');
    const j = tryJson<UploadReply>(r.text);
    // Moonraker confirms the storage-relative path (it may rename on collision).
    const path = j?.item?.path ?? j?.result?.item?.path ?? (folder ? `${folder}/${job.filename}` : job.filename);
    if (!job.print) return { message: 'Uploaded to Moonraker.', printed: false, path };
    // print_started: printing now; print_queued: in Moonraker's job queue (e.g. it powers the printer on first).
    const queued = !!(j?.print_queued ?? j?.result?.print_queued);
    if (serverStart && (j?.print_started || j?.result?.print_started || queued)) {
      return { message: queued ? 'Uploaded to Moonraker; the print is queued.' : 'Uploaded to Moonraker and started printing.', printed: true, path };
    }
    throwIfAborted(cb.signal);
    if (script) {
      cb.onStatus?.('Setting Box slots');
      expectOk(await c.send({ method: 'POST', url: c.url('printer/gcode/script'), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script }) }),
        'Uploaded, but setting the Qidi Box slots failed');
    }
    cb.onStatus?.('Starting print');
    expectOk(await c.send({ method: 'POST', url: c.url('printer/print/start'), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: path }) }),
      'Uploaded, but starting the print failed');
    return { message: 'Uploaded to Moonraker and started printing.', printed: true, path };
  },
};

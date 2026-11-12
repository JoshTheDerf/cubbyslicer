/**
 * Creality Print (K1 / K2 family) — Orca 2.5 CrealityPrint.cpp and its send dialog.
 *   test:   GET  info   (Authorization: Bearer <key> when set) → { model: "F008" … }
 *   upload: POST upload/<name>  multipart: [path=<folder>] (not on CFS-capable models), file   (spaces → _)
 *   slots:  WebSocket ws://<host>:9999/  { method: "get", params: { boxsInfo: 1 } } → { boxsInfo: { materialBoxs: [...] } }
 *           (a status with cfsConnect: 0 means no CFS: the print uses the external spool)
 *           The same reply feeds "Sync filaments from printer" (CrealityPrintAgent, filamentSync.ts).
 *   print:  same socket. Plain: { method: "set", params: { opGcodeFile: "printprt:<path>"[, enableSelfTest] } }
 *           CFS mapping: { method: "set", params: { colorMatch: { path, list: [{ id, type, color, boxId, materialId }] } } }
 *           then { method: "set", params: { multiColorPrint: { gcode: <path>, enableSelfTest } } }
 *           <path> = /usr/data/printer_data/gcodes/<name> (K1 family) or /mnt/UDISK/printer_data/gcodes/<name>
 */
import { HostError, type CfsSlot, type HostContext, type HostEnv, type PrintHostDriver } from '../types';
import { withPort } from '../url';
import { client, expectOk, formFile, openWs, tryJson, headerIf } from '../util';

/** cfs_capable_models: CFS-capable model ids and their names. */
export const CFS_MODELS: Record<string, string> = {
  F008: 'K2 Plus', F012: 'K2 Pro', F016: 'K2 SE', F021: 'K2', F022: 'SPARKX i7',
  K1: 'K1', 'K1 Max': 'K1 Max', 'K1 Max_CFS-C': 'K1 Max_CFS-C', 'K1 SE': 'K1 SE', 'K1 SE_CFS-C': 'K1 SE_CFS-C', K1C: 'K1C', 'K1C_CFS-C': 'K1C_CFS-C', 'K1_CFS-C': 'K1_CFS-C',
};
const K1_FAMILY = new Set(['K1', 'K1 Max', 'K1 Max_CFS-C', 'K1 SE', 'K1 SE_CFS-C', 'K1C', 'K1C_CFS-C', 'K1_CFS-C']);
export const crealityMultiColour = (model: string | undefined) => !!model && model in CFS_MODELS;
export const crealityGcodeDir = (model: string | undefined) => `${model && K1_FAMILY.has(model) ? '/usr/data' : '/mnt/UDISK'}/printer_data/gcodes`;
export const crealitySafeName = (name: string) => name.replace(/ /g, '_');

const mk = (ctx: HostContext, env: HostEnv) => client(ctx, env, () => headerIf('Authorization', ctx.apiKey, 'Bearer '));
const wsUrl = (ctx: HostContext) => ctx.wsUrl || withPort(ctx.host, 9999, 'ws:');

export async function crealityInfo(ctx: HostContext, env: HostEnv, signal?: AbortSignal): Promise<{ model?: string }> {
  const c = mk(ctx, env);
  const r = expectOk(await c.send({ method: 'GET', url: c.url('info'), timeoutMs: 5000 }, { signal }), 'The printer didn’t accept the request');
  return tryJson<{ model?: string }>(r.text) ?? {};
}

/**
 * The send dialog's slot list from a `boxsInfo` reply: CFS boxes (type 0) only when active
 * (state 1), the spool holder (type 1) always; tool id "T<box><A+slot>"; "#0RRGGBB" → "#RRGGBB".
 */
export function parseCfsSlots(reply: unknown): CfsSlot[] {
  const boxes = (reply as { boxsInfo?: { materialBoxs?: unknown } } | null)?.boxsInfo?.materialBoxs;
  if (!Array.isArray(boxes)) return [];
  const out: CfsSlot[] = [];
  for (const b of boxes as Array<Record<string, unknown>>) {
    if (!b || typeof b.id !== 'number') continue;
    if ((b.type ?? 0) === 0 && (b.state ?? 0) !== 1) continue;
    for (const m of Array.isArray(b.materials) ? (b.materials as Array<Record<string, unknown>>) : []) {
      if (!m || typeof m.id !== 'number') continue;
      let colour = typeof m.color === 'string' ? m.color : '#FFFFFF';
      if (colour.length === 8 && colour[0] === '#') colour = `#${colour.slice(2)}`;
      out.push({ toolId: `T${b.id}${String.fromCharCode(65 + m.id)}`, type: typeof m.type === 'string' ? m.type : '', colour, boxId: b.id, materialId: m.id });
    }
  }
  return out;
}

/**
 * The dialog's default slot for each filament: CFS same type and colour, CFS same type, spool
 * holder same type and colour, spool holder same type, else the slot at the filament's position.
 */
export function defaultCfsMapping(filaments: ReadonlyArray<{ type: string; colour: string }>, slots: readonly CfsSlot[]): number[] {
  const hex = (c: string) => c.replace(/^#/, '').slice(0, 6).toUpperCase();
  return filaments.map((f, i) => {
    for (let pass = 0; pass < 4; pass++) {
      const s = slots.findIndex((x) => {
        const ext = x.boxId === 0, type = x.type === f.type, colour = hex(x.colour) === hex(f.colour);
        return pass === 0 ? !ext && type && colour : pass === 1 ? !ext && type : pass === 2 ? ext && type && colour : ext && type;
      });
      if (s >= 0) return s;
    }
    return i < slots.length ? i : 0;
  });
}

/**
 * start_print_commands: a mapping onto CFS slots starts a multi-colour job (colorMatch, then
 * multiColorPrint). No mapping, or one using the spool holder, starts a plain print — an empty
 * colorMatch makes the firmware report "no material". The colorMatch id is the G-code tool
 * (T1A for the first filament …), not the slot: the firmware matches by tool.
 */
export function crealityStartCommands(multiColour: boolean, path: string, cfs?: { mapping: CfsSlot[]; selfTest: boolean }): unknown[] {
  const selfTest = multiColour && cfs?.selfTest ? 1 : 0;
  const list = multiColour ? (cfs?.mapping ?? []).map((s, i) => ({ id: `T1${String.fromCharCode(65 + i)}`, type: s.type, color: s.colour, boxId: s.boxId, materialId: s.materialId })) : [];
  if (list.length && !list.some((x) => x.boxId === 0)) {
    return [
      { method: 'set', params: { colorMatch: { path, list } } },
      { method: 'set', params: { multiColorPrint: { gcode: path, enableSelfTest: selfTest } } },
    ];
  }
  return [{ method: 'set', params: { opGcodeFile: `printprt:${path}`, ...(multiColour ? { enableSelfTest: selfTest } : {}) } }];
}

/**
 * CrealityPrint::query_boxes_info: the `boxsInfo` reply, or null (with `noCfs` when a status says no
 * CFS is connected, or nothing in time). Throws when the socket can't be opened.
 */
export async function crealityBoxes(ctx: HostContext, env: HostEnv, timeoutMs = 8000): Promise<{ reply: unknown; noCfs: boolean }> {
  const ws = await openWs(env, wsUrl(ctx));
  try {
    ws.send({ method: 'get', params: { boxsInfo: 1 } });
    return await ws.next((m) => {
      if (!m || typeof m !== 'object') return undefined;
      if ('boxsInfo' in m) return { reply: m, noCfs: false };
      if ((m as { cfsConnect?: unknown }).cfsConnect === 0) return { reply: null, noCfs: true };
      return undefined;
    }, timeoutMs).catch(() => ({ reply: null, noCfs: false }));
  } finally { ws.close(); }
}

/** The send dialog's slots from query_boxes_info, or none (with `noCfs` when a status says no CFS is connected). */
export async function crealitySlots(ctx: HostContext, env: HostEnv, timeoutMs = 8000): Promise<{ slots: CfsSlot[]; noCfs: boolean }> {
  const { reply, noCfs } = await crealityBoxes(ctx, env, timeoutMs);
  return { slots: reply ? parseCfsSlots(reply) : [], noCfs };
}

export const crealityprint: PrintHostDriver = {
  async test(ctx, env, signal) {
    const i = await crealityInfo(ctx, env, signal);
    return { message: 'Connected to CrealityPrint successfully!', detail: i.model ? `Model ${CFS_MODELS[i.model] ?? i.model}` : undefined };
  },
  async upload(ctx, job, env, cb = {}) {
    cb.onStatus?.('Connecting');
    const { model } = await crealityInfo(ctx, env, cb.signal);
    const multi = crealityMultiColour(model);
    const name = crealitySafeName(job.filename);
    const c = mk(ctx, env);
    cb.onStatus?.('Uploading');
    const fields: Record<string, string> = multi ? {} : { path: job.folder.replace(/^\/+|\/+$/g, '') };
    expectOk(await c.send({ method: 'POST', url: c.url(`upload/${encodeURIComponent(name)}`), body: formFile(fields, 'file', job.file, name) },
      { onProgress: cb.onProgress, signal: cb.signal }), 'Upload failed');
    if (!job.print) return { message: 'Uploaded to the Creality printer.', printed: false, path: name };
    cb.onStatus?.('Starting print');
    const path = `${crealityGcodeDir(model)}/${name}`;
    try {
      const ws = await openWs(env, wsUrl(ctx));
      const cmds = crealityStartCommands(multi, path, job.cfs);
      for (const m of cmds) ws.send(m);
      // A plain start: K1 firmware closes the socket right after accepting; anything (or nothing) within 3 s is fine.
      if (cmds.length === 1) await ws.next((m) => m, 3000).catch(() => undefined);
      ws.close();
    } catch (e) {
      const he = e instanceof HostError ? e : new HostError('network', String((e as Error)?.message ?? e));
      throw new HostError(he.kind, `The file was uploaded, but the print couldn’t be started: ${he.message} Start it from the printer’s screen.`, he.detail);
    }
    return { message: 'Uploaded to the Creality printer and started printing.', printed: true, path };
  },
};

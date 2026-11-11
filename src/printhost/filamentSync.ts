/**
 * "Sync filaments from printer" for Moonraker hosts (Orca 2.5
 * MoonrakerPrinterAgent::fetch_filament_info), in Orca's order:
 * 1. filament changers that publish their lanes in Moonraker's `lane_data`
 *    database namespace (AFC, recent Happy Hare). A lane's `filament_id` (a
 *    string; Happy Hare's numeric Spoolman id doesn't count) picks the preset
 *    with that id;
 * 2. Happy Hare's `mmu` printer object (`gate_status` / `gate_material` /
 *    `gate_color` / `gate_temperature`, gates with status > 0 and a material);
 * 3. a Creality CFS on a Creality Hi: the `box` printer object (T1…T4 boxes in
 *    state "connect", Creality material ids, `same_material` names for
 *    branded spools).
 * Qidi printers (QidiPrinterAgent) read the Box instead: `save_variables`
 * slot variables, the `multi_color_controller` names newer firmware writes,
 * the runout sensors, and the printer's `officiall_filas_list.cfg` dictionary.
 * Without a filament id, the material picks a generic preset of that type; the
 * slot colour becomes the filament colour.
 */
import { SCALAR, valueAt } from '../lib/configValue';
import { parseColour, toHex } from '../lib/colour';
import { currentPresets } from '../presets/store';
import { fetchLaneData, isQidi, moonrakerGet } from './hosts/moonraker';
import { boundPrinter, hostContext, physicalPrinter } from './store';
import { browserEnv } from './transport';
import { HostError, type PhysicalPrinterConfig } from './types';

export interface PrinterLane {
  /** 0-based tool / filament index. */
  index: number;
  /** `#RRGGBB` (or `#RRGGBBAA` when translucent); '' when the lane reports none. */
  colour: string;
  material: string;
  /** Orca filament_id (string ids only). */
  filamentId: string;
  nozzleTemp: number;
  bedTemp: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const int = (v: unknown) => { const n = typeof v === 'number' ? v : parseInt(str(v), 10); return Number.isFinite(n) ? Math.trunc(n) : 0; };

/** normalize_color_value: drop 0x / #, keep hex digits; 6 digits → opaque; anything else → ''. */
export function laneColour(raw: unknown): string {
  let v = str(raw).replace(/^0x/i, '').replace(/^#/, '').replace(/[^0-9a-f]/gi, '');
  if (v.length === 6) v += 'FF';
  const c = v.length === 8 ? parseColour(v) : null;
  return c ? toHex(c) : '';
}

/** `{ result: { namespace: "lane_data", value: { lane1: {...}, … } } }` → lanes with a tool index, by index. */
export function parseLaneData(json: unknown): PrinterLane[] {
  const value = (json as { result?: { value?: unknown } } | null)?.result?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const out: PrinterLane[] = [];
  for (const lane of Object.values(value as Record<string, unknown>)) {
    if (!lane || typeof lane !== 'object') continue;
    const o = lane as Record<string, unknown>;
    const idx = str(o.lane) === '' ? -1 : int(o.lane);
    if (idx < 0) continue;
    out.push({
      index: idx, colour: laneColour(o.color), material: str(o.material),
      filamentId: typeof o.filament_id === 'string' ? o.filament_id.trim() : '', nozzleTemp: int(o.nozzle_temp), bedTemp: int(o.bed_temp),
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

const status = (json: unknown) => (json as { result?: { status?: unknown } } | null)?.result?.status as Record<string, unknown> | undefined;
const at = (arr: unknown, i: number) => (Array.isArray(arr) ? arr[i] : undefined);
const parse = (text: string | null): unknown => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

/** fetch_hh_filament_info: `{ result: { status: { mmu: { num_gates, gate_status, gate_material, gate_color, gate_temperature } } } }`. */
export function parseHappyHare(json: unknown): PrinterLane[] {
  const mmu = status(json)?.mmu as Record<string, unknown> | undefined;
  if (!mmu || typeof mmu !== 'object' || Array.isArray(mmu) || typeof mmu.num_gates !== 'number' || mmu.num_gates <= 0) return [];
  const arr = (k: string) => (k in mmu ? mmu[k] : []);
  if (![arr('gate_status'), arr('gate_material'), arr('gate_color'), arr('gate_temperature')].every(Array.isArray)) return [];
  const out: PrinterLane[] = [];
  for (let g = 0; g < Math.trunc(mmu.num_gates); g++) {
    const st = at(mmu.gate_status, g);
    if (typeof st !== 'number' || st <= 0) continue; // -1 unknown, 0 empty
    const material = at(mmu.gate_material, g);
    if (typeof material !== 'string' || !material) continue;
    const colour = at(mmu.gate_color, g), temp = at(mmu.gate_temperature, g);
    out.push({ index: g, colour: laneColour(typeof colour === 'string' ? colour : ''), material, filamentId: '', nozzleTemp: typeof temp === 'number' ? Math.trunc(temp) : 0, bedTemp: 0 });
  }
  return out;
}

/** CrealityCfs.cpp map_creality_material_id. */
const CREALITY_MATERIAL: Record<string, string> = {
  '000001': 'PLA', '000002': 'ABS', '000003': 'PETG', '000004': 'TPU', '000005': 'ASA', '000006': 'PA', '000007': 'PC', '000008': 'PLA-CF', '000009': 'PETG-CF', '000010': 'PA-CF',
};

/** parse_creality_cfs_response: a Creality Hi's `box` object → loaded CFS slots (box n slot k = index (n − 1) · 4 + k). */
export function parseCrealityBox(json: unknown): PrinterLane[] {
  const box = status(json)?.box as Record<string, unknown> | undefined;
  if (!box || typeof box !== 'object' || Array.isArray(box)) return [];
  // Branded / RFID spools: [material_id, colour, [slots], type_name] in same_material.
  const same = new Map<string, string>();
  if (Array.isArray(box.same_material)) {
    for (const e of box.same_material) if (Array.isArray(e) && e.length >= 4 && typeof e[0] === 'string' && typeof e[3] === 'string' && e[0] && e[3] && !same.has(e[0])) same.set(e[0], e[3]);
  }
  const out: PrinterLane[] = [];
  for (let t = 1; t <= 4; t++) {
    const tray = box[`T${t}`] as Record<string, unknown> | undefined;
    if (!tray || typeof tray !== 'object' || Array.isArray(tray) || tray.state !== 'connect') continue;
    for (let k = 0; k < 4; k++) {
      const id = at(tray.material_type, k);
      const mid = typeof id === 'string' ? id : '';
      const type = CREALITY_MATERIAL[mid] ?? same.get(mid) ?? '';
      if (!type) continue;
      const v = at(tray.color_value, k);
      let c = typeof v === 'string' ? v : '';
      if (c.length === 7 && c[0] === '0') c = c.slice(1); // Creality writes "0RRGGBB"
      out.push({ index: (t - 1) * 4 + k, colour: laneColour(c), material: type, filamentId: '', nozzleTemp: 0, bedTemp: 0 });
    }
  }
  return out;
}

// ---- Qidi Box (QidiPrinterAgent) ----------------------------------------------------------------

export interface QidiDict { colors: Map<number, string>; filaments: Map<number, string> }

/** fetch_filament_dict: `[colordict]` index = colour, and `[filaN]` sections' `filament = name`. */
export function parseQidiDict(text: string): QidiDict {
  const colors = new Map<number, string>(), filaments = new Map<number, string>();
  let section = '', fila = -1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      section = line; fila = -1;
      const m = /^\[fila(.+)\]$/.exec(line);
      if (m) { const n = parseInt(m[1], 10); fila = Number.isFinite(n) ? n : -1; }
      continue;
    }
    if (!line || line[0] === '#' || line[0] === ';') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim(), value = line.slice(eq + 1).trim();
    if (section === '[colordict]') { const n = parseInt(key, 10); if (Number.isFinite(n)) colors.set(n, value); }
    if (fila > 0 && key === 'filament') filaments.set(fila, value);
  }
  return { colors, filaments };
}

/** infer_series_id: Q2 → 1, X-Max 4 → 3, X-Plus 4 → 0; a numeric id as is. */
export function qidiSeriesId(model: string): string {
  const src = model.trim();
  if (!src) return '';
  if (/^\d+$/.test(src)) return src;
  const key = src.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key.includes('q2')) return '1';
  if (key.includes('xmax') && key.includes('4')) return '3';
  if ((key.includes('xplus') || key.includes('plus')) && key.includes('4')) return '0';
  return '';
}

/** normalize_filament_type. */
export function qidiType(name: string): string {
  const u = name.trim().toUpperCase();
  for (const t of ['PLA', 'ABS', 'PETG', 'TPU', 'ASA']) if (u.includes(t)) return t;
  if (u.includes('PA') || u.includes('NYLON')) return 'PA';
  if (u.includes('PC')) return 'PC';
  if (u.includes('PVA')) return 'PVA';
  return u;
}

const QIDI_DEFAULT_ID: Record<string, string> = { PLA: 'QD_1_0_1', ABS: 'QD_1_0_11', PETG: 'QD_1_0_41', TPU: 'QD_1_0_50' };

/** The Box query: slot variables, newer firmware's decoded names, and each slot's runout sensor. */
export const QIDI_SLOT_QUERY = `printer/objects/query?save_variables=variables&multi_color_controller=box${Array.from({ length: 16 }, (_, i) => `&box_stepper%20slot${i}=runout_button`).join('')}`;

export interface QidiSlot { index: number; loaded: boolean; material: string; colour: string; settingId: string }

/** fetch_slot_info: `box_count` × 4 slots; a slot is loaded when its runout sensor reads 0. Null when the reply isn't the Box's. */
export function parseQidiSlots(json: unknown, dict: QidiDict, series: string): { boxCount: number; slots: QidiSlot[] } | null {
  const st = status(json);
  const vars = (st?.save_variables as { variables?: Record<string, unknown> } | undefined)?.variables;
  if (!st || !vars || typeof vars !== 'object') return null;
  const bc = vars.box_count;
  const boxCount = typeof bc === 'number' ? Math.max(0, Math.trunc(bc)) : 1;
  const ctrl = (st.multi_color_controller as { box?: Record<string, unknown> } | undefined)?.box;
  const slots: QidiSlot[] = [];
  for (let i = 0; i < boxCount * 4; i++) {
    const colourV = `color_slot${i}` in vars ? vars[`color_slot${i}`] : 1;
    const filV = `filament_slot${i}` in vars ? vars[`filament_slot${i}`] : 1;
    const colourIdx = typeof colourV === 'number' ? Math.trunc(colourV) : 0;
    const filIdx = typeof filV === 'number' ? Math.trunc(filV) : 0;
    const vendor = vars[`vendor_slot${i}`] === 1 ? 1 : 0;
    const rb = (st[`box_stepper slot${i}`] as { runout_button?: unknown } | undefined)?.runout_button;
    const loaded = typeof rb === 'number' && rb === 0;
    if (!loaded) { slots.push({ index: i, loaded, material: '', colour: '', settingId: '' }); continue; }
    let name = dict.filaments.get(filIdx) ?? 'PLA';
    const decoded = ctrl?.[`box${Math.floor(i / 4)}_filament_info_${i % 4}_filament_type`];
    if (typeof filV === 'string' && typeof decoded === 'string') name = decoded;
    const material = qidiType(name);
    const settingId = /^\d+$/.test(series) && filIdx > 0 ? `QD_${series}_${vendor}_${filIdx}` : QIDI_DEFAULT_ID[material] ?? '';
    const raw = Array.isArray(colourV) && typeof colourV[0] === 'string' ? colourV[0] : dict.colors.get(colourIdx) ?? 'FFFFFFFF';
    slots.push({ index: i, loaded, material, colour: laneColour(raw), settingId });
  }
  return { boxCount, slots };
}

/** The Qidi Box of the printer `config` (QidiPrinterAgent::fetch_filament_info); null when it has none. */
export async function fetchQidiBox(config: PhysicalPrinterConfig, printerModel = boundPrinter.value.model, signal?: AbortSignal): Promise<{ boxCount: number; slots: QidiSlot[] } | null> {
  const ctx = hostContext(config), env = browserEnv();
  const info = parse(await moonrakerGet(ctx, env, 'server/info', signal)) as { result?: Record<string, unknown> } | null;
  const r = (info?.result ?? info ?? {}) as Record<string, unknown>;
  const devName = typeof r.machine_name === 'string' ? r.machine_name : typeof r.hostname === 'string' ? r.hostname : '';
  const series = qidiSeriesId(devName) || qidiSeriesId(printerModel);
  const dictText = await moonrakerGet(ctx, env, 'server/files/config/officiall_filas_list.cfg', signal);
  const dict = dictText ? parseQidiDict(dictText) : { colors: new Map(), filaments: new Map() };
  return parseQidiSlots(parse(await moonrakerGet(ctx, env, QIDI_SLOT_QUERY, signal)), dict, series);
}

/** The printer's loaded lanes, from the first source that reports any (Orca's order). */
async function printerLanes(config: PhysicalPrinterConfig, signal?: AbortSignal): Promise<PrinterLane[]> {
  if (isQidi(boundPrinter.value.model)) {
    const box = await fetchQidiBox(config, boundPrinter.value.model, signal);
    return (box?.slots ?? []).filter((s) => s.loaded).map((s) => ({ index: s.index, colour: s.colour, material: s.material, filamentId: s.settingId, nozzleTemp: 0, bedTemp: 0 }));
  }
  const ctx = hostContext(config), env = browserEnv();
  const lanes = parseLaneData(await fetchLaneData(ctx, env, signal));
  if (lanes.length) return lanes;
  const hh = parseHappyHare(parse(await moonrakerGet(ctx, env, 'printer/objects/query?mmu', signal)));
  if (hh.length) return hh;
  return parseCrealityBox(parse(await moonrakerGet(ctx, env, 'printer/objects/query?box', signal)));
}

export interface FilamentCandidate { id: string; name: string; filamentType?: string; system: boolean; filamentId?: string }

/** MoonrakerPrinterAgent type_to_ofl_family: reported material → OrcaFilamentLibrary generic family. */
const FAMILY: Record<string, string> = {
  PLA: 'PLA', 'PLA-CF': 'PLA-CF', 'PLA SILK': 'PLA Silk', 'PLA-SILK': 'PLA Silk', 'PLA HIGH SPEED': 'PLA High Speed', 'PLA-HS': 'PLA High Speed',
  'PLA HS': 'PLA High Speed', ABS: 'ABS', ASA: 'ASA', PETG: 'PETG', PET: 'PETG', PCTG: 'PCTG', PA: 'PA', NYLON: 'PA', 'PA-CF': 'PA-CF',
  PPA: 'PPA-CF', 'PPA-CF': 'PPA-CF', 'PPA-GF': 'PPA-GF', PC: 'PC', PE: 'PE', PP: 'PP', PVA: 'PVA', HIPS: 'HIPS', BVOH: 'BVOH', TPU: 'TPU',
  EVA: 'EVA', PHA: 'PHA', COPE: 'CoPE', SBS: 'SBS',
};

/** The preset for a lane: same filament_id, else "Generic <family>", else a system preset of that type. */
export function matchLane(lane: PrinterLane, candidates: readonly FilamentCandidate[]): FilamentCandidate | null {
  if (lane.filamentId) {
    const hit = candidates.find((c) => c.filamentId === lane.filamentId);
    if (hit) return hit;
  }
  const type = lane.material.toUpperCase();
  if (!type) return null;
  const family = FAMILY[type];
  if (family) {
    const generic = candidates.find((c) => c.system && c.name.replace(/\s*@.*$/, '').toLowerCase() === `generic ${family}`.toLowerCase());
    if (generic) return generic;
  }
  const want = (family ?? lane.material).toUpperCase();
  return candidates.find((c) => c.system && (c.filamentType ?? '').toUpperCase() === want)
    ?? candidates.find((c) => (c.filamentType ?? '').toUpperCase() === want) ?? null;
}

export interface SyncResult { lanes: PrinterLane[]; matched: Array<{ lane: number; preset: string | null }> }

/**
 * Read the printer's lanes and apply them to the filament slots: one slot per
 * lane index, the matched preset and the lane colour.
 */
export async function syncFilamentsFromPrinter(config: PhysicalPrinterConfig | undefined = physicalPrinter.value?.config, signal?: AbortSignal): Promise<SyncResult> {
  if (!config || config.type !== 'moonraker') throw new HostError('unsupported', 'Filament sync needs a Moonraker printer.');
  const lanes = await printerLanes(config, signal);
  if (!lanes.length) throw new HostError('protocol', isQidi(boundPrinter.value.model) ? 'The printer reports no loaded Qidi Box slots.' : 'The printer reports no filament lanes (no AFC / Happy Hare lane data, Happy Hare MMU or Creality CFS).');
  const p = currentPresets.value;
  const infos = p.compatible.value.filament;
  const candidates: FilamentCandidate[] = infos.map((i) => ({ id: i.id, name: i.name, filamentType: i.filamentType, system: i.source === 'system' }));
  // filament_id lives in the preset values: resolve only when a lane carries one.
  if (lanes.some((l) => l.filamentId)) {
    await Promise.all(candidates.map(async (c) => {
      const r = await p.resolvePreset('filament', c.id).catch(() => null);
      const v = r?.values.filament_id;
      c.filamentId = valueAt(v, SCALAR);
    }));
  }
  const count = lanes[lanes.length - 1].index + 1;
  if (p.selection.filaments.length < count) await p.setFilamentCount(count);
  const matched: SyncResult['matched'] = [];
  for (const lane of lanes) {
    const hit = lane.material ? matchLane(lane, candidates) : null;
    if (hit) await p.selectFilament(lane.index, hit.id);
    if (lane.colour) p.setFilamentColour(lane.index, lane.colour);
    matched.push({ lane: lane.index, preset: hit?.name ?? null });
  }
  return { lanes, matched };
}

/**
 * The send dialog's Box slot choices: every slot of the boxes the printer reports, labelled with
 * what is loaded (material and colour), or all 16 plain slots before the Box is read.
 */
export function qidiSlotItems(box: { boxCount: number; slots: QidiSlot[] } | null): Array<{ value: number; label: string }> {
  const name = (k: number) => `Box ${Math.floor(k / 4) + 1} · slot ${(k % 4) + 1}`;
  if (!box) return Array.from({ length: 16 }, (_, k) => ({ value: k, label: name(k) }));
  return box.slots.map((s) => ({ value: s.index, label: `${name(s.index)} — ${s.loaded ? `${s.material}${s.colour ? ` ${s.colour.slice(0, 7)}` : ''}` : 'empty'}` }));
}

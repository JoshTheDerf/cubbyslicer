/**
 * "Sync filaments from printer" for Moonraker hosts (Orca 2.5
 * MoonrakerPrinterAgent::fetch_moonraker_filament_data): filament changers
 * (AFC, recent Happy Hare) publish their lanes in Moonraker's `lane_data`
 * database namespace. Each lane's `filament_id` (a string; Happy Hare's
 * numeric Spoolman id doesn't count) picks the filament preset with that id,
 * else the material picks a generic preset of that type; the lane's colour
 * becomes the slot colour.
 *
 * Not ported: Orca's Happy Hare (`mmu` printer object) and Creality CFS
 * (`box` object) fallbacks and the Qidi Box dictionary read, which need the
 * device-monitoring agents Orca runs alongside the print host.
 */
import { SCALAR, valueAt } from '../lib/configValue';
import { parseColour, toHex } from '../lib/colour';
import { currentPresets } from '../presets/store';
import { fetchLaneData } from './hosts/moonraker';
import { hostContext, physicalPrinter } from './store';
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
  const lanes = parseLaneData(await fetchLaneData(hostContext(config), browserEnv(), signal));
  if (!lanes.length) throw new HostError('protocol', 'The printer reports no filament lanes (no AFC / Happy Hare lane data in Moonraker).');
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

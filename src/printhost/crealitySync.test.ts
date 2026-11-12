/**
 * "Sync filaments from printer" on a Creality Print host (Orca 2.5 CrealityPrintAgent): the
 * port-9999 `boxsInfo` reply, the spool → preset scoring and the filament_id → preset pick. The
 * replies are shaped after CrealityPrintAgent::parse_cfs_response and its documented K2 Combo
 * schema; none of this was run against a printer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyConfig } from './config';
import { FakeWs, fakeEnv } from './testing';
import type { HostEnv } from './types';

let env: HostEnv | null = null;
vi.mock('./transport', async (orig) => ({ ...(await orig<typeof import('./transport')>()), browserEnv: () => env! }));
const { cfsBaseType, fetchCrealityCfs, matchCfsPreset, parseCfsSync, pickByFilamentId } = await import('./filamentSync');
type Candidate = Parameters<typeof matchCfsPreset>[0][number];
afterEach(() => { env = null; });

// K2 Combo: box id 0 is the spool holder (type 1); CFS boxes 1 and 3 active, 2 inactive.
const REPLY = { boxsInfo: { materialBoxs: [
  { id: 0, state: 1, type: 1, materials: [{ id: 0, state: 1, vendor: 'Creality', type: 'PLA', name: 'Hyper PLA', color: '#0FFFFFF' }] },
  { id: 1, state: 1, type: 0, materials: [
    { id: 0, state: 1, vendor: 'Creality', type: 'PLA', name: 'Hyper PLA', color: '#0FF0000' },
    { id: 1, state: 0, vendor: 'Creality', type: 'PLA', name: 'Hyper PLA', color: '#0000000' },
    { id: 2, state: 2, vendor: 'eSUN', type: 'PETG', name: 'PETG', color: '#000FF00' },
    { id: 3, state: 1, vendor: '', type: '', name: '', color: '#0FFFFFF' },
  ] },
  { id: 2, state: 0, type: 0, materials: [{ id: 0, state: 1, vendor: 'Creality', type: 'ABS', name: 'ABS', color: '#0123456' }] },
  { id: 3, state: 1, type: 0, materials: [{ id: 3, state: 1, vendor: 'Generic', type: 'PLA Silk', name: 'PLA Silk', color: '#00000FF' }] },
] } };

const c = (name: string, filamentType: string, filamentId: string, o: Partial<Candidate> = {}): Candidate =>
  ({ id: `sys:Creality/${name}`, name, filamentType, filamentId, vendor: 'Creality', system: true, user: false, base: true, ...o });
const PRESETS: Candidate[] = [
  c('Generic PLA @Creality K2-all', 'PLA', 'GFL99'),
  c('Generic PLA High Speed @Creality K2-all', 'PLA', 'GFL95'),
  c('Generic PLA Matte @Creality K2-all', 'PLA', 'GFL05'),
  c('Hyper PLA @Creality K2 0.4 nozzle', 'PLA', 'CRL01'),
  c('Creality Hyper PLA @K2 (Harky)', 'PLA', 'CRL01', { id: 'user:h', vendor: undefined, system: false, user: true, base: false }),
  c('Generic PETG @Creality K2-all', 'PETG', 'GFG99'),
  c('eSUN PETG @Creality K2-all', 'PETG', 'ESN01'),
  c('Generic ABS @Creality K2-all', 'ABS', 'GFB99'),
];

describe('parse_cfs_response', () => {
  it('active CFS boxes only, renumbered; loaded slots with a vendor or type; "#0RRGGBB" → "#RRGGBB"', () => {
    const r = parseCfsSync(REPLY)!;
    expect(r.boxCount).toBe(2);
    expect(r.spools.map((s) => [s.box, s.slot, s.vendor, s.brand, s.type, s.colour])).toEqual([
      [0, 0, 'Creality', 'Hyper PLA', 'PLA', '#FF0000'],
      [0, 2, 'eSUN', 'PETG', 'PETG', '#00FF00'], // state 2 (K2 Plus: loaded, not selected) counts
      [1, 3, 'Generic', 'PLA Silk', 'PLA Silk', '#0000FF'],
    ]);
  });
  it('is null without boxsInfo.materialBoxs; no boxes when only the spool holder is active', () => {
    expect(parseCfsSync({})).toBeNull();
    expect(parseCfsSync({ boxsInfo: {} })).toBeNull();
    expect(parseCfsSync(null)).toBeNull();
    expect(parseCfsSync({ boxsInfo: { materialBoxs: [REPLY.boxsInfo.materialBoxs[0]] } })).toEqual({ boxCount: 0, spools: [] });
  });
  it('normalize_filament_type: first matching base prefix', () => {
    expect(['PLA Silk', 'PLA+', 'PETG-CF', 'PET', 'ABS Pro', 'PA12', 'PPS', 'TPU 95A'].map(cfsBaseType)).toEqual(['PLA', 'PLA', 'PETG', 'PET', 'ABS', 'PA', 'PPS', 'TPU']);
  });
});

describe('match_filament_preset', () => {
  it('brand + vendor; a system preset wins a tie with a user copy', () => {
    expect(matchCfsPreset(PRESETS, 'Creality', 'Hyper PLA', 'PLA')).toBe('CRL01');
  });
  it('a spool that only says "PLA" gets the least specific preset (−5 per unclaimed word)', () => {
    expect(matchCfsPreset(PRESETS, 'Creality', 'PLA', 'PLA')).toBe('GFL99');
  });
  it('a third-party brand inside the vendor bundle is found by its name', () => {
    expect(matchCfsPreset(PRESETS, 'eSUN', 'PETG', 'PETG')).toBe('ESN01');
  });
  it('nothing scores: the first system base of the type, if it is that type', () => {
    expect(matchCfsPreset(PRESETS, 'Unknown', '', 'ABS')).toBe('GFB99');
    expect(matchCfsPreset(PRESETS, 'Unknown', '', 'PLA Silk')).toBe(''); // "PLA" is found, but isn't "PLA Silk"
    expect(matchCfsPreset(PRESETS, 'Creality', 'Hyper ASA', 'ASA')).toBe(''); // never another material
  });
  it('the type gate is case-insensitive for scoring', () => {
    expect(matchCfsPreset(PRESETS, 'creality', 'hyper pla', 'pla')).toBe('CRL01');
  });
});

describe('sync_ams_list: filament_id → preset', () => {
  it('the base preset with the id, else "Generic <type>…", else nothing; an empty id changes nothing', () => {
    expect(pickByFilamentId(PRESETS, 'CRL01', 'PLA')?.name).toBe('Hyper PLA @Creality K2 0.4 nozzle');
    expect(pickByFilamentId(PRESETS, 'NOPE', 'PETG')?.name).toBe('Generic PETG @Creality K2-all');
    expect(pickByFilamentId(PRESETS, 'NOPE', 'PEEK')).toBeNull();
    expect(pickByFilamentId(PRESETS, '', 'PLA')).toBeNull();
  });
});

describe('fetch_filament_info over the Creality Print host', () => {
  const config = { ...emptyConfig('crealityprint'), host: '192.168.1.5' };
  const printer = (model: string, onWs: (ws: FakeWs) => void = () => {}, wsFails = false) => {
    let sock: FakeWs | null = null;
    env = fakeEnv((req) => (req.url.endsWith('/info') ? { body: { model } } : undefined), (url) => {
      if (wsFails) throw new DOMException('An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.', 'SecurityError');
      return (sock = new FakeWs(url, (ws, m) => { if ((m.params as { boxsInfo?: number })?.boxsInfo === 1) onWs(ws); }));
    }).env;
    return () => sock;
  };

  it('a CFS model: one lane per loaded slot (box · 4 + slot), base type, colour, matched filament_id', async () => {
    const sock = printer('F021', (ws) => ws.push(REPLY));
    const r = await fetchCrealityCfs(config, async () => PRESETS);
    expect(sock()?.url).toBe('ws://192.168.1.5:9999/');
    expect(sock()?.sent).toEqual([{ method: 'get', params: { boxsInfo: 1 } }]);
    expect(r.lanes?.map((l) => [l.index, l.material, l.colour, l.filamentId])).toEqual([
      [0, 'PLA', '#FF0000', 'CRL01'], [2, 'PETG', '#00FF00', 'ESN01'], [7, 'PLA', '#0000FF', 'GFL99'],
    ]);
  });
  it('the WebSocket URL override is used', async () => {
    const sock = printer('F008', (ws) => ws.push(REPLY));
    await fetchCrealityCfs({ ...config, wsUrl: 'wss://proxy.example/k2' }, async () => PRESETS);
    expect(sock()?.url).toBe('wss://proxy.example/k2');
  });
  it('no CFS: a model without one, a cfsConnect 0 status, or no active boxes → null (Moonraker fallback)', async () => {
    printer('CR-10');
    expect((await fetchCrealityCfs(config, async () => PRESETS)).lanes).toBeNull();
    printer('F021', (ws) => ws.push({ cfsConnect: 0 }));
    expect((await fetchCrealityCfs(config, async () => PRESETS)).lanes).toBeNull();
    printer('F021', (ws) => ws.push({ boxsInfo: { materialBoxs: [REPLY.boxsInfo.materialBoxs[0]] } }));
    expect((await fetchCrealityCfs(config, async () => PRESETS)).lanes).toBeNull();
  });
  it('active boxes with nothing loaded: no lanes (no fallback)', async () => {
    printer('F021', (ws) => ws.push({ boxsInfo: { materialBoxs: [{ id: 1, state: 1, type: 0, materials: [{ id: 0, state: 0 }] }] } }));
    expect((await fetchCrealityCfs(config, async () => PRESETS)).lanes).toEqual([]);
  });
  it('a socket the browser refuses (ws:// from HTTPS) is reported as a socket error', async () => {
    printer('F021', () => {}, true);
    const r = await fetchCrealityCfs(config, async () => PRESETS);
    expect(r.lanes).toBeNull();
    expect(r.socket).toBe(true);
    expect(r.error?.detail).toMatch(/insecure WebSocket/);
  });
});

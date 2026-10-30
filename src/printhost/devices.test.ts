import { describe, expect, it } from 'vitest';
import { emptyConfig } from './config';
import { devicesFor, migrateLegacy, parseStore, pickDevice, presetLabel, uniqueDeviceName, type DeviceStore } from './devices';

const VORON = 'sys:Voron/Voron 2.4 350 0.4 nozzle';
const dev = (id: string, name: string, presets: string[], host = `http://${id}.local`) =>
  ({ id, name, presets: presets.map((p) => ({ id: p, name: presetLabel(p) })), config: { ...emptyConfig('moonraker'), host }, updatedAt: 1 });

describe('device store', () => {
  it('parses defensively', () => {
    const s = parseStore({ devices: [dev('a', 'A', [VORON]), { id: 'a' }, { name: 'no id' }, null, { id: 'b', name: ' ', presets: [{ id: '' }, { id: 'x' }] }], hiddenPresetHosts: ['p', 'p', 3] });
    expect(s.devices.map((d) => [d.id, d.name, d.presets.map((p) => p.id)])).toEqual([['a', 'A', [VORON]], ['b', 'Printer', ['x']]]);
    expect(s.hiddenPresetHosts).toEqual(['p']);
    expect(parseStore('junk')).toEqual({ devices: [], hiddenPresetHosts: [] });
  });

  it('lists the devices that run a preset (two identical printers)', () => {
    const s: DeviceStore = { devices: [dev('b', 'Voron B', [VORON]), dev('x', 'Ender', ['sys:Creality/Ender-3']), dev('a', 'Voron A', [VORON, 'user:v06'])], hiddenPresetHosts: [] };
    expect(devicesFor(s, VORON).map((d) => d.id)).toEqual(['a', 'b']);
    expect(devicesFor(s, 'user:v06').map((d) => d.id)).toEqual(['a']);
    expect(devicesFor(s, 'other')).toEqual([]);
  });

  it('picks the tab’s device, then the last used, then the first', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(pickDevice(list, 'c', 'b')?.id).toBe('c');
    expect(pickDevice(list, 'gone', 'b')?.id).toBe('b');
    expect(pickDevice(list, undefined, 'gone')?.id).toBe('a');
    expect(pickDevice([], 'a')).toBeNull();
  });

  it('makes names unique', () => {
    const s: DeviceStore = { devices: [dev('a', 'Voron', []), dev('b', 'Voron (2)', [])], hiddenPresetHosts: [] };
    expect(uniqueDeviceName(s, 'Voron')).toBe('Voron (3)');
    expect(uniqueDeviceName(s, 'voron', 'a')).toBe('voron');
    expect(uniqueDeviceName(s, '  ')).toBe('Printer');
  });
});

describe('migrateLegacy', () => {
  let n = 0;
  const id = () => `dev:${++n}`;

  it('turns per-preset configs into devices and keeps removed preset hosts hidden', () => {
    n = 0;
    const cfg = { ...emptyConfig('moonraker'), host: 'http://voron.local' };
    const s = migrateLegacy([
      [`cubby.printhost.orca:${VORON}`, { config: cfg }],
      [`cubby.printhost.preflight:${VORON}`, { config: cfg }],
      ['cubby.printhost.orca:user:abc', { config: { ...emptyConfig('octoprint'), host: '10.0.0.5', apiKey: 'k' } }],
      ['cubby.printhost.orca:sys:Prusa/MK4', { disabled: true }],
      ['cubby.printhost.orca:sys:Empty', { config: { type: 'octoprint' } }],
      ['cubby.printhost.devices.v1', { devices: [] }],
      ['unrelated', {}],
    ], (pid) => (pid === 'user:abc' ? 'My Ender' : undefined), id, 5);
    expect(s.devices).toEqual([
      { id: 'dev:1', name: 'Voron 2.4 350 0.4 nozzle', presets: [{ id: VORON, name: 'Voron 2.4 350 0.4 nozzle' }], config: cfg, updatedAt: 5 },
      { id: 'dev:2', name: 'My Ender', presets: [{ id: 'user:abc', name: 'My Ender' }], config: { ...emptyConfig('octoprint'), host: '10.0.0.5', apiKey: 'k' }, updatedAt: 5 },
    ]);
    expect(s.hiddenPresetHosts).toEqual(['sys:Prusa/MK4']);
  });
});

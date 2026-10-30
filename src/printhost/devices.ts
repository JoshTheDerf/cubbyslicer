/**
 * Physical printers as a named list (Orca's PhysicalPrinterCollection): each
 * device has its own address and credentials and runs one or more printer
 * presets, so two identical printers share a preset but are separate devices.
 * Pure helpers; app state is store.ts.
 */
import { STORAGE_PREFIX, normalizeConfig } from './config';
import type { PhysicalPrinterConfig } from './types';

export const DEVICES_KEY = 'cubby.printhost.devices.v1';
/** Per preset, the device used last (new tabs start on it). */
export const LAST_USED_KEY = 'cubby.printhost.lastUsed.v1';
/** Per preset, this tab's device (sessionStorage). */
export const TAB_CHOICE_KEY = 'cubby.printhost.tabChoice.v1';

export interface PresetRef { id: string; name: string }

export interface PhysicalDevice {
  id: string;
  name: string;
  /** Printer presets this device prints (ids; system ids are the same in every engine). */
  presets: PresetRef[];
  config: PhysicalPrinterConfig;
  updatedAt: number;
}

export interface DeviceStore {
  devices: PhysicalDevice[];
  /** Presets whose own print_host (from the profile) the user removed. */
  hiddenPresetHosts: string[];
}

export const emptyStore = (): DeviceStore => ({ devices: [], hiddenPresetHosts: [] });

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function parseStore(raw: unknown): DeviceStore {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof DeviceStore, unknown>>;
  const devices: PhysicalDevice[] = [];
  for (const d of Array.isArray(r.devices) ? r.devices : []) {
    const x = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
    const id = str(x.id);
    if (!id || devices.some((e) => e.id === id)) continue;
    const presets = (Array.isArray(x.presets) ? x.presets : [])
      .map((p) => ({ id: str((p as PresetRef)?.id), name: str((p as PresetRef)?.name) }))
      .filter((p) => p.id);
    devices.push({ id, name: str(x.name).trim() || 'Printer', presets, config: normalizeConfig(x.config), updatedAt: Number(x.updatedAt) || 0 });
  }
  const hidden = Array.isArray(r.hiddenPresetHosts) ? r.hiddenPresetHosts.filter((x): x is string => typeof x === 'string') : [];
  return { devices, hiddenPresetHosts: [...new Set(hidden)] };
}

/** Devices that print `presetId`, by name. */
export function devicesFor(store: DeviceStore, presetId: string): PhysicalDevice[] {
  return store.devices.filter((d) => d.presets.some((p) => p.id === presetId)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** First of: this tab's choice, the last-used device, the first one. */
export function pickDevice<T extends { id: string }>(choices: T[], tabChoice?: string, lastUsed?: string): T | null {
  return choices.find((d) => d.id === tabChoice) ?? choices.find((d) => d.id === lastUsed) ?? choices[0] ?? null;
}

/** `name`, or "name (2)", "name (3)"… when another device has it. */
export function uniqueDeviceName(store: DeviceStore, name: string, exceptId?: string): string {
  const base = name.trim() || 'Printer';
  const taken = (n: string) => store.devices.some((d) => d.id !== exceptId && d.name.toLowerCase() === n.toLowerCase());
  if (!taken(base)) return base;
  for (let i = 2; ; i++) { const n = `${base} (${i})`; if (!taken(n)) return n; }
}

/**
 * Before named devices, one config was stored per printer preset under
 * `cubby.printhost.<engine>:<presetId>`. Each becomes a device for that
 * preset (the same host saved under several engines becomes one device);
 * `{disabled}` entries hide the preset's own print_host.
 */
export function migrateLegacy(entries: Array<[string, unknown]>, presetName: (id: string) => string | undefined, newId: () => string, now = Date.now()): DeviceStore {
  const out = emptyStore();
  for (const [key, value] of entries) {
    if (!key.startsWith(STORAGE_PREFIX) || key === DEVICES_KEY || key === LAST_USED_KEY) continue;
    const rest = key.slice(STORAGE_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon < 0) continue;
    const presetId = rest.slice(colon + 1);
    const v = (value && typeof value === 'object' ? value : {}) as { config?: unknown; disabled?: boolean };
    if (v.disabled) { if (!out.hiddenPresetHosts.includes(presetId)) out.hiddenPresetHosts.push(presetId); continue; }
    const config = normalizeConfig(v.config);
    if (!config.host) continue;
    const same = out.devices.find((d) => d.config.host === config.host && d.config.type === config.type && d.config.printer === config.printer);
    const name = presetName(presetId) ?? presetLabel(presetId);
    if (same) { if (!same.presets.some((p) => p.id === presetId)) same.presets.push({ id: presetId, name }); continue; }
    out.devices.push({ id: newId(), name: uniqueDeviceName(out, name), presets: [{ id: presetId, name }], config, updatedAt: now });
  }
  return out;
}

/** "sys:Vendor/Name 0.4 nozzle" → "Name 0.4 nozzle" (display fallback when the preset isn't loaded). */
export function presetLabel(presetId: string): string {
  const s = presetId.replace(/^(sys|user):/, '');
  return s.slice(s.lastIndexOf('/') + 1) || 'Printer';
}

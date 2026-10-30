/**
 * Physical printer state: a named list of devices (devices.ts) shared by all
 * tabs through localStorage, each running one or more printer presets. Each
 * tab picks which device of the selected preset it sends to (sessionStorage),
 * so two tabs can drive two identical printers. When no device runs the
 * preset, the preset's own print_host / printhost_* values are used.
 */
import { computed, reactive, ref } from 'vue';
import { activeEngine } from '../app/state';
import { currentPresets } from '../presets/store';
import { uuid } from '../presets/util';
import { asArray } from '../presets/values';
import { STORAGE_PREFIX, configFromPreset, normalizeConfig } from './config';
import {
  DEVICES_KEY, LAST_USED_KEY, TAB_CHOICE_KEY, devicesFor, emptyStore, migrateLegacy, parseStore, pickDevice, uniqueDeviceName,
  type DeviceStore, type PhysicalDevice, type PresetRef,
} from './devices';
import { isSupported } from './registry';
import type { HostContext, PhysicalPrinterConfig } from './types';

function storage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try { return (globalThis as Record<string, unknown>)[kind] as Storage ?? null; } catch { return null; }
}
function readJson(st: Storage | null, key: string): unknown {
  try { const raw = st?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeJson(st: Storage | null, key: string, v: unknown): void {
  try { st?.setItem(key, JSON.stringify(v)); } catch { /* storage blocked: this session only */ }
}

function loadStore(): DeviceStore {
  const ls = storage('localStorage');
  const saved = readJson(ls, DEVICES_KEY);
  if (saved) return parseStore(saved);
  // First run with named devices: convert the old one-host-per-preset entries (kept for older builds).
  const entries: Array<[string, unknown]> = [];
  try {
    for (let i = 0; ls && i < ls.length; i++) {
      const k = ls.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) entries.push([k, readJson(ls, k)]);
    }
  } catch { /* storage blocked */ }
  if (!entries.length) return emptyStore();
  // Preset names aren't loaded yet at startup; devices are named from the preset id (renamable).
  const migrated = migrateLegacy(entries, () => undefined, () => `dev:${uuid()}`);
  writeJson(ls, DEVICES_KEY, migrated);
  return migrated;
}

/** All physical printers (every tab sees the same list). */
export const deviceStore = ref<DeviceStore>(loadStore());
const lastUsed = ref<Record<string, string>>((readJson(storage('localStorage'), LAST_USED_KEY) as Record<string, string>) ?? {});
/** This tab's device per printer preset. */
const tabChoice = reactive<Record<string, string>>((readJson(storage('sessionStorage'), TAB_CHOICE_KEY) as Record<string, string>) ?? {});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === DEVICES_KEY) deviceStore.value = parseStore(readJson(storage('localStorage'), DEVICES_KEY));
    else if (e.key === LAST_USED_KEY) lastUsed.value = (readJson(storage('localStorage'), LAST_USED_KEY) as Record<string, string>) ?? {};
  });
}

function commit(next: DeviceStore): void {
  deviceStore.value = next;
  writeJson(storage('localStorage'), DEVICES_KEY, next);
}

/** The printer preset the physical printer is bound to. */
export const boundPrinter = computed(() => {
  const p = currentPresets.value;
  const id = p.selectedId('printer');
  const first = (k: string) => asArray(p.value('printer', k))[0];
  return { engine: activeEngine.value, id, name: p.selectedInfo('printer').name, model: first('printer_model') ?? '', get: first };
});

export type ConfigSource = 'saved' | 'preset';

/** One entry of the "send to" list. `id` is a device id, or `preset:<presetId>` for the preset's own print_host. */
export interface PrinterChoice { id: string; name: string; config: PhysicalPrinterConfig; source: ConfigSource }

/** Where the selected printer preset can be sent: its devices, else the preset's own host. */
export const printerChoices = computed<PrinterChoice[]>(() => {
  const b = boundPrinter.value;
  const devs = devicesFor(deviceStore.value, b.id);
  if (devs.length) return devs.map((d) => ({ id: d.id, name: d.name, config: d.config, source: 'saved' as const }));
  if (deviceStore.value.hiddenPresetHosts.includes(b.id)) return [];
  const fromPreset = configFromPreset(b.get);
  return fromPreset ? [{ id: `preset:${b.id}`, name: b.name, config: fromPreset, source: 'preset' }] : [];
});

/** The device this tab sends to (null when the preset has none). */
export const physicalPrinter = computed<PrinterChoice | null>(() =>
  pickDevice(printerChoices.value, tabChoice[boundPrinter.value.id], lastUsed.value[boundPrinter.value.id]));

/** A usable print host is configured for the current printer. */
export const hostReady = computed(() => !!physicalPrinter.value && isSupported(physicalPrinter.value.config.type));

/** Send this tab's jobs for the selected preset to `id`, and start new tabs on it. */
export function selectDevice(id: string): void {
  const presetId = boundPrinter.value.id;
  tabChoice[presetId] = id;
  writeJson(storage('sessionStorage'), TAB_CHOICE_KEY, tabChoice);
  rememberDevice(id);
}

/** Record `id` as the last-used device of the selected preset. */
export function rememberDevice(id: string): void {
  const presetId = boundPrinter.value.id;
  if (lastUsed.value[presetId] === id) return;
  const fresh = { ...((readJson(storage('localStorage'), LAST_USED_KEY) as Record<string, string>) ?? {}), [presetId]: id };
  lastUsed.value = fresh;
  writeJson(storage('localStorage'), LAST_USED_KEY, fresh);
}

export function deviceById(id: string | null | undefined): PhysicalDevice | undefined {
  return id ? deviceStore.value.devices.find((d) => d.id === id) : undefined;
}

export interface SaveDeviceOptions {
  /** Device to update; omitted: the device this tab uses, or a new one. Pass null to always add one. */
  id?: string | null;
  name?: string;
  presets?: PresetRef[];
}

/** Save a device (and make this tab use it). Returns it. */
export function savePhysicalPrinter(config: PhysicalPrinterConfig, opts: SaveDeviceOptions = {}): PhysicalDevice {
  const b = boundPrinter.value;
  const cur = deviceStore.value;
  const editing = opts.id === undefined ? (physicalPrinter.value?.source === 'saved' ? deviceById(physicalPrinter.value.id) : undefined) : deviceById(opts.id);
  const presets = opts.presets?.length ? opts.presets : editing?.presets ?? [{ id: b.id, name: b.name }];
  const dev: PhysicalDevice = {
    id: editing?.id ?? `dev:${uuid()}`,
    name: uniqueDeviceName(cur, opts.name ?? editing?.name ?? b.name, editing?.id),
    presets,
    config: normalizeConfig(config),
    updatedAt: Date.now(),
  };
  commit({
    devices: editing ? cur.devices.map((d) => (d.id === dev.id ? dev : d)) : [...cur.devices, dev],
    hiddenPresetHosts: cur.hiddenPresetHosts,
  });
  if (dev.presets.some((p) => p.id === b.id)) selectDevice(dev.id);
  return dev;
}

/**
 * Forget a device (default: the one this tab uses). For the preset's own
 * print_host, hide it instead.
 */
export function removePhysicalPrinter(id: string | undefined = physicalPrinter.value?.id): void {
  if (!id) return;
  const cur = deviceStore.value;
  if (id.startsWith('preset:')) {
    const presetId = id.slice('preset:'.length);
    if (!cur.hiddenPresetHosts.includes(presetId)) commit({ ...cur, hiddenPresetHosts: [...cur.hiddenPresetHosts, presetId] });
    return;
  }
  commit({ ...cur, devices: cur.devices.filter((d) => d.id !== id) });
}

export function hostContext(config: PhysicalPrinterConfig): HostContext {
  return { ...config, printerModel: boundPrinter.value.model };
}

// ---- dialogs + running upload --------------------------------------------------------

export const printhostUi = reactive({
  setupOpen: false,
  /** Device the setup dialog edits: an id, 'new', or null for the one this tab uses. */
  setupTarget: null as string | null,
  sendOpen: false,
  /** Which button the send dialog emphasises. */
  sendMode: 'print' as 'print' | 'upload',
  uploading: false,
  progress: 0,
  status: '',
});

/** Edit the device this tab uses (`target` null), another device, or add one ('new'). */
export function openPhysicalPrinterDialog(target: string | null = null): void {
  printhostUi.setupTarget = target;
  printhostUi.setupOpen = true;
}
export function openSendDialog(mode: 'print' | 'upload'): void {
  if (!hostReady.value) { openPhysicalPrinterDialog(); return; }
  printhostUi.sendMode = mode;
  printhostUi.sendOpen = true;
}

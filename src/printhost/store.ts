/**
 * Physical printer state: one print-host config per printer preset (like
 * Orca's physical printers bound to presets), stored in this browser's
 * localStorage only. When nothing is saved for the preset, the preset's own
 * print_host / printhost_* values are used.
 */
import { computed, reactive, ref } from 'vue';
import { activeEngine } from '../app/state';
import { currentPresets } from '../presets/store';
import { asArray } from '../presets/values';
import { configFromPreset, normalizeConfig, storageKey } from './config';
import { isSupported } from './registry';
import type { HostContext, PhysicalPrinterConfig } from './types';

/** Bumped on save/remove so computeds re-read storage. */
const revision = ref(0);

function ls(): Storage | null {
  try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
}

interface Stored { config?: PhysicalPrinterConfig; disabled?: boolean }

function readStored(key: string): Stored | null {
  try {
    const raw = ls()?.getItem(key);
    if (!raw) return null;
    const j = JSON.parse(raw) as Stored;
    return j.disabled ? { disabled: true } : { config: normalizeConfig(j.config) };
  } catch { return null; }
}

/** The printer preset the physical printer is bound to. */
export const boundPrinter = computed(() => {
  const p = currentPresets.value;
  const id = p.selectedId('printer');
  const first = (k: string) => asArray(p.value('printer', k))[0];
  return { engine: activeEngine.value, id, name: p.selectedInfo('printer').name, model: first('printer_model') ?? '', get: first };
});

export type ConfigSource = 'saved' | 'preset';

/** The saved or preset-provided config for the current printer (null when none / removed). */
export const physicalPrinter = computed<{ config: PhysicalPrinterConfig; source: ConfigSource } | null>(() => {
  void revision.value;
  const b = boundPrinter.value;
  const stored = readStored(storageKey(b.engine, b.id));
  if (stored?.disabled) return null;
  if (stored?.config?.host) return { config: stored.config, source: 'saved' };
  const fromPreset = configFromPreset(b.get);
  return fromPreset ? { config: fromPreset, source: 'preset' } : null;
});

/** A usable print host is configured for the current printer. */
export const hostReady = computed(() => !!physicalPrinter.value && isSupported(physicalPrinter.value.config.type));

export function savePhysicalPrinter(config: PhysicalPrinterConfig): void {
  const b = boundPrinter.value;
  try { ls()?.setItem(storageKey(b.engine, b.id), JSON.stringify({ config: normalizeConfig(config) })); } catch { /* storage blocked */ }
  revision.value++;
}

/** Forget the saved config; also hides a preset-provided print_host for this preset. */
export function removePhysicalPrinter(): void {
  const b = boundPrinter.value;
  try { ls()?.setItem(storageKey(b.engine, b.id), JSON.stringify({ disabled: true })); } catch { /* storage blocked */ }
  revision.value++;
}

export function hostContext(config: PhysicalPrinterConfig): HostContext {
  return { ...config, printerModel: boundPrinter.value.model };
}

// ---- dialogs + running upload --------------------------------------------------------

export const printhostUi = reactive({
  setupOpen: false,
  sendOpen: false,
  /** Which button the send dialog emphasises. */
  sendMode: 'print' as 'print' | 'upload',
  uploading: false,
  progress: 0,
  status: '',
});

export function openPhysicalPrinterDialog(): void { printhostUi.setupOpen = true; }
export function openSendDialog(mode: 'print' | 'upload'): void {
  if (!hostReady.value) { printhostUi.setupOpen = true; return; }
  printhostUi.sendMode = mode;
  printhostUi.sendOpen = true;
}

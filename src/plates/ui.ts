/** Plate settings dialog state (not persisted), and the IDEX/IQEX plate mode control. */
import { computed, reactive } from 'vue';
import { resolvedConfig } from '../app/state';
import { plates } from '../project/store';
import { IMEX_PRIMARY_MODE, findImexMode, imexModeKind, imexPlateModeChoices, isImexPrinter, plateImexMode, type ImexModeKind } from './imex';
import { setPlateImexMode } from './store';

export const plateUi = reactive({
  /** Plate whose settings dialog is open (Orca PlateSettingsDialog), or null. */
  settingsFor: null as number | null,
});

export function openPlateSettings(i: number): void { plateUi.settingsFor = i; }

// ---- IDEX/IQEX plate mode (Orca's plate mode icon: click steps through, right-click picks) ----


/** The printer has IDEX/IQEX parallel modes to choose from (more than Primary). */
export const imexModes = computed(() => (isImexPrinter(resolvedConfig.value) ? imexPlateModeChoices(resolvedConfig.value) : []));

export const IMEX_KIND_ICONS: Record<ImexModeKind, string> = {
  primary: 'i-lucide-square', copy: 'i-lucide-copy', mirror: 'i-lucide-flip-horizontal-2', custom: 'i-lucide-palette',
};

export function imexModeLabel(mode: string): string { return mode === IMEX_PRIMARY_MODE ? 'Primary' : mode; }

/** A plate's mode and what it does (null when the printer has no parallel modes). */
export function plateImex(i: number): { mode: string; kind: ImexModeKind; icon: string; label: string } | null {
  if (imexModes.value.length < 2) return null;
  const mode = plateImexMode(plates.value[i]?.config);
  const kind = mode === IMEX_PRIMARY_MODE ? 'primary' : imexModeKind(findImexMode(resolvedConfig.value, mode)?.activeTools ?? '');
  return { mode, kind, icon: IMEX_KIND_ICONS[kind], label: imexModeLabel(mode) };
}

/** Step plate `i` to its next mode (Orca: left-click on the plate's mode icon). */
export function cyclePlateImexMode(i: number): void {
  const modes = imexModes.value;
  if (modes.length < 2) return;
  const k = modes.indexOf(plateImexMode(plates.value[i]?.config));
  setPlateImexMode(i, modes[(k + 1) % modes.length]);
}

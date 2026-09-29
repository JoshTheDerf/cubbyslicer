/**
 * The active calibration print (Orca `Print::m_calib_params`, set by
 * Plater::calib_*). Sent with every slice job as `options.calib` until the
 * project is reset — "New project", opening another project, or deleting
 * every object (Orca's Plater::priv::reset()).
 */
import { reactive, shallowRef, watch } from 'vue';
import type { CalibParams } from '../engine/types';
import { objects, registerProjectSection } from '../project/store';

export const activeCalib = shallowRef<CalibParams | null>(null);
/** Objects created by the calibration setup; once none of them is left, the calibration ends. */
let calibObjects = new Set<string>();

/** Which calibration dialog is open (Calibration menu). */
export type CalibDialogId = 'temp' | 'flow' | 'pa' | 'retraction' | 'volumetric' | 'vfa' | 'is_freq' | 'is_damp' | 'cornering';
export const calibUi = reactive({ open: null as CalibDialogId | null, busy: false });

export function setActiveCalib(p: CalibParams | null, objectIds: string[] = []): void {
  activeCalib.value = p ? JSON.parse(JSON.stringify(p)) as CalibParams : null;
  calibObjects = new Set(p ? objectIds : []);
}

/** Slice job options contributed by the calibration (merged into SliceJob.options). */
export function calibJobOptions(): { calib?: CalibParams } {
  return activeCalib.value ? { calib: activeCalib.value } : {};
}

/** Stable key of the active calibration (part of a plate's slice signature). */
export function calibSignature(): string {
  return activeCalib.value ? JSON.stringify(activeCalib.value) : '';
}

let installed = false;
/** Idempotent: project section + auto-clear when the plate is emptied. */
export function installCalibrationState(): void {
  if (installed) return;
  installed = true;
  registerProjectSection('calibration', {
    save: () => (activeCalib.value ? { params: activeCalib.value, objects: [...calibObjects] } : null),
    load: (data) => {
      const d = data as { params?: CalibParams; objects?: unknown } | null;
      const ok = !!d && typeof d === 'object' && !!d.params && typeof d.params.mode === 'string';
      setActiveCalib(ok ? d!.params! : null, ok && Array.isArray(d!.objects) ? d!.objects.filter((x): x is string => typeof x === 'string') : []);
    },
    reset: () => setActiveCalib(null),
  });
  // Orca resets the calibration with the plate (new project / delete all); opening
  // another project replaces every object, so no calibration object is left either.
  watch(() => objects.value.map((o) => o.id).join('|'), () => {
    if (activeCalib.value && !objects.value.some((o) => calibObjects.has(o.id))) setActiveCalib(null);
  });
}

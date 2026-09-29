/**
 * The only place the settings/presets area touches the project store.
 * Per-object overrides go through the project store (undoable); the
 * `presets` project section is registered once the store exposes
 * `registerProjectSection` (looked up at runtime so either side can land first).
 */
import type { ConfigValue } from '../engine/types';
import { presetsProjectSection } from '../presets/store';
import * as project from '../project/store';
import * as layers from '../layers/store';

/** Overrides of an object, or of one of its parts (modifier settings) when `partId` is given. */
export function getObjectOverrides(id: string, partId?: string, rangeId?: string): Readonly<Record<string, ConfigValue>> {
  if (rangeId) return layers.getRangeOverrides(id, rangeId);
  return partId ? project.getPartOverrides(id, partId) : project.getObjectOverrides(id);
}

export function setObjectOverride(id: string, key: string, value: ConfigValue | undefined, partId?: string, rangeId?: string): void {
  if (rangeId) layers.setRangeOverride(id, rangeId, key, value);
  else if (partId) project.setPartOverride(id, partId, key, value);
  else project.setObjectOverride(id, key, value);
}

export function objectName(id: string, partId?: string, rangeId?: string): string | undefined {
  const o = project.getObject(id);
  if (rangeId) {
    const r = layers.getRange(id, rangeId);
    return r ? `${o?.name ?? 'Object'} › ${r.min}–${r.max} mm` : o?.name;
  }
  if (!partId) return o?.name;
  const p = o?.parts?.find((x) => x.id === partId);
  return p ? `${o!.name} › ${p.name}` : o?.name;
}

type SectionApi = (name: string, section: { save: () => unknown; load: (data: unknown) => void | Promise<void> }) => void;

let registered = false;

/** Register the `presets` project section (idempotent). Returns false if the store has no section API yet. */
export function registerPresetsSection(): boolean {
  if (registered) return true;
  const fn = (project as unknown as Record<string, unknown>).registerProjectSection;
  if (typeof fn !== 'function') return false;
  (fn as SectionApi)('presets', presetsProjectSection);
  registered = true;
  return true;
}

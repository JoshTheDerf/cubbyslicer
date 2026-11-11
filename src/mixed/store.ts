/**
 * Mixed filaments of the active presets (Orca 2.5 native colour mixing, see
 * model.ts): the list, adding / editing / removing one, and the colour of any
 * filament number. Mixed slots follow the physical ones, so objects, parts and
 * colour painting use them like any other filament.
 */
import { computed } from 'vue';
import { currentPresets } from '../presets/store';
import { SCALAR, valueAt } from '../lib/configValue';
import { mixedPreview } from '../engine/client';
import { MAX_FILAMENT_SLOTS, mixedProblems, setMeasuredBlendSource, type MixedDef, type MixedFilament } from './model';

export { mixedLabel, type MixedDef, type MixedFilament } from './model';

// Display colours use the engine's lab-measured blends where Orca has one (desktop does the same).
setMeasuredBlendSource(async (hexes, weights) => (mixedEnabled.value ? (await mixedPreview(hexes, hexes.map((_, i) => i + 1), weights)).measured : null));

/** The active engine and its schema have Orca's mixed filaments (a 2.5 engine). */
export const mixedEnabled = computed(() => currentPresets.value.mixedSupported());

/** Mixed filaments, in slot order (empty when the engine has none). */
export const mixedFilaments = computed<MixedFilament[]>(() => currentPresets.value.mixedFilaments());

/** Display colour of every filament slot, physical then mixed. */
export function filamentColours(): string[] {
  return currentPresets.value.filamentColours();
}

/** Colour of any filament number (1-based), physical or mixed. */
export function filamentColourOf(n: number): string {
  const p = currentPresets.value;
  return n >= 1 && n <= p.filamentSlotCount() ? p.filamentColour(n - 1) : '#888888';
}

/** Filament type of each physical slot (mixes must share one). */
export function physicalTypes(): string[] {
  const p = currentPresets.value;
  return p.selection.filaments.map((_, i) => valueAt(p.value('filament', 'filament_type', i), SCALAR) ?? '');
}

/** Broken or type-mismatched mixes (Orca's "Mixed filament has invalid or mismatched components" warning). */
export const mixedIssues = computed(() => mixedProblems(mixedFilaments.value, physicalTypes()));

/** Room for another mixed slot (physical + mixed ≤ 32, at least 2 physical). */
export const canAddMixed = computed(() => {
  const p = currentPresets.value;
  return mixedEnabled.value && p.selection.filaments.length >= 2 && p.filamentSlotCount() < MAX_FILAMENT_SLOTS;
});

/** Add a mixed filament at the end of the list; returns its filament number, or null when there's no room. */
export function addMixedFilament(def: MixedDef): number | null {
  if (!canAddMixed.value) return null;
  return currentPresets.value.setMixed([...currentPresets.value.mixedDefs(), def]);
}

export function updateMixedFilament(id: number, def: MixedDef): void {
  const p = currentPresets.value;
  const i = id - 1 - p.selection.filaments.length;
  const defs = p.mixedDefs();
  if (i < 0 || i >= defs.length) return;
  defs[i] = def;
  p.setMixed(defs);
}

/**
 * Remove mixed filament `id`. Like deleting any filament slot, objects, parts,
 * paint and plates that used it fall back to filament 1 / unpainted and later
 * slots are renumbered (presets/filamentRefs.ts).
 */
export function removeMixedFilament(id: number): void { currentPresets.value.removeMixed(id); }

/** Remove every mixed filament (last first, so references renumber the same way). */
export function removeAllMixedFilaments(): void {
  const p = currentPresets.value;
  for (const m of [...p.mixedFilaments()].reverse()) p.removeMixed(m.id);
}

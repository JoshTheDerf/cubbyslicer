/**
 * FullSpectrum mixed (virtual) filaments: colours made by alternating thin
 * layers of two or more physical filaments. The engine owns the model (its
 * MixedFilamentManager regenerates the auto pairs from the physical colours
 * and applies the user's rows from `mixed_filament_definitions`); this store
 * asks it for the resulting list (`cs_tool` op "mixed_filaments") and writes
 * edits back to that option. Virtual filaments are numbered after the
 * physical ones, so objects, parts and colour painting use them like any
 * other filament.
 */
import { computed, shallowRef, watch } from 'vue';
import { activeEngine } from '../app/state';
import { engineTool } from '../engine/client';
import { currentPresets } from '../presets/store';
import { toast } from '../ui';

export const DEFINITIONS_KEY = 'mixed_filament_definitions';

export interface MixedComponent { id: number; percent: number }
export interface MixedGradient { enabled: boolean; start: number; end: number; stops: number[]; solidWidths: number[] }

/** Editable part of a mixed filament (FullSpectrum MixedFilamentDefinition). */
export interface MixedDefinition {
  kind: 'blend' | 'pattern';
  components: MixedComponent[];
  /** Simple = Local-Z / pair blend; layer_cycle = whole layers A…B… by cadence. */
  distribution: 'simple' | 'layer_cycle';
  cadence: { a: number; b: number };
  /** Local-Z sublayer cap for this mix (0 = no cap). */
  localZMax: number;
  gradient: MixedGradient;
  /** Surface bias per component, mm (negative expands, positive recesses). */
  offsets: number[];
  offsetA: number;
  offsetB: number;
  perimeterModulation: boolean;
  /** Manual pattern: groups (walls) of physical filament ids. */
  pattern: number[][];
}

export interface MixedFilament extends MixedDefinition {
  /** Filament number (physical count + 1 …). */
  id: number;
  stableId: number;
  custom: boolean;
  a: number;
  b: number;
  /** Share of component b (0–100). */
  percent: number;
  color: string;
}

export type MixedEdit =
  | { op: 'add'; a: number; b: number; percent: number }
  | { op: 'add_definition'; definition: Partial<MixedDefinition> }
  | { op: 'set'; stableId: number; definition: Partial<MixedDefinition> }
  | { op: 'remove'; stableId: number }
  | { op: 'percent'; stableId: number; percent: number };

interface OpResult { definitions: string; filaments: MixedFilament[] }

export const mixedFilaments = shallowRef<MixedFilament[]>([]);
export const mixedEnabled = computed(() => activeEngine.value === 'fullspectrum');

function physicalColours(): string[] {
  const p = currentPresets.value;
  return p.selection.filaments.map((_, i) => p.filamentColour(i));
}

// Project-level value (FullSpectrum keeps mixed filaments with the project,
// like filament colours): PresetStore.project, which is resolved into the config.
function currentDefinitions(): string {
  const v = currentPresets.value.project[DEFINITIONS_KEY];
  return String((Array.isArray(v) ? v[0] : v) ?? '');
}
function storeDefinitions(value: string): void {
  const project = currentPresets.value.project;
  if (value) project[DEFINITIONS_KEY] = value; else delete project[DEFINITIONS_KEY];
}

async function run(edits: MixedEdit[] = []): Promise<OpResult | null> {
  if (!mixedEnabled.value) return null;
  const colors = physicalColours();
  if (colors.length < 2) return { definitions: currentDefinitions(), filaments: [] };
  // Plain data only: edits may carry reactive proxies (not structured-cloneable).
  const { result } = await engineTool<OpResult>('mixed_filaments', JSON.parse(JSON.stringify({ colors, definitions: currentDefinitions(), edits })), [], 'fullspectrum');
  return result;
}

let token = 0;
export async function refreshMixedFilaments(): Promise<void> {
  const t = ++token;
  try {
    const r = await run();
    if (t === token) mixedFilaments.value = r?.filaments ?? [];
  } catch {
    if (t === token) mixedFilaments.value = [];
  }
}

/** Apply edits (add / remove / re-mix) and store the engine's re-serialised rows. */
export async function editMixedFilaments(edits: MixedEdit[]): Promise<boolean> {
  try {
    const r = await run(edits);
    if (!r) return false;
    storeDefinitions(r.definitions);
    mixedFilaments.value = r.filaments;
    return true;
  } catch (e) {
    toast.error("Couldn't update the mixed filaments.", { detail: (e as Error)?.message });
    return false;
  }
}

/** Colour of any filament number, physical or mixed. */
export function filamentColourOf(n: number): string {
  const p = currentPresets.value;
  const physical = p.selection.filaments.length;
  if (n >= 1 && n <= physical) return p.filamentColour(n - 1);
  return mixedFilaments.value.find((m) => m.id === n)?.color ?? '#888888';
}

export function mixedLabel(m: MixedFilament): string {
  if (m.kind === 'pattern') return `Pattern ${m.pattern.map((g) => g.join('')).join(' / ')}`;
  const ids = m.components.map((c) => `F${c.id}`);
  if (m.gradient.enabled) return `Gradient ${ids.join(' → ')}`;
  if (m.components.length > 2) return m.components.map((c) => `F${c.id} ${c.percent}%`).join(' + ');
  return `F${m.a} ${100 - m.percent}% + F${m.b} ${m.percent}%`;
}

// ---- global colour-mixing settings (process or project level, per schema scope) ----

/** FullSpectrum colour-mixing options, grouped like its Print Settings ▸ Multimaterial ▸ Color Mixing. */
export const MIXED_SETTING_GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: 'Local-Z subdivision', keys: [
    'mixed_filament_height_lower_bound', 'dithering_local_z_mode', 'dithering_local_z_whole_objects',
    'dithering_local_z_preserve_first_layer', 'dithering_local_z_infill', 'dithering_local_z_direct_multicolor',
    'dithering_local_z_independent_layer_height'] },
  { title: 'Gradients', keys: ['dithering_local_z_gradient_layer_height', 'dithering_local_z_gradient_middle_filament_window', 'mixed_filament_gradient_mode'] },
  { title: 'Cadence', keys: ['mixed_color_layer_height_a', 'mixed_color_layer_height_b', 'dithering_z_step_size', 'dithering_step_painted_zones_only', 'mixed_filament_advanced_dithering'] },
  { title: 'Surface', keys: ['mixed_filament_component_bias_enabled', 'mixed_filament_surface_indentation', 'fs_surface_paint_only', 'fs_painted_zone_extra_perimeters', 'mixed_filament_region_collapse'] },
];

const isProjectScope = (key: string) => {
  const d = currentPresets.value.schema.value?.options[key];
  return !d || d.scope !== 'print';
};

export function mixedSetting(key: string): string {
  const p = currentPresets.value;
  const v = isProjectScope(key) ? p.project[key] ?? p.schema.value?.options[key]?.default : p.value('process', key);
  return String((Array.isArray(v) ? v[0] : v) ?? '');
}

export function setMixedSetting(key: string, value: string): void {
  const p = currentPresets.value;
  if (!isProjectScope(key)) { p.setValue('process', key, value); return; }
  const dflt = p.schema.value?.options[key]?.default;
  if (value === dflt) delete p.project[key]; else p.project[key] = value;
}

// Re-run when the engine, the physical colours or the definitions change.
let timer: ReturnType<typeof setTimeout> | null = null;
watch(() => [mixedEnabled.value, physicalColours().join(','), mixedEnabled.value ? currentDefinitions() : ''], () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void refreshMixedFilaments(); }, 150);
}, { immediate: true });

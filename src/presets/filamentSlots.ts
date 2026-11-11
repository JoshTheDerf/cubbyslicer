/**
 * Filament slots of an engine's presets: physical slots (`selection.filaments`)
 * followed by Orca 2.5 mixed filaments (project values, src/mixed/model.ts),
 * their colours, adding / removing slots, and the per-extruder nozzle choices
 * (`nozzle_volume_type`, Orca's sidebar "Flow" per extruder).
 */
import type { ConfigValue } from '../engine/types';
import { engineCaps } from '../engine/capabilities';
import { DEFAULT_FILAMENT_COLOUR, formatFilamentColour, parseFilamentColour, type FilamentColour } from '../lib/colour';
import { asList, toNumber, valueAt } from '../lib/configValue';
import {
  IS_MIXED, MAX_FILAMENT_SLOTS, MIXED_SLOT_KEYS, mixedColour, physicalEntries, readMixedSlots, remapOnDelete, writeMixedLayout,
  type MixedDef, type MixedFilament,
} from '../mixed/model';
import { applySlotChange, type SlotChange } from './filamentRefs';
import { presetFilamentColour } from './resolve';
import { DEFAULT_PRESET_ID } from './types';
import { extruderVariants, hasVariants } from './variants';
import { effectiveNozzleStats, formatNozzleStats, maxNozzleCounts, nozzleTotal, parseNozzleStats, statsAfterTypeSwitch } from './nozzleMaps';
import type { EnginePresets } from './enginePresets';

/** Colours handed to newly added filament slots (first unused wins, like Orca's get_next_color_for_filament). */
export const FILAMENT_PALETTE: readonly string[] = [
  '#F2754E', '#2E86DE', '#27AE60', '#F1C40F', '#8E44AD', '#E74C3C', '#1ABC9C', '#FFFFFF', '#34495E', '#E67E22', '#FF6FB5', '#95A5A6',
];
function nextFilamentColour(used: readonly string[]): string {
  const taken = new Set(used.map((c) => c.slice(0, 7).toUpperCase()));
  return FILAMENT_PALETTE.find((c) => !taken.has(c)) ?? FILAMENT_PALETTE[used.length % FILAMENT_PALETTE.length];
}

// ---- project lists --------------------------------------------------------------------------

/**
 * Per-slot project colour lists Orca keeps next to `filament_colour` (PlaterPresetComboBox::sync_colour_config):
 * every colour of the slot (space separated) and "0" gradient / "1" solid or segments. '' = derived.
 */
export const COLOUR_SIDE_KEYS = ['filament_multi_colour', 'filament_colour_type'] as const;

/**
 * The project's own colour of each physical slot ('' = the preset's), `n` long. An entry is the
 * `filament_colour` value, or for a slot with its own multi-colour / type `colour\nmulti\ntype`
 * (an in-memory encoding so slot moves carry all three; layoutSlots writes them back as lists).
 */
export function colourList(s: EnginePresets, n: number): string[] {
  const cur = physicalEntries(s.project, 'filament_colour');
  const multi = physicalEntries(s.project, 'filament_multi_colour');
  const type = physicalEntries(s.project, 'filament_colour_type');
  return Array.from({ length: n }, (_, i) => (multi[i] || type[i] ? `${cur[i] ?? ''}\n${multi[i] ?? ''}\n${type[i] ?? ''}` : cur[i] ?? ''));
}

/** Split a colourList entry into the three project values. */
export function colourEntry(e: string): { colour: string; multi: string; type: string } {
  const [colour = '', multi = '', type = ''] = e.split('\n');
  return { colour, multi, type };
}

/** Rewrite the per-slot project lists: the physical slots' own colours followed by the mixed filaments (Orca keeps them at the tail). */
export function layoutSlots(s: EnginePresets, physicalColours: string[], defs: MixedDef[]): void {
  for (const k of MIXED_SLOT_KEYS) delete s.project[k];
  const entries = physicalColours.slice(0, s.selection.filaments.length).map(colourEntry);
  s.project.filament_colour = entries.map((e) => e.colour);
  if (entries.some((e) => e.multi || e.type)) {
    s.project.filament_multi_colour = entries.map((e) => e.multi);
    s.project.filament_colour_type = entries.map((e) => e.type);
  } else for (const k of COLOUR_SIDE_KEYS) delete s.project[k];
  const shown = physicalColourList(s);
  writeMixedLayout(s.project, s.selection.filaments.length, defs, defs.map((d) => mixedColour(d, shown)));
}

// ---- colours ----------------------------------------------------------------------------------

/** Display colour of physical slot `index`: the project's choice, else the preset's (default_)filament_colour. */
function physicalColour(s: EnginePresets, index: number): string {
  const own = physicalEntries(s.project, 'filament_colour')[index];
  if (own) return own;
  const base = s.bases.value.filaments[index] ?? {};
  const tab = (k: string) => valueAt(s.value('filament', k, index), 0);
  return presetFilamentColour({ filament_colour: 'filament_colour' in base ? tab('filament_colour') : undefined, default_filament_colour: tab('default_filament_colour') })
    || tab('filament_colour') || DEFAULT_FILAMENT_COLOUR;
}

export function physicalColourList(s: EnginePresets): string[] {
  return s.selection.filaments.map((_, i) => physicalColour(s, i));
}

/** Display colour of filament slot `index`: physical, or a mix's blend. */
export function filamentColour(s: EnginePresets, index: number): string {
  const physical = s.selection.filaments.length;
  if (index < physical) return physicalColour(s, index);
  const m = readMixedSlots(s.project)[index - physical];
  return m ? mixedColour(m.def, physicalColourList(s)) : '#888888';
}

/** Display colour of every filament slot, physical then mixed. */
export function filamentColours(s: EnginePresets): string[] {
  const phys = physicalColourList(s);
  if (!mixedSupported(s)) return phys;
  return [...phys, ...readMixedSlots(s.project).map((m) => mixedColour(m.def, phys))];
}

export function setFilamentColour(s: EnginePresets, index: number, colour: string): void {
  if (index < 0 || index >= s.selection.filaments.length) return;
  const list = colourList(s, s.selection.filaments.length);
  list[index] = colour;
  layoutSlots(s, list, mixedDefs(s));
}

/**
 * Every colour of physical slot `index` (Orca `filament_color_picker_value`): the project's own
 * multi-colour / type, else its own single colour, else the preset's filament_multi_colour /
 * filament_colour_type, else the slot's colour.
 */
export function filamentColourSpec(s: EnginePresets, index: number): FilamentColour {
  const own = colourEntry(colourList(s, s.selection.filaments.length)[index] ?? '');
  if (own.multi) return parseFilamentColour(own.colour, own.multi, own.type, physicalColour(s, index));
  if (own.colour) return parseFilamentColour(own.colour);
  const tab = (k: string) => valueAt(s.value('filament', k, index), 0);
  return parseFilamentColour(physicalColour(s, index), tab('filament_multi_colour'), tab('filament_colour_type'), physicalColour(s, index));
}

/**
 * Set physical slot `index`'s colours from the picker (PlaterPresetComboBox::sync_colour_config):
 * filament_colour = the first, filament_multi_colour = all, filament_colour_type "0" gradient / "1".
 * Opaque colours keep the 6-digit spelling (filament_color_picker_result). null = the preset's colour.
 */
export function setFilamentColourSpec(s: EnginePresets, index: number, fc: FilamentColour | null): void {
  if (index < 0 || index >= s.selection.filaments.length) return;
  const list = colourList(s, s.selection.filaments.length);
  if (!fc) list[index] = '';
  else {
    const f = formatFilamentColour(fc);
    list[index] = `${f.filament_colour}\n${f.filament_multi_colour}\n${f.filament_colour_type}`;
  }
  layoutSlots(s, list, mixedDefs(s));
}

// ---- mixed filaments ----------------------------------------------------------------------------

export function mixedSupported(s: EnginePresets): boolean {
  return engineCaps(s.engine).mixedFilaments && !!s.schema.value?.options[IS_MIXED];
}

export function mixedDefs(s: EnginePresets): MixedDef[] {
  return readMixedSlots(s.project).map((m) => m.def);
}

export function mixedFilaments(s: EnginePresets): MixedFilament[] {
  if (!mixedSupported(s)) return [];
  const physical = s.selection.filaments.length;
  const colours = physicalColourList(s);
  return readMixedSlots(s.project).map((m, i) => ({ ...m.def, id: physical + i + 1, color: mixedColour(m.def, colours) }));
}

/** The slot count and the mixed-slot test after a layout change (for the process filament values). */
function slotsAfter(s: EnginePresets): [number, (n: number) => boolean] {
  const physical = s.selection.filaments.length;
  return [filamentSlotCount(s), (n) => n > physical];
}

export function filamentSlotCount(s: EnginePresets): number {
  return s.selection.filaments.length + (mixedSupported(s) ? readMixedSlots(s.project).length : 0);
}

/** Replace the mixed filaments; returns the last one's filament number (null when none). */
export function setMixed(s: EnginePresets, defs: MixedDef[]): number | null {
  const keep = defs.slice(0, Math.max(0, MAX_FILAMENT_SLOTS - s.selection.filaments.length));
  layoutSlots(s, colourList(s, s.selection.filaments.length), keep);
  return keep.length ? s.selection.filaments.length + keep.length : null;
}

/** Remove mixed filament number `id` (1-based slot); references to it and the later slots are renumbered. */
export function removeMixed(s: EnginePresets, id: number): void {
  const i = id - 1 - s.selection.filaments.length;
  const defs = mixedDefs(s);
  if (i < 0 || i >= defs.length) return;
  defs.splice(i, 1);
  setMixed(s, defs);
  applySlotChange({ kind: 'delete', slot: id }, s, ...slotsAfter(s));
}

// ---- adding / removing physical slots -----------------------------------------------------------

/**
 * Physical slot count (single-extruder multi-material). New slots go in
 * front of the mixed tail and references to the mixes move up
 * (Sidebar::add_custom_filament); shrinking deletes the last slots one by
 * one like Orca's "−" button (Sidebar::delete_filament).
 */
export async function setFilamentCount(s: EnginePresets, n: number): Promise<void> {
  const count = Math.max(1, Math.min(MAX_FILAMENT_SLOTS - mixedDefs(s).length, Math.floor(n)));
  const prev = s.selection.filaments.length;
  if (count < prev) {
    for (let i = prev - 1; i >= count; i--) removeSlot(s, i);
    await s.refresh({ keepSelection: true });
    return;
  }
  const defs = mixedDefs(s);
  const colours = colourList(s, count);
  const sel = s.selection.filaments.slice(0, count);
  while (sel.length < count) sel.push(sel[sel.length - 1] ?? DEFAULT_PRESET_ID);
  s.selection.filaments = sel;
  while (s.overrides.filaments.length < count) s.overrides.filaments.push({});
  s.overrides.filaments.splice(count);
  for (let i = prev; i < count; i++) colours[i] = nextFilamentColour(colours.slice(0, i).map((c, j) => colourEntry(c).colour || filamentColour(s, j)));
  layoutSlots(s, colours, defs);
  if (count > prev) applySlotChange({ kind: 'insert', at: prev + 1, count: count - prev }, s, ...slotsAfter(s));
  await s.refresh({ keepSelection: true });
}

function removeSlot(s: EnginePresets, index: number): void {
  const n = s.selection.filaments.length;
  if (n <= 1 || index < 0 || index >= n) return;
  const colours = colourList(s, n);
  colours.splice(index, 1);
  const defs = remapOnDelete(mixedDefs(s), index + 1);
  s.selection.filaments = s.selection.filaments.filter((_, i) => i !== index);
  s.overrides.filaments.splice(index, 1);
  layoutSlots(s, colours, defs);
  applySlotChange({ kind: 'delete', slot: index + 1 }, s, ...slotsAfter(s));
}

/**
 * Remove physical filament slot `index` (Orca's per-row delete), keeping the
 * other slots' presets, edits and colours. Mixes that used it lose that
 * component (remap_mixed_components_on_delete); objects, parts, paint and
 * plates are renumbered (filamentRefs.ts).
 */
export async function removeFilament(s: EnginePresets, index: number): Promise<void> {
  const n = s.selection.filaments.length;
  if (n <= 1 || index < 0 || index >= n) return;
  removeSlot(s, index);
  await s.refresh({ keepSelection: true });
}

export type { SlotChange };

// ---- nozzles (Orca 2.5 sidebar: diameter + flow per extruder) ------------------------------------

/** The printer's extruders: extruder type and the nozzle volume types its profile has values for. */
export function extruders(s: EnginePresets) {
  return extruderVariants(s.bases.value.printer);
}

/** The profile differs per extruder / flow type (support_different_extruders). */
export function printerHasVariants(s: EnginePresets): boolean {
  return hasVariants(s.bases.value.printer);
}

/**
 * Each extruder's nozzle volume type (`nozzle_volume_type`, project config):
 * the project's choice when the printer offers it, else the printer's
 * `default_nozzle_volume_type`, else Standard.
 */
export function nozzleVolumeTypes(s: EnginePresets): string[] {
  const ex = extruders(s);
  const own = asList(s.project.nozzle_volume_type as ConfigValue | undefined);
  const dflt = asList(s.value('printer', 'default_nozzle_volume_type'));
  return ex.map((e, i) => {
    const offered = (t: string | undefined) => !!t && (e.volumeTypes.includes(t) || (t === 'Hybrid' && e.multiNozzle));
    return [own[i], dflt[i], dflt[0]].find(offered) ?? e.volumeTypes[0] ?? 'Standard';
  });
}

export function setNozzleVolumeType(s: EnginePresets, extruder: number, type: string): void {
  const list = nozzleVolumeTypes(s);
  if (extruder < 0 || extruder >= list.length) return;
  const stats = nozzleStats(s);
  list[extruder] = type;
  s.project.nozzle_volume_type = list;
  // onNozzleVolumeTypeSwitch: the rack follows a single-type switch (a Hybrid one keeps its split).
  if (stats && s.project.extruder_nozzle_stats !== undefined) {
    s.project.extruder_nozzle_stats = statsAfterTypeSwitch(stats, extruder, type, maxNozzleCounts({ extruder_max_nozzle_count: s.value('printer', 'extruder_max_nozzle_count') ?? '1' }, list.length)[extruder]);
  }
}

/**
 * `extruder_nozzle_stats` of a printer with a nozzle rack (H2C): the project's
 * split when it fits the printer, else desktop's seed (seedExtruderNozzleStats).
 * null when no extruder holds several nozzles.
 */
export function nozzleStats(s: EnginePresets): string[] | null {
  if (!s.schema.value?.options.extruder_nozzle_stats) return null;
  const vt = nozzleVolumeTypes(s);
  const max = maxNozzleCounts({ extruder_max_nozzle_count: s.value('printer', 'extruder_max_nozzle_count') ?? '1' }, vt.length);
  if (!max.some((n) => n > 1)) return null;
  return effectiveNozzleStats(asList(s.project.extruder_nozzle_stats as ConfigValue | undefined), vt, max);
}

/**
 * Replace an extruder's rack (the "Set nozzle count" dialog's Confirm: a Hybrid extruder's types all at
 * once, a single-type extruder its one type). Counts above the rack size or an empty rack are refused.
 */
export function setNozzleCounts(s: EnginePresets, extruder: number, counts: Record<string, number>): boolean {
  const stats = nozzleStats(s);
  if (!stats || extruder < 0 || extruder >= stats.length) return false;
  const max = maxNozzleCounts({ extruder_max_nozzle_count: s.value('printer', 'extruder_max_nozzle_count') ?? '1' }, stats.length)[extruder];
  const c = Object.fromEntries(Object.entries(counts).map(([t, n]) => [t, Math.max(0, Math.trunc(n))]));
  const total = nozzleTotal(c);
  // ManualNozzleCountDialog force_no_zero: a Hybrid extruder, or the other extruder already empty.
  const hybrid = nozzleVolumeTypes(s)[extruder] === 'Hybrid';
  const othersHave = stats.some((x, e) => e !== extruder && nozzleTotal(parseNozzleStats(x)) > 0);
  if ((total < 1 && (hybrid || !othersHave)) || total > max) return false;
  const next = stats.slice();
  next[extruder] = total ? formatNozzleStats(c) : `${Object.keys(c)[0] ?? nozzleVolumeTypes(s)[extruder] ?? 'Standard'}#0`;
  s.project.extruder_nozzle_stats = next;
  return true;
}

/** Set how many nozzles of `type` an extruder's rack holds (the other types keep theirs, capped by the rack size). */
export function setNozzleCount(s: EnginePresets, extruder: number, type: string, count: number): void {
  const stats = nozzleStats(s);
  if (!stats || extruder < 0 || extruder >= stats.length) return;
  const max = maxNozzleCounts({ extruder_max_nozzle_count: s.value('printer', 'extruder_max_nozzle_count') ?? '1' }, stats.length)[extruder];
  const c = parseNozzleStats(stats[extruder]);
  const others = nozzleTotal(c) - (c[type] ?? 0);
  c[type] = Math.max(0, Math.min(Math.trunc(count), max - others));
  const next = stats.slice();
  next[extruder] = formatNozzleStats(c) || stats[extruder];
  s.project.extruder_nozzle_stats = next;
}

/**
 * Purge mode choices of the printer (Tab.cpp: Prime Saving needs an extruder with
 * several sub-nozzles, Fast needs `support_fast_purge_mode`); [] = no choice.
 */
export function purgeModes(s: EnginePresets): Array<'Default' | 'Saving' | 'Fast'> {
  if (!s.schema.value?.options.prime_volume_mode) return [];
  const multi = asList(s.value('printer', 'extruder_max_nozzle_count')).some((v) => toNumber(v, 1) > 1);
  const fast = valueAt(s.value('printer', 'support_fast_purge_mode'), 0) === '1';
  if (!multi && !fast) return [];
  return ['Default', ...(fast ? ['Fast' as const] : multi ? ['Saving' as const] : [])];
}

/** `prime_volume_mode`, reset to Default when the printer can't honour it. */
export function purgeMode(s: EnginePresets): 'Default' | 'Saving' | 'Fast' {
  const v = valueAt(s.project.prime_volume_mode as ConfigValue | undefined, 0);
  return purgeModes(s).includes(v as 'Saving') ? (v as 'Saving' | 'Fast') : 'Default';
}

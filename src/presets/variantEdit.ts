/**
 * Editing per-variant values (Orca 2.5 Tab: the extruder / variant switch at
 * the top of the process, printer and filament settings, Tab::switch_excluder,
 * Tab::sync_excluder).
 *
 * A per-variant row shows one element of its vector: the column of the
 * variant being edited. Process and printer tabs edit "the selected
 * extruder" with that extruder's current flow type (sidebar); filament tabs
 * pick one of the filament's own variant columns. The vectors themselves stay
 * full width; edits change one column, and the edited-vs-inherited marker is
 * per column.
 */
import { reactive } from 'vue';
import type { ConfigValue, FlatConfig } from '../engine/types';
import { asList, variantColumn, variantName, type VariantFamily } from '../lib/configValue';
import type { PresetKind } from './types';
import { cloneValue, valuesEqual } from './values';
import { columnCount, familyOfKind, fitLength, layoutKeys, shortVolumeName, variantKey, VARIANT_LAYOUT } from './variants';
import { extruders, nozzleVolumeTypes, printerHasVariants } from './filamentSlots';
import type { EnginePresets } from './enginePresets';

/** Which variant the settings editors show (UI state, shared by every engine). */
export const variantEdit = reactive({
  /** Extruder (0-based) the process / printer variant rows show. */
  extruder: 0,
  /** Filament tab: column of the filament's own variant list; -1 = the column its extruder prints with. */
  filamentColumn: -1,
});

export interface VariantTag {
  value: number;
  label: string;
  /** Full description ("Left nozzle, High Flow"). */
  title: string;
  modified: boolean;
}

/** The layout keys (column names) of a tab, with its current values. */
function layoutOf(s: EnginePresets, kind: PresetKind, index: number): FlatConfig {
  const out: FlatConfig = {};
  for (const k of layoutKeys(familyOfKind(kind))) { const v = s.value(kind, k, index); if (v !== undefined) out[k] = v; }
  return out;
}

/** Element of `key`'s vector the editor shows for `extruder` (process / printer), or undefined for keys that aren't per-variant. */
export function variantElement(s: EnginePresets, kind: PresetKind, key: string, index = 0, extruder = variantEdit.extruder): number | undefined {
  const info = variantKey(s.schema.value, key);
  const family = familyOfKind(kind);
  if (!info || info.family !== family) return undefined;
  const col = editColumn(s, kind, index, extruder);
  return col === undefined ? undefined : col * info.stride;
}

/** The variant column edited on a tab (undefined: the tab has a single column). */
function editColumn(s: EnginePresets, kind: PresetKind, index = 0, extruder = variantEdit.extruder): number | undefined {
  const family = familyOfKind(kind);
  const layout = layoutOf(s, kind, index);
  const columns = asList(layout[VARIANT_LAYOUT[family].variant]).length;
  if (columns <= 1) return undefined;
  if (family === 'filament') {
    const c = variantEdit.filamentColumn;
    if (c >= 0 && c < columns) return c;
    return Math.max(0, filamentDefaultColumn(s, index, layout));
  }
  const ex = extruders(s);
  const e = Math.min(Math.max(0, extruder), ex.length - 1);
  const cfg: FlatConfig = { ...layout, extruder_type: ex.map((x) => x.type), nozzle_volume_type: nozzleVolumeTypes(s), extruder_variant_list: s.value('printer', 'extruder_variant_list') ?? [] };
  const col = variantColumn(cfg, family as Exclude<VariantFamily, 'filament'>, { extruderId: e + 1, extruderType: ex[e]?.type ?? 'Direct Drive', nozzleVolumeType: nozzleVolumeTypes(s)[e] ?? 'Standard' });
  return col >= 0 ? col : undefined;
}

/** A filament's column for the extruder it is mapped to (filament_map) and that extruder's flow type. */
function filamentDefaultColumn(s: EnginePresets, index: number, layout: FlatConfig): number {
  const map = asList(s.project.filament_map as ConfigValue | undefined);
  const ex = extruders(s);
  const e = Math.min(Math.max(0, (parseInt(map[index] ?? '1', 10) || 1) - 1), ex.length - 1);
  const want = variantName(ex[e]?.type ?? 'Direct Drive', nozzleVolumeTypes(s)[e] ?? 'Standard');
  return asList(layout[VARIANT_LAYOUT.filament.variant]).indexOf(want);
}

/** Options of the switch at the top of a settings tab ([] = no switch: one extruder / one variant). */
export function variantTags(s: EnginePresets, kind: PresetKind, index = 0): VariantTag[] {
  if (kind === 'filament') {
    const vars = asList(s.value('filament', VARIANT_LAYOUT.filament.variant, index));
    if (vars.length <= 1) return [];
    return vars.map((v, c) => {
      const vol = ['Extra High Flow', 'TPU High Flow', 'E3D High Flow', 'High Flow', 'Standard'].find((t) => v.endsWith(` ${t}`)) ?? '';
      const drive = vol ? v.slice(0, -vol.length - 1) : v;
      return { value: c, label: `${drive} ${shortVolumeName(vol)}`.trim(), title: v, modified: columnModified(s, kind, index, c) };
    });
  }
  const ex = extruders(s);
  if (ex.length < 2 || (kind === 'process' && !printerHasVariants(s))) return [];
  const vols = nozzleVolumeTypes(s);
  const bbl = ex.length === 2 && s.infos.value.printer.vendor === 'BBL';
  return ex.map((_, e) => {
    const name = bbl ? (e === 0 ? 'Left' : 'Right') : kind === 'printer' ? `Extruder ${e + 1}` : `T${e + 1}`;
    const col = editColumn(s, kind, index, e);
    return {
      value: e,
      label: kind === 'printer' ? name : `${name} ${shortVolumeName(vols[e] === 'Hybrid' ? 'Standard' : vols[e])}`,
      title: `${bbl ? `${name} nozzle` : `Extruder ${e + 1}`}, ${vols[e] ?? 'Standard'}`,
      modified: col !== undefined && columnModified(s, kind, index, col),
    };
  });
}

/** Some per-variant value of the tab differs from the preset in column `col`. */
function columnModified(s: EnginePresets, kind: PresetKind, index: number, col: number): boolean {
  const ov = s.overrideBag(kind, index);
  const family = familyOfKind(kind);
  return Object.keys(ov).some((k) => {
    const info = variantKey(s.schema.value, k);
    return !!info && info.family === family && elementModified(s, kind, k, index, col * info.stride);
  });
}

/** Element `element` of a vector key differs from the preset's (unsaved edit). */
export function elementModified(s: EnginePresets, kind: PresetKind, key: string, index: number, element: number): boolean {
  if (!s.isModified(kind, key, index)) return false;
  const a = asList(s.value(kind, key, index)), b = asList(s.presetValue(kind, key, index));
  return (a[element] ?? a[0]) !== (b[element] ?? b[0]);
}

/** The tab's column count for a family key's vector (× stride). */
function fullLength(s: EnginePresets, kind: PresetKind, key: string, index: number): number {
  const info = variantKey(s.schema.value, key)!;
  const layout = layoutOf(s, kind, index);
  if (kind === 'printer' && layout.printer_extruder_variant === undefined) layout.nozzle_diameter = s.value('printer', 'nozzle_diameter') ?? [];
  return columnCount(layout, info.family) * info.stride;
}

/** The tab's full-width vector of a per-variant key with element `element` set to `v`. */
export function withElement(s: EnginePresets, kind: PresetKind, key: string, index: number, element: number, v: string): string[] {
  const cur = fitLength(asList(s.value(kind, key, index)), fullLength(s, kind, key, index)).slice();
  while (cur.length <= element) cur.push(cur[0] ?? v);
  cur[element] = v;
  return cur;
}

/** Set one element of a per-variant vector (the vector padded to its full width first). */
export function setVariantElement(s: EnginePresets, kind: PresetKind, key: string, index: number, element: number, v: string): void {
  s.setValue(kind, key, withElement(s, kind, key, index, element, v), index);
}

/** Revert one element to the preset's value (the key's override goes once nothing differs). */
export function revertVariantElement(s: EnginePresets, kind: PresetKind, key: string, index: number, element: number): void {
  const base = asList(s.presetValue(kind, key, index));
  const v = base[element] ?? base[0];
  if (v !== undefined) setVariantElement(s, kind, key, index, element, v);
}

/**
 * "A value entered once applies to every variant": a single value for a key
 * whose preset has several columns fills them all (Orca 2.5 release notes:
 * an object setting entered as a single value applies to every nozzle).
 */
export function spreadSingleValue(s: EnginePresets, kind: PresetKind, key: string, v: ConfigValue, index: number): ConfigValue {
  const info = variantKey(s.schema.value, key);
  if (!info || info.family !== familyOfKind(kind)) return v;
  const list = asList(v);
  if (list.length !== 1) return v;
  const n = Math.max(asList(s.presetValue(kind, key, index)).length, fullLength(s, kind, key, index));
  return n > 1 ? new Array<string>(n).fill(list[0]) : v;
}

/**
 * Tab::sync_excluder: copy the edited values of extruder `from`'s column to
 * the other extruder's column with the same flow type (two-extruder printers).
 * Returns the number of keys changed.
 */
export function syncVariantColumns(s: EnginePresets, kind: 'process' | 'printer', from = variantEdit.extruder): number {
  const ex = extruders(s);
  if (ex.length !== 2) return 0;
  const vols = nozzleVolumeTypes(s);
  const family = familyOfKind(kind);
  const layout = layoutOf(s, kind, 0);
  const colOf = (e: number) => variantColumn({ ...layout, extruder_variant_list: s.value('printer', 'extruder_variant_list') ?? [] },
    family as Exclude<VariantFamily, 'filament'>, { extruderId: e + 1, extruderType: ex[e].type, nozzleVolumeType: vols[from] ?? 'Standard' });
  const src = colOf(from), dst = colOf(1 - from);
  if (src < 0 || dst < 0 || src === dst) return 0;
  let n = 0;
  for (const key of Object.keys(s.overrideBag(kind, 0))) {
    const info = variantKey(s.schema.value, key);
    if (!info || info.family !== family) continue;
    const cur = fitLength(asList(s.value(kind, key, 0)), fullLength(s, kind, key, 0));
    let dirty = false;
    for (let j = 0; j < info.stride; j++) dirty ||= elementModified(s, kind, key, 0, src * info.stride + j);
    if (!dirty) continue;
    const next = cur.slice();
    for (let j = 0; j < info.stride; j++) next[dst * info.stride + j] = cur[src * info.stride + j];
    if (valuesEqual(next, cur)) continue;
    s.setValue(kind, key, cloneValue(next), 0);
    n++;
  }
  return n;
}

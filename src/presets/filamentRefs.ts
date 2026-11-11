/**
 * Renumbering filament references when filament slots are removed or
 * inserted — the one place for physical and mixed slots alike, doing what
 * desktop Orca 2.5 does and nothing more.
 *
 * Deleting filament N (1-based), optionally merged into R (Sidebar::delete_filament →
 * PartPlateList::on_filament_deleted, Plater::on_filaments_delete,
 * ObjectList::update_filament_values_for_items_when_delete_filament,
 * ModelVolume::update_extruder_count_when_delete_filament, then the print tab's update()):
 * - object / part `extruder` = N → R (default 1); > N → − 1;
 * - height range `extruder` = N → R (default 0: the object's filament); > N → − 1;
 * - object / part `support_filament` / `support_interface_filament` = N → removed; > N → − 1
 *   (desktop writes a part's renumbered value onto its object — a slip; the part's own is renumbered here);
 * - process `support_filament` / `support_interface_filament`: only a value now past the last slot changes,
 *   to the Plater copy's renumbered value (N → 0, else − 1); smaller values stay as they are;
 * - process `wipe_tower_filament` and the "Filament for Features" ids are not renumbered; a value past
 *   the last slot is left for full_config to clamp (`clampFilamentIndexKeys`); support / wipe tower
 *   values pointing at a mixed slot reset to 0 (update_print_fff_config);
 * - colour paint states = N → R (default: unpainted); > N → − 1;
 * - layer slider tool changes to N are dropped (or moved to R), later tool changes − 1; colour
 *   changes are not touched;
 * - per-slot lists (`filament_map`, `filament_volume_map`, `filament_nozzle_map`) lose entry N;
 *   plate print sequences drop N and renumber the rest.
 * Inserting a physical slot ahead of the mixed tail (Sidebar::add_custom_filament) moves only object
 * and part `extruder` and colour paint ≥ the new number up; the project's per-slot lists get the new
 * entry in place, each plate's are appended to (PartPlate::on_filament_added).
 */
import { NOZZLE_VOLUME_TYPE_IDS, SCALAR, asList, valueAt } from '../lib/configValue';
import type { ConfigValue, CustomGcodeItem, FlatConfig, PaintLayers, PaintMap } from '../engine/types';
import { meshPaint, mutate, objects, plates } from '../project/store';
import type { LayerRange, ObjectPart, ProjectObject } from '../project/types';
import type { PlateMeta } from '../project/plates';
import type { PresetValues } from './types';

export type SlotChange =
  /** Filament `slot` (1-based) removed; its references go to `replace` (1-based, numbered after the removal) when given. */
  | { kind: 'delete'; slot: number; replace?: number }
  /** `count` slots inserted so that the first new one is number `at` (1-based). */
  | { kind: 'insert'; at: number; count: number };

/** A filament number after the change; `orDefault` for a reference to the deleted slot without a replacement (null = drop it). */
export function remapFilamentId(id: number, c: SlotChange, orDefault: number | null): number | null {
  if (!Number.isFinite(id) || id < 1) return id;
  if (c.kind === 'insert') return id >= c.at ? id + c.count : id;
  if (id === c.slot) return c.replace ?? orDefault;
  return id > c.slot ? id - 1 : id;
}

/** Support filaments: the keys desktop renumbers on objects and parts. */
export const SUPPORT_FILAMENT_KEYS = ['support_filament', 'support_interface_filament'] as const;
/** Every 1-based filament number key of the process (PresetBundle::full_fff_config). */
export const PHYSICAL_FILAMENT_KEYS = ['support_filament', 'support_interface_filament', 'wipe_tower_filament'] as const;
export const FEATURE_FILAMENT_ID_KEYS = [
  'outer_wall_filament_id', 'inner_wall_filament_id', 'sparse_infill_filament_id', 'internal_solid_filament_id',
  'top_surface_filament_id', 'bottom_surface_filament_id',
] as const;
/** Keys the Plater keeps its own copy of (Plater::priv config); others read back as unset (0). */
const PLATER_COPY = new Set(['support_filament', 'support_interface_filament', 'wipe_tower_filament', 'outer_wall_filament_id', 'inner_wall_filament_id', 'sparse_infill_filament_id']);

/** Per-slot lists that lose / gain an entry with the slot, and the value a new entry gets (set_num_filaments). */
const SLOT_LISTS: Record<string, string> = { filament_map: '1', filament_volume_map: '0', filament_nozzle_map: '0' };

const num = (v: ConfigValue | undefined): number => parseInt(valueAt(v, SCALAR) ?? '', 10);

/**
 * Remap the filament keys of an override bag; the same object when nothing changed. `extruderDefault`:
 * what `extruder` = N becomes without a replacement (null = remove it). `support`: renumber the support
 * filaments too (objects and parts; not height ranges).
 */
export function remapOverrides(ov: Record<string, ConfigValue>, c: SlotChange, extruderDefault: number | null, support = c.kind === 'delete'): Record<string, ConfigValue> {
  let out: Record<string, ConfigValue> | null = null;
  const set = (k: string, id: number | null) => {
    out ??= { ...ov };
    if (id === null) delete out[k]; else out[k] = String(id);
  };
  if (ov.extruder !== undefined) {
    const id = num(ov.extruder);
    const next = remapFilamentId(id, c, extruderDefault);
    if (next !== id) set('extruder', next);
  }
  if (support && c.kind === 'delete') {
    for (const k of SUPPORT_FILAMENT_KEYS) {
      if (ov[k] === undefined) continue;
      const id = num(ov[k]);
      if (id === c.slot) { set(k, null); continue; }
      if (id > c.slot) set(k, id - 1);
    }
  }
  return out ?? ov;
}

/**
 * The process values after deleting filament `slot` of `before` slots (Plater::on_filaments_delete on
 * its config copy, then update_print_fff_config's reset_invalid_filament): what changes, by key.
 * `isMixed(n)`: slot n (1-based, after the change) is a mixed filament.
 */
export function processFilamentWrites(get: (k: string) => ConfigValue | undefined, c: SlotChange, after: number, isMixed: (n: number) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  const check = (k: string, allowMixed: boolean) => {
    const raw = get(k);
    if (raw === undefined) return;
    const v = num(raw);
    if (!Number.isFinite(v)) return;
    let next = v;
    if (v > after) {
      if (!PLATER_COPY.has(k)) next = 0;
      else if (c.kind === 'delete' && (SUPPORT_FILAMENT_KEYS as readonly string[]).includes(k)) next = v === c.slot ? 0 : v > c.slot ? v - 1 : v;
      // else: the Plater copy holds the same value, so it stays (full_config clamps it).
    } else if (!allowMixed && v > 0 && isMixed(v)) next = 0;
    if (next !== v) out[k] = String(next);
  };
  PHYSICAL_FILAMENT_KEYS.forEach((k) => check(k, false));
  FEATURE_FILAMENT_ID_KEYS.forEach((k) => check(k, true));
  return out;
}

/**
 * PresetBundle::full_fff_config: support / interface / wipe tower filaments clamped to [0, slots],
 * "Filament for Features" ids past the last slot (or negative) back to 0. Mutates and returns `cfg`.
 */
export function clampFilamentIndexKeys(cfg: FlatConfig, slots: number): FlatConfig {
  for (const k of PHYSICAL_FILAMENT_KEYS) {
    if (cfg[k] === undefined) continue;
    const v = num(cfg[k]);
    if (Number.isFinite(v) && (v < 0 || v > slots)) cfg[k] = String(Math.min(Math.max(v, 0), slots));
  }
  for (const k of FEATURE_FILAMENT_ID_KEYS) {
    if (cfg[k] === undefined) continue;
    const v = num(cfg[k]);
    if (Number.isFinite(v) && (v < 0 || v > slots)) cfg[k] = '0';
  }
  return cfg;
}

// ---- colour paint (TriangleSelector bitstream, 3MF hex strings) -------------------------------

const HEX = '0123456789ABCDEF';

/**
 * Remap the states of one triangle's paint string (FacetsAnnotation
 * get_triangle_as_string). The string is read from its last character; each
 * nibble is a split node (low two bits = split sides) or a leaf: state << 2 for
 * states 0–2, 0b1100 + (state − 3) for 3–17, 0b1100 0b1111 + (state − 18) above.
 */
export function remapPaintString(s: string, map: (state: number) => number): string {
  const nib = s.toUpperCase().split('').reverse().map((ch) => HEX.indexOf(ch));
  if (nib.some((n) => n < 0)) return s;
  const out: number[] = [];
  let changed = false;
  for (let i = 0; i < nib.length;) {
    const code = nib[i++];
    if ((code & 0b11) !== 0) { out.push(code); continue; } // split node
    let state: number;
    if ((code & 0b1100) === 0b1100) {
      const a = nib[i++];
      if (a === undefined) return s;
      if (a === 0b1111) { const b = nib[i++]; if (b === undefined) return s; state = b + 18; } else state = a + 3;
    } else state = code >> 2;
    const next = Math.max(0, map(state));
    if (next !== state) changed = true;
    if (next < 3) out.push(next << 2);
    else if (next < 18) out.push(0b1100, next - 3);
    else out.push(0b1100, 0b1111, next - 18);
  }
  return changed ? out.map((n) => HEX[n]).reverse().join('') : s;
}

/** Paint states are filament numbers (0 = unpainted: the part's filament). */
export function paintStateMap(c: SlotChange): (state: number) => number {
  return (st) => (st === 0 ? 0 : remapFilamentId(st, c, 0) ?? 0);
}

export function remapPaintMap(m: PaintMap, c: SlotChange): PaintMap {
  const f = paintStateMap(c);
  let changed = false;
  const out = m.map(([t, hex]) => {
    const n = remapPaintString(hex, f);
    if (n !== hex) changed = true;
    return [t, n] as [number, string];
  }).filter(([, hex]) => hex !== '0'); // a whole triangle back to unpainted
  return changed || out.length !== m.length ? out : m;
}

// ---- plates ---------------------------------------------------------------------------------

function remapList(v: ConfigValue, c: SlotChange, fill: string, append: boolean): ConfigValue {
  const list = Array.isArray(v) ? v.slice() : String(v).split(',');
  if (c.kind === 'delete') { if (c.slot - 1 < list.length) list.splice(c.slot - 1, 1); }
  else if (append) list.push(...new Array<string>(c.count).fill(fill));
  else if (c.at - 1 <= list.length) list.splice(c.at - 1, 0, ...new Array<string>(c.count).fill(fill));
  return Array.isArray(v) ? list : list.join(',');
}

const ints = (v: ConfigValue): number[] => (Array.isArray(v) ? v : String(v).split(',')).map((x) => parseInt(String(x), 10));
const like = (v: ConfigValue, list: number[]): ConfigValue => (Array.isArray(v) ? list.map(String) : list.join(','));
/** Drop filament `slot` from an order and renumber the later ones. */
const dropFrom = (order: number[], slot: number) => order.filter((n) => n !== slot).map((n) => (n > slot ? n - 1 : n));

/**
 * PartPlate::update_first_layer_print_sequence_when_delete_filament: the first layer order (unless empty /
 * auto) and every other-layers entry ([begin, end, order…] × other_layers_print_sequence_nums).
 */
function remapSequences(cfg: Record<string, ConfigValue>, slot: number): Record<string, ConfigValue> | null {
  let out: Record<string, ConfigValue> | null = null;
  const first = cfg.first_layer_print_sequence;
  if (first !== undefined) {
    const list = ints(first);
    if (list.length && list[0] !== 0) (out ??= { ...cfg }).first_layer_print_sequence = like(first, dropFrom(list, slot));
  }
  const other = cfg.other_layers_print_sequence;
  const n = parseInt(String(valueAt(cfg.other_layers_print_sequence_nums, SCALAR) ?? '0'), 10) || 0;
  if (other !== undefined && n > 0) {
    const flat = ints(other);
    if (flat.length % n === 0) {
      const per = flat.length / n;
      const entries: number[][] = [];
      for (let i = 0; i < n; i++) { const e = flat.slice(i * per, (i + 1) * per); entries.push([e[0], e[1], ...dropFrom(e.slice(2), slot)]); }
      // Entries keep one length (the list is flat): an order that lost an entry everywhere stays rectangular.
      if (entries.every((e) => e.length === entries[0].length)) (out ??= { ...cfg }).other_layers_print_sequence = like(other, entries.flat());
    }
  }
  return out;
}

/** Per-slot project / plate lists (filament_map, …) after the change; plates (`plate`) append on insert and fix their sequences. */
export function remapSlotLists(cfg: Record<string, ConfigValue>, c: SlotChange, plate = false, volumeFill = '0'): Record<string, ConfigValue> {
  let out: Record<string, ConfigValue> | null = null;
  for (const [k, fill] of Object.entries(SLOT_LISTS)) {
    if (cfg[k] !== undefined) (out ??= { ...cfg })[k] = remapList(cfg[k], c, k === 'filament_volume_map' ? volumeFill : fill, plate);
  }
  if (plate && c.kind === 'delete') {
    const seq = remapSequences(out ?? cfg, c.slot);
    if (seq) out = seq;
  }
  return out ?? cfg;
}

/** Plater::on_filaments_delete: tool changes only (colour changes keep their filament). */
function remapGcodes(list: CustomGcodeItem[], c: SlotChange): CustomGcodeItem[] {
  if (c.kind !== 'delete') return list;
  const out: CustomGcodeItem[] = [];
  for (const g of list) {
    if (g.type !== 'tool_change' || !g.extruder) { out.push(g); continue; }
    const id = remapFilamentId(g.extruder, c, null);
    if (id === null) continue;
    out.push(id === g.extruder ? g : { ...g, extruder: id });
  }
  return out;
}

// ---- applying it to the project --------------------------------------------------------------

function remapObject(o: ProjectObject, c: SlotChange): ProjectObject {
  const overrides = remapOverrides(o.overrides, c, 1);
  const parts = o.parts?.map((pt): ObjectPart => {
    const ov = remapOverrides(pt.overrides, c, 1);
    return ov === pt.overrides ? pt : { ...pt, overrides: ov };
  });
  // Height ranges: delete only, extruder only (add_custom_filament leaves them).
  const layerRanges = c.kind === 'delete' ? o.layerRanges?.map((r): LayerRange => {
    const ov = remapOverrides(r.overrides, c, 0, false);
    return ov === r.overrides ? r : { ...r, overrides: ov };
  }) : o.layerRanges;
  const same = overrides === o.overrides && (parts ?? []).every((p, i) => p === o.parts![i]) && (layerRanges ?? []).every((r, i) => r === o.layerRanges![i]);
  return same ? o : { ...o, overrides, ...(parts ? { parts } : {}), ...(layerRanges ? { layerRanges } : {}) };
}

function remapPlate(p: PlateMeta, c: SlotChange, volumeFill: string): PlateMeta {
  const config = p.config ? remapSlotLists(p.config, c, true, volumeFill) : undefined;
  const customGcodes = p.customGcodes ? remapGcodes(p.customGcodes, c) : undefined;
  if (config === p.config && customGcodes === p.customGcodes) return p;
  return { ...p, ...(config ? { config } : {}), ...(customGcodes ? { customGcodes } : {}) };
}

/**
 * Apply a slot change to the project (objects, parts, height ranges, colour
 * paint, plates) as one undo step, and to the presets' process values /
 * project lists through `presets`. `slotsAfter` / `isMixed`: the slot count after the change and
 * which (1-based) slots are mixed then (for the process values).
 */
export function applySlotChange(c: SlotChange, presets: {
  project: PresetValues;
  value(kind: 'process', key: string): ConfigValue | undefined;
  setValue(kind: 'process', key: string, v: ConfigValue | undefined): void;
}, slotsAfter = Infinity, isMixed: (n: number) => boolean = () => false): void {
  if (c.kind === 'insert' && c.count <= 0) return;
  // PartPlate::on_filament_added: a new plate volume entry takes the first extruder's flow type (Hybrid → Standard).
  const vt = NOZZLE_VOLUME_TYPE_IDS[asList(presets.project.nozzle_volume_type as ConfigValue | undefined)[0] ?? 'Standard'] ?? 0;
  const volumeFill = String(vt === NOZZLE_VOLUME_TYPE_IDS.Hybrid ? 0 : vt);
  mutate(c.kind === 'delete' ? 'Remove filament' : 'Add filament', () => {
    objects.value = objects.value.map((o) => remapObject(o, c));
    const paint = meshPaint.value;
    let nextPaint: Record<string, PaintLayers> | null = null;
    for (const [id, layers] of Object.entries(paint)) {
      if (!layers.color) continue;
      const m = remapPaintMap(layers.color, c);
      if (m === layers.color) continue;
      nextPaint ??= { ...paint };
      const nl: PaintLayers = { ...layers };
      if (m.length) nl.color = m; else delete nl.color;
      if (Object.keys(nl).length) nextPaint[id] = nl; else delete nextPaint[id];
    }
    if (nextPaint) meshPaint.value = nextPaint;
    plates.value = plates.value.map((p) => remapPlate(p, c, volumeFill));
  });
  for (const [k, v] of Object.entries(processFilamentWrites((k) => presets.value('process', k), c, slotsAfter, isMixed))) presets.setValue('process', k, v);
  const lists = remapSlotLists(presets.project, c);
  if (lists !== presets.project) for (const [k, v] of Object.entries(lists)) presets.project[k] = v;
}

// ---- opening a project onto fewer filaments -----------------------------------------------------

/**
 * A model opened onto `slots` filaments (physical + mixed) keeps no reference past the last slot,
 * as desktop does after loading: the 3MF loader (object `extruder` 0 → 1, part `extruder` 0 removed),
 * then the filament count change it causes — ObjectList::update_filament_values_for_items (object
 * `extruder` past the end → 1; part `extruder` past the end removed: the part follows its object;
 * object / part support filaments past the end removed), ModelVolume::update_extruder_count from
 * GLCanvas3D::reload_scene (colour paint past the end → unpainted) and PartPlate::set_filament_count
 * (plate `filament_map` / `filament_nozzle_map` / `filament_volume_map` resized, new entries 1 / 0 / Standard).
 * Height ranges are left as desktop leaves them. Mutates `data`; true when anything changed.
 */
export function clampModelFilamentRefs(data: { objects: ProjectObject[]; paint?: Record<string, PaintLayers>; plates?: PlateMeta[] }, slots: number): boolean {
  if (!(slots >= 1)) return false;
  let changed = false;
  const past = (v: ConfigValue | undefined) => { const n = num(v); return Number.isFinite(n) && n > slots; };
  const support = (ov: Record<string, ConfigValue>) => {
    for (const k of SUPPORT_FILAMENT_KEYS) if (past(ov[k])) { delete ov[k]; changed = true; }
  };
  for (const o of data.objects) {
    const e = num(o.overrides.extruder);
    if (Number.isFinite(e) && (e === 0 || e > slots)) { o.overrides.extruder = '1'; changed = true; }
    support(o.overrides);
    for (const pt of o.parts ?? []) {
      const pe = num(pt.overrides.extruder);
      if (Number.isFinite(pe) && (pe === 0 || pe > slots)) { delete pt.overrides.extruder; changed = true; }
      support(pt.overrides);
    }
  }
  const state = (st: number) => (st > slots ? 0 : st);
  for (const layers of Object.values(data.paint ?? {})) {
    if (!layers.color) continue;
    const m = layers.color.map(([t, hex]) => [t, remapPaintString(hex, state)] as [number, string]);
    if (m.some(([, hex], i) => hex !== layers.color![i][1])) { layers.color = m.filter(([, hex]) => hex !== '0'); changed = true; }
  }
  const fills: Record<string, string> = { filament_map: '1', filament_nozzle_map: '0', filament_volume_map: String(NOZZLE_VOLUME_TYPE_IDS.Standard ?? 0) };
  for (const p of data.plates ?? []) {
    if (!p.config) continue;
    for (const [k, fill] of Object.entries(fills)) {
      const v: ConfigValue | undefined = p.config[k];
      if (v === undefined) continue;
      const list: string[] = Array.isArray(v) ? v.slice() : String(v).split(',');
      if (list.length === slots) continue;
      const next: string[] = list.length > slots ? list.slice(0, slots) : [...list, ...new Array<string>(slots - list.length).fill(fill)];
      p.config = { ...p.config, [k]: Array.isArray(v) ? next : next.join(',') };
      changed = true;
    }
  }
  return changed;
}

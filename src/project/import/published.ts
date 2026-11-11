/**
 * "Published" 3MFs (OrcaSlicer 2.5 Publish): the parts of desktop's import
 * that don't need app state.
 *
 * - The type gate and the metadata (Plater::priv::load_files: `orca_published`
 *   must be exactly "1", bbs_3mf.cpp is_published_3mf_flag; keys, material
 *   entries with their identity, the extruder layouts and the INI payload,
 *   each malformed part ignored on its own).
 * - The slot plan of the material pass (PresetBundle::load_config_file_config,
 *   published mode): where each published material lands on the receiver's
 *   slots, which receiver / payload mixed filaments move to the tail, which
 *   entries become empty mixed placeholders or are dropped, how far the slot
 *   list grows, and the authored-slot → destination relocations the model's
 *   filament references follow (remap_model_filament_slots).
 * - PublishSettings.cpp helpers: publish_base_key, publish_key_index,
 *   normalize_filament_type, publish_material_base_name, the candidate score of
 *   the type gate / slot de-aliasing, resolve_published_extruder_slot.
 */
import { MATERIAL_TYPES } from '../../settings/rules/materialTypes.generated';
import { findVariantIndex } from '../../presets/variants';
import { readOrcaIni } from './ini';
import { PUBLISHED } from './orcaFormat';

export interface PublishedMaterial {
  /** 0-based author filament slot; -1 (hand-crafted entries without one) is skipped. */
  slot: number;
  keys: string[];
  /** Full Publish: the whole filament (its keys in `fullKeys`). */
  full: boolean;
  fullKeys: string[];
  /** Type requirement (`publish_type` + `type`): a partial entry's slot must hold that material family. */
  publishType: boolean;
  type: string;
  publishColor: boolean;
  color: string;
  /** The author's slot preset identity (`material` object). */
  material: { filamentType: string; filamentVendor: string; filamentId: string; settingId: string; name: string };
}

/** PublishedExtruderLayout: each published per-extruder column's extruder number and variant. */
export interface PublishedLayout { extruderIds: number[]; variants: string[] }

export interface OrcaPublished {
  /** Process / printer keys, possibly with a "#N" per-extruder suffix. */
  keys: string[];
  materials: PublishedMaterial[];
  /** The payload values (flat Orca config, serialized). */
  config: Record<string, string>;
  /** Layout of the printer keys' columns (orca_published_extruder_layout extruder_ids / variants). */
  printerLayout: PublishedLayout | null;
  /** Layout of the process keys' columns (print_extruder_ids / print_variants). */
  printLayout: PublishedLayout | null;
}

export const isPublishedFlag = (v: string | undefined): boolean => v === '1';

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The published payload of a 3MF's model metadata, or null when it isn't a published file. */
export function readPublished(get: (name: string) => string | undefined, warnings: string[]): OrcaPublished | null {
  if (!isPublishedFlag(get(PUBLISHED.flag))) return null;
  const out: OrcaPublished = { keys: [], materials: [], config: {}, printerLayout: null, printLayout: null };
  const json = (name: string, what: string): unknown => {
    const raw = get(name);
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw) as unknown; } catch { warnings.push(`The published ${what} couldn’t be read.`); return undefined; }
  };
  out.keys = strs(json(PUBLISHED.keys, 'settings list'));
  const mats = json(PUBLISHED.materialKeys, 'filament settings');
  if (Array.isArray(mats)) {
    for (const m of mats as unknown[]) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
      const e = m as Record<string, unknown>;
      const mat = e.material && typeof e.material === 'object' && !Array.isArray(e.material) ? e.material as Record<string, unknown> : {};
      out.materials.push({
        slot: typeof e.slot === 'number' && Number.isInteger(e.slot) ? e.slot : -1,
        keys: strs(e.keys),
        full: e.full === true,
        fullKeys: strs(e.full_keys),
        publishType: e.publish_type === true,
        type: str(e.type),
        publishColor: e.publish_color === true,
        color: str(e.color),
        material: {
          filamentType: str(mat.filament_type), filamentVendor: str(mat.filament_vendor), filamentId: str(mat.filament_id),
          settingId: str(mat.setting_id), name: str(mat.name),
        },
      });
    }
  }
  const layout = json(PUBLISHED.layout, 'extruder layout');
  if (layout && typeof layout === 'object') {
    const l = layout as Record<string, unknown>;
    const ints = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]).map(Math.trunc) : null);
    const names = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as string[] : null);
    const ids = ints(l.extruder_ids), variants = names(l.variants);
    // A malformed layout leaves the keys to the positional import.
    if (ids && variants) {
      out.printerLayout = { extruderIds: ids, variants };
      if ('print_extruder_ids' in l && 'print_variants' in l) {
        const pids = ints(l.print_extruder_ids), pvariants = names(l.print_variants);
        if (pids && pvariants) out.printLayout = { extruderIds: pids, variants: pvariants };
      }
    }
  }
  const payload = get(PUBLISHED.config);
  if (payload !== undefined) {
    const cfg = readOrcaIni(payload);
    if (cfg) out.config = cfg; else warnings.push('The published settings couldn’t be read.');
  }
  return out;
}

// ---- PublishSettings.cpp helpers ---------------------------------------------------------------

export const publishBaseKey = (key: string): string => { const i = key.indexOf('#'); return i < 0 ? key : key.slice(0, i); };

/** The strict "#N" index of a key, -1 when it has none or a malformed one. */
export function publishKeyIndex(key: string): number {
  const i = key.indexOf('#');
  if (i < 0 || i + 1 >= key.length) return -1;
  const s = key.slice(i + 1);
  if (!/^\d+$/.test(s)) return -1;
  const n = Number(s);
  return n > 1_000_000 ? -1 : n;
}

/** publish_structural_keys: never applied from a published file. */
export const PUBLISH_STRUCTURAL = new Set([
  'printer_settings_id', 'filament_settings_id', 'print_settings_id', 'sla_print_settings_id', 'sla_material_settings_id',
  'compatible_printers', 'compatible_prints', 'compatible_printers_condition', 'compatible_prints_condition',
  'default_filament_profile', 'default_print_profile', 'default_sla_print_profile', 'default_sla_material_profile',
  'extruder_count', 'bed_shape', 'inherits', 'inherits_group', 'printer_technology', 'printer_model', 'printer_variant',
  'physical_printer_settings_id', 'filament_ids', 'different_settings_to_system',
]);
/** publishable_printer_keys: the printer tab's Retraction and Z-Hop groups. */
export const PUBLISH_PRINTER_KEYS = new Set([
  'retraction_length', 'retract_restart_extra', 'retraction_speed', 'deretraction_speed', 'retraction_minimum_travel',
  'retract_when_changing_layer', 'wipe', 'wipe_distance', 'retract_before_wipe', 'retract_after_wipe',
  'retract_lift_enforce', 'z_hop_types', 'z_hop', 'travel_slope', 'retract_lift_above', 'retract_lift_below',
]);
/** publish_mixed_keys: project-level per-slot arrays of a mixed filament. */
export const PUBLISH_MIXED_KEYS = new Set([
  'filament_is_mixed', 'filament_mixed_components', 'filament_mixed_sublayer_ratios', 'filament_mixed_gradient',
  'filament_mixed_gradient_range', 'filament_mixed_gradient_curve', 'filament_mixed_gradient_per_part',
]);
/** s_project_options_published: the only project options a published file brings (plate geometry). */
export const PUBLISH_PROJECT_KEYS = ['wipe_tower_x', 'wipe_tower_y', 'wipe_tower_rotation_angle'] as const;
/** EnforcerBlockerType::ExtruderMax: physical + mixed slots. */
export const PUBLISH_SLOT_LIMIT = 32;

export const isMixedDefinition = (m: Pick<PublishedMaterial, 'keys'>): boolean => m.keys.some((k) => PUBLISH_MIXED_KEYS.has(publishBaseKey(k)));

const KNOWN_TYPES = new Set(MATERIAL_TYPES.map((t) => t[0]));
/** normalize_filament_type: "PLA High Speed" → "PLA"; dash types ("PA-CF") stay distinct. */
export function normalizeFilamentType(type: string): string {
  if (!type || KNOWN_TYPES.has(type)) return type;
  const sep = type.indexOf(' ');
  if (sep >= 0 && KNOWN_TYPES.has(type.slice(0, sep))) return type.slice(0, sep);
  return type;
}

/** publish_material_base_name: "Generic PLA @System" → "Generic PLA". */
export function publishMaterialBaseName(name: string): string {
  const at = name.indexOf('@');
  return (at < 0 ? name : name.slice(0, at)).replace(/\s+$/, '');
}

/** The label desktop reports a material under: filament id, else the required type, else its type. */
export const materialLabel = (m: PublishedMaterial): string => m.material.filamentId || m.type || m.material.filamentType;

/** The fields of a library filament the candidate score reads. */
export interface FilamentCandidate { name: string; alias?: string; settingId?: string; filamentId?: string; filamentType?: string; filamentVendor?: string }

/**
 * candidate_score: 5 exact preset name (as published or as the receiver's
 * catalog resolves it), 4 bare name / alias, 3 setting id, 2 filament id,
 * 1 vendor + type, 0 type only, -1 no match.
 */
export function candidateScore(c: FilamentCandidate, m: PublishedMaterial, resolvedName: string): number {
  const name = m.material.name;
  if (name && c.name === name) return 5;
  if (resolvedName && c.name === resolvedName) return 5;
  if (name) {
    const bare = publishMaterialBaseName(name);
    if (bare && (c.alias === name || c.name === bare || c.alias === bare)) return 4;
  }
  if (m.material.settingId && c.settingId === m.material.settingId) return 3;
  if (m.material.filamentId && c.filamentId === m.material.filamentId) return 2;
  const required = m.type || normalizeFilamentType(m.material.filamentType);
  if (required && normalizeFilamentType(c.filamentType ?? '') === required) return m.material.filamentVendor && c.filamentVendor === m.material.filamentVendor ? 1 : 0;
  return -1;
}

/**
 * resolve_published_extruder_slot: the receiver column for the author's
 * column `index` — the receiver's extruder with the author's number, in the
 * nozzle type it runs now; -1 when the variant differs or doesn't resolve.
 */
export function resolvePublishedExtruderSlot(
  layout: PublishedLayout, index: number,
  receiver: { nozzleCount: number; extruderTypes: readonly string[]; volumeTypes: readonly string[] },
  target: { ids: readonly number[]; variants: readonly string[] },
): number {
  if (index >= layout.extruderIds.length || index >= layout.variants.length) return -1;
  const ae = layout.extruderIds[index];
  if (ae < 1 || ae > receiver.nozzleCount) return -1;
  const e = ae - 1;
  if (e >= receiver.extruderTypes.length || e >= receiver.volumeTypes.length) return -1;
  const variant = `${receiver.extruderTypes[e]} ${receiver.volumeTypes[e]}`;
  if (receiver.volumeTypes[e] === 'Hybrid' || layout.variants[index] !== variant) return -1;
  return Math.max(findVariantIndex(variant, ae, target.variants, target.ids), 0);
}

// ---- the slot plan ------------------------------------------------------------------------------

export interface ReceiverSlots {
  /** Physical slots (0 … physical-1). */
  physical: number;
  /** Mixed slots after them (physical … physical+mixed-1). */
  mixed: number;
  /** Physical filament capacity: the nozzle count, or the slot limit on a single-extruder multi-material printer. */
  capacity: number;
}

export interface PlannedMaterial extends PublishedMaterial {
  /** The slot the author published it at (`slot` is where it lands). */
  authoredSlot: number;
  /** Surplus material past the printer's capacity: lands as an empty mixed filament. */
  placeholder?: boolean;
}

export interface SlotPlan {
  /** Entries that still apply, in file order, `slot` = destination. */
  entries: PlannedMaterial[];
  /** Receiver mixed slot → tail slot (physical-first rebalance). */
  receiverMoves: Array<[number, number]>;
  /** Payload mixed definitions / placeholders moved from the authored slot to their destination. */
  payloadMoves: Array<[number, number]>;
  /** Authored (or receiver) slot → destination: the model's filament references follow these. */
  relocations: Map<number, number>;
  /** Slot count after the load (never below the receiver's). */
  targetSlots: number;
  /** Grown slots past the capacity with nothing published: empty mixed placeholders. */
  gapSlots: number[];
  /** "material:…" entries that couldn't be placed. */
  skipped: string[];
  /** material_replacements lines. */
  notes: string[];
}

/** Placement part of the material pass (before any preset is touched). `numFilaments`: the payload's filament_colour count. */
export function planPublishedSlots(materials: readonly PublishedMaterial[], r: ReceiverSlots, numFilaments: number): SlotPlan {
  const size = r.physical + r.mixed;
  const isReceiverMix = (s: number) => s >= r.physical && s < size;
  const plan: SlotPlan = { entries: [], receiverMoves: [], payloadMoves: [], relocations: new Map(), targetSlots: size, gapSlots: [], skipped: [], notes: [] };
  if (!materials.length) return plan;
  let growTarget = 0;
  for (const m of materials) {
    if (m.slot < 0) continue;
    if (!isMixedDefinition(m) && m.slot >= r.capacity) continue;
    growTarget = Math.max(growTarget, m.slot + 1);
  }
  let boundary = r.physical;
  for (const m of materials) {
    if (m.slot >= 0 && !isMixedDefinition(m) && (m.slot < size || m.slot < r.capacity)) boundary = Math.max(boundary, m.slot + 1);
  }
  let nextFree = Math.max(boundary, size);
  let relocated = false;
  const swept = new Set<number>();
  for (let s = 1; s < size; s++) {
    if (!isReceiverMix(s) || s >= boundary) continue;
    const dest = nextFree++;
    swept.add(s);
    plan.receiverMoves.push([s, dest]);
    relocated = true;
    plan.relocations.set(s, dest);
    plan.notes.push(`slot ${s} -> slot ${dest}: mixed filament`);
  }
  for (const m of materials) {
    const e: PlannedMaterial = { ...m, authoredSlot: m.slot };
    if (m.slot < 0) { plan.entries.push(e); continue; }
    const mix = isMixedDefinition(m);
    const keep = mix ? isReceiverMix(m.slot) && !swept.has(m.slot) : m.slot < size || m.slot < r.capacity;
    if (keep) { plan.entries.push(e); continue; }
    const label = materialLabel(m);
    if (Math.max(m.slot, nextFree) >= PUBLISH_SLOT_LIMIT) {
      plan.skipped.push(`material:${label} (${mix ? 'mixed filament definition: filament slot limit reached' : 'filament slot limit reached'})`);
      continue;
    }
    if (!mix && r.capacity < 2) {
      plan.skipped.push(`material:${label} (the printer's filament limit is ${r.capacity})`);
      continue;
    }
    const dest = mix ? Math.max(m.slot, nextFree) : nextFree;
    nextFree = dest + 1;
    if (mix) {
      if (dest !== m.slot) {
        e.slot = dest;
        relocated = true;
        plan.payloadMoves.push([m.slot, dest]);
        plan.relocations.set(m.slot, dest);
        plan.notes.push(`slot ${m.slot} -> slot ${dest}: mixed filament`);
      }
    } else {
      e.placeholder = true;
      relocated = true;
      if (dest !== m.slot) {
        e.slot = dest;
        plan.payloadMoves.push([m.slot, dest]);
        plan.relocations.set(m.slot, dest);
      }
      plan.notes.push(dest !== m.slot
        ? `slot ${m.slot} -> slot ${dest}: unassigned mixed filament (the printer's filament limit is ${r.capacity})`
        : `slot ${dest}: unassigned mixed filament (the printer's filament limit is ${r.capacity})`);
    }
    plan.entries.push(e);
  }
  plan.targetSlots = Math.max(size, Math.min(growTarget, numFilaments), relocated ? nextFree : 0);
  const published = new Set(plan.entries.filter((e) => e.slot >= 0).map((e) => e.slot));
  for (let s = size; s < plan.targetSlots; s++) if (s >= r.capacity && !published.has(s)) plan.gapSlots.push(s);
  return plan;
}

/**
 * apply_mixed_config_relocations: move the payload's per-slot mixed cells to
 * their destinations, all at once from a snapshot (sources stay as they were).
 */
export function relocateMixedCells(cells: readonly string[], moves: ReadonlyArray<readonly [number, number]>, fill: string): string[] {
  const out = [...cells];
  for (const [from, to] of moves) {
    while (out.length <= to) out.push(fill);
    out[to] = cells[from] ?? fill;
  }
  return out;
}

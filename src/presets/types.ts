/**
 * Preset system types shared by both engine catalogs, the store and the UI.
 */
import type { ConfigValue, EngineId } from '../engine/types';

/** Preset tab / collection. (Orca JSON `type`: machine | process | filament.) */
export type PresetKind = 'printer' | 'process' | 'filament';
export const PRESET_KINDS: readonly PresetKind[] = ['printer', 'process', 'filament'];

/** Orca/Bambu JSON `type` for a kind. */
export const ORCA_JSON_TYPE: Record<PresetKind, string> = { printer: 'machine', process: 'process', filament: 'filament' };

export function kindFromJsonType(t: unknown): PresetKind | null {
  if (t === 'machine' || t === 'printer') return 'printer';
  if (t === 'process' || t === 'print') return 'process';
  if (t === 'filament') return 'filament';
  return null;
}

/** Raw settings bag of a preset (engine-native keys; no structural keys). */
export type PresetValues = Record<string, ConfigValue>;

export type PresetSource = 'system' | 'user' | 'default';

/** Id of the synthetic "engine defaults" preset available for every kind. */
export const DEFAULT_PRESET_ID = 'default';

/** Lightweight description used by pickers and compatibility filtering. */
export interface PresetInfo {
  /** Stable id: `default`, `sys:<vendor>/<name>` or `user:<uuid>`. */
  id: string;
  kind: PresetKind;
  name: string;
  source: PresetSource;
  vendor?: string;
  /** For user presets: id of the system preset they inherit from. */
  parentId?: string;
  /** Orca "alias": name without the `@printer` suffix (filament library dedup). */
  alias?: string;
  // grouping / display meta (resolved through inheritance)
  printerModel?: string;
  printerVariant?: string;
  filamentType?: string;
  filamentVendor?: string;
  /** Compatibility (resolved through inheritance). */
  compatiblePrinters?: string[];
  compatiblePrintersCondition?: string;
  compatiblePrints?: string[];
  compatiblePrintsCondition?: string;
  /** Orca library filament hidden for these printer names (m_excluded_from). */
  excludedPrinters?: string[];
  /** Printer presets: default process / filament preset names. */
  defaultProcess?: string;
  defaultFilaments?: string[];
  /** From the OrcaFilamentLibrary (Orca) — used for grouping. */
  fromLibrary?: boolean;
}

export interface VendorInfo {
  id: string;
  name: string;
  description?: string;
}

export interface PrinterVariant {
  /** Printer preset (machine) info. */
  preset: PresetInfo;
  /** Nozzle / variant label ("0.4"). */
  variant: string;
}

export interface MachineModel {
  vendor: string;
  name: string;
  /** Declared nozzle options ("0.2;0.4;..."). */
  nozzles: string[];
  family?: string;
  coverUrl?: string;
  variants: PrinterVariant[];
}

/**
 * Engine-specific source of system presets. Both engines implement this; the
 * store layers user presets, compatibility filtering and resolution on top.
 */
export interface PresetCatalog {
  readonly engine: EngineId;
  /** Vendors that ship printer presets (may be empty). */
  vendors(): Promise<VendorInfo[]>;
  /** Machine models (+ nozzle variants) of a vendor. */
  models(vendorId: string): Promise<MachineModel[]>;
  /** Info for a system preset id (null when unknown). */
  info(id: string, kind: PresetKind): Promise<PresetInfo | null>;
  /**
   * Instantiable system presets of `kind` that could be compatible with the
   * given printer (vendor scope + shared libraries). Not yet filtered.
   */
  candidates(kind: 'process' | 'filament', printer: PresetInfo | null): Promise<PresetInfo[]>;
  /** Default plate type of a machine model (Orca model JSON `default_bed_type`), if the catalog knows it. */
  modelDefaultBedType?(vendorId: string, model: string): Promise<string | null>;
  /** URLs of a machine model's bed mesh (STL) and texture (SVG/PNG), if it has them (Orca model JSON bed_model / bed_texture). */
  modelBedAssets?(vendorId: string, model: string): Promise<BedAssets | null>;
  /** Flattened (inheritance-resolved) values of a system preset. */
  resolve(id: string, kind: PresetKind): Promise<PresetValues | null>;
  /** Find a system preset by name (for imports / user presets referencing a parent by name). */
  findByName(kind: PresetKind, name: string, vendorHint?: string): Promise<PresetInfo | null>;
}

/** Keys that describe a preset rather than configure the engine. */
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'name', 'inherits', 'from', 'instantiation', 'type', 'setting_id', 'version', 'is_custom_defined',
  'renamed_from', 'description', 'alias', 'base_id', 'user_id', 'updated_time', 'filament_id_map',
]);

/** Keys stripped from the final engine config (preset metadata the engine doesn't need). */
export const NON_ENGINE_KEYS: ReadonlySet<string> = new Set([
  ...STRUCTURAL_KEYS,
  'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition',
  'inherits_group', 'compatible_machine_expression_group', 'compatible_process_expression_group',
  'different_settings_to_system', 'print_compatible_printers', 'upward_compatible_machine',
]);

export interface BedAssets { model?: string; texture?: string }

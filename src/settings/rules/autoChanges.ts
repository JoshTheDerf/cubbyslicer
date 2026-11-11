/**
 * Orca's automatic value changes and their dialogs, as small checks:
 *
 * - `ConfigManipulation::update_print_fff_config` (runs after every process edit: resets, the spiral vase
 *   ask, alternate extra wall, fuzzy skin vs. Arachne, support style, filament ids, …) and the value change
 *   inside `toggle_print_fff_options` (reverse internal only → threshold 0);
 * - `Tab::on_value_change` for the process tab (prime tower vs. smooth timelapse / clumping detection /
 *   precise Z, "No sparse layers", print by object on i3, support filaments, make overhang printable,
 *   rotate template, layer height limits) and the printer / filament ones (long retraction when cut);
 * - `TabFilament::update` / its on-change handlers (max volumetric speed, ironing spacing, recommended
 *   temperatures, chamber temperatures) and `TabFilament::toggle_options` (first layer fan reset);
 * - `TabPrinter::toggle_options` / on-change (firmware retraction ask, manual filament change, purge in
 *   prime tower, input shaper per firmware, layer height limits of BBL multi-extruder printers).
 *
 * A check returns a step: silent writes, or a prompt with the message, buttons and the writes per answer,
 * exactly as desktop shows them. `runAutoChanges` runs the checks in Orca's order on the config with the
 * earlier answers applied, asking through a callback. The messages are Orca's (autoChanges.test.ts checks
 * them against the Orca source when a checkout is available).
 */
import type { ConfigValue } from '../../engine/types';
import { asList, toBool, toNumber, valueAt } from '../../lib/configValue';
import { MATERIAL_DEFAULTS, MATERIAL_TYPES } from './materialTypes.generated';
import type { RuleFamily } from './types';

export type Answer = 'yes' | 'no' | 'ok';
export type Writes = Record<string, ConfigValue>;

export interface Prompt {
  /** Check id (tests, "don't show again" keys). */
  id: string;
  title: string;
  message: string;
  /** `ok`: a message with OK; `yesno`: Yes / No (labels may be renamed, Orca's SetButtonLabel). */
  buttons: 'ok' | 'yesno';
  yesLabel?: string;
  noLabel?: string;
  /** What closing the dialog without a button counts as (Orca: whichever branch its `== wxID_…` test doesn't take). */
  dismiss: Answer;
  /** Orca's "Don't show this again" (show_dsa_button): the app setting that silences it. */
  dontShowKey?: string;
  writes: Partial<Record<Answer, Writes>>;
  /** Per-answer flags the runner stores in `memo` (what a later ask of the same chain depends on). */
  remember?: Partial<Record<Answer, Record<string, unknown>>>;
}

export type Step = { silent: Writes } | { prompt: Prompt };

/** What the checks can see. `get` reads the family being edited with earlier writes applied. */
export interface AutoContext {
  family: RuleFamily;
  get(key: string): ConfigValue | undefined;
  printer(key: string): ConfigValue | undefined;
  /** Global process settings (false: an object's / part's overrides over the process). */
  isGlobal: boolean;
  /** Bambu Lab printer (`is_BBL_Printer`). */
  isBBL: boolean;
  /** Settings mode: 0 simple, 1 advanced, 2 expert. */
  mode: number;
  /** Selected nozzle variant / extruder page (Orca `variant_index`). */
  variantIndex: number;
  /** Filament slots (physical + mixed). */
  filamentCount: number;
  /** 1-based slot is a mixed filament. */
  isMixedSlot(slot: number): boolean;
  /** Filament slot (0-based) properties: type, is support, soluble. */
  filament(index: number): { type: string; isSupport: boolean; soluble: boolean } | null;
  /** Filament types objects / parts print with (`has_filaments`). */
  modelFilamentTypes: readonly string[];
  /** The value a filament id key falls back to when out of range (`plater()->config()`), else 0. */
  platerValue(key: string): number;
  /** An object has a variable layer height profile. */
  hasVariableLayerHeight: boolean;
  /** App setting (`app_config->get`), for "don't show again". */
  appFlag(key: string): boolean;
  /** Per-session memory Orca keeps in members / statics (asked-once flags). */
  memo: Record<string, unknown>;
  /** The selected preset is a user preset without unsaved edits (TabPrint::update's overhang seed). */
  userSavedPreset?: boolean;
}

/** The edit that triggered the run: the key (without `#index`) and its new value. */
export interface Change { key: string; value: ConfigValue }

export interface Check {
  id: string;
  family: RuleFamily;
  /** Keys whose change runs it (Tab::on_value_change); absent = after every change of the family (update_*). */
  on?: readonly string[];
  /** Only for the global process settings (Tab), not for per-object settings. */
  globalOnly?: boolean;
  test(c: AutoContext, change: Change): Step | null;
  /** Runs after the check (and its answer) with the result applied: Orca's remembered values. */
  after?(c: AutoContext): void;
}

// ---- value helpers ----------------------------------------------------------------------------

const EPSILON = 1e-4;
/** PrintConfig.hpp IRONING_SPACING_MIN. */
export const IRONING_SPACING_MIN = 0.05;
const first = (v: ConfigValue | undefined) => valueAt(v, 0);
const num = (c: AutoContext, k: string, i = 0) => toNumber(valueAt(c.get(k), i), 0);
const bool = (c: AutoContext, k: string, i = 0) => toBool(valueAt(c.get(k), i));
const str = (c: AutoContext, k: string) => first(c.get(k)) ?? '';
const pbool = (c: AutoContext, k: string) => toBool(first(c.printer(k)));
const pstr = (c: AutoContext, k: string) => first(c.printer(k)) ?? '';
const changedBool = (ch: Change) => toBool(first(ch.value));
/** A float-or-percent's absolute value (percent of `base`). */
function absValue(v: string | undefined, base: number): number {
  if (!v) return 0;
  return v.trim().endsWith('%') ? toNumber(v.trim().slice(0, -1), 0) * base / 100 : toNumber(v, 0);
}
const ok = (id: string, message: string, writes: Writes = {}, title = ''): Step =>
  ({ prompt: { id, title, message, buttons: 'ok', dismiss: 'ok', writes: { ok: writes } } });
const yesNo = (id: string, message: string, yes: Writes, no: Writes, o: Partial<Prompt> = {}): Step =>
  ({ prompt: { id, title: '', message, buttons: 'yesno', dismiss: 'no', writes: { yes, no }, ...o } });

/** MaterialType::get_temperature_range / get_chamber_temperature_range: [min, max, known]. */
export function materialRange(type: string, what: 'nozzle' | 'chamber'): [number, number, boolean] {
  const row = MATERIAL_TYPES.find((r) => r[0] === type);
  if (what === 'nozzle') return row ? [row[1], row[2], true] : [MATERIAL_DEFAULTS.minTemp, MATERIAL_DEFAULTS.maxTemp, false];
  return row ? [row[3], row[4], true] : [MATERIAL_DEFAULTS.chamberMin, MATERIAL_DEFAULTS.chamberMax, false];
}

/** Tab.cpp input_shaper_types_for_flavor (the first entry is what a reset picks). */
export function inputShaperTypes(flavor: string): string[] {
  switch (flavor) {
    case 'klipper': return ['Default', 'ZV', 'MZV', 'ZVD', 'EI', '2HUMP_EI', '3HUMP_EI', 'Disable'];
    case 'reprapfirmware': return ['Default', 'MZV', 'ZVD', 'ZVDD', 'ZVDDD', 'EI2', 'EI3', 'DAA', 'Disable'];
    case 'marlin2': return ['ZV', 'Disable'];
    default: return ['Default', 'Disable'];
  }
}

const TREE_STYLES = ['default', 'tree_slim', 'tree_strong', 'tree_hybrid', 'organic'];
const NORMAL_STYLES = ['default', 'grid', 'snug'];
const isTree = (t: string) => t.startsWith('tree');

/** `is_support_filament(id, false)`: PLA / PETG count as support material when the model also prints the other. */
function isSupportFilament(c: AutoContext, id: number): boolean {
  const f = c.filament(id);
  if (!f) return false;
  if (f.type === 'PETG' || f.type === 'PLA') {
    const others = f.type === 'PETG' ? ['PLA'] : ['PETG', 'TPU', 'TPU-AMS'];
    if (c.modelFilamentTypes.some((t) => others.includes(t))) return true;
  }
  return f.isSupport;
}
const isSoluble = (c: AutoContext, id: number) => !!c.filament(id)?.soluble;
const hasModelFilament = (c: AutoContext, types: string[]) => c.modelFilamentTypes.some((t) => types.includes(t));

// ---- messages (Orca's text) -------------------------------------------------------------------------

export const MSG = {
  belt: 'Raft and draft shield are not available on belt printers.\nThey have been disabled.',
  layerHeight: 'Layer height too small\nIt has been reset to 0.2',
  ironingSpacing: 'Ironing spacing too small\nIt has been reset to 0.1',
  firstLayer: 'Zero initial layer height is invalid.\n\nThe first layer height will be reset to 0.2.',
  xyCompensation: 'This setting is only used for tuning model size by small amounts.\nFor example, when the model size has small errors or when tolerances are incorrect. For large adjustments, please use the model scale function.\n\nThe value will be reset to 0.',
  elephantFoot: 'The elephant foot compensation value is too large.\nIf there are significant elephant foot issues, please check other settings.\nThe bed temperature may be too high, for example.\n\nThe value will be reset to 0.',
  spiral: 'Spiral mode only works when wall loops is 1, support is disabled, clumping detection by probing is disabled, top shell layers is 0, sparse infill density is 0 and timelapse type is traditional.',
  spiralI3: ' But machines with I3 structure will not generate timelapse videos.',
  spiralAsk: 'Change these settings automatically?\nYes - Change these settings and enable spiral/vase mode automatically\nNo  - Cancel enabling spiral mode',
  alternateWall: "Alternate extra wall doesn't work well when ensure vertical shell thickness is set to All.",
  alternateWallAsk: "Change these settings automatically?\nYes - Change ensure vertical shell thickness to Moderate and enable alternate extra wall\nNo  - Don't use alternate extra wall",
  mixedSublayer: 'Using variable layer height together with mixed color sublayer may result in poor color mixing quality.',
  seamSlope: 'seam_slope_start_height needs to be smaller than layer_height.\nReset to 0.',
  lockDepth: 'Lock depth should be smaller than skin depth.\nReset to 50% of skin depth.',
  fuzzy: 'Both [Extrusion] and [Combined] modes of Fuzzy Skin require the Arachne Wall Generator to be enabled.',
  fuzzyAsk: 'Change these settings automatically?\nYes - Enable Arachne Wall Generator\nNo  - Disable Arachne Wall Generator and set [Displacement] mode of the Fuzzy Skin',
  towerNozzles: 'Prime tower is required for nozzle changing. There may be flaws on the model without prime tower. Are you sure you want to disable prime tower?',
  towerTimelapseOff: 'A prime tower is required for smooth timelapse mode. There may be flaws on the model without a prime tower. Are you sure you want to disable the prime tower?',
  towerClumpingOff: 'A prime tower is required for clumping detection. There may be flaws on the model without prime tower. Are you sure you want to disable prime tower?',
  towerPreciseZ: 'Enabling both precise Z height and the prime tower may cause slicing errors. Do you still want to enable?',
  clumpingOn: 'A prime tower is required for clumping detection. There may be flaws on the model without prime tower. Do you still want to enable clumping detection?',
  preciseZOn: 'Enabling both precise Z height and the prime tower may cause slicing errors. Do you still want to enable precise Z height?',
  smoothNoSparse: 'Smooth timelapse needs a prime tower on every layer, which is not compatible with "No sparse layers". "No sparse layers" has been turned off.',
  smoothTower: 'A prime tower is required for smooth timelapse mode. There may be flaws on the model without prime tower. Do you want to enable the prime tower?',
  noSparseSmooth: '"No sparse layers" is not compatible with smooth timelapse, which needs a prime tower on every layer. Timelapse has been switched to traditional mode.',
  byObjectI3: 'The current printer does not support timelapse in Traditional Mode when printing By-Object.',
  byObjectAsk: 'Still print by object?',
  supportBase: 'Non-soluble support materials are not recommended for support base.\nAre you sure to use them for support base?\n',
  interfaceSupport: 'When using support material for the support interface, we recommend the following settings:\n0 top Z distance, 0 interface spacing, interlaced rectilinear pattern and disable independent support layer height.',
  interfaceSoluble: 'When using soluble material for the support interface, we recommend the following settings:\n0 top Z distance, 0 interface spacing, interlaced rectilinear pattern, disable independent support layer height and use soluble materials for both support interface and support base.',
  interfaceAsk: 'Change these settings automatically?\nYes - Change these settings automatically.\nNo  - Do not change these settings for me.',
  overhangPrintable: "Enabling this option will modify the model's shape. If your print requires precise dimensions or is part of an assembly, it's important to double-check whether this change in geometry impacts the functionality of your print.",
  rotateTemplate: 'Infill patterns are typically designed to handle rotation automatically to ensure proper printing and achieve their intended effects (e.g., Gyroid, Cubic). Rotating the current sparse infill pattern may lead to insufficient support. Please proceed with caution and thoroughly check for any potential printing issues. Are you sure you want to enable this option?',
  sureEnable: 'Are you sure you want to enable this option?',
  layerTooSmall: (min: number) => `Layer height is too small. It will be set to the minimum (${g(min)} mm).`,
  layerOutOfRange: 'Layer height is outside the limits set in Printer Settings -> Extruder -> Layer height limits, this may cause printing quality issues.',
  layerAdjust: (to: number) => `Adjust it to the limit (${g(to)} mm) automatically?`,
  longRetraction: 'Experimental feature: Retracting and cutting off the filament at a greater distance during filament changes to minimize flush. Although it can notably reduce flush, it may also elevate the risk of nozzle clogs or other printing complications.',
  longRetractionFilament: 'Experimental feature: Retracting and cutting off the filament at a greater distance during filament changes to minimize flush. Although it can notably reduce flush, it may also elevate the risk of nozzle clogs or other printing complications. Please use with the latest printer firmware.',
  maxVolumetric: 'Too small max volumetric speed.\nValue was reset to 0.5',
  tempMin: (t: number, type: string) => `A minimum temperature above ${t}℃ is recommended for ${type}.\n`,
  tempMax: (t: number, type: string) => `A maximum temperature below ${t}℃ is recommended for ${type}.\n`,
  tempOrder: 'The recommended minimum temperature cannot be higher than the recommended maximum temperature.\n',
  pleaseCheck: 'Please check.\n',
  nozzleRange: 'The nozzle may become clogged when the temperature is out of the recommended range.\nPlease make sure whether to use this temperature to print.\n\n',
  nozzleRecommended: (lo: number, hi: number) => `The recommended nozzle temperature for this filament type is [${lo}, ${hi}] degrees Celsius.`,
  chamberMax: (t: number) => `Current chamber temperature is higher than the material's safe temperature; this may result in material softening and nozzle clogs. The maximum safe temperature for the material is ${t}`,
  chamberMin: (min: number, target: number) => `The minimal chamber temperature (${min}℃) is higher than the target chamber temperature (${target}℃). The minimal value is the threshold at which printing starts while the chamber keeps heating toward the target, so it should not exceed it. It will be clamped to the target.`,
  firmwareRetraction: 'The Retract before wipe option could be only 100% when using the Firmware Retraction mode.\n\nShall I set it to 100% in order to enable Firmware Retraction?',
  semmNozzle: 'This is a single extruder multi-material printer, diameters of all extruders will be set to the new value. Do you want to proceed?',
  semmNozzleTitle: 'Nozzle diameter',
  adaptivePa: 'Adaptive Pressure Advance model validation failed:\n',
  bedVolumeInvalid: 'Invalid collision volume format. Use XxY, XxY, ... or ZMIN..ZMAX;XxY, XxY, ... and separate multiple volumes with |.',
  bedVolumeAsk: 'This definition contains collision-volume syntax. Add it to the toolhead collision volumes for G-code checking and travel avoidance? The existing excluded bed area will be preserved.',
  bedVolumeTitle: 'Add collision volumes',
} as const;

/** AdaptivePAProcessor::validate_adaptive_pa_model messages (`%1%` = line number). */
export const PA_MSG = {
  chars: 'Line %1%: only numbers, commas and dots are allowed',
  count: 'Line %1%: must contain exactly 3 comma-separated values (PA, flow, acceleration)',
  missingPa: 'Line %1%: missing PA value',
  missingFlow: 'Line %1%: missing flow value',
  missingAccel: 'Line %1%: missing acceleration value',
  pa: 'Line %1%: PA value must be less than 2',
  flow: 'Line %1%: flow value must be greater than PA value',
  accel: 'Line %1%: acceleration value must be greater than flow value',
  invalid: 'Line %1%: invalid numeric value',
} as const;

/** std::getline(stream, field, ','): a trailing delimiter gives no empty last field. */
function splitGetline(s: string, d: string): string[] {
  if (s === '') return [];
  const parts = s.split(d);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}
/** std::stod: leading blanks, the longest number prefix; throws (null) when there is none. */
function stod(s: string): number | null {
  const m = /^[\s]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s);
  return m ? Number(m[0]) : null;
}

/** AdaptivePAProcessor::validate_adaptive_pa_model: '' when valid, else the first problem. */
export function validateAdaptivePaModel(model: string): string {
  if (!model) return '';
  const lines = model.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const n = String(i + 1);
    const fmt = (m: string) => m.replace('%1%', n);
    // trim_adaptive_pa_model_fields: blanks around each field go.
    const line = splitGetline(lines[i], ',').map((f) => f.replace(/^[ \t\r]+|[ \t\r]+$/g, '')).join(',');
    if (!line) continue;
    if (/[^0-9,.]/.test(line)) return fmt(PA_MSG.chars);
    if ((line.match(/,/g) ?? []).length !== 2) return fmt(PA_MSG.count);
    const f = splitGetline(line, ',');
    if (f.length < 1) return fmt(PA_MSG.missingPa);
    const pa = stod(f[0]);
    if (pa === null) return fmt(PA_MSG.invalid);
    if (f.length < 2) return fmt(PA_MSG.missingFlow);
    const flow = stod(f[1]);
    if (flow === null) return fmt(PA_MSG.invalid);
    if (f.length < 3) return fmt(PA_MSG.missingAccel);
    const accel = stod(f[2]);
    if (accel === null) return fmt(PA_MSG.invalid);
    if (pa >= 2) return fmt(PA_MSG.pa);
    if (flow <= pa) return fmt(PA_MSG.flow);
    if (accel <= flow) return fmt(PA_MSG.accel);
  }
  return '';
}

/** PrintConfig.cpp looks_like_bed_exclusion_volume_syntax. */
export function isBedExclusionVolumeSyntax(v: string): boolean {
  return v.includes('|') || (v.includes('..') && v.includes(';'));
}

/**
 * Tab::on_value_change("bed_exclude_area") with collision-volume text typed into the area: an invalid
 * definition is an error (the area keeps its value); a valid one offers to append it to the collision
 * volumes (append_bed_exclude_volumes: the shared string, or every extruder's in per-extruder mode).
 * `valid` is is_valid_bed_exclude_volumes_string with the printer's printable height.
 */
export function bedExcludeVolumeOffer(definition: string, valid: boolean, printer: (k: string) => ConfigValue | undefined): Step {
  if (!valid) return { prompt: { id: 'bed-exclude-volume-invalid', title: 'Error', message: MSG.bedVolumeInvalid, buttons: 'ok', dismiss: 'ok', writes: {} } };
  const append = (cur: string) => (cur ? `${cur}|${definition}` : definition);
  let yes: Writes;
  if ((first(printer('bed_exclude_volume_mode')) ?? 'shared') === 'per_extruder') {
    const defs = asList(printer('extruder_bed_exclude_volumes')).slice();
    const n = Math.max(1, asList(printer('nozzle_diameter')).length);
    while (defs.length < n) defs.push('');
    for (let i = 0; i < n; i++) defs[i] = append(defs[i]);
    yes = { extruder_bed_exclude_volumes: defs };
  } else {
    yes = { bed_exclude_volumes: append(first(printer('bed_exclude_volumes')) ?? '') };
  }
  return { prompt: { id: 'bed-exclude-volume', title: MSG.bedVolumeTitle, message: MSG.bedVolumeAsk, buttons: 'yesno', dismiss: 'no', writes: { yes } } };
}

/** C++ `%g` for the layer heights in these messages. */
function g(v: number): string { return String(Number(v.toPrecision(6))); }

// ---- process: ConfigManipulation::update_print_fff_config ------------------------------------------

const FILAMENT_PHYSICAL_ONLY = ['support_filament', 'support_interface_filament', 'wipe_tower_filament'];
const FILAMENT_FEATURE_KEYS = ['outer_wall_filament_id', 'inner_wall_filament_id', 'sparse_infill_filament_id', 'internal_solid_filament_id',
  'top_surface_filament_id', 'bottom_surface_filament_id'];

const PRINT_UPDATE: Check[] = [
  { id: 'belt-raft-shield', family: 'print', test: (c) => {
    if (!pbool(c, 'belt_printer')) return null;
    const raft = num(c, 'raft_layers') > 0, shield = c.get('draft_shield') !== undefined && str(c, 'draft_shield') !== 'disabled';
    if (!raft && !shield) return null;
    return ok('belt-raft-shield', MSG.belt, { ...(raft ? { raft_layers: '0' } : {}), ...(shield ? { draft_shield: 'disabled' } : {}) });
  } },
  { id: 'layer-height-zero', family: 'print', test: (c) => (c.get('layer_height') !== undefined && num(c, 'layer_height') < EPSILON ? ok('layer-height-zero', MSG.layerHeight, { layer_height: '0.2' }) : null) },
  { id: 'ironing-spacing', family: 'print', test: (c) => (c.get('ironing_spacing') !== undefined && num(c, 'ironing_spacing') < IRONING_SPACING_MIN ? ok('ironing-spacing', MSG.ironingSpacing, { ironing_spacing: '0.1' }) : null) },
  { id: 'support-ironing-spacing', family: 'print', test: (c) => (c.get('support_ironing_spacing') !== undefined && num(c, 'support_ironing_spacing') < IRONING_SPACING_MIN ? ok('support-ironing-spacing', MSG.ironingSpacing, { support_ironing_spacing: '0.1' }) : null) },
  { id: 'first-layer-zero', family: 'print', test: (c) => (c.get('initial_layer_print_height') !== undefined && num(c, 'initial_layer_print_height') < EPSILON ? ok('first-layer-zero', MSG.firstLayer, { initial_layer_print_height: '0.2' }) : null) },
  { id: 'xy-hole', family: 'print', test: (c) => (Math.abs(num(c, 'xy_hole_compensation')) > 2 ? ok('xy-hole', MSG.xyCompensation, { xy_hole_compensation: '0' }) : null) },
  { id: 'xy-contour', family: 'print', test: (c) => (Math.abs(num(c, 'xy_contour_compensation')) > 2 ? ok('xy-contour', MSG.xyCompensation, { xy_contour_compensation: '0' }) : null) },
  { id: 'elephant-foot', family: 'print', test: (c) => (num(c, 'elefant_foot_compensation') > 1 ? ok('elephant-foot', MSG.elephantFoot, { elefant_foot_compensation: '0' }) : null) },
  // DevPrinterConfigUtil::support_wrapping_detection: the rules treat it as "Bambu printer" (./orca.ts).
  { id: 'wrapping-unsupported', family: 'print', test: (c) => (bool(c, 'enable_wrapping_detection') && !c.isBBL ? { silent: { enable_wrapping_detection: '0' } } : null) },
  { id: 'spiral-mode', family: 'print', test: (c) => {
    if (!bool(c, 'spiral_mode')) return null;
    const fine = num(c, 'wall_loops') === 1 && num(c, 'top_shell_layers') === 0 && num(c, 'sparse_infill_density') === 0 && !bool(c, 'enable_support')
      && num(c, 'enforce_support_layers') === 0 && !bool(c, 'detect_thin_wall') && !bool(c, 'overhang_reverse') && str(c, 'timelapse_type') === '0'
      && !bool(c, 'enable_wrapping_detection');
    if (fine) return null;
    const conform: Writes = {
      wall_loops: '1', top_shell_layers: '0', sparse_infill_density: '0%', enable_support: '0', enforce_support_layers: '0', detect_thin_wall: '0',
      overhang_reverse: '0', timelapse_type: '0', enable_wrapping_detection: '0',
    };
    let message: string = MSG.spiral;
    if (pstr(c, 'printer_structure') === 'i3') message += MSG.spiralI3;
    // Per-object settings: a message with OK, and the settings follow (show_spiral_mode_settings_dialog).
    if (!c.isGlobal) return ok('spiral-mode', message, conform);
    return yesNo('spiral-mode', `${message}\n\n${MSG.spiralAsk}`, conform, { spiral_mode: '0' });
  } },
  { id: 'alternate-extra-wall', family: 'print', test: (c) => {
    if (!bool(c, 'alternate_extra_wall') || str(c, 'ensure_vertical_shell_thickness') !== 'ensure_all') return null;
    const yes = { ensure_vertical_shell_thickness: 'ensure_moderate', alternate_extra_wall: '1' };
    if (!c.isGlobal) return ok('alternate-extra-wall', MSG.alternateWall, yes);
    return yesNo('alternate-extra-wall', `${MSG.alternateWall}\n\n${MSG.alternateWallAsk}`, yes, { ensure_vertical_shell_thickness: 'ensure_all', alternate_extra_wall: '0' });
  } },
  // BBL printers do not support cone wipe tower.
  { id: 'bbl-cone-tower', family: 'print', test: (c) => (bool(c, 'enable_prime_tower') && c.isBBL && str(c, 'wipe_tower_wall_type') === 'cone' ? { silent: { wipe_tower_wall_type: 'rectangle' } } : null) },
  // Supports switched on in the global settings turn overhang wall detection on (asked once per enabling).
  // TabPrint::update seeds the flag once: a saved user preset that has supports without overhang detection
  // is left as it is.
  { id: 'support-overhangs', family: 'print', test: (c) => {
    if (c.isGlobal && c.memo.supportOverhangsInit === undefined) {
      c.memo.supportOverhangsInit = true;
      c.memo.supportOverhangsQueried = !!c.userSavedPreset && bool(c, 'enable_support') && !bool(c, 'detect_overhang_wall');
    }
    if (!(c.isGlobal && bool(c, 'enable_support'))) { c.memo.supportOverhangsQueried = false; return null; }
    if (c.memo.supportOverhangsQueried) return null;
    c.memo.supportOverhangsQueried = true;
    return bool(c, 'detect_overhang_wall') ? null : { silent: { detect_overhang_wall: '1' } };
  } },
  { id: 'support-style', family: 'print', test: (c) => {
    if (!bool(c, 'enable_support')) return null;
    const allowed = isTree(str(c, 'support_type')) ? TREE_STYLES : NORMAL_STYLES;
    return allowed.includes(str(c, 'support_style')) ? null : { silent: { support_style: 'default' } };
  } },
  // Filament overrides pointing at a slot that no longer exists; support / wipe tower also refuse mixed slots.
  { id: 'filament-ids', family: 'print', test: (c) => {
    const w: Writes = {};
    const check = (key: string, allowMixed: boolean) => {
      if (c.get(key) === undefined) return;
      const v = Math.trunc(num(c, key));
      const out = v > c.filamentCount;
      const mixed = !allowMixed && v > 0 && v <= c.filamentCount && c.isMixedSlot(v);
      if (out || mixed) w[key] = String(out ? c.platerValue(key) : 0);
    };
    FILAMENT_PHYSICAL_ONLY.forEach((k) => check(k, false));
    FILAMENT_FEATURE_KEYS.forEach((k) => check(k, true));
    return Object.keys(w).length ? { silent: w } : null;
  } },
  { id: 'mixed-sublayer-vlh', family: 'print', test: (c) => {
    const on = bool(c, 'enable_mixed_color_sublayer');
    if (!on) { c.memo.mixedSublayerWarned = false; return null; }
    if (c.memo.mixedSublayerWarned || c.appFlag('no_warn_mixed_sublayer_variable_layer') || !c.hasVariableLayerHeight) return null;
    c.memo.mixedSublayerWarned = true;
    return { prompt: { id: 'mixed-sublayer-vlh', title: '', message: MSG.mixedSublayer, buttons: 'ok', dismiss: 'ok', dontShowKey: 'no_warn_mixed_sublayer_variable_layer', writes: {} } };
  } },
  { id: 'seam-slope-height', family: 'print', test: (c) => {
    if (str(c, 'seam_slope_type') === 'none' || c.get('seam_slope_start_height') === undefined) return null;
    const lh = num(c, 'layer_height');
    return absValue(str(c, 'seam_slope_start_height'), lh) >= lh ? ok('seam-slope-height', MSG.seamSlope, { seam_slope_start_height: '0' }) : null;
  } },
  { id: 'lock-depth', family: 'print', test: (c) => {
    if (c.get('infill_lock_depth') === undefined) return null;
    const skin = num(c, 'skin_infill_depth');
    return num(c, 'infill_lock_depth') > skin ? ok('lock-depth', MSG.lockDepth, { infill_lock_depth: String(skin / 2) }) : null;
  } },
  { id: 'fuzzy-arachne', family: 'print', test: (c) => {
    if (c.get('fuzzy_skin_mode') === undefined || str(c, 'fuzzy_skin_mode') === 'displacement' || str(c, 'wall_generator') === 'arachne') return null;
    return yesNo('fuzzy-arachne', `${MSG.fuzzy}\n\n${MSG.fuzzyAsk}`, { wall_generator: 'arachne' }, { fuzzy_skin_mode: 'displacement' });
  } },
  // toggle_print_fff_options: reversing internal perimeters only zeroes the threshold.
  { id: 'overhang-reverse-internal', family: 'print', test: (c) => (bool(c, 'overhang_reverse_internal_only') && str(c, 'overhang_reverse_threshold') !== '0%' ? { silent: { overhang_reverse_threshold: '0%' } } : null) },
];

// ---- process: Tab::on_value_change ------------------------------------------------------------

/** extruder_max_nozzle_count: any extruder with a nozzle rack (nil = -… / empty). */
function hasNozzleRack(c: AutoContext): boolean {
  return asList(c.printer('extruder_max_nozzle_count')).some((s) => { const n = toNumber(s, 0); return n > 1 && n < 2147483647; });
}

const PRINT_CHANGE: Check[] = [
  // Tab::on_value_change("enable_prime_tower"). Turning it off: the nozzle-rack ask, then — with the edit's
  // value, not the answer — the smooth timelapse ask and, unless that one kept the tower, the clumping ask.
  // So a "No" to the first still shows the next one, as desktop does.
  { id: 'prime-tower', family: 'print', on: ['enable_prime_tower'], globalOnly: true, test: (c, ch) => {
    const keep: Writes = { enable_prime_tower: '1' };
    const warn = (id: string, message: string, writes: Partial<Record<Answer, Writes>>, remember?: Prompt['remember']): Step =>
      ({ prompt: { id, title: 'Warning', message, buttons: 'yesno', dismiss: 'yes', writes, remember } });
    if (!changedBool(ch)) {
      if (hasNozzleRack(c) && !c.memo.towerNozzlesAsked) {
        c.memo.towerNozzlesAsked = true;
        return warn('prime-tower-nozzles', MSG.towerNozzles, { no: keep });
      }
      if (str(c, 'timelapse_type') === '1' && !c.memo.towerTimelapseAsked) {
        c.memo.towerTimelapseAsked = true;
        return warn('prime-tower-timelapse', MSG.towerTimelapseOff, { no: keep }, { no: { towerTimelapseKept: true } });
      }
      if (bool(c, 'enable_wrapping_detection') && !c.memo.towerTimelapseKept && !c.memo.towerClumpingAsked) {
        c.memo.towerClumpingAsked = true;
        return warn('prime-tower-clumping', MSG.towerClumpingOff, { no: keep });
      }
      return null;
    }
    if (bool(c, 'precise_z_height') && !c.memo.towerPreciseAsked) {
      c.memo.towerPreciseAsked = true;
      return warn('prime-tower-precise-z', MSG.towerPreciseZ, { no: { enable_prime_tower: '0' } });
    }
    return null;
  } },
  { id: 'clumping-detection', family: 'print', on: ['enable_wrapping_detection'], globalOnly: true, test: (c, ch) => (changedBool(ch) && !bool(c, 'enable_prime_tower')
    ? { prompt: { id: 'clumping-detection', title: 'Warning', message: MSG.clumpingOn, buttons: 'yesno', dismiss: 'yes', writes: { no: { enable_wrapping_detection: '0' } } } } : null) },
  { id: 'precise-z', family: 'print', on: ['precise_z_height'], globalOnly: true, test: (c, ch) => (changedBool(ch) && bool(c, 'enable_prime_tower')
    ? { prompt: { id: 'precise-z', title: 'Warning', message: MSG.preciseZOn, buttons: 'yesno', dismiss: 'yes', writes: { no: { precise_z_height: '0' } } } } : null) },
  { id: 'smooth-no-sparse', family: 'print', on: ['timelapse_type'], globalOnly: true, test: (c, ch) => (first(ch.value) === '1' && bool(c, 'wipe_tower_no_sparse_layers')
    ? ok('smooth-no-sparse', MSG.smoothNoSparse, { wipe_tower_no_sparse_layers: '0' }, 'Warning') : null) },
  { id: 'smooth-tower', family: 'print', on: ['timelapse_type'], globalOnly: true, test: (c, ch) => (first(ch.value) === '1' && !bool(c, 'enable_prime_tower')
    ? { prompt: { id: 'smooth-tower', title: 'Warning', message: MSG.smoothTower, buttons: 'yesno', dismiss: 'no', writes: { yes: { enable_prime_tower: '1' } } } } : null) },
  { id: 'no-sparse-smooth', family: 'print', on: ['wipe_tower_no_sparse_layers'], globalOnly: true, test: (c, ch) => (changedBool(ch) && str(c, 'timelapse_type') === '1'
    ? ok('no-sparse-smooth', MSG.noSparseSmooth, { timelapse_type: '0' }, 'Warning') : null) },
  { id: 'by-object-i3', family: 'print', on: ['print_sequence'], globalOnly: true, test: (c) => (str(c, 'print_sequence') === 'by object' && pstr(c, 'printer_structure') === 'i3'
    ? { prompt: { id: 'by-object-i3', title: '', message: `${MSG.byObjectI3}\n\n${MSG.byObjectAsk}`, buttons: 'yesno', dismiss: 'yes', writes: { no: { print_sequence: 'by layer' } } } } : null) },
  // Orca: only in simple mode.
  { id: 'support-type-style', family: 'print', on: ['support_type'], globalOnly: true, test: (c) => (c.mode === 0 && str(c, 'support_style') !== 'default' ? { silent: { support_style: 'default' } } : null) },
  { id: 'support-filament', family: 'print', on: ['support_filament'], globalOnly: true, test: (c) => {
    const id = Math.trunc(num(c, 'support_filament')) - 1;
    if (!(isSupportFilament(c, id) && !isSoluble(c, id) && !hasModelFilament(c, ['TPU', 'TPU-AMS']))) return null;
    return { prompt: { id: 'support-filament', title: '', message: MSG.supportBase, buttons: 'yesno', dismiss: 'yes', writes: { no: { support_filament: '0' } } } };
  } },
  { id: 'support-interface-filament', family: 'print', on: ['support_interface_filament'], globalOnly: true, test: (c) => {
    const base = Math.trunc(num(c, 'support_filament')) - 1;
    const iface = Math.trunc(num(c, 'support_interface_filament')) - 1;
    const tuned = num(c, 'support_top_z_distance') === 0 && num(c, 'support_interface_spacing') === 0 && str(c, 'support_interface_pattern') === 'rectilinear_interlaced';
    if (!((isSupportFilament(c, iface) && !tuned) || (isSoluble(c, iface) && !isSoluble(c, base)))) return null;
    const msg = isSoluble(c, iface) ? MSG.interfaceSoluble : MSG.interfaceSupport;
    const yes: Writes = { support_top_z_distance: '0', support_interface_spacing: '0', support_interface_pattern: 'rectilinear_interlaced', independent_support_layer_height: '0' };
    const type = c.filament(iface)?.type ?? '';
    if ((type === 'PLA' && hasModelFilament(c, ['TPU', 'TPU-AMS'])) || (isSoluble(c, iface) && !isSoluble(c, base))) yes.support_filament = String(iface + 1);
    return { prompt: { id: 'support-interface-filament', title: 'Suggestion', message: `${msg}\n\n${MSG.interfaceAsk}`, buttons: 'yesno', dismiss: 'no', writes: { yes } } };
  } },
  { id: 'make-overhang-printable', family: 'print', on: ['make_overhang_printable'], globalOnly: true, test: (c) => (bool(c, 'make_overhang_printable')
    ? { prompt: { id: 'make-overhang-printable', title: '', message: `${MSG.overhangPrintable}\n\n${MSG.sureEnable}`, buttons: 'yesno', yesLabel: 'Enable', noLabel: 'Cancel', dismiss: 'yes', writes: { no: { make_overhang_printable: '0' } } } } : null) },
  { id: 'rotate-template', family: 'print', on: ['sparse_infill_rotate_template'], globalOnly: true, test: (c, ch) => {
    const safe = ['rectilinear', 'line', 'zigzag', 'crosszag', 'lockedzag'].includes(str(c, 'sparse_infill_pattern')) || !first(ch.value);
    if (safe || c.memo.lastRotateTemplate) return null;
    return { prompt: { id: 'rotate-template', title: '', message: `${MSG.rotateTemplate}\n\n${MSG.sureEnable}`, buttons: 'yesno', yesLabel: 'Enable', noLabel: 'Cancel', dismiss: 'yes',
      writes: { no: { sparse_infill_rotate_template: '' } } } };
  },
  // m_last_sparse_infill_rotate_template_value: the value after the answer.
  after: (c) => { c.memo.lastRotateTemplate = str(c, 'sparse_infill_rotate_template'); } },
  // check_layer_height: the printer's layer height limits (min / max over the extruders).
  { id: 'layer-height-limits', family: 'print', on: ['layer_height'], globalOnly: true, test: (c) => {
    const mins = asList(c.printer('min_layer_height')).map((s) => toNumber(s, 0));
    const maxs = asList(c.printer('max_layer_height')).map((s) => toNumber(s, 0));
    if (!mins.length || !maxs.length) return null;
    const min = Math.min(...mins), max = Math.max(...maxs), lh = num(c, 'layer_height');
    if (min > EPSILON && lh < EPSILON) return ok('layer-height-limits', MSG.layerTooSmall(min), { layer_height: String(min) });
    const ask = (to: number): Step => ({ prompt: { id: 'layer-height-limits', title: '', message: `${MSG.layerOutOfRange}\n\n${MSG.layerAdjust(to)}`, buttons: 'yesno',
      yesLabel: 'Adjust', noLabel: 'Ignore', dismiss: 'no', writes: { yes: { layer_height: String(to) } } } });
    if (max > EPSILON && lh > max + EPSILON) return ask(max);
    if (min > EPSILON && lh < min - EPSILON) return ask(min);
    return null;
  } },
];

// ---- filament ---------------------------------------------------------------------------------

const FILAMENT: Check[] = [
  // TabFilament::update
  { id: 'max-volumetric-speed', family: 'filament', test: (c) => {
    if (c.get('filament_max_volumetric_speed') === undefined) return null;
    return num(c, 'filament_max_volumetric_speed') < 0.5 ? ok('max-volumetric-speed', MSG.maxVolumetric, { filament_max_volumetric_speed: ['0.5'] }) : null;
  } },
  { id: 'filament-ironing-spacing', family: 'filament', test: (c) => {
    const v = c.get('filament_ironing_spacing');
    if (v === undefined) return null;
    const list = asList(v);
    let reset = false;
    const next = list.map((s) => { if (s === 'nil' || s === '') return s; if (toNumber(s, 1) < IRONING_SPACING_MIN) { reset = true; return '0.1'; } return s; });
    return reset ? ok('filament-ironing-spacing', MSG.ironingSpacing, { filament_ironing_spacing: next }) : null;
  } },
  // TabFilament::toggle_options: "No cooling for the first" layers force the first layer fan override off.
  { id: 'first-layer-fan', family: 'filament', test: (c) => {
    if (num(c, 'close_fan_the_first_x_layers') <= 0 || c.get('initial_layer_fan_speed') === undefined) return null;
    const list = asList(c.get('initial_layer_fan_speed'));
    return list.some((s) => s !== '-1') ? { silent: { initial_layer_fan_speed: list.map(() => '-1') } } : null;
  } },
  { id: 'recommended-range', family: 'filament', on: ['nozzle_temperature_range_low', 'nozzle_temperature_range_high'], test: (c) => {
    if (c.get('nozzle_temperature_range_low') === undefined || c.get('nozzle_temperature_range_high') === undefined) return null;
    const lo = num(c, 'nozzle_temperature_range_low', c.variantIndex), hi = num(c, 'nozzle_temperature_range_high', c.variantIndex);
    let type = str(c, 'filament_type');
    const [min, max, known] = materialRange(type, 'nozzle');
    if (!known) type = 'Unknown';
    let msg = '';
    if (lo < min) msg += MSG.tempMin(min, type);
    if (hi > max) msg += MSG.tempMax(max, type);
    if (lo > hi) msg += MSG.tempOrder;
    return msg ? ok('recommended-range', msg + MSG.pleaseCheck) : null;
  } },
  { id: 'nozzle-temperature', family: 'filament', on: ['nozzle_temperature', 'nozzle_temperature_initial_layer'], test: (c, ch) => {
    if (c.get('nozzle_temperature_range_low') === undefined || c.get('nozzle_temperature_range_high') === undefined) return null;
    const lo = num(c, 'nozzle_temperature_range_low', c.variantIndex), hi = num(c, 'nozzle_temperature_range_high', c.variantIndex);
    const t = num(c, ch.key, c.variantIndex);
    return t < lo || t > hi ? ok('nozzle-temperature', MSG.nozzleRange + MSG.nozzleRecommended(lo, hi)) : null;
  } },
  { id: 'chamber-temperature', family: 'filament', on: ['chamber_temperature'], test: (c) => {
    if (!pbool(c, 'support_chamber_temp_control') || c.get('chamber_temperature') === undefined) return null;
    const [, max, known] = materialRange(str(c, 'filament_type'), 'chamber');
    return known && max < num(c, 'chamber_temperature') ? ok('chamber-temperature', MSG.chamberMax(max)) : null;
  } },
  { id: 'chamber-minimal', family: 'filament', on: ['chamber_temperature', 'chamber_minimal_temperature'], test: (c) => {
    if (c.get('chamber_minimal_temperature') === undefined || c.get('chamber_temperature') === undefined) return null;
    const min = num(c, 'chamber_minimal_temperature'), target = num(c, 'chamber_temperature');
    return min > target ? ok('chamber-minimal', MSG.chamberMin(min, target), { chamber_minimal_temperature: [String(target)] }) : null;
  } },
  // The PA group's on-change: only the edited extruder variant's model is checked.
  { id: 'adaptive-pa-model', family: 'filament', on: ['adaptive_pressure_advance_model'], test: (c) => {
    const list = asList(c.get('adaptive_pressure_advance_model'));
    if (!list.length) return null;
    const error = validateAdaptivePaModel(list[c.variantIndex] ?? list[0] ?? ''); // ConfigOptionStrings::get_at
    return error ? ok('adaptive-pa-model', MSG.adaptivePa + error) : null;
  } },
  { id: 'filament-long-retraction', family: 'filament', on: ['filament_long_retractions_when_cut'], test: (c, ch) => (toBool(valueAt(ch.value, Math.min(c.variantIndex, Math.max(0, asList(ch.value).length - 1))))
    ? ok('filament-long-retraction', MSG.longRetractionFilament) : null) },
];

// ---- printer ----------------------------------------------------------------------------------

const PRINTER: Check[] = [
  // TabPrinter::toggle_options (extruder pages): firmware retraction needs retract before wipe at 100 %.
  { id: 'firmware-retraction', family: 'printer', test: (c) => {
    if (!bool(c, 'use_firmware_retraction')) return null;
    const i = c.variantIndex;
    // retraction = have_retract_length || use_firmware_retraction, so true here.
    const wipe = bool(c, 'wipe', i);
    const rbw = toNumber((valueAt(c.get('retract_before_wipe'), i) ?? '100').replace('%', ''), 100);
    if (!(wipe && rbw < 100)) return null;
    const yes: Writes = { wipe: asList(c.get('wipe')).map(() => '0'), retract_before_wipe: asList(c.get('retract_before_wipe')).map(() => '100%') };
    return { prompt: { id: 'firmware-retraction', title: 'Firmware Retraction', message: MSG.firmwareRetraction, buttons: 'yesno', dismiss: 'no', writes: { yes, no: { use_firmware_retraction: '0' } } } };
  } },
  { id: 'manual-filament-change', family: 'printer', test: (c) => (!bool(c, 'single_extruder_multi_material') && bool(c, 'manual_filament_change') ? { silent: { manual_filament_change: '0' } } : null) },
  { id: 'semm-purge', family: 'printer', on: ['single_extruder_multi_material'], test: (c) => (!bool(c, 'single_extruder_multi_material') && bool(c, 'purge_in_prime_tower') ? { silent: { purge_in_prime_tower: '0' } } : null) },
  // TabPrinter::update_input_shaper_menu: a type the firmware doesn't have falls back to its first one.
  { id: 'input-shaper', family: 'printer', test: (c) => {
    if (c.get('input_shaping_type') === undefined) return null;
    const allowed = inputShaperTypes(str(c, 'gcode_flavor'));
    return allowed.includes(str(c, 'input_shaping_type')) ? null : { silent: { input_shaping_type: allowed[0] } };
  } },
  // BBL multi-extruder printers keep one layer height limit for every extruder.
  { id: 'layer-limits-shared', family: 'printer', on: ['min_layer_height', 'max_layer_height'], test: (c, ch) => {
    const list = asList(c.get(ch.key));
    if (!c.isBBL || list.length < 2) return null;
    const v = list[Math.min(c.variantIndex, list.length - 1)];
    return list.every((s) => s === v) ? null : { silent: { [ch.key]: list.map(() => v) } };
  } },
  // The extruder page's on-change: a single-extruder multi-material printer keeps one nozzle diameter
  // (not BBL multi-extruder printers, whose nozzles are independent). Yes copies the new value to every
  // extruder, No puts the edited one back to the other's.
  { id: 'semm-nozzle-diameter', family: 'printer', on: ['nozzle_diameter'], test: (c) => {
    const list = asList(c.get('nozzle_diameter'));
    if (!bool(c, 'single_extruder_multi_material') || list.length < 2 || c.isBBL) return null;
    const i = Math.min(c.variantIndex, list.length - 1), other = i === 0 ? 1 : 0;
    const nd = toNumber(list[i], 0);
    if (Math.abs(toNumber(list[other], 0) - nd) <= EPSILON) return null;
    return { prompt: { id: 'semm-nozzle-diameter', title: MSG.semmNozzleTitle, message: MSG.semmNozzle, buttons: 'yesno', dismiss: 'no',
      writes: { yes: { nozzle_diameter: list.map(() => list[i]) }, no: { nozzle_diameter: list.map((v, j) => (j === i ? list[other] : v)) } } } };
  } },
  { id: 'long-retraction', family: 'printer', on: ['long_retractions_when_cut'], test: (c, ch) => (toBool(valueAt(ch.value, Math.min(c.variantIndex, Math.max(0, asList(ch.value).length - 1))))
    ? ok('long-retraction', MSG.longRetraction) : null) },
];

export const AUTO_CHECKS: Record<RuleFamily, Check[]> = {
  // Orca: Tab::on_value_change runs first (the field's own handler), then Tab::update → update_print_fff_config.
  print: [...PRINT_CHANGE, ...PRINT_UPDATE],
  filament: FILAMENT,
  printer: PRINTER,
};

/**
 * A preset was selected (Tab::load_current_preset → update): only the checks that run on every update —
 * TabPrint::update_print_fff_config, TabFilament::update / toggle_options, TabPrinter::update_fff /
 * toggle_options — not the per-key on-change handlers.
 */
export function runPresetChecks(c: AutoContext, ask: (p: Prompt) => Promise<Answer>): Promise<Writes> {
  return runAutoChanges(c, { key: '', value: '' }, ask, { select: true });
}

const TOWER_MEMO = ['towerNozzlesAsked', 'towerTimelapseAsked', 'towerTimelapseKept', 'towerClumpingAsked', 'towerPreciseAsked'];
function clearTowerMemo(memo: Record<string, unknown>): void { for (const k of TOWER_MEMO) delete memo[k]; }

/**
 * Run the checks for one edit. `ask` shows a prompt and resolves with the answer (dismissed = the prompt's
 * `dismiss`). Returns the writes in order (later ones win); the caller applies them.
 */
export async function runAutoChanges(c: AutoContext, change: Change, ask: (p: Prompt) => Promise<Answer>, opts: { select?: boolean } = {}): Promise<Writes> {
  const out: Writes = {};
  const base = c.get.bind(c);
  const ctx: AutoContext = { ...c, get: (k) => (k in out ? out[k] : base(k)) };
  clearTowerMemo(c.memo);
  const key = change.key.replace(/#\d+$/, '');
  for (const check of AUTO_CHECKS[c.family]) {
    if (check.on && (opts.select || !check.on.includes(key))) continue;
    if (check.globalOnly && !c.isGlobal) continue;
    // A check may fire more than once (the prime tower's chain of asks); bounded.
    for (let guard = 0; guard < 4; guard++) {
      const step = check.test(ctx, { key, value: change.value });
      if (!step) break;
      if ('silent' in step) { Object.assign(out, step.silent); break; }
      const answer = await ask(step.prompt);
      Object.assign(out, step.prompt.writes[answer] ?? {});
      Object.assign(c.memo, step.prompt.remember?.[answer] ?? {});
      if (!check.on || check.id !== 'prime-tower') break;
    }
    check.after?.(ctx);
  }
  clearTowerMemo(c.memo);
  return out;
}

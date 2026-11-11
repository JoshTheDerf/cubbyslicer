/**
 * The hand-written half of Orca's enable / show rules. The generated table
 * (./orca.generated.ts) holds every toggle call with its C++ condition; the
 * evaluator (./cpp.ts) runs those conditions directly. What it can't run is
 * here: app state the GUI reads from elsewhere (BUILTINS), small library
 * predicates (HELPERS), locals computed in several statements (HAND_LOCALS,
 * each with the C++ text it ports so a source change fails the rules test),
 * and rules Orca applies outside the toggle functions (EXTRA_RULES, CHOICES).
 */
import type { ConfigValue } from '../../engine/types';
import { asList, toBool, toNumber, valueAt } from '../../lib/configValue';
import type { CppValue } from './cpp';
import type { RuleContext, RuleFamily } from './types';

const fn = (f: (...a: CppValue[]) => CppValue): CppValue => ({ fn: f });
const str = (v: CppValue) => String(v);

/** PrintConfig.hpp predicates over enum values. */
const SEPARABLE = new Set(['monotonic', 'monotonicline', 'rectilinear', 'alignedrectilinear', 'zigzag', 'crosszag', 'lockedzag', 'line', 'grid', 'triangles',
  'tri-hexagon', 'cubic', 'quartercubic', 'honeycomb', '3dhoneycomb', 'lateral-honeycomb', 'lateral-lattice', 'crosshatch', 'tpmsd', 'tpmsfk', 'gyroid',
  'hilbertcurve', 'archimedeanchords', 'octagramspiral']);
const SMOOTHABLE = new Set(['hilbertcurve', 'octagramspiral', 'lightning', 'honeycomb', '3dhoneycomb', 'concentric', 'crosshatch']);
const SMOOTHABLE_MULTILINE = new Set(['grid', 'triangles', 'tri-hexagon', 'cubic']);
/** Enum values the helpers above name (checked against the schema by the rules test). */
export const HELPER_ENUM_VALUES = {
  sparse_infill_pattern: [...SEPARABLE, ...SMOOTHABLE, ...SMOOTHABLE_MULTILINE, 'tpmsd', 'tpmsfk', 'gyroid'],
  support_type: ['tree(auto)', 'tree(manual)', 'normal(auto)'],
  curr_bed_type: ['Supertack Plate', 'Cool Plate', 'Textured Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Textured PEI Plate'],
};

export const HELPERS: Record<string, CppValue> = {
  is_tree: fn((t) => str(t) === 'tree(auto)' || str(t) === 'tree(manual)'),
  is_auto: fn((t) => str(t) === 'normal(auto)' || str(t) === 'tree(auto)'),
  is_adaptive_infill_pattern: fn((p) => ['gyroid', 'tpmsd', 'tpmsfk'].includes(str(p))),
  is_separable_infill_pattern: fn((p) => SEPARABLE.has(str(p))),
  is_smoothable_infill_pattern: fn((p, multiline = 1) => SMOOTHABLE.has(str(p)) || (SMOOTHABLE_MULTILINE.has(str(p)) && Number(multiline) > 1)),
  is_approx: fn((a, b) => Math.abs(Number(a) - Number(b)) < 1e-6),
  'std::abs': fn((a) => Math.abs(Number(a))),
  BELT_BRIM_MIN_TILT_DEG: 1, BELT_BRIM_MAX_TILT_DEG: 85,
  comSimple: 0, comAdvanced: 1, comExpert: 2, comDevelop: 3,
};

/** App state the GUI code reads from outside the configs. */
export function builtins(ctx: RuleContext): Record<string, CppValue> {
  return {
    is_BBL_Printer: ctx.isBBL, is_BBL_printer: ctx.isBBL,
    is_bbl_vendor: fn(() => ctx.isBBL),
    get_printer_extruder_count: fn(() => ctx.extruderCount),
    variant_index: ctx.variantIndex,
    // TabPrinter: the extruder selected on the Extruder page (here: the page's extruder).
    extruder: ctx.variantIndex,
    m_mode: ctx.mode,
    is_global_config: ctx.isGlobal,
    // The plate settings tab (curr_bed_type) is not part of the settings editor.
    m_type: 0, 'Preset::TYPE_PLATE': -1,
    // Orca asks its device database (printer type); CubbySlicer has none, so Bambu printers (the ones with
    // wrapping detection) offer it.
    'DevPrinterConfigUtil::support_wrapping_detection': fn(() => ctx.isBBL),
  };
}

interface HandLocal {
  /** The C++ initialiser text (as extracted) this ports. */
  cpp: string;
  eval: (ctx: RuleContext, local: (name: string) => CppValue) => CppValue;
}

const printer = (ctx: RuleContext, key: string): ConfigValue | undefined => ctx.read('printer', key);
const isBelt = (ctx: RuleContext) => toBool(valueAt(printer(ctx, 'belt_printer'), 0));

/** Locals assigned in several statements or computed from things the evaluator doesn't model. */
export const HAND_LOCALS: Record<RuleFamily, Record<string, HandLocal>> = {
  print: {
    is_belt_printer: { cpp: 'false ; = belt_opt->value', eval: (ctx) => isBelt(ctx) },
    tilt: { cpp: 'std::abs(angle->value)', eval: (ctx) => Math.abs(toNumber(valueAt(printer(ctx, 'belt_slice_rotation_angle'), 0), 0)) },
    is_belt_tilted: {
      cpp: 'false ; = (axis->value == BeltRotationAxis::X || axis->value == BeltRotationAxis::Y) && tilt >= BELT_BRIM_MIN_TILT_DEG && tilt <= BELT_BRIM_MAX_TILT_DEG',
      eval: (ctx, local) => {
        const axis = valueAt(printer(ctx, 'belt_slice_rotation'), 0);
        const tilt = Number(local('tilt'));
        return isBelt(ctx) && (axis === 'x' || axis === 'y') && tilt >= 1 && tilt <= 85;
      },
    },
    machine_supports_junction_deviation: {
      cpp: 'false ; = !machine_jd->values.empty() && machine_jd->values.front() > 0.0',
      eval: (ctx) => valueAt(printer(ctx, 'gcode_flavor'), 0) === 'marlin2' && toNumber(valueAt(printer(ctx, 'machine_max_junction_deviation'), 0), 0) > 0,
    },
    printer_type: { cpp: 'wxGetApp().preset_bundle->printers.get_edited_preset().get_printer_type(wxGetApp().preset_bundle)', eval: () => '' },
  },
  printer: {
    enable_jerk: {
      cpp: '!gcf_is_marlin_firmware ; = std::all_of(values.begin(), values.end(), [](double val) { return val == 0.0; }) ; = true',
      eval: (ctx) => valueAt(ctx.read('self', 'gcode_flavor'), 0) !== 'marlin2'
        || asList(ctx.read('self', 'machine_max_junction_deviation')).every((v) => toNumber(v, 0) === 0),
    },
    printer_type: { cpp: 'preset_bundle->printers.get_edited_preset().get_printer_type(preset_bundle)', eval: () => '' },
  },
  filament: {
    bed_temp_1st_layer_key: {
      cpp: '"" ; = get_bed_temp_1st_layer_key(proj_cfg.opt_enum<BedType>("curr_bed_type"))',
      eval: (ctx) => BED_TEMP_KEY[valueAt(ctx.read('project', 'curr_bed_type'), 0) ?? ''] ?? '',
    },
    support_multi_bed_types: {
      cpp: 'std::find(bed_temp_keys.begin(), bed_temp_keys.end(), bed_temp_1st_layer_key) == bed_temp_keys.end() || is_BBL_printer || printer_cfg.opt_bool("support_multi_bed_types")',
      eval: (ctx, local) => !Object.values(BED_TEMP_KEY).includes(String(local('bed_temp_1st_layer_key'))) || ctx.isBBL
        || toBool(valueAt(printer(ctx, 'support_multi_bed_types'), 0)),
    },
  },
};

/** get_bed_temp_1st_layer_key (PrintConfig.hpp). */
const BED_TEMP_KEY: Record<string, string> = {
  'Supertack Plate': 'supertack_plate_temp_initial_layer', 'Cool Plate': 'cool_plate_temp_initial_layer',
  'Textured Cool Plate': 'textured_cool_plate_temp_initial_layer', 'Engineering Plate': 'eng_plate_temp_initial_layer',
  'High Temp Plate': 'hot_plate_temp_initial_layer', 'Textured PEI Plate': 'textured_plate_temp_initial_layer',
};

// ---- rules outside the toggle functions ---------------------------------------------

export interface ExtraRule {
  kind: 'enable' | 'show';
  keys: string[];
  when: (ctx: RuleContext) => boolean;
  reason: string;
}

/** filament_* overrides of printer retraction settings (TabFilament::update_filament_overrides_page). */
const FILAMENT_RETRACTION_OVERRIDES = ['filament_z_hop', 'filament_z_hop_types', 'filament_retract_lift_above', 'filament_retract_lift_below',
  'filament_retract_lift_enforce', 'filament_retraction_speed', 'filament_deretraction_speed', 'filament_retract_restart_extra',
  'filament_retract_length_toolchange', 'filament_retract_restart_extra_toolchange', 'filament_retraction_minimum_travel',
  'filament_retract_when_changing_layer', 'filament_wipe', 'filament_wipe_distance', 'filament_retract_before_wipe', 'filament_retract_after_wipe',
  'filament_long_retractions_when_cut', 'filament_retraction_distances_when_cut'];
/** LongRectrationLevel::EnableFilament */
const LONG_RETRACTION_FILAMENT = 2;

export const EXTRA_RULES: Record<RuleFamily, ExtraRule[]> = {
  print: [],
  printer: [
    // TabPrinter::toggle_options: m_imex_modes_ctrl->set_applicable(is_imex) (the Modes grid edits these lists).
    { kind: 'enable', keys: ['imex_mode_names', 'imex_mode_active_tools', 'imex_mode_gcodes'], when: (ctx) => toBool(valueAt(ctx.read('self', 'is_imex'), 0)),
      reason: 'Enable IDEX/IQEX printer mode to use this setting.' },
  ],
  filament: [
    {
      kind: 'enable', keys: FILAMENT_RETRACTION_OVERRIDES,
      when: (ctx) => { const v = valueAt(ctx.read('self', 'filament_retraction_length'), 0); return v === undefined || v === 'nil' || toNumber(v, 0) > 0; },
      reason: "Set the filament retraction length above zero, or use the printer's value, to edit this setting.",
    },
    { kind: 'show', keys: ['filament_long_retractions_when_cut'], when: (ctx) => toNumber(valueAt(printer(ctx, 'enable_long_retraction_when_cut'), 0), 0) === LONG_RETRACTION_FILAMENT,
      reason: 'The printer profile must allow filament overrides for long retraction when cutting.' },
    {
      kind: 'show', keys: ['filament_retraction_distances_when_cut'],
      when: (ctx) => toNumber(valueAt(printer(ctx, 'enable_long_retraction_when_cut'), 0), 0) === LONG_RETRACTION_FILAMENT
        && toBool(valueAt(ctx.read('self', 'filament_long_retractions_when_cut'), 0)),
      reason: 'Allow long retraction when cutting in the printer profile and enable it in the filament profile to use this setting.',
    },
  ],
};

/** Enum choices a tab narrows at runtime (TabPrint / TabPrinter::toggle_options), or null to keep the schema's. */
export interface Choices { values: string[]; labels?: string[] }
export const CHOICES: Record<RuleFamily, Record<string, (ctx: RuleContext) => Choices | null>> = {
  print: {
    // Normal supports: Default / Grid / Snug; tree supports: Default / Slim / Strong / Hybrid / Organic.
    support_style: (ctx) => {
      const t = valueAt(ctx.read('self', 'support_type'), 0) ?? '';
      return { values: t.startsWith('tree') ? ['default', 'tree_slim', 'tree_strong', 'tree_hybrid', 'organic'] : ['default', 'grid', 'snug'] };
    },
    // "Leading edge only" is offered on belt printers (kept while selected).
    brim_type: (ctx) => (isBelt(ctx) || valueAt(ctx.read('self', 'brim_type'), 0) === 'leading_edge_only' ? null : { values: ['auto_brim', 'brim_ears', 'painted', 'outer_only', 'inner_only', 'outer_and_inner', 'no_brim'] }),
    // Bambu printers have no cone wipe tower.
    wipe_tower_wall_type: (ctx) => (ctx.isBBL ? { values: ['rectangle', 'rib'] } : null),
  },
  printer: {
    // One gantry: front/rear is meaningless; "Left" / "Right" map to front-left / front-right.
    imex_tool_layout: (ctx) => (Math.max(1, toNumber(valueAt(ctx.read('self', 'imex_gantry_count'), 0), 1)) >= 2 ? null
      : { values: ['front-left', 'front-right'], labels: ['Left', 'Right'] }),
  },
  filament: {},
};

/**
 * Values Orca rewrites when a related value changes (TabPrinter::on_value_change): retract before / after
 * wipe are percentages of one retraction, so after ≤ 100 − before. Returns the extra edits to apply.
 */
export function coupledEdits(family: RuleFamily, key: string, value: ConfigValue, read: (key: string) => ConfigValue | undefined, index: number): Record<string, ConfigValue> {
  if (family !== 'printer' || (key !== 'retract_before_wipe' && key !== 'retract_after_wipe')) return {};
  const pct = (v: string | undefined) => Math.min(100, Math.max(0, toNumber(v, 0)));
  const list = (v: ConfigValue | undefined) => asList(v).slice();
  const before = key === 'retract_before_wipe' ? list(value) : list(read('retract_before_wipe'));
  const after = key === 'retract_after_wipe' ? list(value) : list(read('retract_after_wipe'));
  const b = pct(valueAt(before, index)), a = pct(valueAt(after, index));
  if (a <= 100 - b) return {};
  while (after.length <= index) after.push(after[after.length - 1] ?? '0%');
  after[index] = `${100 - b}%`;
  return { retract_after_wipe: after };
}

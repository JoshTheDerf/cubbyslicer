/**
 * G-code placeholder catalogue for the custom G-code editor (Orca
 * EditGCodeDialog::init_params_list): slicing states, print statistics,
 * objects info, dimensions, temperatures, timestamps, the variables specific
 * to one G-code field, and every preset option (from the engine schema,
 * grouped by settings page).
 */
import type { ConfigSchema } from '../../engine/types';
import type { BuiltLayout, SettingsTabId } from '../../settings/layout/types';
import { isVectorType } from '../../presets/values';

export interface PlaceholderItem {
  key: string;
  label: string;
  tooltip: string;
  /** Vector options are inserted as key[] (index inside the brackets). */
  vector: boolean;
}
export interface PlaceholderGroup {
  id: string;
  title: string;
  icon: string;
  items: PlaceholderItem[];
  groups?: PlaceholderGroup[];
}

type Def = [key: string, vector: boolean, label: string, tooltip: string];

const RO_STATES: Def[] = [['zhop', false, 'Current Z-hop', 'Contains Z-hop present at the beginning of the custom G-code block.']];
const RW_STATES: Def[] = [
  ['position', true, 'Position', 'Position of the extruder at the beginning of the custom G-code block. If the custom G-code travels somewhere else, it should write to this variable so the slicer knows where it travels from when it gets control back.'],
  ['e_retracted', true, 'Retraction', 'Retraction state at the beginning of the custom G-code block. If the custom G-code moves the extruder axis, it should write to this variable so the slicer de-retracts correctly when it gets control back.'],
  ['e_restart_extra', true, 'Extra de-retraction', 'Currently planned extra extruder priming after de-retraction.'],
  ['e_position', true, 'Absolute E position', 'Current position of the extruder axis. Only used with absolute extruder addressing.'],
];
const OTHER_STATES: Def[] = [
  ['current_extruder', false, 'Current extruder', 'Zero-based index of currently used extruder.'],
  ['current_object_idx', false, 'Current object index', 'Specific for sequential printing. Zero-based index of currently printed object.'],
  ['has_wipe_tower', false, 'Has wipe tower', 'Whether or not wipe tower is being generated in the print.'],
  ['initial_extruder', false, 'Initial extruder', 'Zero-based index of the first extruder used in the print. Same as initial_tool.'],
  ['initial_tool', false, 'Initial tool', 'Zero-based index of the first extruder used in the print. Same as initial_extruder.'],
  ['is_extruder_used', true, 'Is extruder used?', 'Vector of booleans stating whether a given extruder is used in the print.'],
  ['num_extruders', false, 'Number of extruders', 'Total number of extruders, regardless of whether they are used in the current print.'],
  ['has_single_extruder_multi_material_priming', false, 'Has single extruder MM priming', 'Are the extra multi-material priming regions used in this print?'],
  ['initial_no_support_extruder', false, 'Initial no support extruder', 'Zero-based index of the first extruder used for printing without support. Same as initial_no_support_tool.'],
  ['in_head_wrap_detect_zone', false, 'In head wrap detect zone', 'Indicates if the first layer overlaps with the head wrap zone.'],
];
const STATISTICS: Def[] = [
  ['extruded_volume', true, 'Volume per extruder', 'Total filament volume extruded per extruder during the entire print.'],
  ['total_toolchanges', false, 'Total tool changes', 'Number of tool changes during the print.'],
  ['extruded_volume_total', false, 'Total volume', 'Total volume of filament used during the entire print.'],
  ['extruded_weight', true, 'Weight per extruder', 'Weight per extruder extruded during the entire print. Calculated from filament_density value in Filament Settings.'],
  ['extruded_weight_total', false, 'Total weight', 'Total weight of the print. Calculated from filament_density value in Filament Settings.'],
  ['total_layer_count', false, 'Total layer count', 'Number of layers in the entire print.'],
  ['normal_print_time', false, 'Print time (normal mode)', 'Estimated print time when printed in normal mode (i.e. not in silent mode). Same as print_time.'],
  ['print_time', false, 'Print time (normal mode)', 'Estimated print time when printed in normal mode (i.e. not in silent mode). Same as normal_print_time.'],
  ['silent_print_time', false, 'Print time (silent mode)', 'Estimated print time when printed in silent mode.'],
  ['total_cost', false, 'Total cost', 'Total cost of all material used in the print. Calculated from filament_cost value in Filament Settings.'],
  ['total_weight', false, 'Total weight', 'Total weight of the print. Calculated from filament_density value in Filament Settings.'],
  ['total_wipe_tower_cost', false, 'Total wipe tower cost', 'Total cost of the material wasted on the wipe tower. Calculated from filament_cost value in Filament Settings.'],
  ['total_wipe_tower_filament', false, 'Wipe tower volume', 'Total filament volume extruded on the wipe tower.'],
  ['used_filament', false, 'Used filament', 'Total length of filament used in the print.'],
  ['print_time_sec', false, 'Print time (seconds)', 'Total estimated print time in seconds. Replaced with actual value during post-processing.'],
  ['used_filament_length', false, 'Filament length (meters)', 'Total filament length used in meters. Replaced with actual value during post-processing.'],
];
const OBJECTS: Def[] = [
  ['num_objects', false, 'Number of objects', 'Total number of objects in the print.'],
  ['num_instances', false, 'Number of instances', 'Total number of object instances in the print, summed over all objects.'],
  ['scale', true, 'Scale per object', "Contains a string with the information about what scaling was applied to the individual objects. Indexing of the objects is zero-based (first object has index 0).\nExample: 'x:100% y:50% z:100%'."],
  ['input_filename_base', false, 'Input filename without extension', 'Source filename of the first object, without extension.'],
  ['input_filename', false, 'Full input filename', 'Source filename of the first object.'],
  ['plate_name', false, 'Plate name', 'Name of the plate sliced.'],
];
const PT = 'The vector has two elements: X and Y coordinate of the point. Values in mm.';
const BB = 'The vector has two elements: X and Y dimension of the bounding box. Values in mm.';
const DIMENSIONS: Def[] = [
  ['first_layer_print_convex_hull', true, 'First layer convex hull', "Vector of points of the first layer convex hull. Each element has the following format: '[x, y]' (x and y are floating-point numbers in mm)."],
  ['first_layer_print_min', true, 'Bottom-left corner of the first layer bounding box', PT],
  ['first_layer_print_max', true, 'Top-right corner of the first layer bounding box', PT],
  ['first_layer_print_size', true, 'Size of the first layer bounding box', BB],
  ['print_bed_min', true, 'Bottom-left corner of print bed bounding box', PT],
  ['print_bed_max', true, 'Top-right corner of print bed bounding box', PT],
  ['print_bed_size', true, 'Size of the print bed bounding box', BB],
  ['first_layer_center_no_wipe_tower', true, 'First layer center without wipe tower', PT],
  ['first_layer_height', false, 'First layer height', 'Height of the first layer.'],
];
const TEMPERATURES: Def[] = [
  ['bed_temperature', true, 'Bed temperature', 'Vector of bed temperatures for each extruder/filament.'],
  ['bed_temperature_initial_layer', true, 'First layer bed temperature', 'Vector of first layer bed temperatures for each extruder/filament. Provides the same value as first_layer_bed_temperature.'],
  ['bed_temperature_initial_layer_single', false, 'First layer bed temperature (initial extruder)', 'First layer bed temperature for the initial extruder. Same as bed_temperature_initial_layer[initial_extruder]'],
  ['chamber_temperature', true, 'Chamber temperature', 'Vector of chamber temperatures for each extruder/filament.'],
  ['chamber_minimal_temperature', true, 'Chamber minimal temperature', 'Vector of minimal chamber temperatures for each extruder/filament.'],
  ['overall_chamber_temperature', false, 'Overall chamber temperature', 'Overall chamber temperature. This value is the maximum chamber temperature of any extruder/filament used.'],
  ['first_layer_bed_temperature', true, 'First layer bed temperature', 'Vector of first layer bed temperatures for each extruder/filament. Provides the same value as bed_temperature_initial_layer.'],
  ['first_layer_temperature', true, 'First layer temperature', 'Vector of first layer temperatures for each extruder/filament.'],
];
const TIMESTAMPS: Def[] = [
  ['timestamp', false, 'Timestamp', 'String containing current time in yyyyMMdd-hhmmss format.'],
  ['year', false, 'Year', ''], ['month', false, 'Month', ''], ['day', false, 'Day', ''],
  ['hour', false, 'Hour', ''], ['minute', false, 'Minute', ''], ['second', false, 'Second', ''],
];
const OTHER_PRESETS: Def[] = [
  ['print_preset', false, 'Print preset name', 'Name of the print preset used for slicing.'],
  ['filament_preset', true, 'Filament preset name', 'Names of the filament presets used for slicing. The variable is a vector containing one name for each extruder.'],
  ['printer_preset', false, 'Printer preset name', 'Name of the printer preset used for slicing.'],
  ['physical_printer_preset', false, 'Physical printer name', 'Name of the physical printer used for slicing.'],
];

const ROLES = 'Possible values: Perimeter, ExternalPerimeter, OverhangPerimeter, InternalInfill, SolidInfill, TopSolidInfill, BottomSurface, BridgeInfill, GapFill, Ironing, Skirt, Brim, SupportMaterial, SupportMaterialInterface, SupportTransition, WipeTower, Mixed.';
const SPECIFIC_DEFS: Record<string, Def> = Object.fromEntries(([
  ['layer_num', false, 'Layer number', 'Index of the current layer. One-based (i.e. first layer is number 1).'],
  ['layer_z', false, 'Layer Z', 'Height of the current layer above the print bed, measured to the top of the layer.'],
  ['max_layer_z', false, 'Maximal layer Z', 'Height of the last layer above the print bed.'],
  ['filament_extruder_id', false, 'Filament extruder ID', 'The current extruder ID. The same as current_extruder.'],
  ['previous_extruder', false, 'Previous extruder', 'Index of the extruder that is being unloaded. The index is zero based (first extruder has index 0).'],
  ['next_extruder', false, 'Next extruder', 'Index of the extruder that is being loaded. The index is zero based (first extruder has index 0).'],
  ['relative_e_axis', false, 'Relative e-axis', 'Indicates if relative positioning is being used.'],
  ['toolchange_count', false, 'Toolchange count', 'The number of toolchanges throught the print.'],
  ['old_retract_length', false, 'Old retract length', 'The retraction length of the previous filament.'],
  ['new_retract_length', false, 'New retract length', 'The retraction length of the new filament.'],
  ['old_retract_length_toolchange', false, 'Old retract length toolchange', 'The toolchange retraction length of the previous filament.'],
  ['new_retract_length_toolchange', false, 'New retract length toolchange', 'The toolchange retraction length of the new filament.'],
  ['old_filament_temp', false, 'Old filament temp', 'The old filament temp.'],
  ['new_filament_temp', false, 'New filament temp', 'The new filament temp.'],
  ['x_after_toolchange', false, 'X after toolchange', 'The X pos after toolchange.'],
  ['y_after_toolchange', false, 'Y after toolchange', 'The Y pos after toolchange.'],
  ['z_after_toolchange', false, 'Z after toolchange', 'The Z pos after toolchange.'],
  ['first_flush_volume', false, 'First flush volume', 'The first flush volume.'],
  ['second_flush_volume', false, 'Second flush volume', 'The second flush volume.'],
  ['old_filament_e_feedrate', false, 'Old filament e feedrate', 'The old filament extruder feedrate.'],
  ['new_filament_e_feedrate', false, 'New filament e feedrate', 'The new filament extruder feedrate.'],
  ['travel_point_1_x', false, 'Travel point 1 X', 'The travel point 1 X.'],
  ['travel_point_1_y', false, 'Travel point 1 Y', 'The travel point 1 Y.'],
  ['travel_point_2_x', false, 'Travel point 2 X', 'The travel point 2 X.'],
  ['travel_point_2_y', false, 'Travel point 2 Y', 'The travel point 2 Y.'],
  ['travel_point_3_x', false, 'Travel point 3 X', 'The travel point 3 X.'],
  ['travel_point_3_y', false, 'Travel point 3 Y', 'The travel point 3 Y.'],
  ['flush_length_1', false, 'Flush length 1', 'The first flush length.'],
  ['flush_length_2', false, 'Flush length 2', 'The second flush length.'],
  ['flush_length_3', false, 'Flush length 3', 'The third flush length.'],
  ['flush_length_4', false, 'Flush length 4', 'The fourth flush length.'],
  ['extrusion_role', false, 'Extrusion role', `The new extrusion role/type that is going to be used.\n${ROLES}`],
  ['last_extrusion_role', false, 'Last extrusion role', `The previously used extrusion role/type.\n${ROLES}`],
] as Def[]).map((d) => [d[0], d]));

const LAYER = ['layer_num', 'layer_z', 'max_layer_z'];
/** s_CustomGcodeSpecificPlaceholders (PrintConfig.cpp) + preFlight / PrusaSlicer key names. */
export const SPECIFIC_PLACEHOLDERS: Record<string, string[]> = {
  file_start_gcode: [], machine_start_gcode: [], printing_by_object_gcode: [], machine_pause_gcode: [], template_custom_gcode: [],
  machine_end_gcode: [...LAYER, 'filament_extruder_id'],
  before_layer_change_gcode: LAYER, layer_change_gcode: LAYER, timelapse_gcode: LAYER,
  change_filament_gcode: [...LAYER, 'next_extruder', 'previous_extruder', 'first_flush_volume', 'flush_length_1', 'flush_length_2', 'flush_length_3', 'flush_length_4',
    'new_filament_e_feedrate', 'new_filament_temp', 'new_retract_length', 'new_retract_length_toolchange', 'old_filament_e_feedrate', 'old_filament_temp',
    'old_retract_length', 'old_retract_length_toolchange', 'relative_e_axis', 'second_flush_volume', 'toolchange_count', 'toolchange_z' /* no def: skipped */,
    'travel_point_1_x', 'travel_point_1_y', 'travel_point_2_x', 'travel_point_2_y', 'travel_point_3_x', 'travel_point_3_y',
    'x_after_toolchange', 'y_after_toolchange', 'z_after_toolchange'],
  change_extrusion_role_gcode: ['layer_num', 'layer_z', 'extrusion_role', 'last_extrusion_role'],
  filament_change_extrusion_role_gcode: ['layer_num', 'layer_z', 'extrusion_role', 'last_extrusion_role'],
  process_change_extrusion_role_gcode: ['layer_num', 'layer_z', 'extrusion_role', 'last_extrusion_role'],
  filament_start_gcode: ['filament_extruder_id'],
  filament_end_gcode: [...LAYER, 'filament_extruder_id'],
  // preFlight (PrusaSlicer names)
  start_gcode: [], end_gcode: [...LAYER], before_layer_gcode: LAYER, layer_gcode: LAYER, toolchange_gcode: [...LAYER, 'next_extruder', 'previous_extruder'],
  start_filament_gcode: ['filament_extruder_id'], end_filament_gcode: [...LAYER, 'filament_extruder_id'],
};

const items = (defs: Def[]): PlaceholderItem[] => defs.map(([key, vector, label, tooltip]) => ({ key, vector, label, tooltip }));

const TAB_OF_SCOPE: Record<string, SettingsTabId> = { print: 'process', object: 'process', filament: 'filament', machine: 'printer' };

/** The placeholder tree for the G-code option `gcodeKey`. */
export function placeholderTree(gcodeKey: string, schema: ConfigSchema | null, layout: BuiltLayout | null): PlaceholderGroup[] {
  const out: PlaceholderGroup[] = [
    { id: 'state-global', title: '[Global] Slicing state', icon: 'i-lucide-globe', items: [], groups: [
      { id: 'state-ro', title: 'Read only', icon: 'i-lucide-lock', items: items(RO_STATES) },
      { id: 'state-rw', title: 'Read write', icon: 'i-lucide-lock-open', items: items(RW_STATES) },
    ] },
    { id: 'state', title: 'Slicing state', icon: 'i-lucide-layers', items: items(OTHER_STATES) },
    { id: 'stats', title: 'Print statistics', icon: 'i-lucide-chart-no-axes-column', items: items(STATISTICS) },
    { id: 'objects', title: 'Objects info', icon: 'i-lucide-box', items: items(OBJECTS) },
    { id: 'dimensions', title: 'Dimensions', icon: 'i-lucide-ruler', items: items(DIMENSIONS) },
    { id: 'temperatures', title: 'Temperatures', icon: 'i-lucide-thermometer', items: items(TEMPERATURES) },
    { id: 'timestamps', title: 'Timestamps', icon: 'i-lucide-clock', items: items(TIMESTAMPS) },
  ];
  const specific = (SPECIFIC_PLACEHOLDERS[gcodeKey] ?? []).map((k) => SPECIFIC_DEFS[k]).filter(Boolean);
  if (specific.length) out.splice(0, 0, { id: 'specific', title: `Specific for ${gcodeKey}`, icon: 'i-lucide-file-code', items: items(specific) });

  // Presets: every option, grouped like the settings tabs.
  const presets: PlaceholderGroup = { id: 'presets', title: 'Presets', icon: 'i-lucide-settings', items: items(OTHER_PRESETS), groups: [] };
  if (schema) {
    const titles: Record<SettingsTabId, string> = { process: 'Print settings', filament: 'Filament settings', printer: 'Printer settings' };
    const icons: Record<SettingsTabId, string> = { process: 'i-lucide-layers', filament: 'i-lucide-disc', printer: 'i-lucide-printer' };
    for (const tab of ['process', 'filament', 'printer'] as SettingsTabId[]) {
      const inTab = Object.entries(schema.options).filter(([, d]) => TAB_OF_SCOPE[d.scope] === tab && d.type !== 'none');
      const keysInTab = new Set(inTab.map(([k]) => k));
      const seen = new Set<string>();
      const sub: PlaceholderGroup[] = [];
      for (const page of layout?.[tab]?.pages ?? []) {
        if (page.extruder !== undefined && page.extruder > 0) continue;
        const keys = [...new Set(page.groups.flatMap((g) => g.keys))].filter((k) => keysInTab.has(k) && !seen.has(k));
        keys.forEach((k) => seen.add(k));
        if (keys.length) sub.push({ id: `p-${tab}-${page.id}`, title: page.title, icon: 'i-lucide-list', items: keys.sort().map((k) => optItem(schema, k)) });
      }
      const rest = inTab.map(([k]) => k).filter((k) => !seen.has(k)).sort();
      presets.groups!.push({ id: `p-${tab}`, title: titles[tab], icon: icons[tab], items: rest.map((k) => optItem(schema, k)), groups: sub });
    }
  }
  out.push(presets);
  return out;
}

function optItem(schema: ConfigSchema, key: string): PlaceholderItem {
  const d = schema.options[key];
  return { key, vector: isVectorType(d.type), label: d.fullLabel || d.label || key, tooltip: d.tooltip };
}

/** Text inserted for an item: `{key}` / `{key[]}`, or bare `key` / `key[]` inside an existing `{…}` / `[…]`. */
export function insertionText(item: PlaceholderItem, insideBraces: boolean): string {
  const core = item.vector ? `${item.key}[]` : item.key;
  return insideBraces ? core : `{${core}}`;
}

/** Whether offset `pos` of `text` sits inside an unclosed `{` or `[` placeholder bracket. */
export function insideBraces(text: string, pos: number): boolean {
  const before = text.slice(0, pos);
  const open = Math.max(before.lastIndexOf('{'), before.lastIndexOf('['));
  const close = Math.max(before.lastIndexOf('}'), before.lastIndexOf(']'));
  return open > close && !before.slice(open).includes('\n');
}

/** Case-insensitive filter over key, label and tooltip; empty groups dropped. */
export function filterTree(groups: PlaceholderGroup[], q: string): PlaceholderGroup[] {
  const s = q.trim().toLowerCase();
  if (!s) return groups;
  const hit = (i: PlaceholderItem) => i.key.toLowerCase().includes(s) || i.label.toLowerCase().includes(s);
  const walk = (g: PlaceholderGroup): PlaceholderGroup | null => {
    const its = g.items.filter(hit);
    const sub = (g.groups ?? []).map(walk).filter((x): x is PlaceholderGroup => !!x);
    return its.length || sub.length ? { ...g, items: its, groups: sub } : null;
  };
  return groups.map(walk).filter((x): x is PlaceholderGroup => !!x);
}

/**
 * The OrcaSlicer project 3MF format (src/libslic3r/Format/bbs_3mf.cpp, v2.5.0)
 * as far as both the reader (orca3mf.ts) and the writer
 * (persistence/orca3mfWriter.ts) need it: version tags, file names, volume
 * subtypes, per-plate metadata ↔ config keys, and which archive entries a
 * load → save keeps. Pure data, no app state.
 */
import type { PartType, PreciseSeamType } from '../types';
import { PRECISE_SEAM_TYPES } from '../types';

/**
 * The format the writer implements: OrcaSlicer 2.5.0 (SoftFever_VERSION) and
 * the Bambu Studio version it claims compatibility with (SLIC3R_VERSION,
 * version.inc). Desktop Orca reads the "OrcaSlicer" tag as the file version.
 */
export const ORCA_FORMAT_VERSION = '2.5.0';
export const BBS_COMPAT_VERSION = '02.08.01.55';

export const MODEL_FILE = '3D/3dmodel.model';
export const MODEL_SETTINGS_FILE = 'Metadata/model_settings.config';
export const PROJECT_SETTINGS_FILE = 'Metadata/project_settings.config';
export const SLICE_INFO_FILE = 'Metadata/slice_info.config';
export const LAYER_HEIGHTS_FILE = 'Metadata/layer_heights_profile.txt';
export const LAYER_RANGES_FILE = 'Metadata/layer_config_ranges.xml';
export const BRIM_EARS_FILE = 'Metadata/brim_ear_points.txt';
export const CUSTOM_GCODE_FILE = 'Metadata/custom_gcode_per_layer.xml';
export const CUT_INFO_FILE = 'Metadata/cut_information.xml';
/** The Design tab's document (Model::cad_recipe). Read case-insensitively; capped at 1 GiB like Orca. */
export const CAD_RECIPE_FILE = 'Metadata/orca_cad.bin';
/** Its pre-rename name: read only (the current name wins), never written. */
export const LEGACY_CAD_RECIPE_FILE = 'Metadata/SnapOrca_cad.bin';
export const MAX_CAD_RECIPE_BYTES = 1 << 30;
export const TEXTURE_DISPLACEMENT_DIR = 'Metadata/texture_displacement/';

/** Model-file `<metadata name>` items the writer sets itself; the rest pass through. */
export const OWN_MODEL_METADATA = new Set([
  'Application', 'OrcaSlicer', 'BambuStudio:3mfVersion', 'bamboo_slicer:Version3mf', 'Title', 'CreationDate', 'ModificationDate',
  // Plate 1's thumbnail paths (older writers); the writer references its own.
  'Thumbnail_Middle', 'Thumbnail_Small',
]);

/** Model metadata of a "published" 3MF (bbs_3mf.hpp ORCA_PUBLISHED_*). Consumed on open, never written back. */
export const PUBLISHED = {
  flag: 'orca_published',
  keys: 'orca_published_keys',
  materialKeys: 'orca_published_material_keys',
  config: 'orca_published_config',
  layout: 'orca_published_extruder_layout',
} as const;
export const PUBLISHED_METADATA = new Set<string>(Object.values(PUBLISHED));

/**
 * Archive entries a load → save keeps (desktop Orca keeps them too): the CAD
 * recipe, texture displacement layers, embossed SVG shapes, the Auxiliaries
 * folder (designer pictures, BOM, cover) and the project-embedded presets.
 * Everything else is either rebuilt by the writer or derived data (G-code,
 * thumbnails, slice info) that Orca also drops or regenerates.
 */
export function isKeptEntry(path: string): boolean {
  const l = path.toLowerCase();
  if (l === CAD_RECIPE_FILE.toLowerCase()) return true;
  if (l.startsWith(TEXTURE_DISPLACEMENT_DIR.toLowerCase())) return true;
  if (l.startsWith('3d/') && l.endsWith('.svg')) return true;
  if (l.startsWith('auxiliaries/') && !l.endsWith('/')) return true;
  return /^metadata\/(print_setting|process_settings|filament_settings|machine_settings)_\d+\.config$/.test(l);
}

/** model_settings.config `subtype` ↔ part type. */
export const SUBTYPE_OF: Record<PartType, string> = {
  part: 'normal_part', negative: 'negative_part', modifier: 'modifier_part', support_blocker: 'support_blocker', support_enforcer: 'support_enforcer',
};
export const PART_TYPE_OF: Record<string, PartType> = Object.fromEntries(Object.entries(SUBTYPE_OF).map(([k, v]) => [v, k as PartType]));

export const PRECISE_SEAM_TYPE_KEY = 'precise_seam_type';
export const PRECISE_SEAM_CONFIG_PREFIX = 'precise_seam_config:';
export function isPreciseSeamType(s: string): s is PreciseSeamType {
  return (PRECISE_SEAM_TYPES as readonly string[]).includes(s);
}

/** Per-triangle paint attributes CubbySlicer edits (the rest, e.g. paint_texture_N, pass through). */
export const PAINT_ATTR = { support: 'paint_supports', seam: 'paint_seam', color: 'paint_color', fuzzy: 'paint_fuzzy_skin' } as const;

/**
 * Object / volume metadata keys that aren't settings. `drop`: rebuilt by the
 * writer or stale once read. `mesh`: describe the volume's geometry and are
 * kept only while it has that mesh. Every other key is a setting: the ones
 * the engine knows become overrides, the rest pass through.
 */
export const VOLUME_KEY_DROP = new Set(['name', 'matrix', 'volume_type', 'part_type', 'is_modifier', 'mesh_stat', 'face_count', 'backup_id', PRECISE_SEAM_TYPE_KEY]);
export const VOLUME_KEY_MESH = new Set(['source_file', 'source_object_id', 'source_volume_id', 'source_offset_x', 'source_offset_y', 'source_offset_z',
  'source_in_inches', 'source_in_meters', 'texture_displacement']);
/** Child elements of `<part>` that are rebuilt (the rest — text / SVG shape — are mesh-bound passthrough). */
export const VOLUME_ELEMENT_DROP = new Set(['metadata', 'mesh_stat']);
export const OBJECT_KEY_DROP = new Set(['name']);

/**
 * Plate metadata keys ↔ per-plate config keys, in the order Orca 2.5 writes
 * them (`_add_model_config_file_to_archive`). `read` turns the metadata value
 * into the config value, `write` back (null: not written).
 */
export interface PlateKey { meta: string; key: string; read(v: string): string | null; write(v: string): string | null }
const same = (v: string) => v;
const spaces = { read: (v: string) => v.trim().split(/\s+/).join(','), write: (v: string) => v.split(',').map((s) => s.trim()).join(' ') };
const bool = { read: (v: string) => (v === 'true' || v === '1' ? '1' : '0'), write: (v: string) => (v === '1' || v === 'true' ? 'true' : 'false') };
export const IMEX_PRIMARY_MODE = 'primary';
export const PLATE_KEYS: PlateKey[] = [
  { meta: 'bed_type', key: 'curr_bed_type', read: (v) => (v === 'SuperTack Plate' ? 'Supertack Plate' : v), write: same },
  { meta: 'print_sequence', key: 'print_sequence', read: same, write: same },
  { meta: 'first_layer_print_sequence', key: 'first_layer_print_sequence', ...spaces },
  { meta: 'other_layers_print_sequence', key: 'other_layers_print_sequence', ...spaces },
  { meta: 'other_layers_print_sequence_nums', key: 'other_layers_print_sequence_nums', read: same, write: same },
  { meta: 'spiral_mode', key: 'spiral_mode', ...bool },
  { meta: 'imex_parallel_mode', key: 'imex_parallel_mode', read: same, write: (v) => (v && v !== IMEX_PRIMARY_MODE ? v : null) },
  { meta: 'imex_head_filament_map', key: 'imex_head_filament_map', read: same, write: (v) => v || null },
  // Orca only loads manual modes ("Auto" is the global default).
  { meta: 'filament_map_mode', key: 'filament_map_mode', read: (v) => (v === 'Auto' ? null : v), write: same },
  { meta: 'filament_maps', key: 'filament_map', read: (v) => spaces.read(v).split(',').map((n) => String(Math.max(1, Number(n) || 1))).join(','), write: spaces.write },
  // Hybrid (2) and TPU High Flow (3) are clamped to Standard on load, as Orca does.
  { meta: 'filament_volume_maps', key: 'filament_volume_map', read: (v) => spaces.read(v).split(',').map((n) => (Number(n) > 1 ? '0' : n)).join(','), write: spaces.write },
];
/** The legacy name of imex_parallel_mode (read only). */
export const PLATE_KEY_ALIASES: Record<string, string> = { ixex_parallel_mode: 'imex_parallel_mode' };
/** Plate metadata that is rebuilt (identity, thumbnails, sliced output). */
export const PLATE_META_DROP = new Set(['plater_id', 'plater_name', 'locked', 'gcode_file', 'thumbnail_file', 'thumbnail_no_light_file',
  'top_file', 'pick_file', 'pattern_file', 'pattern_bbox_file', 'index']);
/** The filament map / volume map only count when the plate has its own map mode (Orca writes them only then). */
export const PLATE_KEYS_NEED_MAP_MODE = new Set(['filament_map', 'filament_volume_map']);

/** CustomGCode::Type ↔ our item type. */
export const GCODE_TYPE_ID: Record<string, number> = { color_change: 0, pause: 1, tool_change: 2, template: 3, custom: 4 };
export const GCODE_TYPE_NAME = ['color_change', 'pause', 'tool_change', 'template', 'custom'] as const;

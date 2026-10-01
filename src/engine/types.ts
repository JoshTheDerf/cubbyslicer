/**
 * Engine contract types. Mirrors docs/ENGINE-CONTRACT.md — keep in sync.
 */

export type EngineId = 'orca' | 'preflight' | 'fullspectrum';

/**
 * Engines built from OrcaSlicer's libslic3r (same config keys, profiles,
 * calibration and cs_tool ops): OrcaSlicer itself and the FullSpectrum fork
 * (Snapmaker Orca + mixed filaments).
 */
export function isOrcaFamily(e: EngineId): boolean { return e === 'orca' || e === 'fullspectrum'; }

/** Engine-native serialized config value. Arrays are per-extruder vectors. */
export type ConfigValue = string | string[];
/** Flat key → value config (fully resolved: presets + overrides). */
export type FlatConfig = Record<string, ConfigValue>;

export interface SliceObjectInput {
  /** Stable project object id (echoed back in warnings where possible). */
  id: string;
  name: string;
  /** xyz triples, mesh-local coordinates (mm). */
  positions: Float32Array;
  /** Triangle vertex indices (uint32 triples). */
  indices: Uint32Array;
  /** Column-major 4x4 mesh-local → bed transform (mm, Z up, bed origin). */
  transform: number[];
  /** Per-object config overrides (engine-native keys). */
  config?: FlatConfig;
  /** Extra volumes of the object (Orca parts / modifiers / negative parts / support blockers & enforcers). */
  parts?: SliceVolumeInput[];
  /** Painted facets of this object's own mesh (see PaintLayers). */
  paint?: PaintLayers;
  /**
   * Variable layer height (Orca ModelObject::layer_height_profile): flat
   * [z0, h0, z1, h1, …], z in mm from the object's bottom (print coordinates,
   * after scaling), h = layer height at that z. Empty/absent = uniform.
   */
  layerHeightProfile?: number[];
  /** Height range modifiers (Orca layer_config_ranges): z in mm from the object's bottom. */
  layerRanges?: Array<{ min: number; max: number; config: FlatConfig }>;
  /** Brim ears (Orca BrimPoint): positions in the object's mesh-local frame (before its transform), mm. */
  brimPoints?: Array<{ pos: [number, number, number]; radius: number }>;
}

/** Orca painting layers: which FacetsAnnotation of the volume. */
export type PaintLayer = 'support' | 'seam' | 'color' | 'fuzzy';
/**
 * Painted facets in Orca's per-triangle hex format (the strings OrcaSlicer
 * stores in 3MF "paint_supports" / "paint_seam" / "paint_color" / "paint_fuzzy"):
 * sparse [triangleIndex, hex] pairs over the volume's mesh as given to the engine.
 */
export type PaintMap = Array<[number, string]>;
export type PaintLayers = Partial<Record<PaintLayer, PaintMap>>;

/** Orca CustomGCode::Item for the plate (preview layer slider markers). */
export interface CustomGcodeItem {
  /** Print Z (mm) of the layer the code is inserted before. */
  z: number;
  type: 'color_change' | 'pause' | 'custom' | 'tool_change' | 'template';
  /** 1-based extruder for color / tool change (0 = current). */
  extruder?: number;
  /** Colour for color_change (#RRGGBB). */
  color?: string;
  /** G-code for 'custom', message for 'pause'. */
  extra?: string;
}

/** Orca Calib_Params (Calibration menu). Mode names follow CalibMode. */
export interface CalibParams {
  mode: 'pa_line' | 'pa_pattern' | 'pa_tower' | 'flow_rate' | 'temp_tower' | 'vol_speed_tower' | 'vfa_tower'
    | 'retraction_tower' | 'input_shaping_freq' | 'input_shaping_damp' | 'cornering';
  start: number;
  end: number;
  step: number;
  printNumbers?: boolean;
  extruderId?: number;
  freqStartX?: number; freqEndX?: number; freqStartY?: number; freqEndY?: number;
  testModel?: number;
  shaperType?: string;
  accelerations?: number[];
  speeds?: number[];
}

export type SliceVolumeType = 'part' | 'negative' | 'modifier' | 'support_blocker' | 'support_enforcer';

export interface SliceVolumeInput {
  id: string;
  name: string;
  type: SliceVolumeType;
  positions: Float32Array;
  indices: Uint32Array;
  /** Column-major 4x4 mesh-local → bed transform (already includes the object's). */
  transform: number[];
  config?: FlatConfig;
  paint?: PaintLayers;
}

export interface SliceJob {
  engine: EngineId;
  config: FlatConfig;
  objects: SliceObjectInput[];
  options?: {
    validate?: boolean;
    dropToBed?: boolean;
    /** Extra G-code placeholder variables (Orca-profile compatibility for preFlight). */
    placeholderVars?: Record<string, { type: string; value: ConfigValue }>;
    /** Color changes / pauses / custom G-code per print Z for this plate. */
    customGcodes?: CustomGcodeItem[];
    /** Calibration print (Orca Calibration menu). */
    calib?: CalibParams;
  };
}

export interface SliceWarning { code: string; message: string }

export interface SliceStats {
  printTimeSec: number;
  filamentMm: number[];
  filamentCm3: number[];
  filamentG: number[];
  filamentCost: number[];
  layers: number;
  maxZ: number;
}

export interface SliceReport {
  ok: boolean;
  error: string | null;
  warnings: SliceWarning[];
  stats: SliceStats | null;
  timings?: { processMs: number; exportMs: number };
  substitutions?: string[];
  /** Set by the engine worker: threads the slice ran on (1 = single-threaded build). */
  threads?: number;
}

export interface SliceResult {
  engine: EngineId;
  /** Raw G-code bytes (UTF-8). Decode lazily; can be 100+ MB. */
  gcode: Uint8Array;
  report: SliceReport;
}

export interface SliceProgress { percent: number; message: string }

export type ConfigOptionType =
  | 'bool' | 'int' | 'float' | 'percent' | 'floatOrPercent' | 'string' | 'enum' | 'point' | 'point3'
  | 'bools' | 'ints' | 'floats' | 'percents' | 'floatsOrPercents' | 'strings' | 'points'
  | 'none';

export type ConfigMode = 'simple' | 'advanced' | 'expert';
export type ConfigScope = 'print' | 'filament' | 'machine' | 'object' | 'other';

export interface ConfigOptionDef {
  type: ConfigOptionType;
  label: string;
  fullLabel: string;
  category: string;
  tooltip: string;
  sidetext: string;
  mode: ConfigMode;
  min: number | null;
  max: number | null;
  default: string;
  enumValues?: string[];
  enumLabels?: string[];
  multiline?: boolean;
  fullWidth?: boolean;
  readonly?: boolean;
  nullable?: boolean;
  guiType?: string;
  scope: ConfigScope;
}

export interface ConfigSchema {
  engine: EngineId;
  version: string;
  options: Record<string, ConfigOptionDef>;
}

export interface EngineVersion {
  engine: EngineId;
  version: string;
  bridge: number;
  build: string;
}

// ---- worker protocol --------------------------------------------------------

export type WorkerRequest =
  | { type: 'slice'; id: number; job: SliceJob }
  | { type: 'describe'; id: number }
  | { type: 'evalCondition'; id: number; expr: string; config: FlatConfig }
  | { type: 'orient'; id: number; object: SliceObjectInput }
  /** Engine tools (cs_tool): painting sessions, cut, layer height profiles, … */
  | { type: 'tool'; id: number; op: string; args: unknown; meshes: ToolMesh[] }
  /** Orca auto arrange (cs_tool "arrange"): the objects as in a slice job. */
  | { type: 'arrange'; id: number; config: FlatConfig; objects: SliceObjectInput[]; args: ArrangeArgs };

export type WorkerResponse =
  | { type: 'progress'; id: number; percent: number; message: string }
  | { type: 'result'; id: number; gcode: ArrayBuffer; report: SliceReport }
  | { type: 'schema'; id: number; schema: ConfigSchema }
  | { type: 'condition'; id: number; value: boolean | null }
  | { type: 'orient'; id: number; rotation: number[] }
  | { type: 'tool'; id: number; result: unknown; meshes: ToolMesh[] }
  | { type: 'error'; id: number; message: string; report?: SliceReport; fatal: boolean; stalled?: boolean };

/** Orca auto arrange request (docs/ENGINE-CONTRACT.md "arrange"); `items` is parallel to the objects. */
export interface ArrangeArgs {
  mode: 'all' | 'plate' | 'selection';
  currentPlate: number;
  plates: Array<{ locked: boolean; seq: '' | 'by layer' | 'by object'; toolChanges: number[] }>;
  items: Array<{ plate: number; printable: boolean; selected: boolean }>;
  settings: { distance: number; enableRotation: boolean; alignToYAxis: boolean; allowMultiMaterials: boolean; avoidCaliRegion: boolean };
  /** BBL vendor printer (offers "Avoid extrusion calibration region"). */
  bbl: boolean;
}

export interface ArrangeResult {
  /** Per object: unmoved, or its plate and new mesh-origin XY (plate-local) and rotation about world Z. */
  items: Array<{ moved: false } | { moved: true; plate: number; x: number; y: number; dRot: number }>;
  /** Plate count after arranging (new plates are appended). */
  plates: number;
  unplaced: string[];
  warnings: string[];
  /** Object indices in arrange order (Orca's by-object print order). */
  order: number[];
  seqPrint: boolean;
}

/** A mesh passed to / returned from an engine tool (mesh-local float32 xyz + uint32 triangles). */
export interface ToolMesh { positions: Float32Array; indices: Uint32Array }

/**
 * Types of the CAD kernel (`public/wasm/cad/cad.mjs`, docs/CAD-KERNEL-CONTRACT.md) for the
 * methods the Design tab calls. Hand-written from the contract and checked against the real
 * module (results carry more keys than listed here; only what the app reads is typed).
 * Keys are the kernel's (snake_case), never renamed, so a reader can grep the contract.
 */

/** `cad_version()`. */
export interface CadKernelVersion { module: string; orca: string; occt: string; abi: number; recipeVersion: number; build: string }

/** The kernel ABI this app speaks. */
export const CAD_KERNEL_ABI = 1;

/** Error codes of the output envelope (contract "Error codes"). */
export const CAD_ERR = {
  unknownMethod: -32601,
  invalidParams: -32602,
  handler: -32000,
  staleIds: -32010,
  readOnly: -32020,
  noDocument: -32021,
  sketchSession: -32022,
  unreadable: -32030,
  /** v1.1: not a Design-tab recipe at all. */
  notRecipe: -32031,
} as const;

/** Feature types in ordinal order (the wire format; contract "Feature JSON"). */
export const FEATURE_TYPES = [
  'Sketch', 'Extrude', 'Fillet', 'Chamfer', 'Hole', 'Thread', 'Shell', 'Revolve', 'Sweep', 'Pattern', 'Plane', 'Loft', 'Draft',
  'Import', 'Boolean', 'Cut', 'Mirror', 'Axis', 'CoordSys', 'Helix', 'Transform', 'Thicken', 'Project', 'DeleteFace', 'Rib',
  'SurfaceExtrude', 'SurfaceRevolve', 'ThickenSurface', 'SurfaceOffset', 'SurfaceLoft', 'SurfaceFill', 'Mate',
] as const;
export type FeatureType = typeof FEATURE_TYPES[number];

export type Vec3 = [number, number, number];

/** A feature as `get_feature` reports it: every field of Orca's CadFeature (keys = C++ member names). */
export type FeatureJson = { type: FeatureType; name: string; enabled: boolean; expr: Record<string, string> } & Record<string, unknown>;

/** `describe_tools.fields[]`: the feature field schema. */
export interface FieldSchema { name: string; type: string; enum?: string[] }

export interface DescribeTools {
  module: string;
  methods: string[];
  feature_types: string[];
  fields: FieldSchema[];
  bindable_fields: string[];
  id_lifetime: string;
}

export interface SceneFeature { index: number; type: FeatureType; name: string; enabled: boolean }

export interface SceneBody {
  index: number;
  /** Display name (the user's name when `user_name`, else derived from the source feature). */
  name: string;
  user_name: boolean;
  has_color: boolean;
  /** RGBA 0..1. */
  color?: [number, number, number, number];
  source_feature: number;
  /** Absent for a body without faces. */
  bbox?: { min: Vec3; max: Vec3 };
  center?: Vec3;
  is_solid: boolean;
  face_count: number;
  edge_count: number;
}

/** `describe_scene`. */
export interface DescribeScene {
  modeling_origin: Vec3;
  features: SceneFeature[];
  bodies: SceneBody[];
  /** The last rebuild's error ('' = it succeeded). */
  error: string;
  generation: number;
  read_only: boolean;
  dirty: boolean;
  can_undo: boolean;
  can_redo: boolean;
  variables: Record<string, string>;
  mate_conflicts: Array<{ feature: number; reason: string }>;
  auto_close_loops: boolean;
  /** v1.1: the current history rebuilds (`error` may be a rolled-back edit's message). */
  rebuild_ok?: boolean;
  failed_feature?: number;
  failed_feature_name?: string;
  variable_values?: Record<string, number>;
  variable_errors?: Record<string, string>;
}

/** `doc_open`. The document is open even when `ok` (the rebuild) is false. */
export interface DocOpenResult {
  doc: number;
  version: number;
  read_only: boolean;
  read_only_reason?: string;
  ok: boolean;
  error: string;
  features: number;
  bodies: number;
  generation: number;
  ms: number;
  /** v1.1 */
  failed_feature?: number;
  failed_feature_name?: string;
  cancelled?: boolean;
}

/** What every mutating method returns (McpControl's shape + generation). */
export interface MutationResult {
  ok: boolean;
  error?: string;
  generation?: number;
  bodies?: number;
  index?: number;
  /** `suppress_feature {force}`: the toggle was kept although the rebuild failed. */
  kept?: boolean;
  /** `delete_feature`: every feature index that was removed (a Sketch cascades). */
  removed?: number[];
  /** v1.1: where the rebuild failed (-1 none), the host cancelled it, where the replay started, set_variable rebuilt. */
  failed_feature?: number;
  failed_feature_name?: string;
  cancelled?: boolean;
  replayed_from?: number;
  rebuilt?: boolean;
}

export interface DocSaveResult { bytes: number; version: number; verbatim: boolean }

/** One array in a mesh blob: element offset in bytes, length in elements. */
export interface BlobArray { offset: number; count: number }

/** `get_mesh` per body (display mesh). */
export interface DisplayMeshLayout {
  body: number;
  faces: number;
  edges: number;
  positions: BlobArray;
  normals: BlobArray;
  indices: BlobArray;
  triFace: BlobArray;
  edgeIds: BlobArray;
  edgeStarts: BlobArray;
  edgePoints: BlobArray;
  edgeFlags?: Array<{ edge: number; seam: boolean; degenerate: boolean }>;
}

/** `export_mesh` per body (plate mesh: welded, Orca's Commit to Plate tessellation). */
export interface PlateMeshLayout { body: number; positions: BlobArray; indices: BlobArray; triFace: BlobArray; triangles: number; vertices: number }

/** A plane frame (contract "Planes"): `plane_of_face`, `datums`, any `plane` argument. */
export interface PlaneFrame { origin: Vec3; normal: Vec3; x_axis: Vec3; y_axis: Vec3 }

/** `datums`. */
export interface DatumsResult {
  base_planes: Array<{ name: 'XY' | 'XZ' | 'YZ'; plane: PlaneFrame }>;
  planes: Array<{ name: string; plane: PlaneFrame }>;
  axes: Array<{ name: string; origin: Vec3; direction: Vec3; error: string }>;
  coordsys: Array<{ name: string; origin: Vec3; x: Vec3; y: Vec3; error: string }>;
}

/** `face_info`. */
export interface FaceInfo {
  id: number;
  surface: string;
  area: number;
  centroid: Vec3;
  normal: Vec3;
  plane?: PlaneFrame;
  cylinder?: { axis: Vec3; base: Vec3; height: number; internal: boolean; radius: number };
  edges: number[];
  generation: number;
}

/** `edge_info`. */
export interface EdgeInfo {
  id: number;
  curve: string;
  length: number;
  p0: Vec3;
  p1: Vec3;
  circle?: { axis: Vec3; center: Vec3; radius: number };
  faces: number[];
  generation: number;
}

/** `thread_standards`. */
export interface ThreadStandard { name: string; major_diameter: number; pitch: number; series: string; depth: number; minor_diameter: number; internal_depth: number; imperial?: boolean }
/** `hole_standards`. */
export interface HoleStandard { designation: string; clearance: number; cbore_diameter: number; cbore_depth: number; csink_diameter: number; csink_angle: number }

/** `feature_preview`: plate-mesh layout of every body with the candidate applied (no triFace). */
export interface PreviewResult { ok: boolean; error: string; meshes: Array<{ body: number; positions: BlobArray; indices: BlobArray }> }

/** `mass_properties`. */
export interface MassProperties { volume: number; surface_area: number; center_of_mass: Vec3; is_solid: boolean; valid: boolean }

/** `import_mesh` (McpControl's conversion report). */
export interface ImportMeshResult extends MutationResult { watertight?: boolean; is_solid?: boolean; faces_final?: number; first_feature?: number; volume?: number }
/** `import_step`. */
export interface ImportStepResult extends MutationResult { imported?: number; first_feature?: number }

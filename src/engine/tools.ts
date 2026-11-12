/**
 * Engine tool ops (`cs_tool`, docs/ENGINE-CONTRACT.md "Tools"): each op's
 * arguments and result, so callers of `engineTool` get both checked.
 * New ops (fix model, colour decompose, mixed_filament, texture bake) go here.
 */
import type { FlatConfig, PaintLayers, PaintMap } from './types';

/** TriangleSelector brush / fill operations (GLGizmoPainterBase). */
export type PaintApplyKind = 'circle' | 'sphere' | 'pointer' | 'height' | 'fill' | 'bucket' | 'clear';

export interface PaintApplyArgs {
  handle: number;
  kind: PaintApplyKind;
  /** Triangle under the cursor (mesh index). */
  facet?: number;
  /** Hit point / camera position in the mesh frame. */
  point?: number[];
  camera?: number[];
  /** Previous stroke point (circle / sphere drags paint the segment in between). */
  prev?: number[];
  state?: number;
  /** Brush radius, or band height for 'height' (mm). */
  radius?: number;
  /** Column-major mesh → world matrix. */
  trafo?: number[];
  /** Smart fill / bucket angle (degrees). */
  angle?: number;
  /** World Z of the hit ('height'). */
  zWorld?: number;
  /** Support painting on overhangs only: overhang angle (degrees, 0 = off). */
  overhang?: number;
  /**
   * The section view's plane in the mesh frame, [nx, ny, nz, offset]: triangles with
   * n·p > offset are cut away and not painted (TriangleSelector::ClippingPlane, desktop's
   * get_clipping_plane_in_volume_coordinates). Omitted when the section view is off.
   */
  clip?: number[];
}

/** Facets of a session, one output mesh per painted state (`states[i]` ↔ `meshes[i]`). */
export interface PaintStates { states: number[] }

/** Orca Cut (GLGizmoCut3D::perform_cut) request; volumes are in the instance's object space. */
export interface CutArgs {
  name: string;
  offset: number[];
  volumes: Array<{ name: string; type: string; transform: number[]; config?: Record<string, unknown>; paint?: PaintLayers }>;
  cut: {
    mode: 'plane' | 'groove';
    matrix: number[];
    keepUpper: boolean; keepLower: boolean; keepAsParts: boolean;
    placeOnCutUpper: boolean; flipUpper: boolean; placeOnCutLower: boolean; flipLower: boolean;
    keepPaint: boolean;
    connectors: Array<{
      pos: number[]; radius: number; height: number; type: string; style: string; shape: string;
      radiusTolerance: number; heightTolerance: number;
    }>;
    groove?: { depth: number; width: number; flapsAngle: number; angle: number; depthTolerance: number; widthTolerance: number };
  };
}

export interface CutResult {
  objects: Array<{
    name: string;
    /** Column-major instance matrix of the piece. */
    instance: number[];
    volumes: Array<{ name: string; type: string; transform: number[]; connector?: boolean; paint?: PaintLayers; mesh: number }>;
  }>;
}

// ---- mixed filaments (orca 2.5, ENGINE-CONTRACT "Mixed filaments") ----------------------

export type MixedFilamentArgs =
  /** Blend of physical colours; `components` 1-based into `colors`, `ratios` weights. */
  | { action: 'preview'; colors: string[]; components: number[]; ratios: number[] }
  /** Colour-match recipe (ColorDecomposeDialog): from the physical filaments, or a standard CMYW / RYBW set. */
  | { action: 'recommend'; target: string; mode: 'filaments' | 'cmyw' | 'rybw'; materialType?: string;
      filaments?: Array<{ color: string; name?: string; type?: string; mixed?: boolean }> }
  /** validate_mixed_filament_params on the per-slot mix keys. */
  | { action: 'validate'; config: FlatConfig };

export interface MixedPreviewResult {
  /** Orca's blend (already the lab-measured colour when the table has one). */
  color: string;
  /** The lab-measured table's entry, or null. */
  measured: string | null;
}
export interface MixedRecommendResult {
  valid: boolean;
  mode: 'filaments' | 'cmyw' | 'rybw';
  color: string;
  /** filament: 1-based physical filament, 0 = a standard base colour the project doesn't have. ratio: percent. */
  components: Array<{ filament: number; color: string; baseColor: string; ratio: number }>;
}
export interface MixedValidateResult { errors: Record<string, string> }

// ---- extruder variants (orca 2.5, ENGINE-CONTRACT "Extruder variants") ----------------------

export interface ResolveVariantsResult {
  extruderCount: number;
  differentExtruders: boolean;
  resolvedBy: 'print_apply' | 'bridge' | 'none';
  /** Serialized values, one per extruder (print / printer; stride-2 printer keys have 2 per extruder). */
  print: Record<string, string[]>;
  printer: Record<string, string[]>;
  /** One per filament. */
  filament: Record<string, string[]>;
}

// ---- prime tower (orca, ENGINE-CONTRACT "Prime tower") -------------------------------------

export interface WipeTowerFootprintArgs {
  /** The job config (cs_slice shape). */
  config: FlatConfig;
  /** 1-based filaments the plate prints (PartPlate::get_extruders(true)); default every filament. */
  filaments?: number[];
  /** Floor on the filament count (desktop's initial placement / arrange use 2). */
  minFilaments?: number;
  /** Tallest object on the plate, mm. */
  maxHeight?: number;
  /** Thinnest layer height on the plate, mm. */
  layerHeight?: number;
  /** Printed objects (by-object sequence only). */
  objects?: number;
  /** Index into wipe_tower_x / wipe_tower_y. */
  plate?: number;
  /** Anchor to place (default wipe_tower_x/y[plate]), plate-local mm. */
  position?: [number, number];
  /** Vendor model_id ("N9" moves desktop's default Y). */
  printerModelId?: string;
}

export type Point2 = [number, number];

export interface WipeTowerFootprintResult {
  /** prime_tower_is_printed. */
  printed: boolean;
  towerType: 'Type1' | 'Type2';
  width: number;
  depth: number;
  height: number;
  brim: number;
  coneMargin: number;
  rotation: number;
  filaments: number[];
  /** Tower-local first-layer outline, brim excluded, unrotated. */
  outline: Point2[];
  /** Tower-local, rotated, brim included: what must fit. */
  footprint: Point2[];
  /** printable_area, or the intersection of every extruder_printable_area. */
  printableArea: Point2[][];
  /** Desktop's clamp of `position`, then moved inside printableArea. */
  placement: { x: number; y: number; moved: boolean; fits: boolean };
  /** PartPlateList::set_default_wipe_tower_pos_for_plate. */
  defaultPosition: { x: number; y: number; fits: boolean };
}

// ---- mesh repair (orca, ENGINE-CONTRACT "Mesh repair") ------------------------------------

export interface RepairMeshArgs {
  /** The volume's painted facets, re-projected onto the repaired triangles. */
  paint?: PaintLayers;
  /** Desktop's keep_painting. */
  keepPainting?: boolean;
}

export interface RepairMeshStats {
  weldedVertices: number;
  removedTriangles: number;
  reversedShells: number;
  filledHoles: number;
  removedShells: number;
  selfIntersections: number;
}

export interface RepairMeshResult {
  /** false = no solid could be built (desktop's "failed to repair"). */
  repaired: boolean;
  /** false = it already was a closed, consistently oriented, self-intersection-free mesh. */
  modified: boolean;
  error: string | null;
  triangles: number;
  vertices: number;
  stats: RepairMeshStats;
  /** Re-projected paint; omitted when nothing is painted. */
  paint?: PaintLayers;
}

export interface ToolOps {
  paint_open: { args: { paint: PaintMap; maxState: number }; result: PaintStates & { handle: number } };
  paint_apply: { args: PaintApplyArgs; result: PaintStates };
  paint_get: { args: { handle: number }; result: { paint: PaintMap } };
  paint_close: { args: { handle: number }; result: unknown };
  /** Sparse [triangle, state] pairs → paint strings. */
  paint_from_states: { args: { states: Array<[number, number]> }; result: { paint: PaintMap } };
  layer_profile_adaptive: { args: { transform: number[]; config: FlatConfig; quality: number }; result: { profile: number[] } };
  layer_profile_smooth: {
    args: { transform: number[]; config: FlatConfig; profile: number[]; radius: number; keepMin: boolean };
    result: { profile: number[] };
  };
  cut: { args: CutArgs; result: CutResult };
  /** Result depends on `args.action`; use the typed helpers in client.ts (mixedPreview, …). */
  mixed_filament: { args: MixedFilamentArgs; result: MixedPreviewResult | MixedRecommendResult | MixedValidateResult };
  /** Per-extruder / per-filament values of the variant vectors for a job config, without slicing. */
  resolve_variants: { args: { config: FlatConfig }; result: ResolveVariantsResult };
  /** Prime tower size and desktop placement for a plate. */
  wipe_tower_footprint: { args: WipeTowerFootprintArgs; result: WipeTowerFootprintResult };
  /** Desktop "Fix model": CGAL repair of one volume's mesh (meshes[0] in, repaired meshes[0] out). */
  repair_mesh: { args: RepairMeshArgs; result: RepairMeshResult };
  /** Orca 2.5 texture displacement bake of one volume (meshes[0] = base mesh → displaced mesh). */
  texture_displacement: { args: TextureDisplacementArgs; result: TextureDisplacementResult };
}

/**
 * ENGINE-CONTRACT "Texture displacement". Uint8Array values in tool args are
 * packed into the request blob and sent as `{offset, length}` (packTool).
 */
export interface TextureDisplacementArgs {
  /** `{version, options, layers}` as texture_displacement_layers_to_json writes it. */
  layers: { version: number; options: Record<string, unknown>; layers: Array<Record<string, unknown>> };
  /** Slot → PNG bytes. */
  images: Record<string, Uint8Array>;
  /** Slot → paint mask. */
  paint: Record<string, ReadonlyArray<readonly [number, string]>>;
  /** Column-major mesh → world (instance · volume). */
  transform?: number[];
  /** World point the texture is anchored at (the object's first model part). */
  anchor?: [number, number, number];
  /** How far the object's lowest point lies below this part's (mm). */
  restingDrop?: number;
  /**
   * The part's support / seam / colour / fuzzy painting on the base mesh, carried onto the
   * result (desktop's bake commit, transfer_facet_paint) and returned as `paint`.
   */
  carryPaint?: PaintLayers;
}

/** `cancelled`: the run stopped at the host's request (no mesh). `paint`: the carried channels still painted. */
export type TextureDisplacementResult =
  | { triangles: number; budgetLimited: boolean; paint?: PaintLayers; cancelled?: undefined }
  | { cancelled: true; triangles?: undefined; budgetLimited?: undefined; paint?: undefined };

export type ToolOp = keyof ToolOps;
export type ToolArgs<K extends ToolOp> = ToolOps[K]['args'];
export type ToolResult<K extends ToolOp> = ToolOps[K]['result'];

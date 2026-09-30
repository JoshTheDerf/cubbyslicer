import type { ConfigValue } from '../engine/types';
import type { Quat, Vec3 } from './math';
import type { CadNode } from '../cad/api';

export interface BBox3 { min: Vec3; max: Vec3 }

/**
 * Mesh geometry. Indexed with welded (deduplicated) vertices, mesh-local mm.
 * Always stored `markRaw` outside Vue reactivity — these arrays can be huge.
 */
export interface MeshData {
  id: string;
  positions: Float32Array;
  indices: Uint32Array;
  bbox: BBox3;
  vertexCount: number;
  triangleCount: number;
}

/** Orca volume types (ModelVolumeType). */
export type PartType = 'part' | 'negative' | 'modifier' | 'support_blocker' | 'support_enforcer';

export const PART_TYPE_LABELS: Record<PartType, string> = {
  part: 'Part',
  negative: 'Negative part',
  modifier: 'Modifier',
  support_blocker: 'Support blocker',
  support_enforcer: 'Support enforcer',
};

/**
 * An extra volume of an object (Orca parts / modifiers / …). Its transform is
 * in the object's local frame: world = object TRS · part TRS · mesh-local.
 * The object's own `meshId` is its first (implicit) model part.
 */
export interface ObjectPart {
  id: string;
  name: string;
  meshId: string;
  type: PartType;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  /** Per-part engine config overrides (for modifiers: the settings they apply). */
  overrides: Record<string, ConfigValue>;
  /** Text / SVG emboss source (re-editable with the text / SVG tool). */
  emboss?: EmbossMeta;
}

// ---- tools: emboss (text / SVG) + brim ears ----------------------------------

/** Parameters of an embossed text volume (Orca GLGizmoEmboss / TextConfiguration). */
export interface TextEmboss {
  kind: 'text';
  text: string;
  /** Bundled font family id (src/tools/text/fonts.ts). */
  font: string;
  bold: boolean;
  italic: boolean;
  /** Font size = em height, mm. */
  size: number;
  /** Extrusion depth, mm. */
  depth: number;
  /** Extra gap between letters / lines, mm. */
  letterSpacing: number;
  lineSpacing: number;
  align: 'left' | 'center' | 'right';
}

/** An embossed SVG volume (Orca GLGizmoSVG). */
export interface SvgEmboss {
  kind: 'svg';
  /** File name the SVG came from. */
  name: string;
  /** SVG source (kept so size / depth can be changed later). */
  svg: string;
  /** Target width, mm (height follows the aspect ratio). */
  width: number;
  depth: number;
}

export type EmbossMeta = TextEmboss | SvgEmboss;

/** Orca BrimPoint: a brim ear, in the object's mesh-local frame (mm), with its radius (mm). */
export interface BrimPoint { pos: Vec3; radius: number }

export interface ProjectObject {
  id: string;
  name: string;
  meshId: string;
  /** Bed-space translation of the mesh-local origin (mm). */
  position: Vec3;
  /** Unit quaternion [x, y, z, w]. */
  rotation: Quat;
  scale: Vec3;
  visible: boolean;
  printable: boolean;
  /** Per-object engine config overrides (engine-native keys). */
  overrides: Record<string, ConfigValue>;
  /** CSS colour, '' = theme default. */
  color: string;
  /** Extra volumes (split to parts, added modifiers, …). */
  parts?: ObjectPart[];
  /**
   * Variable layer height (Orca layer_height_profile): flat [z0, h0, z1, h1, …],
   * z mm from the object's bottom (print coordinates). Absent = uniform.
   */
  layerHeightProfile?: number[];
  /** Height range modifiers (Orca layer_config_ranges), z mm from the object's bottom. */
  layerRanges?: LayerRange[];
  /** Text / SVG emboss source when the object itself is embossed text / SVG. */
  emboss?: EmbossMeta;
  /** Brim ears (Orca ModelObject::brim_points), mesh-local. */
  brimPoints?: BrimPoint[];
  /**
   * Placement in the assembled model (Orca offset_to_assembly), e.g. where a
   * cut piece sat before "place on cut" / arrange. Assembly View shows it.
   */
  assembly?: { position: Vec3; rotation: Quat; scale: Vec3 };
  /**
   * CubbyCAD modelling: the object IS this node tree (a primitive or a
   * manifold group, verbatim CubbyCAD JSON). `meshId` is derived from it
   * (evaluated Z-up without the root's own transform; this object's TRS places
   * it). The tree is immutable and `markRaw` — edits replace it (src/cad).
   */
  cad?: CadObjectData;
}

export interface CadObjectData {
  node: CadNode;
}

/** One height range modifier: Z range + the settings it applies (Orca "Height range Modifier"). */
export interface LayerRange {
  id: string;
  min: number;
  max: number;
  overrides: Record<string, ConfigValue>;
}

/** Result of parsing one model file: one or more meshes with optional placement. */
export interface ParsedObject {
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** Column-major placement from the file (3MF build items); null = place automatically. */
  transform: number[] | null;
  printable?: boolean;
  /**
   * Per-triangle colour groups (OBJ materials / vertex colours → Orca ObjColorDialog):
   * `tri[i]` = group index of triangle i (0xffffffff = none); a group's colour is '#rrggbb' or null (unknown).
   */
  faceGroups?: { tri: Uint32Array; groups: Array<{ name: string; color: string | null }> };
}

export interface ParseResult {
  objects: ParsedObject[];
  warnings: string[];
}

export type ObjectIssue = 'outside' | 'height' | 'exclude' | 'overlap';

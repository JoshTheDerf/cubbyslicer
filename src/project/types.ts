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
 * Orca 2.5 precise seam modifiers (ModelVolumeType PRECISE_SEAM_*). In a 3MF a
 * seam volume is a `modifier_part` plus `precise_seam_type` metadata, with its
 * settings stored dormant as `precise_seam_config:<key>`, so readers without
 * the feature see an inert modifier.
 */
export const PRECISE_SEAM_TYPES = [
  'precise_seam_center', 'precise_seam_left', 'precise_seam_right',
  'precise_seam_enforced', 'precise_seam_blocked', 'precise_seam_neutral',
] as const;
export type PreciseSeamType = (typeof PRECISE_SEAM_TYPES)[number];

export const PRECISE_SEAM_LABELS: Record<PreciseSeamType, string> = {
  precise_seam_center: 'Seam: center',
  precise_seam_left: 'Seam: left',
  precise_seam_right: 'Seam: right',
  precise_seam_enforced: 'Seam: enforced',
  precise_seam_blocked: 'Seam: blocked',
  precise_seam_neutral: 'Seam: neutral',
};

/**
 * A precise seam volume. The part keeps `type: 'modifier'` (Orca's base type)
 * and its `overrides` stay empty, so an engine without seam volumes slices it
 * as an inert modifier. Immutable: replace it, never mutate it.
 */
export interface PreciseSeam {
  type: PreciseSeamType;
  /** The seam's own settings (Orca writes them as `precise_seam_config:<key>`). */
  config: Record<string, ConfigValue>;
}

/**
 * Data from an opened OrcaSlicer / Bambu project that CubbySlicer doesn't
 * model, written back verbatim on save (src/project/persistence/passthrough.ts
 * has the project-level half). Immutable and shared by undo snapshots and
 * copies: replace it, never mutate it.
 */
export interface ElementPassthrough {
  /** `<metadata key value>` entries, in file order (e.g. settings this engine doesn't know). */
  metadata?: Array<[string, string]>;
  /** Attributes of the element itself (e.g. `<object auto_drop="0">`). */
  attrs?: Array<[string, string]>;
  /** Child elements other than `<metadata>`, as XML (attribute values kept escaped). */
  elements?: string[];
}

/** Passthrough of one volume (an object's own mesh or a part). */
export interface VolumePassthrough extends ElementPassthrough {
  /**
   * The mesh this was read with. `meshMetadata`, `elements` and `subtype`
   * describe that geometry (source file, texture layers, text / SVG shape) and
   * are dropped once the volume's mesh is replaced (cut, simplify, …).
   */
  meshId: string;
  meshMetadata?: Array<[string, string]>;
  /**
   * A volume subtype this version doesn't know: the part opens as an inert
   * modifier (no settings) and saves with this subtype while it still is one.
   */
  subtype?: string;
}

export interface ObjectPassthrough {
  object?: ElementPassthrough;
  /** The object's own volume (its `meshId`). */
  volume?: VolumePassthrough;
  /** The object's entry in Metadata/cut_information.xml (inner XML), kept for Orca's cut connectors. */
  cutInfo?: string;
}

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
  /** Set on a precise seam volume (then `type` is 'modifier'); see PreciseSeam. */
  preciseSeam?: PreciseSeam;
  /** Unmodelled 3MF data of this volume (see ElementPassthrough). */
  passthrough?: VolumePassthrough;
  /** Design tab: this part is a committed body of an assembly commit (its mesh follows the body; see ProjectObject.design). */
  design?: DesignLink;
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

// ---- texture displacement (Orca 2.5, src/texture) ------------------------------

/**
 * One Orca texture displacement layer (TextureDisplacementLayer). `json` is the
 * layer as desktop serialises it (texture_displacement_layers_to_json), without
 * `path_in_3mf`; keys we don't edit (UV islands, seams, view projection, …)
 * are kept as read. Immutable: replace it, never mutate it.
 */
export interface TextureLayer {
  readonly json: Readonly<Record<string, unknown>>;
  /** The texture: an encoded 8-bit grey or colour PNG (null = none). Shared, never mutated. */
  readonly image: Uint8Array | null;
}

/** A volume's layer stack + desktop's per-volume options (TextureDisplacementOptions, as read). Immutable. */
export interface TextureStack {
  readonly layers: readonly TextureLayer[];
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * Texture displacement data of one mesh (keyed by mesh id like paint, so
 * instances share it): the layer stack (on the object's first model part, as
 * on desktop) and the per-slot paint masks (`paint_texture_<slot>`). Immutable.
 */
export interface MeshTexture {
  readonly stack?: TextureStack;
  /** Slot → painted facets in Orca's per-triangle hex format. */
  readonly masks?: Readonly<Record<string, ReadonlyArray<readonly [number, string]>>>;
}

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
   * Orca's assemble state of this instance as an opened 3MF had it
   * (model_settings.config `<assemble_item>`; desktop sets it from the
   * instance's placement when the file had none): the 3MF matrix (12 numbers,
   * column by column) and offset_to_assembly. Written back exactly while
   * `assembly` is unset or still this pose. Immutable: replace it.
   */
  assemble?: { matrix: readonly number[]; offset: Vec3 };
  /**
   * CubbyCAD modelling: the object IS this node tree (a primitive or a
   * manifold group, verbatim CubbyCAD JSON). `meshId` is derived from it
   * (evaluated Z-up without the root's own transform; this object's TRS places
   * it). The tree is immutable and `markRaw` — edits replace it (src/cad).
   */
  cad?: CadObjectData;
  /**
   * Design tab: the object is a committed body of the project's design (Metadata/orca_cad.bin)
   * and follows it — every design edit replaces `meshId` (src/design/link.ts). Never set
   * together with `cad`. Desktop Orca doesn't know the link (it sees a plain mesh).
   */
  design?: DesignLink;
  /** Unmodelled 3MF data of this object and its own volume (see ElementPassthrough). */
  passthrough?: ObjectPassthrough;
}

export interface CadObjectData {
  node: CadNode;
}

/** A plate object ↔ design body link (src/design/link.ts). Immutable: replace it, never mutate it. */
export interface DesignLink {
  /** The body's identity across rebuilds: the feature that made it and its rank among that feature's bodies. */
  sourceFeature: number;
  ordinal: number;
  /** The body's index when it was last resolved (fallback when the source feature no longer makes bodies). */
  body: number;
  /** Design (bed) coordinates of the mesh-local origin: mesh = body − origin. */
  origin: Vec3;
}

/** One height range modifier: Z range + the settings it applies (Orca "Height range Modifier"). */
export interface LayerRange {
  id: string;
  min: number;
  max: number;
  overrides: Record<string, ConfigValue>;
  /** Settings of an opened 3MF this engine doesn't know: never sliced, written back as read. Immutable. */
  passthrough?: ReadonlyArray<readonly [string, string]>;
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

/** 'zone': in another IDEX/IQEX carriage's zone or a carriage collision strip (Orca 2.5 parallel modes). */
export type ObjectIssue = 'outside' | 'height' | 'exclude' | 'zone' | 'overlap';

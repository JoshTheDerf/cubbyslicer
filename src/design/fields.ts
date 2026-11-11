/**
 * The parameter editor's layout per feature type: which of the CadFeature fields a type reads
 * (contract "Field reference by type", CadDocument.hpp), labelled like Orca's feature cards
 * (DesignPanel.cpp). Value kinds come from the kernel (`describe_tools.fields`): numbers, ints,
 * booleans and enums are editable; references are picked in the viewport (faces, edges, bodies:
 * on the design as it was before the feature, its input) or chosen (sketches, datum planes).
 * Fields in `describe_tools.bindable_fields` can be driven by an expression.
 */
import type { FeatureJson, FeatureType, FieldSchema } from './kernel/types';

export type RefKind = 'feature' | 'body' | 'face' | 'edge' | 'faces' | 'edges' | 'datum';

export interface FieldDef {
  key: string;
  label: string;
  /** Unit suffix ('mm', '°'). */
  unit?: string;
  /** Overrides the kernel's type: an int with named values. */
  options?: ReadonlyArray<readonly [number, string]>;
  /** A reference: picked in the viewport (face / edge / body kinds) or chosen (feature, datum). */
  ref?: RefKind;
  /** The field holding the body a face / edge reference is on (`target_body`, `plane_face_body`…). */
  bodyKey?: string;
  /** feature refs: only these types (default Sketch). */
  featureTypes?: readonly string[];
  /** Vec3 field (three numbers). */
  vec3?: boolean;
  min?: number;
  max?: number;
  /** Shown only when this holds for the current values. */
  when?: (f: Record<string, unknown>) => boolean;
}

const MM = 'mm', DEG = '°';
const MODE: FieldDef = { key: 'mode', label: 'Result' };
const SKETCH: FieldDef = { key: 'sketch_ref', label: 'Sketch', ref: 'feature' };
const BODY: FieldDef = { key: 'target_body', label: 'Body', ref: 'body' };

/** Orca's labels for enum values (DesignPanel.cpp cards). */
export const ENUM_LABELS: Record<string, Record<string, string>> = {
  mode: { New: 'New body', Add: 'Join', Cut: 'Cut', Intersect: 'Intersect' },
  extrude_end: { Blind: 'Blind', Symmetric: 'Symmetric', TwoSided: 'Two-sided', ThroughAll: 'Through all', UpToFace: 'Up to face', UpToVertex: 'Up to vertex' },
  face_group: { Top: 'Top', Bottom: 'Bottom', Lateral: 'Lateral', All: 'All' },
  plane_type: { Offset: 'Offset', Angle: 'Angle', Midplane: 'Midplane', Tangent: 'Tangent', TwoEdges: 'Two edges', Coincident: 'Coincident' },
  axis_type: { TwoPoints: 'Two points', FaceNormal: 'Face normal', CylinderCenterline: 'Cylinder centreline', PlaneIntersection: 'Plane intersection', AlongEdge: 'Along edge' },
  coordsys_type: { PointWorld: 'Point (world)', FaceAndDirection: 'Face + direction' },
  shape: { Rectangle: 'Rectangle', Circle: 'Circle' },
};

const noEdges = (f: Record<string, unknown>) => !Array.isArray(f.dressup_edges) || !(f.dressup_edges as unknown[]).length;
const legacySketch = (f: Record<string, unknown>) => !Array.isArray(f.entities) || !(f.entities as unknown[]).length;

export const FEATURE_FIELDS: Record<FeatureType, FieldDef[]> = {
  Sketch: [
    { key: 'shape', label: 'Shape', when: legacySketch },
    { key: 'width', label: 'Width', unit: MM, when: legacySketch },
    { key: 'height', label: 'Height', unit: MM, when: legacySketch },
    { key: 'radius', label: 'Radius', unit: MM, when: legacySketch },
  ],
  Extrude: [
    SKETCH,
    { key: 'distance', label: 'Distance', unit: MM },
    { key: 'extrude_end', label: 'End' },
    { key: 'distance2', label: 'Second distance', unit: MM, when: (f) => f.extrude_end === 'TwoSided' },
    { key: 'up_to_face', label: 'Up to face', ref: 'face', bodyKey: 'target_body', when: (f) => f.extrude_end === 'UpToFace' },
    { key: 'taper_deg', label: 'Taper', unit: DEG, min: -89, max: 89 },
    MODE,
    { key: 'flip', label: 'Flip direction' },
    BODY,
  ],
  Fillet: [
    { key: 'dressup_size', label: 'Radius', unit: MM, min: 0 },
    { key: 'dressup_edges', label: 'Edges', ref: 'edges', bodyKey: 'target_body' },
    { key: 'face_group', label: 'Edges of', when: noEdges },
    BODY,
  ],
  Chamfer: [
    { key: 'dressup_size', label: 'Distance', unit: MM, min: 0 },
    { key: 'dressup_edges', label: 'Edges', ref: 'edges', bodyKey: 'target_body' },
    { key: 'face_group', label: 'Edges of', when: noEdges },
    BODY,
  ],
  Hole: [
    { key: 'hole_diameter', label: 'Diameter', unit: MM, min: 0 },
    { key: 'hole_through', label: 'Through all' },
    { key: 'hole_depth', label: 'Depth', unit: MM, min: 0, when: (f) => !f.hole_through },
    { key: 'hole_x', label: 'Position X', unit: MM },
    { key: 'hole_y', label: 'Position Y', unit: MM },
    { key: 'hole_style', label: 'Style', options: [[0, 'Simple'], [1, 'Counterbore'], [2, 'Countersink']] },
    { key: 'hole_cbore_diameter', label: 'Counterbore diameter', unit: MM, when: (f) => f.hole_style === 1 },
    { key: 'hole_cbore_depth', label: 'Counterbore depth', unit: MM, when: (f) => f.hole_style === 1 },
    { key: 'hole_csink_diameter', label: 'Countersink diameter', unit: MM, when: (f) => f.hole_style === 2 },
    { key: 'hole_csink_angle', label: 'Countersink angle', unit: DEG, when: (f) => f.hole_style === 2 },
    BODY,
  ],
  Thread: [
    { key: 'thread_radius', label: 'Radius', unit: MM, min: 0 },
    { key: 'thread_pitch', label: 'Pitch', unit: MM, min: 0 },
    { key: 'thread_height', label: 'Length', unit: MM, min: 0 },
    { key: 'thread_depth', label: 'Depth', unit: MM, min: 0 },
    { key: 'thread_internal', label: 'Internal' },
    { key: 'thread_x', label: 'Position X', unit: MM },
    { key: 'thread_y', label: 'Position Y', unit: MM },
    BODY,
  ],
  Shell: [{ key: 'shell_thickness', label: 'Thickness', unit: MM, min: 0 }, { key: 'shell_face', label: 'Open face', ref: 'face', bodyKey: 'target_body' }, BODY],
  Revolve: [
    SKETCH,
    { key: 'revolve_angle', label: 'Angle', unit: DEG },
    { key: 'revolve_axis', label: 'Axis', options: [[0, 'Sketch X'], [1, 'Sketch Y']] },
    MODE,
    { key: 'flip', label: 'Flip direction' },
    BODY,
  ],
  Sweep: [{ key: 'sketch_ref', label: 'Profile', ref: 'feature' }, { key: 'sweep_path_ref', label: 'Path', ref: 'feature', featureTypes: ['Sketch', 'Helix'] }, MODE, BODY],
  Pattern: [
    { key: 'pattern_circular', label: 'Circular' },
    { key: 'pattern_count', label: 'Count', min: 1 },
    { key: 'pattern_spacing', label: 'Spacing', unit: MM, when: (f) => !f.pattern_circular },
    { key: 'pattern_dir', label: 'Direction', options: [[0, 'Plane X'], [1, 'Plane Y']], when: (f) => !f.pattern_circular },
    { key: 'pattern_angle', label: 'Angle', unit: DEG, when: (f) => !!f.pattern_circular },
    { key: 'pattern_inclusive', label: 'Spacing spans the whole pattern' },
    BODY,
  ],
  Plane: [
    { key: 'plane_type', label: 'Type' },
    { key: 'plane_base', label: 'Base plane', ref: 'datum' },
    { key: 'plane_face', label: 'Face A', ref: 'face', bodyKey: 'plane_face_body', when: (f) => f.plane_type !== 'TwoEdges' },
    { key: 'plane_face2', label: 'Face B', ref: 'face', bodyKey: 'plane_face2_body', when: (f) => f.plane_type === 'Midplane' },
    { key: 'plane_edge', label: 'Edge A', ref: 'edge', bodyKey: 'plane_edge_body', when: (f) => f.plane_type === 'Angle' || f.plane_type === 'TwoEdges' },
    { key: 'plane_edge2', label: 'Edge B', ref: 'edge', bodyKey: 'plane_edge2_body', when: (f) => f.plane_type === 'TwoEdges' },
    { key: 'plane_offset', label: 'Offset', unit: MM },
    { key: 'plane_angle_tilt', label: 'Tilt', unit: DEG, when: (f) => f.plane_type === 'Angle' },
    { key: 'plane_u_size', label: 'Width', unit: MM },
    { key: 'plane_v_size', label: 'Height', unit: MM },
  ],
  Loft: [{ key: 'loft_profile_refs', label: 'Profiles', ref: 'feature' }, { key: 'loft_ruled', label: 'Ruled' }, MODE, BODY],
  Draft: [{ key: 'draft_angle', label: 'Angle', unit: DEG }, { key: 'draft_face', label: 'Face', ref: 'face', bodyKey: 'target_body' }, BODY],
  Import: [MODE],
  Boolean: [
    { key: 'mode', label: 'Operation' },
    { key: 'target_body', label: 'Target body', ref: 'body' },
    { key: 'bool_tool_body', label: 'Tool body', ref: 'body' },
    { key: 'bool_keep_tool', label: 'Keep tool body' },
    { key: 'bool_tolerance', label: 'Fuzzy tolerance', unit: MM, min: 0 },
  ],
  Cut: [
    { key: 'cut_offset', label: 'Offset', unit: MM },
    { key: 'cut_flip', label: 'Flip' },
    { key: 'cut_keep_upper', label: 'Keep upper part' },
    { key: 'cut_keep_lower', label: 'Keep lower part' },
    { key: 'cut_face', label: 'Splitting face', ref: 'face', bodyKey: 'cut_face_body', when: (f) => Number(f.cut_face) >= 0 },
    BODY,
  ],
  Mirror: [MODE, { key: 'mirror_keep_original', label: 'Keep original' }, BODY],
  Axis: [
    { key: 'axis_type', label: 'Type' },
    { key: 'axis_face', label: 'Face', ref: 'face', bodyKey: 'axis_body', when: (f) => f.axis_type === 'FaceNormal' || f.axis_type === 'CylinderCenterline' },
    { key: 'axis_edge', label: 'Edge', ref: 'edge', bodyKey: 'axis_body', when: (f) => f.axis_type === 'AlongEdge' },
    { key: 'axis_plane_a', label: 'Plane A', ref: 'datum', when: (f) => f.axis_type === 'PlaneIntersection' },
    { key: 'axis_plane_b', label: 'Plane B', ref: 'datum', when: (f) => f.axis_type === 'PlaneIntersection' },
    { key: 'axis_p1', label: 'Point 1', unit: MM, vec3: true, when: (f) => f.axis_type === 'TwoPoints' },
    { key: 'axis_p2', label: 'Point 2', unit: MM, vec3: true, when: (f) => f.axis_type === 'TwoPoints' },
  ],
  CoordSys: [
    { key: 'coordsys_type', label: 'Type' },
    { key: 'coordsys_point', label: 'Point', unit: MM, vec3: true, when: (f) => f.coordsys_type !== 'FaceAndDirection' },
    { key: 'coordsys_face', label: 'Face', ref: 'face', bodyKey: 'coordsys_body', when: (f) => f.coordsys_type === 'FaceAndDirection' },
    { key: 'coordsys_edge', label: 'Edge (sets in-plane direction)', ref: 'edge', bodyKey: 'coordsys_body', when: (f) => f.coordsys_type === 'FaceAndDirection' },
    { key: 'coordsys_x_hint', label: 'X direction', vec3: true, when: (f) => f.coordsys_type === 'FaceAndDirection' },
  ],
  Helix: [
    { key: 'helix_radius', label: 'Radius', unit: MM, min: 0 },
    { key: 'helix_pitch', label: 'Pitch', unit: MM, min: 0 },
    { key: 'helix_height', label: 'Height', unit: MM, min: 0 },
    { key: 'helix_taper_deg', label: 'Taper', unit: DEG },
    { key: 'helix_left_handed', label: 'Left-handed' },
  ],
  Transform: [
    { key: 'xf_translate', label: 'Move', unit: MM, vec3: true },
    { key: 'xf_axis', label: 'Rotation axis', vec3: true },
    { key: 'xf_angle_deg', label: 'Angle', unit: DEG },
    { key: 'xf_pivot', label: 'Pivot', unit: MM, vec3: true },
    { key: 'xf_copy', label: 'Keep original (make a copy)' },
    BODY,
  ],
  Thicken: [{ key: 'thicken_thickness', label: 'Thickness', unit: MM }, { key: 'thicken_flip', label: 'Flip' }, { key: 'thicken_face', label: 'Face', ref: 'face', bodyKey: 'target_body' }, BODY],
  Project: [{ key: 'project_source_body', label: 'Source body', ref: 'body' }, { key: 'project_edges', label: 'Edges', ref: 'edges' }],
  DeleteFace: [{ key: 'delete_faces', label: 'Faces', ref: 'faces', bodyKey: 'target_body' }, BODY],
  Rib: [{ key: 'rib_thickness', label: 'Thickness', unit: MM }, { key: 'rib_depth', label: 'Depth', unit: MM }, BODY],
  SurfaceExtrude: [SKETCH, { key: 'distance', label: 'Distance', unit: MM }],
  SurfaceRevolve: [SKETCH, { key: 'revolve_angle', label: 'Angle', unit: DEG }, { key: 'revolve_axis', label: 'Axis', options: [[0, 'Sketch X'], [1, 'Sketch Y']] }, { key: 'flip', label: 'Flip direction' }],
  ThickenSurface: [{ key: 'thicken_thickness', label: 'Thickness', unit: MM }, { key: 'thicken_flip', label: 'Flip direction' }, { ...BODY, label: 'Sheet body' }],
  // Orca's Surface Offset reads `plane_offset` (DesignPanel build_candidate / CadDocument::apply_surface_offset).
  SurfaceOffset: [{ key: 'plane_offset', label: 'Offset', unit: MM }, { ...BODY, label: 'Sheet body' }],
  SurfaceLoft: [{ key: 'loft_profile_refs', label: 'Profiles', ref: 'feature' }, { key: 'loft_ruled', label: 'Ruled' }],
  SurfaceFill: [SKETCH],
  Mate: [
    { key: 'mate_kind', label: 'Kind', options: [[0, 'Fastened'], [1, 'Planar'], [2, 'Revolute'], [3, 'Slider'], [4, 'Cylindrical']] },
    { key: 'mate_cs_a', label: 'A (fixed)', ref: 'feature', featureTypes: ['CoordSys'] },
    { key: 'mate_cs_b', label: 'B (moves)', ref: 'feature', featureTypes: ['CoordSys'] },
    { key: 'mate_offset', label: 'Offset', unit: MM },
    { key: 'mate_angle', label: 'Angle', unit: DEG },
    { key: 'mate_flip', label: 'Flip (oppose z axes)' },
  ],
};

export type ControlKind = 'number' | 'int' | 'bool' | 'enum' | 'vec3' | 'ref' | 'text';

export interface EditorField extends FieldDef {
  kind: ControlKind;
  /** Enum / option values in order, with labels. */
  choices?: Array<{ value: string | number; label: string }>;
  bindable: boolean;
}

/** The editor rows of feature `f`, typed by the kernel's schema (fields it doesn't know are left out). */
export function editorFields(f: FeatureJson, schema: readonly FieldSchema[], bindable: readonly string[]): EditorField[] {
  const types = new Map(schema.map((s) => [s.name, s]));
  const bind = new Set(bindable);
  const out: EditorField[] = [];
  for (const d of FEATURE_FIELDS[f.type] ?? []) {
    const s = types.get(d.key);
    if (!s || !(d.key in f)) continue;
    if (d.when && !d.when(f)) continue;
    let kind: ControlKind;
    let choices: EditorField['choices'];
    if (d.ref) kind = 'ref';
    else if (d.options) { kind = 'enum'; choices = d.options.map(([value, label]) => ({ value, label })); }
    else if (d.vec3 || s.type === 'vec3') kind = 'vec3';
    else if (s.type === 'enum') { kind = 'enum'; choices = (s.enum ?? []).map((v) => ({ value: v, label: ENUM_LABELS[d.key]?.[v] ?? v })); }
    else if (s.type === 'bool') kind = 'bool';
    else if (s.type === 'int') kind = 'int';
    else if (s.type === 'number') kind = 'number';
    else if (s.type === 'string') kind = 'text';
    else continue;
    out.push({ ...d, kind, choices, bindable: bind.has(d.key) && (kind === 'number' || kind === 'int') });
  }
  return out;
}

/** A reference field's value as text (names features, numbers bodies / faces / edges). */
export function refText(v: unknown, kind: RefKind, featureName: (i: number) => string | undefined): string {
  if (Array.isArray(v)) {
    if (!v.length) return kind === 'edges' ? 'none (edge group below)' : 'none';
    if (kind === 'feature') return v.map((i) => featureName(Number(i)) ?? `#${Number(i) + 1}`).join(', ');
    return `${v.length} ${kind === 'faces' ? 'face' : 'edge'}${v.length === 1 ? '' : 's'} (${v.slice(0, 8).join(', ')}${v.length > 8 ? ', …' : ''})`;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return kind === 'body' ? 'last body' : '—';
  switch (kind) {
    case 'feature': return featureName(n) ?? `feature ${n + 1}`;
    case 'body': return `Body ${n + 1}`;
    case 'datum': return n === 0 ? 'XY' : n === 1 ? 'XZ' : n === 2 ? 'YZ' : `Plane ${n - 2}`;
    default: return `${kind} ${n}`;
  }
}

/** Orca's feature tree icons (tree_icon_for), as Lucide icons. */
export const FEATURE_ICONS: Record<FeatureType, string> = {
  Sketch: 'i-lucide-pen-tool', Extrude: 'i-lucide-arrow-up-from-line', Fillet: 'i-lucide-square-round-corner', Chamfer: 'i-lucide-scissors-line-dashed',
  Hole: 'i-lucide-circle-dot', Thread: 'i-lucide-cable', Shell: 'i-lucide-package-open', Revolve: 'i-lucide-rotate-3d', Sweep: 'i-lucide-spline',
  Pattern: 'i-lucide-grid-3x3', Plane: 'i-lucide-square-dashed', Loft: 'i-lucide-layers-2', Draft: 'i-lucide-triangle-right', Import: 'i-lucide-file-input',
  Boolean: 'i-lucide-combine', Cut: 'i-lucide-slice', Mirror: 'i-lucide-flip-horizontal-2', Axis: 'i-lucide-move-diagonal', CoordSys: 'i-lucide-axis-3d',
  Helix: 'i-lucide-git-commit-vertical', Transform: 'i-lucide-move-3d', Thicken: 'i-lucide-panel-top', Project: 'i-lucide-scan-line', DeleteFace: 'i-lucide-eraser',
  Rib: 'i-lucide-git-commit-horizontal', SurfaceExtrude: 'i-lucide-square-arrow-up', SurfaceRevolve: 'i-lucide-orbit', ThickenSurface: 'i-lucide-panel-bottom',
  SurfaceOffset: 'i-lucide-copy', SurfaceLoft: 'i-lucide-layers-3', SurfaceFill: 'i-lucide-paint-bucket', Mate: 'i-lucide-link-2',
};

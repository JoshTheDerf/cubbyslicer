/**
 * OrcaSlicer 2.5 texture displacement data (libslic3r/TextureDisplacement.hpp):
 * desktop's defaults, its 3MF JSON (texture_displacement_layers_to_json /
 * _from_json, TextureDisplacement.cpp) and typed reads of the layer fields
 * the tool edits. Layers keep desktop's JSON object, so fields we don't edit
 * survive open → save unchanged.
 */
import type { MeshTexture, TextureLayer, TextureStack } from '../project/types';

/** TEXTURE_DISPLACEMENT_MAX_LAYERS. */
export const MAX_TEXTURE_LAYERS = 8;
/** bbs_3mf.cpp TEXTURE_DISPLACEMENT_KEY / _DIR / _ATTRS. */
export const TEXTURE_KEY = 'texture_displacement';
export const TEXTURE_DIR = 'Metadata/texture_displacement/';
export const maskAttr = (slot: number) => `paint_texture_${slot}`;
export const MASK_ATTR_RE = /^paint_texture_([0-7])$/;

/** TextureProjectionMethod. */
export const Projection = { Triplanar: 0, Cylindrical: 1, Spherical: 2, LSCM: 3, ViewProjected: 4, ModelUV: 5 } as const;
/** TextureTileMethod. */
export const TileMethod = { Repeat: 0, MirroredRepeat: 1 } as const;
/** TextureBlendMode. */
export const BlendMode = { Add: 0, Subtract: 1, Multiply: 2, Divide: 3, Override: 4 } as const;

/** A new layer exactly as desktop serialises a default-constructed TextureDisplacementLayer. */
export function defaultLayerJson(slot: number): Record<string, unknown> {
  return {
    slot, name: '', path: '',
    depth_mm: 0.4, tiling_scale: 12.5, rotation_deg: 0, offset: [0, 0], invert: false, midlevel: 0, smoothing: 0,
    edge_smoothing: false, edge_smoothing_amount: 0.5, auto_connect_islands: true,
    tile_enabled: true, tile_method: TileMethod.Repeat, projection_method: Projection.Triplanar, blend_mode: BlendMode.Add, color_enabled: false,
    lscm_seam_angle_deg: 30, island_padding_mm: -1,
    view_project_right: [1, 0, 0], view_project_up: [0, 1, 0], view_project_projective: false, view_project_matrix: new Array(12).fill(0),
    lscm_seam_edges: [], islands: [], island_groups: [], lscm_uv_overrides: [],
  };
}

/** TextureDisplacementOptions defaults (Standard mode). */
export function defaultOptions(): Record<string, unknown> {
  return {
    displace_border: true, smooth_enabled: false, smooth_strength: 0.3, smooth_iterations: 2, smooth_skip_border: true,
    pipeline_v2: true, v2_refine_mm: 0, v2_regularize: false, v2_max_triangles_k: -1, v2_relocate: false, v2_flip_edges: true,
    color_mix_enabled: true, color_despeckle: 2, color_mix_count: 8, active_slot: 0, panel_mode: 0,
  };
}

// ---- typed reads (desktop `read()`: a value of the wrong type keeps the default) ----

export function num(j: Readonly<Record<string, unknown>>, k: string, def: number): number {
  const v = j[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}
export function bool(j: Readonly<Record<string, unknown>>, k: string, def: boolean): boolean {
  const v = j[k];
  return typeof v === 'boolean' ? v : def;
}
export function str(j: Readonly<Record<string, unknown>>, k: string, def = ''): string {
  const v = j[k];
  return typeof v === 'string' ? v : def;
}
/** read_enum: integers only. */
export function enumInt(j: Readonly<Record<string, unknown>>, k: string, def: number): number {
  const v = j[k];
  return typeof v === 'number' && Number.isInteger(v) ? v : def;
}

export const layerSlot = (l: TextureLayer): number => enumInt(l.json, 'slot', -1);
/** Panel name: the layer's name, else "Layer N" (layer_name()). */
export const layerName = (l: TextureLayer): string => str(l.json, 'name') || `Layer ${layerSlot(l) + 1}`;
/** projection_method as the reader clamps it (0..4; ModelUV is never read back). */
export const projectionOf = (l: TextureLayer): number => Math.min(4, Math.max(0, enumInt(l.json, 'projection_method', Projection.Triplanar)));

/** The layers in stack order: by slot (the lowest is the base layer; the bake combines them in slot order). */
export function orderedLayers(stack: TextureStack | undefined): TextureLayer[] {
  return [...(stack?.layers ?? [])].sort((a, b) => layerSlot(a) - layerSlot(b));
}

/** A layer with some fields changed (layers are immutable). */
export function withFields(l: TextureLayer, patch: Record<string, unknown>, image?: Uint8Array | null): TextureLayer {
  return Object.freeze({ json: Object.freeze({ ...l.json, ...patch }), image: image === undefined ? l.image : image });
}

/** The lowest free slot (add_texture_layer), or -1 when all eight are used. */
export function freeSlot(stack: TextureStack | undefined): number {
  const used = new Set((stack?.layers ?? []).map(layerSlot));
  for (let i = 0; i < MAX_TEXTURE_LAYERS; i++) if (!used.has(i)) return i;
  return -1;
}

/** Slots painted on a mesh. */
export function paintedSlots(t: MeshTexture | undefined): Set<number> {
  return new Set(Object.entries(t?.masks ?? {}).filter(([, m]) => m.length).map(([s]) => Number(s)));
}

/**
 * Every facet painted (select_whole_model: ENFORCER on each triangle). An
 * unsplit triangle in state 1 serialises as "4" (TriangleSelector::serialize).
 */
export function wholeMask(triangles: number): Array<[number, string]> {
  const out: Array<[number, string]> = new Array(triangles);
  for (let t = 0; t < triangles; t++) out[t] = [t, '4'];
  return out;
}

/**
 * A mask recorded for another mesh indexes triangles it doesn't have; the
 * selector would load it empty and the next stroke would write that back over
 * the mask (desktop's m_selectors_stale check). Such a mask isn't edited.
 */
export function maskFits(mask: ReadonlyArray<readonly [number, string]> | undefined, triangles: number): boolean {
  return !mask || mask.every(([t]) => Number.isInteger(t) && t >= 0 && t < triangles);
}

// ---- 3MF JSON ------------------------------------------------------------------

/**
 * texture_displacement_layers_to_json: `paths` gives each slot's image path in
 * the archive (path_in_3mf is empty for a layer without one).
 */
export function stackToJson(stack: TextureStack, paths: ReadonlyMap<number, string>): string {
  return JSON.stringify({
    version: 1,
    options: { ...defaultOptions(), ...stack.options },
    layers: stack.layers.map((l) => ({ ...defaultLayerJson(layerSlot(l)), ...l.json, path_in_3mf: paths.get(layerSlot(l)) ?? '' })),
  });
}

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const allNums = (v: unknown) => !Array.isArray(v) || v.every(isNum);
const allNumArrays = (v: unknown) => !Array.isArray(v) || v.every((e) => !Array.isArray(e) || e.every(isNum));

/**
 * texture_displacement_layers_from_json + the importer's image lookup
 * (_apply_texture_displacement). Null where desktop rejects the document: not
 * a JSON object, a layer slot missing or outside 0..7, a non-number in a
 * vector / matrix / seam / island / UV-override array. Images come only from
 * the archive (`image(path_in_3mf)`), never from `path`.
 */
export function stackFromJson(text: string, image: (path: string) => Uint8Array | undefined): TextureStack | null {
  let root: unknown;
  try { root = JSON.parse(text); } catch { return null; }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const r = root as Record<string, unknown>;
  const opts = r.options && typeof r.options === 'object' && !Array.isArray(r.options) ? { ...(r.options as Record<string, unknown>) } : {};
  const layers: TextureLayer[] = [];
  const seen = new Set<number>();
  for (const j of Array.isArray(r.layers) ? r.layers : []) {
    if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
    const o = { ...(j as Record<string, unknown>) };
    const slot = typeof o.slot === 'number' ? Math.trunc(o.slot) : -1;
    if (!(slot >= 0 && slot < MAX_TEXTURE_LAYERS)) return null;
    for (const k of ['offset', 'view_project_right', 'view_project_up', 'view_project_matrix', 'lscm_seam_edges']) if (!allNums(o[k])) return null;
    for (const k of ['islands', 'lscm_uv_overrides']) if (!allNumArrays(o[k])) return null;
    o.slot = slot;
    const path = typeof o.path_in_3mf === 'string' ? o.path_in_3mf : '';
    delete o.path_in_3mf;
    if (seen.has(slot)) continue; // two layers can't share a slot's mask
    seen.add(slot);
    layers.push(Object.freeze({ json: Object.freeze(o), image: (path && image(path)) || null }));
  }
  return Object.freeze({ layers: Object.freeze(layers), options: Object.freeze(opts) });
}

/**
 * Normalized feature (extrusion role) taxonomy shared by the parser, the
 * renderer and the legend. Ids are small integers so they fit a Uint8 per
 * segment and index a 32-entry shader palette.
 *
 * Dialects mapped here:
 *   - PrusaSlicer / preFlight: `;TYPE:External perimeter`, `;TYPE:Perimeter`, ...
 *   - OrcaSlicer / Bambu:      `;TYPE:Outer wall` or `; FEATURE: Outer wall`, ...
 *   - Cura:                    `;TYPE:WALL-OUTER`, `;TYPE:FILL`, ...
 */

export const Feature = {
  Other: 0,
  OuterWall: 1,
  InnerWall: 2,
  OverhangWall: 3,
  SparseInfill: 4,
  SolidInfill: 5,
  TopSurface: 6,
  BottomSurface: 7,
  Bridge: 8,
  InternalBridge: 9,
  GapInfill: 10,
  SkirtBrim: 11,
  Support: 12,
  SupportInterface: 13,
  SupportTransition: 14,
  WipeTower: 15,
  Ironing: 16,
  Custom: 17,
  // ---- non-extrusion moves ----
  Travel: 18,
  Wipe: 19,
  Retract: 20,
  Unretract: 21,
  /** Marker-only (never a segment feature). */
  Seam: 22,
} as const;
export type FeatureId = (typeof Feature)[keyof typeof Feature];

export const FEATURE_COUNT = 23;
/** Features `< FIRST_NON_EXTRUSION` are extrusions (drawn as tubes). */
export const FIRST_NON_EXTRUSION = Feature.Travel;

export function isExtrusionFeature(f: number): boolean {
  return f < FIRST_NON_EXTRUSION;
}

export interface FeatureMeta {
  id: FeatureId;
  label: string;
  /** sRGB hex. Orca/PrusaSlicer-like palette. */
  color: number;
}

export const FEATURES: readonly FeatureMeta[] = [
  { id: Feature.Other, label: 'Other', color: 0xe6b3b3 },
  { id: Feature.OuterWall, label: 'Outer wall', color: 0xff7d38 },
  { id: Feature.InnerWall, label: 'Inner wall', color: 0xffe64d },
  { id: Feature.OverhangWall, label: 'Overhang wall', color: 0x1f1fff },
  { id: Feature.SparseInfill, label: 'Sparse infill', color: 0xb03029 },
  { id: Feature.SolidInfill, label: 'Internal solid infill', color: 0x9654cc },
  { id: Feature.TopSurface, label: 'Top surface', color: 0xf04040 },
  { id: Feature.BottomSurface, label: 'Bottom surface', color: 0x6666c7 },
  { id: Feature.Bridge, label: 'Bridge', color: 0x4d80ba },
  { id: Feature.InternalBridge, label: 'Internal bridge', color: 0x4da1b8 },
  { id: Feature.GapInfill, label: 'Gap infill', color: 0xffffff },
  { id: Feature.SkirtBrim, label: 'Skirt / brim', color: 0x00876e },
  { id: Feature.Support, label: 'Support', color: 0x00ff00 },
  { id: Feature.SupportInterface, label: 'Support interface', color: 0x008000 },
  { id: Feature.SupportTransition, label: 'Support transition', color: 0x406d40 },
  { id: Feature.WipeTower, label: 'Prime tower', color: 0xb3e3ab },
  { id: Feature.Ironing, label: 'Ironing', color: 0xff8c69 },
  { id: Feature.Custom, label: 'Custom', color: 0x5ed194 },
  { id: Feature.Travel, label: 'Travel', color: 0x3848a0 },
  { id: Feature.Wipe, label: 'Wipe', color: 0xffff00 },
  { id: Feature.Retract, label: 'Retract', color: 0xcc00cc },
  { id: Feature.Unretract, label: 'Unretract', color: 0x00cccc },
  { id: Feature.Seam, label: 'Seam', color: 0xe6e6e6 },
];

const cache = new Map<string, FeatureId>();

/** Map a `;TYPE:` / `; FEATURE:` value to a normalized id (cached). */
export function classifyFeature(raw: string): FeatureId {
  const key = raw.trim();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const id = classifyUncached(key.toLowerCase());
  if (cache.size < 256) cache.set(key, id);
  return id;
}

function classifyUncached(s: string): FeatureId {
  if (!s) return Feature.Other;
  // Order matters: most specific first.
  if (s.includes('internal bridge') || s === 'internal bridge infill') return Feature.InternalBridge;
  if (s.includes('bridge')) return Feature.Bridge;
  if (s.includes('overhang')) return Feature.OverhangWall;
  if (s.includes('support transition')) return Feature.SupportTransition;
  if (s.includes('interface')) return Feature.SupportInterface; // Prusa "Support material interface", Cura SUPPORT-INTERFACE
  if (s.includes('support')) return Feature.Support;
  if (s.includes('skirt') || s.includes('brim')) return Feature.SkirtBrim;
  if (s.includes('wipe tower') || s.includes('prime tower') || s.includes('prime-tower')) return Feature.WipeTower;
  if (s.includes('ironing')) return Feature.Ironing;
  if (s.includes('external perimeter') || s.includes('outer wall') || s === 'wall-outer') return Feature.OuterWall;
  if (s.includes('perimeter') || s.includes('inner wall') || s === 'wall-inner' || s.includes('floating vertical shell')) return Feature.InnerWall;
  if (s.includes('gap')) return Feature.GapInfill;
  if (s.includes('top')) return Feature.TopSurface;       // "Top solid infill", "Top surface"
  if (s.includes('bottom')) return Feature.BottomSurface; // "Bottom surface"
  if (s.includes('solid') || s === 'skin') return Feature.SolidInfill;
  if (s.includes('infill') || s === 'fill') return Feature.SparseInfill;
  if (s.includes('custom')) return Feature.Custom;
  if (s.includes('wall')) return Feature.InnerWall;
  return Feature.Other;
}

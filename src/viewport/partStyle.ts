/**
 * How non-model volumes look in the Prepare view and the object list (Orca
 * `GLVolume::*_COL`, 3DScene.cpp). All are drawn translucent.
 */
import type { ObjectPart, PartType, PreciseSeamType } from '../project/types';

/** Modifier / negative / support volumes. */
export const PART_COLORS: Record<Exclude<PartType, 'part'>, number> = {
  negative: 0x8a8f98,
  modifier: 0xf5c542,
  support_blocker: 0xef5b5b,
  support_enforcer: 0x4ea1ff,
};

/** Orca 2.5 precise seam volumes, per subtype (3DScene.cpp PRECISE_SEAM_*_COL). */
export const SEAM_COLORS: Record<PreciseSeamType, number> = {
  precise_seam_center: 0xffa015,
  precise_seam_left: 0xffc000,
  precise_seam_right: 0xff8300,
  precise_seam_enforced: 0x69d169,
  precise_seam_blocked: 0xd16969,
  precise_seam_neutral: 0xa7a7a7,
};

/** Object-list icons for the seam subtypes. */
export const SEAM_ICONS: Record<PreciseSeamType, string> = {
  precise_seam_center: 'i-lucide-crosshair',
  precise_seam_left: 'i-lucide-arrow-left-to-line',
  precise_seam_right: 'i-lucide-arrow-right-to-line',
  precise_seam_enforced: 'i-lucide-locate-fixed',
  precise_seam_blocked: 'i-lucide-locate-off',
  precise_seam_neutral: 'i-lucide-locate',
};

/** The 3D colour of a non-model part (null for model parts, which use the object's material). */
export function partColour(p: Pick<ObjectPart, 'type' | 'preciseSeam'>): number | null {
  if (p.preciseSeam) return SEAM_COLORS[p.preciseSeam.type] ?? PART_COLORS.modifier;
  return p.type === 'part' ? null : PART_COLORS[p.type] ?? 0xffffff;
}

/**
 * Shape editors opened from a settings row: a polygon option (excluded bed
 * area, wrapping exclusion area, …) in the bed shape dialog's area mode, and
 * the toolhead collision volume editor. The printable area itself uses the
 * full bed shape dialog (`dialogs.bedShape`).
 */
import { dialogRequest } from '../../ui/dialogRequest';

export interface ShapeRequest { title: string; points: string[]; allowEmpty: boolean }
/** Answers the new points, or null when cancelled. */
export const shapeRequest = dialogRequest<ShapeRequest, string[] | null>(null);

export interface VolumesRequest { title: string; value: string; printableHeight: number; bed: string[] }
/** Answers the new `bed_exclude_volumes`-style string, or null when cancelled. */
export const volumesRequest = dialogRequest<VolumesRequest, string | null>(null);

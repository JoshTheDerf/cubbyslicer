import type { GizmoOptions } from 'three-viewport-gizmo';
import {
  AXIS_CUBE_FACES, Z_UP_FACE_LABELS, viewCubeThemeOptions as sharedThemeOptions, type AxisCubeFace, type CubePalettes,
} from '@cubby/shared/camera';

/**
 * Colours + face labels for the view cube (`three-viewport-gizmo`, type
 * 'cube'), on @cubby/shared/camera's theme (shared with cad-project), with
 * the dark palette taken from our theme tokens (src/ui/theme.css) and the
 * faces labelled for the slicer's Z-up bed space.
 *
 * Bed convention (Orca / PrusaSlicer): +Z is up, the printer's front is -Y
 * (the "Front" view looks from -Y toward +Y), +X is right. The option keys
 * are the axis names (x = +X face, ny = -Y face, …).
 */
export const VIEW_CUBE_FACES = AXIS_CUBE_FACES;
export type ViewCubeFace = AxisCubeFace;
export { Z_UP_FACE_LABELS };

export const SLICER_CUBE_PALETTES: CubePalettes = {
  light: {
    body: '#e0e7ec', face: '#ffffff', label: '#222222', hoverFace: '#d6f5e7', hoverLabel: '#0a0a0a',
    handle: '#c9ced6', hoverHandle: '#19c37d',
  },
  // --bg-3 faces, --fg-0 labels, --accent-2 hover, --line-strong handles.
  dark: {
    body: '#15181d', face: '#252a33', label: '#e8eaed', hoverFace: '#13a86a', hoverLabel: '#ffffff',
    handle: '#3a414d', hoverHandle: '#19c37d',
  },
};

export function viewCubeThemeOptions(dark: boolean): GizmoOptions {
  return sharedThemeOptions(dark, { palette: SLICER_CUBE_PALETTES, up: 'z' });
}

import type { GizmoOptions } from 'three-viewport-gizmo';

/**
 * Colours + face labels for the view cube (`three-viewport-gizmo`, type
 * 'cube'). Ported from cad-project/src/core/viewport/viewCubeTheme.ts, with
 * the dark palette taken from our theme tokens (src/ui/theme.css) and the
 * labels fixed for the slicer's Z-up bed space.
 *
 * Bed convention (Orca / PrusaSlicer): +Z is up, the printer's front is -Y
 * (the "Front" view looks from -Y toward +Y), +X is right. The library's
 * built-in Z-up labels call +Y "Front", so every face label is set here.
 * The option keys are the axis names (x = +X face, ny = -Y face, …).
 */
export const VIEW_CUBE_FACES = ['x', 'nx', 'y', 'ny', 'z', 'nz'] as const;
export type ViewCubeFace = (typeof VIEW_CUBE_FACES)[number];

export const Z_UP_FACE_LABELS: Record<ViewCubeFace, string> = {
  x: 'Right', nx: 'Left', y: 'Back', ny: 'Front', z: 'Top', nz: 'Bottom',
};

interface CubePalette {
  /** The cube body showing between faces (library default is a light grey). */
  body: string;
  face: string;
  label: string;
  hoverFace: string;
  hoverLabel: string;
  handle: string;
  hoverHandle: string;
}

const LIGHT: CubePalette = {
  body: '#e0e7ec', face: '#ffffff', label: '#222222', hoverFace: '#d6f5e7', hoverLabel: '#0a0a0a',
  handle: '#c9ced6', hoverHandle: '#19c37d',
};
// --bg-3 faces, --fg-0 labels, --accent-2 hover, --line-strong handles.
const DARK: CubePalette = {
  body: '#15181d', face: '#252a33', label: '#e8eaed', hoverFace: '#13a86a', hoverLabel: '#ffffff',
  handle: '#3a414d', hoverHandle: '#19c37d',
};

export function viewCubeThemeOptions(dark: boolean): GizmoOptions {
  const p = dark ? DARK : LIGHT;
  const opts: GizmoOptions = {
    corners: { color: p.handle, hover: { color: p.hoverHandle } },
    edges: { color: p.handle, hover: { color: p.hoverHandle } },
    background: { color: p.body, hover: { color: p.body } },
  };
  for (const f of VIEW_CUBE_FACES) {
    opts[f] = {
      label: Z_UP_FACE_LABELS[f],
      color: p.face,
      labelColor: p.label,
      hover: { color: p.hoverFace, labelColor: p.hoverLabel },
    };
  }
  return opts;
}

/**
 * Orca-style view cube for the slicer's Z-up, render-on-demand viewports (the
 * Prepare view and the G-code preview): @cubby/shared/camera's ViewCube with
 * the slicer's palette, font and bed-space face labels. See the shared class
 * for the integration notes (render right after the main render, `update()`
 * on resize, `update({ rebuild: true })` after the container was hidden).
 */
import { ViewCube as SharedViewCube, type ViewCubeOptions as SharedViewCubeOptions } from '@cubby/shared/camera';
import { SLICER_CUBE_PALETTES } from './viewCubeTheme';

export type ViewCubeOptions = Omit<SharedViewCubeOptions, 'up' | 'palette'>;

export class ViewCube extends SharedViewCube {
  constructor(o: ViewCubeOptions) {
    super({
      ...o,
      up: 'z',
      palette: SLICER_CUBE_PALETTES,
      gizmo: { className: 'cs-viewcube', font: { family: 'Inter, system-ui, sans-serif', weight: 600 }, ...(o.gizmo ?? {}) },
    });
  }
}

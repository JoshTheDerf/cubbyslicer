/**
 * Attach the shared Orca-style view cube (src/viewport/viewCube.ts) to the
 * preview camera. The cube draws into a scissored corner of the preview's
 * own WebGLRenderer right after each scene render, and its hit area lives in
 * the canvas host (top-right).
 */
import { ViewCube } from '../viewport/viewCube';
import type { PreviewRenderer } from './render/PreviewRenderer';

export interface ViewCubeHandle { dispose(): void }

export function attachViewCube(r: PreviewRenderer, container: HTMLElement): ViewCubeHandle | null {
  let cube: ViewCube;
  try {
    cube = new ViewCube({
      renderer: r.renderer,
      camera: r.camera,
      controls: r.controls,
      container,
      requestRender: () => r.requestRender(),
      dark: document.documentElement.classList.contains('dark'),
    });
  } catch (e) {
    console.warn('[preview] view cube unavailable', e);
    return null;
  }
  const offRender = r.addAfterRender(() => cube.render());
  // The cube caches its viewport from DOM rects: re-measure on resize.
  const ro = new ResizeObserver(() => cube.update());
  ro.observe(container);
  return {
    dispose: () => { ro.disconnect(); offRender(); cube.dispose(); },
  };
}

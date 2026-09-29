/**
 * Orca-style view cube for a Z-up, render-on-demand three.js viewport.
 * Wraps `three-viewport-gizmo` (same package + version as cad-project).
 *
 * Usage (Prepare viewport, and reusable by the G-code preview):
 *
 *   const cube = new ViewCube({ renderer, camera, controls, container, requestRender });
 *   // after every main-scene render:
 *   cube.render();
 *   // on container resize / DPR change:
 *   cube.update();
 *   cube.setTheme(true);   // dark palette (default)
 *   cube.dispose();
 *
 * Integration notes
 *  - The gizmo draws into a scissored corner of the SAME renderer, so call
 *    `render()` right after the main `renderer.render()` (never on its own —
 *    the main render clears the canvas).
 *  - Face clicks animate the camera INSIDE the library; it only advances when
 *    `render()` runs. Its start/change/end events and pointer hover are
 *    bridged to `requestRender()` so an on-demand loop keeps pumping frames
 *    until the animation settles.
 *  - Z-up: the library derives its up axis from `Object3D.DEFAULT_UP` at
 *    construction and in its drag math. We swap DEFAULT_UP to +Z only while
 *    constructing (no global side effect for other scenes) and pin the drag
 *    coordinate conversion on the instance to Z-up.
 *  - Its viewport is cached from DOM rects; `update()` re-measures. After the
 *    container was display:none the cached state goes stale, so `rebuild()`
 *    (called by `update({ rebuild: true })`) recreates it, as cad-project does.
 */
import { Object3D, Vector3, type OrthographicCamera, type PerspectiveCamera, type WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ViewportGizmo, type GizmoOptions } from 'three-viewport-gizmo';
import { viewCubeThemeOptions } from './viewCubeTheme';

export interface ViewCubeOptions {
  renderer: WebGLRenderer;
  camera: PerspectiveCamera | OrthographicCamera;
  controls: OrbitControls;
  /** Positioned element the cube's hit area is appended to (usually the canvas's parent). */
  container: HTMLElement;
  /** Wake the host's on-demand render loop. */
  requestRender: () => void;
  /** Extra gizmo options (placement, size, offset…). */
  gizmo?: GizmoOptions;
  dark?: boolean;
}

const Z_UP = new Vector3(0, 0, 1);

/** Z-up variant of ViewportGizmo.coordinateConversion (spherical ↔ world). */
function zUpConversion(t: Vector3, toWorld = false): Vector3 {
  const { x, y, z } = t;
  return toWorld ? t.set(z, x, y) : t.set(y, z, x);
}

export class ViewCube {
  gizmo: ViewportGizmo;
  private dark: boolean;
  private disposed = false;
  private readonly bump = () => this.o.requestRender();
  private dom: HTMLElement | null = null;

  constructor(private readonly o: ViewCubeOptions) {
    this.dark = o.dark ?? true;
    this.gizmo = this.create();
  }

  private options(): GizmoOptions {
    return {
      type: 'cube',
      size: 96,
      placement: 'top-right',
      offset: { top: 12, right: 12 },
      className: 'cs-viewcube',
      font: { family: 'Inter, system-ui, sans-serif', weight: 600 },
      container: this.o.container,
      ...viewCubeThemeOptions(this.dark),
      ...(this.o.gizmo ?? {}),
    };
  }

  private create(): ViewportGizmo {
    const prev = Object3D.DEFAULT_UP.clone();
    Object3D.DEFAULT_UP.copy(Z_UP);
    let g: ViewportGizmo;
    try {
      g = new ViewportGizmo(this.o.camera, this.o.renderer, this.options());
    } finally {
      Object3D.DEFAULT_UP.copy(prev);
    }
    g.up.copy(Z_UP);
    (g as unknown as { coordinateConversion: typeof zUpConversion }).coordinateConversion = zUpConversion;
    g.attachControls(this.o.controls);
    g.addEventListener('start', this.bump);
    g.addEventListener('change', this.bump);
    g.addEventListener('end', this.bump);
    // Hover highlighting changes materials without a camera change.
    this.dom = (g as unknown as { _domElement?: HTMLElement })._domElement ?? null;
    this.dom?.addEventListener('pointermove', this.bump);
    this.dom?.addEventListener('pointerleave', this.bump);
    this.dom?.setAttribute('aria-label', 'View cube: click a face to look from that side, drag to orbit');
    this.dom?.setAttribute('role', 'img');
    return g;
  }

  private destroy(): void {
    this.dom?.removeEventListener('pointermove', this.bump);
    this.dom?.removeEventListener('pointerleave', this.bump);
    this.dom = null;
    try { this.gizmo.dispose(); } catch (e) { console.warn('[viewCube] dispose failed', e); }
  }

  /** True while a face-click animation is running (keep rendering). */
  get animating(): boolean { return this.gizmo.animating; }

  /** Draw the cube into its corner. Call right after the main scene render. */
  render(): void {
    if (this.disposed) return;
    this.gizmo.render();
    if (this.gizmo.animating) this.o.requestRender();
  }

  /** Re-measure after a resize / DPR change (`rebuild` after the container was hidden). */
  update(opts: { rebuild?: boolean } = {}): void {
    if (this.disposed) return;
    if (opts.rebuild) this.rebuild();
    else this.gizmo.update();
    this.o.requestRender();
  }

  rebuild(): void {
    if (this.disposed) return;
    this.destroy();
    this.gizmo = this.create();
  }

  /** Switch palette (options are constructor-only, so this rebuilds). */
  setTheme(dark: boolean): void {
    if (dark === this.dark) return;
    this.dark = dark;
    this.rebuild();
    this.o.requestRender();
  }

  setVisible(v: boolean): void {
    this.gizmo.enabled = v;
    if (this.dom) this.dom.style.display = v ? '' : 'none';
  }

  dispose(): void {
    if (this.disposed) return;
    this.destroy();
    this.disposed = true;
  }
}

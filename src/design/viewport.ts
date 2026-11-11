/**
 * The mounted Design viewport, for commands (actions, the bridge) that move its camera or take
 * a picture of it — the Design twin of src/viewport/controller.ts.
 */
import type { ViewPreset } from '../viewport/controller';

export interface DesignViewportHandle {
  fitAll(): void;
  fitSelection(): void;
  setView(p: ViewPreset): void;
  zoom(dir: 1 | -1): void;
  /** Where a design point (bed mm) is on screen, client px (overlays, e2e scripts). */
  screenPoint(p: readonly [number, number, number]): [number, number] | null;
  /** Sketch mode: look straight at the plane, framing the entities (null: leave, restore the camera). */
  sketchView?(plane: import('./kernel/types').PlaneFrame | null, entities: readonly import('./sketch/model').SkEntity[], around?: { min: readonly number[]; max: readonly number[] }): void;
  /** A PNG of the current view. */
  capture(width: number, height: number): Promise<Blob>;
}

let handle: DesignViewportHandle | null = null;
export function registerDesignViewport(h: DesignViewportHandle | null): void { handle = h; }
export function designViewport(): DesignViewportHandle | null { return handle; }

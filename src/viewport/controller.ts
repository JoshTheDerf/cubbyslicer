/**
 * Bridge between the shell (toolbar, shortcuts, menus) and the live
 * three.js scene: gizmo mode, lay-on-face mode, camera commands, projection
 * and grid snap.
 */
import { reactive } from 'vue';
import type { CameraType } from '@cubby/shared/camera';
import { SnapSetting } from '@cubby/shared/snap';
import { readString, writeString } from '../lib/storage';

/** 'all' is CubbyCAD's full edit gizmo (move, rotate and scale handles together), the default. */
export type GizmoMode = 'all' | 'translate' | 'rotate' | 'scale';
/** What a finished gizmo drag did. */
export type TransformKind = Exclude<GizmoMode, 'all'>;
export type ViewPreset = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';
export type { CameraType };

/** Grid snap for gizmo drags and arrow nudges (mm, 0 = off), persisted per browser. */
const snapSetting = new SnapSetting({ initial: 0, storageKey: 'cubby.slicer.snap' });
const CAMERA_KEY = 'cubby.slicer.camera';
const COM_KEY = 'cubby.slicer.center-of-mass';
const FOCUS_KEY = 'cubby.slicer.focus-mode';

function storedCameraType(): CameraType {
  return readString(CAMERA_KEY) === 'orthographic' ? 'orthographic' : 'perspective';
}

export const viewportState = reactive({
  gizmo: 'all' as GizmoMode,
  layOnFace: false,
  camera: storedCameraType(),
  snap: snapSetting.value,
  /** Orca View > "Show all collision volumes": every toolhead collision prism at full height. */
  showCollisionVolumes: false,
  /** Orca 2.5 canvas menu "X-Ray": Prepare draws models see-through (not saved, as desktop's Plater flag). */
  xray: false,
  /** Orca 2.5 canvas menu "Center of mass" (desktop's app config `show_center_of_mass`). */
  centerOfMass: readString(COM_KEY) === '1',
  /** Orca 2.5 canvas menu "Focus mode": only the current plate in Prepare (desktop's `focus_mode`, off by default). */
  focusMode: readString(FOCUS_KEY) === '1',
  /**
   * Orca 2.5 section view (GLCanvas3D::SectionView), shared by Prepare and Preview: `ratio` 0 = off,
   * up to 1 = everything cut away; `normal` faces the camera it was aimed from (null until first aimed).
   */
  section: { ratio: 0, lastRatio: 0, normal: null as [number, number, number] | null, panelOpen: false, aim: 0 },
});

export function toggleXray(on = !viewportState.xray): void { viewportState.xray = on; }
export function toggleCenterOfMass(on = !viewportState.centerOfMass): void { viewportState.centerOfMass = on; writeString(COM_KEY, on ? '1' : '0'); }
export function toggleFocusMode(on = !viewportState.focusMode): void {
  viewportState.focusMode = on;
  writeString(FOCUS_KEY, on ? '1' : '0');
  // Desktop zooms to the current plate when focus mode turns on.
  if (on) fitBed();
}

/** GLCanvas3D::set_section_view_ratio: clamped to 0..1; the first cut faces the camera. */
export function setSectionRatio(ratio: number): void {
  const s = viewportState.section;
  ratio = Math.min(1, Math.max(0, Math.round(ratio * 1e4) / 1e4));
  if (ratio === s.ratio) return;
  if (ratio === 0) s.lastRatio = s.ratio;
  s.ratio = ratio;
  if (!s.normal) alignSectionToCamera();
}
/** GLCanvas3D::toggle_section_view: off, or back to the last cut (0.5 the first time). */
export function toggleSection(): void {
  const s = viewportState.section;
  setSectionRatio(s.ratio > 0 ? 0 : s.lastRatio > 0 ? s.lastRatio : 0.5);
}
/** "Set viewing angle": the plane faces the camera (the scene reads `aim` and writes `normal`). */
export function alignSectionToCamera(): void { viewportState.section.aim++; }

export function toggleCollisionVolumes(on = !viewportState.showCollisionVolumes): void { viewportState.showCollisionVolumes = on; }

export interface ViewportHandle {
  setView(p: ViewPreset): void;
  fitSelection(): void;
  fitBed(): void;
  zoom(dir: 1 | -1): void;
  /** PNG of the Prepare view (see PrepareScene.capture). */
  capture?(opts: CaptureOptions): Promise<Blob>;
}

export interface CaptureOptions { width: number; height: number; view?: ViewPreset; fit?: 'selection' | 'objects' | 'plate' }

let handle: ViewportHandle | null = null;
export function registerViewport(h: ViewportHandle | null): void { handle = h; }

export function setView(p: ViewPreset): void { handle?.setView(p); }
export function fitSelection(): void { handle?.fitSelection(); }
export function fitBed(): void { handle?.fitBed(); }
export function zoomView(dir: 1 | -1): void { handle?.zoom(dir); }
/** Screenshot of the Prepare view; null while no viewport is mounted. */
export function captureViewport(opts: CaptureOptions): Promise<Blob> | null { return handle?.capture?.(opts) ?? null; }

/** Pick a gizmo mode; picking the active single mode again returns to the full gizmo. */
export function setGizmo(m: GizmoMode): void {
  viewportState.gizmo = m !== 'all' && viewportState.gizmo === m ? 'all' : m;
  viewportState.layOnFace = false;
}
export function toggleLayOnFace(on = !viewportState.layOnFace): void { viewportState.layOnFace = on; }

/** Perspective / orthographic projection of the Prepare view (the scene watches it). */
export function setCameraType(t: CameraType): void {
  viewportState.camera = t;
  writeString(CAMERA_KEY, t);
}
export function toggleCameraType(): void { setCameraType(viewportState.camera === 'perspective' ? 'orthographic' : 'perspective'); }

export function setSnapIncrement(v: number): void {
  snapSetting.set(v);
  viewportState.snap = snapSetting.value;
}

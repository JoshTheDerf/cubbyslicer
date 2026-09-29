/**
 * Bridge between the shell (toolbar, shortcuts, menus) and the live
 * three.js scene: gizmo mode, lay-on-face mode, camera commands, projection
 * and grid snap.
 */
import { reactive } from 'vue';
import type { CameraType } from '@cubby/shared/camera';
import { SnapSetting } from '@cubby/shared/snap';

/** 'all' is CubbyCAD's full edit gizmo (move, rotate and scale handles together), the default. */
export type GizmoMode = 'all' | 'translate' | 'rotate' | 'scale';
/** What a finished gizmo drag did. */
export type TransformKind = Exclude<GizmoMode, 'all'>;
export type ViewPreset = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';
export type { CameraType };

/** Grid snap for gizmo drags and arrow nudges (mm, 0 = off), persisted per browser. */
const snapSetting = new SnapSetting({ initial: 0, storageKey: 'cubby.slicer.snap' });
const CAMERA_KEY = 'cubby.slicer.camera';

function storedCameraType(): CameraType {
  try { return localStorage.getItem(CAMERA_KEY) === 'orthographic' ? 'orthographic' : 'perspective'; } catch { return 'perspective'; }
}

export const viewportState = reactive({
  gizmo: 'all' as GizmoMode,
  layOnFace: false,
  camera: storedCameraType(),
  snap: snapSetting.value,
});

export interface ViewportHandle {
  setView(p: ViewPreset): void;
  fitSelection(): void;
  fitBed(): void;
  zoom(dir: 1 | -1): void;
}

let handle: ViewportHandle | null = null;
export function registerViewport(h: ViewportHandle | null): void { handle = h; }

export function setView(p: ViewPreset): void { handle?.setView(p); }
export function fitSelection(): void { handle?.fitSelection(); }
export function fitBed(): void { handle?.fitBed(); }
export function zoomView(dir: 1 | -1): void { handle?.zoom(dir); }

/** Pick a gizmo mode; picking the active single mode again returns to the full gizmo. */
export function setGizmo(m: GizmoMode): void {
  viewportState.gizmo = m !== 'all' && viewportState.gizmo === m ? 'all' : m;
  viewportState.layOnFace = false;
}
export function toggleLayOnFace(on = !viewportState.layOnFace): void { viewportState.layOnFace = on; }

/** Perspective / orthographic projection of the Prepare view (the scene watches it). */
export function setCameraType(t: CameraType): void {
  viewportState.camera = t;
  try { localStorage.setItem(CAMERA_KEY, t); } catch { /* not persisted */ }
}
export function toggleCameraType(): void { setCameraType(viewportState.camera === 'perspective' ? 'orthographic' : 'perspective'); }

export function setSnapIncrement(v: number): void {
  snapSetting.set(v);
  viewportState.snap = snapSetting.value;
}

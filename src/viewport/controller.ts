/**
 * Bridge between the shell (toolbar, shortcuts, menus) and the live
 * three.js scene: gizmo mode, lay-on-face mode, camera commands.
 */
import { reactive } from 'vue';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type ViewPreset = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

export const viewportState = reactive({
  gizmo: 'translate' as GizmoMode,
  layOnFace: false,
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

export function setGizmo(m: GizmoMode): void { viewportState.gizmo = m; viewportState.layOnFace = false; }
export function toggleLayOnFace(on = !viewportState.layOnFace): void { viewportState.layOnFace = on; }

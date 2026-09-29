/**
 * Camera preferences (Orca Preferences → Camera) applied to an OrbitControls
 * instance: zoom to mouse position, reverse mouse zoom, orbit speed, swapped
 * pan / rotate buttons and orbiting around the point under the cursor.
 * Used by the Prepare viewport and the G-code preview.
 */
import { MOUSE, Plane, Raycaster, Vector2, Vector3, type Camera, type Object3D } from 'three';
import { setPickRayFromCamera } from '@cubby/shared/gizmo';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { watch } from 'vue';
import { preferences } from '../app/preferences';

export interface CameraPrefsTarget {
  controls: OrbitControls;
  /** The camera, or a getter for a view that switches projection. */
  camera: Camera | (() => Camera);
  /** Element receiving pointer events (the canvas' container). */
  host: HTMLElement;
  /** Objects to pick the orbit centre on (falls back to the bed plane z = 0). */
  pickRoots?: () => Object3D[];
  requestRender?: () => void;
}

/** Apply the preferences now and whenever they change. Returns a disposer. */
export function bindCameraPrefs(t: CameraPrefsTarget): () => void {
  const c = t.controls;
  const base = { ...c.mouseButtons };
  const baseRotate = c.rotateSpeed;
  const apply = () => {
    c.zoomToCursor = preferences.zoomToCursor;
    // OrbitControls scales by 0.95^(zoomSpeed·|Δ|): a negative speed flips the wheel direction.
    c.zoomSpeed = preferences.reverseZoom ? -1 : 1;
    c.rotateSpeed = baseRotate * preferences.orbitSpeed;
    const swap = (b: MOUSE | null | undefined) => (b === MOUSE.PAN ? MOUSE.ROTATE : b === MOUSE.ROTATE ? MOUSE.PAN : b);
    c.mouseButtons = preferences.swapPanRotate
      ? { LEFT: swap(base.LEFT) as MOUSE, MIDDLE: swap(base.MIDDLE) as MOUSE, RIGHT: swap(base.RIGHT) as MOUSE }
      : { ...base };
  };
  apply();
  const stop = watch(() => [preferences.zoomToCursor, preferences.reverseZoom, preferences.orbitSpeed, preferences.swapPanRotate], apply);

  // ---- orbit around the cursor point -----------------------------------------------------
  const ray = new Raycaster();
  let drag: { id: number; x: number; y: number; pivot: Vector3 } | null = null;
  const camera = () => (typeof t.camera === 'function' ? t.camera() : t.camera);
  const buttonFor = (b: number): MOUSE | null | undefined => (b === 0 ? c.mouseButtons.LEFT : b === 1 ? c.mouseButtons.MIDDLE : b === 2 ? c.mouseButtons.RIGHT : null);

  function pivotAt(x: number, y: number): Vector3 {
    const r = t.host.getBoundingClientRect();
    setPickRayFromCamera(ray, new Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera());
    const roots = t.pickRoots?.() ?? [];
    const hit = ray.intersectObjects(roots, true).find((h) => h.object.visible && (h.object as { isMesh?: boolean }).isMesh);
    if (hit) return hit.point.clone();
    const p = ray.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), 0), new Vector3());
    return p ?? c.target.clone();
  }

  const onDown = (e: PointerEvent) => {
    if (!preferences.orbitAroundCursor || e.pointerType === 'touch' || !c.enabled || !c.enableRotate) return;
    if (!(e.target instanceof HTMLCanvasElement) || buttonFor(e.button) !== MOUSE.ROTATE) return;
    // Take over this drag: OrbitControls (on the canvas, below us) never sees it.
    e.stopPropagation();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pivot: pivotAt(e.clientX, e.clientY) };
  };
  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const r = t.host.getBoundingClientRect();
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    const k = (2 * Math.PI * c.rotateSpeed) / Math.max(1, r.height);
    rotateAbout(camera(), c.target, drag.pivot, -dx * k, dy * k);
    c.update();
    t.requestRender?.();
  };
  const onUp = (e: PointerEvent) => { if (drag && e.pointerId === drag.id) drag = null; };
  t.host.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  return () => {
    stop();
    t.host.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
}

/**
 * Rotate the camera and its orbit target together about `pivot`: `azimuth`
 * around world +Z, `elevation` > 0 raises the camera (towards a top view; kept
 * away from the poles), so the view turns without jumping.
 */
export function rotateAbout(camera: Camera, target: Vector3, pivot: Vector3, azimuth: number, elevation: number): void {
  const up = new Vector3(0, 0, 1);
  const pos = camera.position.clone().sub(pivot);
  const tgt = target.clone().sub(pivot);
  const fwd = target.clone().sub(camera.position).normalize();
  const right = new Vector3().crossVectors(fwd, up);
  if (right.lengthSq() < 1e-10) right.set(1, 0, 0); else right.normalize();
  // Clamp the elevation so the view direction doesn't flip over the pole.
  const polar = Math.acos(Math.min(1, Math.max(-1, -fwd.dot(up))));
  const minPolar = 0.02, maxPolar = Math.PI - 0.02;
  const next = Math.min(maxPolar, Math.max(minPolar, polar - elevation));
  const e = polar - next;
  pos.applyAxisAngle(right, -e); tgt.applyAxisAngle(right, -e);
  pos.applyAxisAngle(up, azimuth); tgt.applyAxisAngle(up, azimuth);
  camera.position.copy(pos.add(pivot));
  target.copy(tgt.add(pivot));
  camera.up.copy(up);
  camera.lookAt(target);
}

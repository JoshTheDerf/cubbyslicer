/**
 * "Adjust placement" (desktop GLGizmoTextureDisplacement Adjust Texture
 * mode, render_adjust_texture_gizmo / on_mouse_adjust_texture): instead of
 * painting, a handle on the model slides the active layer's texture by
 * changing its `offset`. The handle is a square lying in the painted patch's
 * tangent plane (drag anywhere on it: both axes) with two arrows along the
 * texture's U / V axes (drag one: that axis only), anchored at the patch's
 * centroid (compute_layer_paint_anchor). A drag of `delta` mm in the plane
 * sets offset = start − R(delta / tile size) (v scaled by the image aspect),
 * so the handle follows the cursor and sits on the anchor at offset 0.
 * Desktop measures in the part's own frame; this measures in the texture
 * frame the bake projects in (world millimetres), which is the same for an
 * unrotated, unscaled part and is what the texture follows otherwise.
 */
import { BufferGeometry, DoubleSide, Float32BufferAttribute, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, Plane, Vector2, Vector3 } from 'three';
import type { TextureLayer } from '../project/types';
import { ToolOverlay, render } from '../tools/overlay';
import { installHandler, toolScene } from '../tools/state';
import type { ToolHandler, ToolPointerEvent } from '../viewport/scene';
import { num } from './model';
import { offsetOf } from './fastView';

/** box_projection_axes: the texture's U / V directions on the plane the normal is closest to. */
export function boxAxes(n: Vector3): { u: Vector3; v: Vector3 } {
  const sgn = (x: number) => (x >= 0 ? 1 : -1);
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  if (ax >= ay && ax >= az) return { u: new Vector3(0, sgn(n.x), 0), v: new Vector3(0, 0, -1) };
  if (ay >= ax && ay >= az) return { u: new Vector3(-sgn(n.y), 0, 0), v: new Vector3(0, 0, -1) };
  return { u: new Vector3(sgn(n.z), 0, 0), v: new Vector3(0, -1, 0) };
}

/** project_planar: a point's (u, v) millimetres on the plane the normal is closest to. */
export function projectPlanar(p: Vector3, n: Vector3): Vector2 {
  const { u, v } = boxAxes(n);
  return new Vector2(p.dot(u), p.dot(v));
}

export interface Anchor { point: Vector3; normal: Vector3; size: number }

/**
 * compute_layer_paint_anchor on the painted facets (world): the mean of the
 * triangle centroids and the area-weighted normal (+Z when they cancel out).
 * `size`: the part's bounding-box diagonal, which scales the handle.
 */
export function paintAnchor(positions: Float32Array, indices: Uint32Array, toWorld: Matrix4, size: number): Anchor | null {
  if (!indices.length) return null;
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), ab = new Vector3(), ac = new Vector3();
  const sum = new Vector3(), nsum = new Vector3();
  const at = (i: number, out: Vector3) => out.fromArray(positions, i * 3).applyMatrix4(toWorld);
  for (let t = 0; t < indices.length; t += 3) {
    at(indices[t], a); at(indices[t + 1], b); at(indices[t + 2], c);
    nsum.add(ab.subVectors(b, a).cross(ac.subVectors(c, a)));
    sum.add(a).add(b).add(c);
  }
  const point = sum.multiplyScalar(1 / indices.length);
  const normal = nsum.lengthSq() > 1e-16 ? nsum.normalize() : new Vector3(0, 0, 1);
  return { point, normal, size };
}

/** Desktop's handle sizes: the drag plane sits clear of the surface; the square and arrows scale with the part. */
export function handleSizes(size: number): { lift: number; half: number; arrow: number } {
  const half = size * 0.04 + 1;
  return { lift: size * 0.01 + 0.2, half, arrow: half * 2.2 };
}

/** adjust_handle_center: where the handle sits for the layer's offset (back on the anchor at offset 0). */
export function handleCenter(anchor: Anchor, offset: readonly [number, number], tiling: number, rotationDeg: number, aspect: number): Vector3 {
  const r = (rotationDeg * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
  const ox = offset[0], oy = aspect > 0 ? offset[1] / aspect : offset[1];
  const ux = ox * cs + oy * sn, uy = -ox * sn + oy * cs;
  const { u, v } = boxAxes(anchor.normal);
  return planePoint(anchor).addScaledVector(u, -ux * tiling).addScaledVector(v, -uy * tiling);
}

export function planePoint(anchor: Anchor): Vector3 {
  return anchor.point.clone().addScaledVector(anchor.normal, handleSizes(anchor.size).lift);
}

/** on_mouse_adjust_texture: the offset after dragging `delta` (planar mm) from `start`. */
export function draggedOffset(start: readonly [number, number], delta: Vector2, tiling: number, rotationDeg: number, aspect: number,
                              axis: 'pan' | 'u' | 'v'): [number, number] {
  const dx = axis === 'v' ? 0 : delta.x, dy = axis === 'u' ? 0 : delta.y;
  const s = tiling > 1e-6 ? 1 / tiling : 1;
  const r = (rotationDeg * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
  const rx = dx * s * cs - dy * s * sn;
  const ry = (dx * s * sn + dy * s * cs) * aspect;
  return [start[0] - rx, start[1] - ry];
}

type Handle = 'pan' | 'u' | 'v';

/** The on-canvas handle; `onOffset` writes the dragged offset (`final` on release). */
export class PlacementHandle {
  private overlay = new ToolOverlay('texture-placement');
  private anchor: Anchor | null = null;
  private layer: TextureLayer | null = null;
  private aspect = 1;
  private drag: { handle: Handle; start: [number, number]; from: Vector2 } | null = null;
  private enabled = false;

  constructor(private readonly onOffset: (offset: [number, number], final: boolean) => void) {}

  get dragging(): boolean { return !!this.drag; }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    installHandler(on ? this.handler : null);
    if (!on) { this.drag = null; this.overlay.clear(); render(); }
  }

  /** The anchor (from the active layer's paint) and the layer the handle drives; redraws. */
  update(anchor: Anchor | null, layer: TextureLayer | null, aspect: number): void {
    this.anchor = anchor;
    this.layer = layer;
    this.aspect = aspect > 0 ? aspect : 1;
    this.draw();
  }

  dispose(): void {
    this.setEnabled(false);
    this.overlay.dispose();
  }

  private params() {
    const l = this.layer!;
    return { tiling: num(l.json, 'tiling_scale', 12.5), rot: num(l.json, 'rotation_deg', 0), offset: offsetOf(l) };
  }

  private geometry(): { center: Vector3; u: Vector3; v: Vector3; half: number; arrow: number } | null {
    if (!this.anchor || !this.layer) return null;
    const p = this.params();
    const { u, v } = boxAxes(this.anchor.normal);
    const { half, arrow } = handleSizes(this.anchor.size);
    return { center: handleCenter(this.anchor, p.offset, p.tiling, p.rot, this.aspect), u, v, half, arrow };
  }

  private draw(): void {
    this.overlay.attach();
    this.overlay.clear();
    const g = this.enabled ? this.geometry() : null;
    if (!g) { render(); return; }
    const active = this.drag?.handle;
    const corner = (su: number, sv: number) => g.center.clone().addScaledVector(g.u, su * g.half).addScaledVector(g.v, sv * g.half);
    const quad = new BufferGeometry();
    const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    quad.setAttribute('position', new Float32BufferAttribute([q[0], q[1], q[2], q[0], q[2], q[3]].flatMap((p) => p.toArray()), 3));
    const square = new Mesh(quad, new MeshBasicMaterial({ color: active === 'pan' ? 0xffd400 : 0xff8a00, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false, side: DoubleSide }));
    square.renderOrder = 40;
    this.overlay.add(square);
    for (const [axis, other, h] of [[g.u, g.v, 'u'], [g.v, g.u, 'v']] as const) {
      const tip = g.center.clone().addScaledVector(axis, g.arrow);
      const head = (s: number) => g.center.clone().addScaledVector(axis, g.arrow * 0.82).addScaledVector(other, s * g.arrow * 0.08);
      const pts = [g.center, tip, tip, head(1), tip, head(-1)];
      const lg = new BufferGeometry();
      lg.setAttribute('position', new Float32BufferAttribute(pts.flatMap((p) => p.toArray()), 3));
      const line = new LineSegments(lg, new LineBasicMaterial({ color: active === h ? 0xffd400 : 0xff8a00, depthTest: false, depthWrite: false, transparent: true }));
      line.renderOrder = 41;
      this.overlay.add(line);
    }
    render();
  }

  private screen(p: Vector3): Vector2 | null {
    const sc = toolScene.value;
    if (!sc) return null;
    const r = sc.renderer.domElement.getBoundingClientRect();
    const v = p.clone().project(sc.camera);
    return new Vector2(r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height);
  }

  private planeHit(e: ToolPointerEvent): Vector2 | null {
    if (!this.anchor) return null;
    const pp = planePoint(this.anchor);
    const hit = e.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(this.anchor.normal, pp), new Vector3());
    return hit ? projectPlanar(hit, this.anchor.normal) : null;
  }

  /** Which part of the handle is under the pointer (arrows first, within 8 px; then the square). */
  pick(clientX: number, clientY: number): Handle | null {
    const g = this.geometry();
    if (!g) return null;
    const c = this.screen(g.center), ut = this.screen(g.center.clone().addScaledVector(g.u, g.arrow)), vt = this.screen(g.center.clone().addScaledVector(g.v, g.arrow));
    const corner = this.screen(g.center.clone().addScaledVector(g.u, g.half).addScaledVector(g.v, g.half));
    if (!c || !ut || !vt || !corner) return null;
    const m = new Vector2(clientX, clientY);
    const seg = (a: Vector2, b: Vector2) => {
      const ab = b.clone().sub(a), l2 = ab.lengthSq();
      const t = l2 > 1e-9 ? Math.min(1, Math.max(0, m.clone().sub(a).dot(ab) / l2)) : 0;
      return m.distanceTo(a.clone().addScaledVector(ab, t));
    };
    const du = seg(c, ut), dv = seg(c, vt);
    if (du <= 8 && du <= dv) return 'u';
    if (dv <= 8) return 'v';
    return m.distanceTo(c) <= corner.distanceTo(c) ? 'pan' : null;
  }

  readonly handler: ToolHandler = {
    strokes: true,
    hideGizmo: true,
    cursor: 'move',
    onPointer: (e) => {
      if (e.kind === 'down') {
        if ((e.button ?? 0) !== 0 || !this.layer) return false;
        const h = this.pick(e.clientX, e.clientY);
        if (!h) return false; // off the handle: the camera orbits
        const from = this.planeHit(e);
        if (!from) return false;
        this.drag = { handle: h, start: offsetOf(this.layer), from };
        this.draw();
        return true;
      }
      if (e.kind === 'drag' && this.drag && this.layer) {
        const cur = this.planeHit(e);
        if (!cur) return true;
        const p = this.params();
        this.onOffset(draggedOffset(this.drag.start, cur.clone().sub(this.drag.from), p.tiling, p.rot, this.aspect, this.drag.handle), false);
        return true;
      }
      if (e.kind === 'up') {
        const was = !!this.drag;
        this.drag = null;
        if (was && this.layer) this.onOffset(offsetOf(this.layer), true);
        this.draw();
        return was;
      }
      return e.kind === 'click' && !!this.pick(e.clientX, e.clientY);
    },
  };
}

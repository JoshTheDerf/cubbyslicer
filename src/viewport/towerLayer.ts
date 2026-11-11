/**
 * The prime tower drawn in Prepare (desktop GLVolumeCollection::load_wipe_tower_preview):
 * the estimated body split into one slab per plate filament along Y, in the
 * filaments' colours at 66 % opacity, on a one-layer brim slab that follows the
 * first-layer outline (a Type2 cone base bulges past the body box). Rotated by
 * wipe_tower_rotation_angle about the anchor. Hover highlights it; a left drag
 * (or one finger) moves it on the bed, clamped as desktop's Selection::translate
 * does (WipeTower::move_box_inside_polygon, WIPE_TOWER_MARGIN).
 */
import {
  BoxGeometry, Color, EdgesGeometry, ExtrudeGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial,
  Shape, Vector2, type Ray, Plane, Vector3,
} from 'three';
import type { TowerView } from '../app/towerPreview';
import { boundsOf, moveBoxInsidePolygon, offsetConvex, translatePoly, WIPE_TOWER_MARGIN, type P2 } from '../app/wipeTowerPlace';
import { toThreeColor } from '../lib/colour';
import type { ViewportTheme } from './tokens';

/** One layer, visual only (desktop's brim_height). */
const BRIM_HEIGHT = 0.2;

interface TowerEntry { view: TowerView; group: Group; offset: [number, number]; meshes: Mesh[]; edges: LineSegments }

export interface TowerDrag { plate: number; start: Vector3; x0: number; y0: number; x: number; y: number; moved: boolean }

export class TowerLayer {
  readonly group = new Group();
  private entries: TowerEntry[] = [];
  private hovered: number | null = null;
  private dragging: TowerDrag | null = null;
  private key = '';

  private only: number | null = null;

  /** `decorate`: per-material setup the scene needs (the section view's clipping plane). */
  constructor(private theme: ViewportTheme, private decorate: (m: MeshStandardMaterial) => void = () => {}) {
    this.group.name = 'prime-towers';
  }

  /** Focus mode: only this plate's tower (null: all). */
  setOnly(plate: number | null): void {
    this.only = plate;
    for (const e of this.entries) e.group.visible = plate === null || e.view.plate === plate;
  }

  /** Towers to draw; `offsets[plate]` = the plate's world offset. */
  set(views: readonly TowerView[], offsets: (plate: number) => [number, number]): void {
    const key = JSON.stringify(views.map((v) => [v, offsets(v.plate)]));
    if (key === this.key) return;
    this.key = key;
    if (this.dragging && !views.some((v) => v.plate === this.dragging!.plate)) this.dragging = null;
    this.clear();
    for (const v of views) this.entries.push(this.build(v, offsets(v.plate)));
    this.setOnly(this.only);
    this.restyle();
  }

  get count(): number { return this.entries.length; }

  private build(v: TowerView, offset: [number, number]): TowerEntry {
    const g = new Group();
    g.name = `prime-tower-${v.plate}`;
    g.userData.towerPlate = v.plate;
    const meshes: Mesh[] = [];
    const colours = v.colours.length ? v.colours : ['#888888'];
    const n = colours.length;
    for (let i = 0; i < n; i++) {
      const geo = new BoxGeometry(v.width, v.depth / n, v.height);
      geo.translate(v.width / 2, (v.depth * (i + 0.5)) / n, v.height / 2);
      const m = new Mesh(geo, this.material(colours[i]));
      m.userData.towerPlate = v.plate;
      m.renderOrder = 2;
      meshes.push(m);
      g.add(m);
    }
    if (v.brim > 0) {
      const outline: P2[] = v.outline.length >= 3 ? v.outline : [[0, 0], [v.width, 0], [v.width, v.depth], [0, v.depth]];
      const ring = offsetConvex(outline, v.brim);
      const shape = new Shape(ring.map(([x, y]) => new Vector2(x, y)));
      const geo = new ExtrudeGeometry(shape, { depth: BRIM_HEIGHT, bevelEnabled: false });
      const m = new Mesh(geo, this.material(colours[0]));
      m.userData.towerPlate = v.plate;
      meshes.push(m);
      g.add(m);
    }
    const body = new BoxGeometry(v.width, v.depth, v.height);
    body.translate(v.width / 2, v.depth / 2, v.height / 2);
    const edges = new LineSegments(new EdgesGeometry(body), new LineBasicMaterial({ color: this.theme.bedEdge, transparent: true, opacity: 0.8 }));
    body.dispose();
    g.add(edges);
    g.position.set(offset[0] + v.x, offset[1] + v.y, 0);
    g.rotation.z = (v.rotation * Math.PI) / 180;
    this.group.add(g);
    return { view: v, group: g, offset, meshes, edges };
  }

  private clear(): void {
    for (const e of this.entries) {
      for (const m of e.meshes) { m.geometry.dispose(); (m.material as MeshStandardMaterial).dispose(); }
      e.edges.geometry.dispose();
      (e.edges.material as LineBasicMaterial).dispose();
      this.group.remove(e.group);
    }
    this.entries = [];
  }

  dispose(): void { this.clear(); }

  /** Desktop: the filament colours at 66 % opacity. */
  private material(css: string): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ color: toThreeColor(css), transparent: true, opacity: 0.66, roughness: 0.7, metalness: 0, depthWrite: false });
    this.decorate(m);
    return m;
  }

  /** The tower plate under the ray and its distance, or null. */
  hit(ray: Ray): { plate: number; distance: number } | null {
    let best: { plate: number; distance: number } | null = null;
    const p = new Vector3();
    for (const e of this.entries) {
      if (!e.group.visible) continue;
      e.group.updateMatrixWorld();
      for (const m of e.meshes) {
        m.geometry.computeBoundingBox();
        const box = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
        if (!ray.intersectBox(box, p)) continue;
        const d = p.distanceTo(ray.origin);
        if (!best || d < best.distance) best = { plate: e.view.plate, distance: d };
      }
    }
    return best;
  }

  setHover(plate: number | null): boolean {
    if (this.hovered === plate) return false;
    this.hovered = plate;
    this.restyle();
    return true;
  }

  private restyle(): void {
    for (const e of this.entries) {
      const hot = this.hovered === e.view.plate || this.dragging?.plate === e.view.plate;
      for (const m of e.meshes) (m.material as MeshStandardMaterial).emissive.copy(hot ? this.theme.hover : BLACK).multiplyScalar(hot ? 0.35 : 1);
      (e.edges.material as LineBasicMaterial).color.copy(hot ? this.theme.hover : this.theme.bedEdge);
    }
  }

  // ---- drag ---------------------------------------------------------------

  beginDrag(plate: number, ray: Ray): boolean {
    const e = this.entries.find((x) => x.view.plate === plate);
    const start = ray.intersectPlane(BED, new Vector3());
    if (!e || !start) return false;
    this.dragging = { plate, start, x0: e.view.x, y0: e.view.y, x: e.view.x, y: e.view.y, moved: false };
    this.restyle();
    return true;
  }

  get drag(): TowerDrag | null { return this.dragging; }

  /** Follow the pointer; the anchor stays where the footprint fits the printable area. */
  dragTo(ray: Ray): void {
    const d = this.dragging;
    const e = d && this.entries.find((x) => x.view.plate === d.plate);
    const p = ray.intersectPlane(BED, new Vector3());
    if (!d || !e || !p) return;
    let x = d.x0 + p.x - d.start.x, y = d.y0 + p.y - d.start.y;
    const fp = e.view.footprint.length >= 3 ? e.view.footprint : [[0, 0], [e.view.width, 0], [e.view.width, e.view.depth], [0, e.view.depth]] as P2[];
    const shift = moveBoxInsidePolygon(boundsOf(translatePoly(fp, x, y)), e.view.printableArea, WIPE_TOWER_MARGIN);
    x += shift[0]; y += shift[1];
    d.x = x; d.y = y;
    d.moved ||= Math.hypot(x - d.x0, y - d.y0) > 1e-3;
    e.group.position.set(e.offset[0] + x, e.offset[1] + y, 0);
  }

  /** A cancelled gesture: put the tower back. */
  cancelDrag(): void {
    const d = this.dragging;
    const e = d && this.entries.find((x) => x.view.plate === d.plate);
    if (e) e.group.position.set(e.offset[0] + d!.x0, e.offset[1] + d!.y0, 0);
    this.dragging = null;
    this.restyle();
  }

  /** End the drag; the final anchor when it moved. */
  endDrag(): TowerDrag | null {
    const d = this.dragging;
    this.dragging = null;
    this.restyle();
    return d;
  }
}

const BED = new Plane(new Vector3(0, 0, 1), 0);

const BLACK = new Color(0, 0, 0);



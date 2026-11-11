/**
 * The Prepare scene's plates: one bed per plate in Orca's grid (see
 * project/plates.ts), the active one drawn normally and the others dimmed,
 * the vendor bed model / texture, the toolhead collision volumes and the
 * per-plate overlays (IDEX/IQEX zones, belt marks).
 */
import { Box3, Group, Vector3, type Mesh, type MeshStandardMaterial, type Scene } from 'three';
import type { BedShape } from '../app/state';
import type { BedAssets } from '../presets/types';
import { plateBed } from '../project/plates';
import { buildBed, buildBedExtras, disposeObject3D, plateLabelSprite } from './bed';
import { loadBedMesh, loadBedTexture } from './bedAssets';
import { buildCollisionVolumes, footprintBounds, type CollisionVolume } from './collisionVolumes';
import type { ViewportTheme } from './tokens';

/** World-space XY boxes + top Z of the printable objects (to size collision prisms). */
export type ObjectBoxes = ReadonlyArray<Box3>;

export class PlateLayer {
  bed: BedShape | null = null;
  count = 1;
  active = 0;
  /** Orca 2.5 focus mode: the other plates are hidden, not dimmed. */
  focus = false;
  private group: Group | null = null;
  private assets: BedAssets | null = null;
  private assetsToken = 0;
  private volumes: CollisionVolume[] = [];
  private showAllVolumes = false;
  private volumesKey = '';
  private disposed = false;

  constructor(private scene: Scene, private theme: ViewportTheme, private requestRender: () => void) {}

  /** Lay out `count` plates; returns true the first time a bed is set. */
  set(bed: BedShape, count: number, active: number): boolean {
    const first = !this.bed;
    const same = this.bed === bed && count === this.count;
    this.bed = bed;
    this.count = Math.max(1, count);
    this.active = Math.min(Math.max(0, active), this.count - 1);
    if (!same || !this.group) {
      if (this.group) { this.scene.remove(this.group); disposeObject3D(this.group); }
      const g = new Group();
      g.name = 'plates';
      for (let i = 0; i < this.count; i++) {
        const pb = plateBed(bed, i, this.count);
        const pg = buildBed(pb, this.theme);
        pg.userData.plate = i;
        if (this.count > 1) pg.add(plateLabelSprite(pb, i, this.theme));
        g.add(pg);
      }
      this.group = g;
      this.scene.add(g);
      this.volumesKey = '';
      for (const name of this.overlays.keys()) this.applyOverlay(name);
      void this.refreshExtras();
    }
    this.styleActive();
    this.requestRender();
    return first;
  }

  /** The active plate's bed as a box (height capped for framing). */
  activeBox(): Box3 {
    const b = this.bed ? plateBed(this.bed, this.active, this.count) : null;
    if (!b) return new Box3(new Vector3(0, 0, 0), new Vector3(220, 220, 0));
    return new Box3(new Vector3(b.min[0], b.min[1], 0), new Vector3(b.max[0], b.max[1], Math.min(b.maxHeight || 0, 40)));
  }

  /** Dim every plate but the active one (materials are per plate group). */
  styleActive(): void {
    this.group?.children.forEach((pg) => {
      const on = pg.userData.plate === this.active || this.count === 1;
      pg.visible = on || !this.focus;
      pg.traverse((o) => {
        const mat = (o as Mesh).material as MeshStandardMaterial | undefined;
        if (!mat || Array.isArray(mat)) return;
        const base = (mat.userData.base ??= { opacity: mat.opacity, transparent: mat.transparent }) as { opacity: number; transparent: boolean };
        const transparent = on ? base.transparent : true;
        const opacity = on ? base.opacity : base.opacity * 0.4;
        if (mat.transparent !== transparent || mat.opacity !== opacity) {
          mat.transparent = transparent; mat.opacity = opacity; mat.needsUpdate = true;
        }
      });
    });
  }

  /** The printer model's bed mesh / texture (lazy; see bedAssets.ts). null = generic plate only. */
  setAssets(assets: BedAssets | null): void {
    if (assets?.model === this.assets?.model && assets?.texture === this.assets?.texture) return;
    this.assets = assets;
    void this.refreshExtras();
  }

  private async refreshExtras(): Promise<void> {
    const token = ++this.assetsToken;
    const a = this.assets;
    const [mesh, tex] = await Promise.all([
      a?.model ? loadBedMesh(a.model) : null,
      a?.texture ? loadBedTexture(a.texture) : null,
    ]);
    if (token !== this.assetsToken || this.disposed || !this.bed) return;
    // The vendor mesh replaces the flat plate (grid, edge and axes stay on top),
    // on every plate; extras live inside each plate group so dimming applies.
    this.group?.children.forEach((pg) => {
      const i = pg.userData.plate as number;
      pg.traverse((o) => { if (o.name === 'plate') o.visible = !mesh; });
      const old = pg.getObjectByName('bed-extras') as Group | undefined;
      if (old) { old.removeFromParent(); disposeObject3D(old); }
      if (mesh || tex) pg.add(buildBedExtras(plateBed(this.bed!, i, this.count), this.theme, mesh, tex));
    });
    this.styleActive();
    this.requestRender();
  }

  // ---- per-plate overlays (IDEX/IQEX zones, belt marks) ------------------------------

  private overlays = new Map<string, { key: string; build: (plate: number) => Group | null }>();

  /**
   * Add / replace the overlay `name` on every plate (inside the plate group,
   * so it dims with it); `build` returns null for a plate without one, and
   * `key` skips unchanged updates.
   */
  setPlateOverlay(name: string, key: string, build: ((plate: number) => Group | null) | null): void {
    if (this.overlays.get(name)?.key === key) return;
    if (build) this.overlays.set(name, { key, build }); else this.overlays.delete(name);
    this.applyOverlay(name);
    this.styleActive();
    this.requestRender();
  }

  private applyOverlay(name: string): void {
    const o = this.overlays.get(name);
    this.group?.children.forEach((pg) => {
      const old = pg.getObjectByName(name);
      if (old) { old.removeFromParent(); disposeObject3D(old); }
      const z = o?.build(pg.userData.plate as number);
      if (z) { z.name = name; pg.add(z); }
    });
  }

  // ---- collision volumes ----------------------------------------------------------

  setCollisionVolumes(vols: CollisionVolume[], showAll: boolean): void {
    this.volumes = vols;
    this.showAllVolumes = showAll;
    this.volumesKey = '';
  }

  /**
   * (Re)draw the collision volumes on every plate. Prisms rise to the tallest
   * object whose XY box meets the volume's footprint box (Orca uses the exact
   * hull; the box is a close, conservative stand-in), or full height with
   * "Show all collision volumes". Cheap when nothing changed.
   */
  updateCollisionVolumes(objects: ObjectBoxes): void {
    if (!this.group || !this.bed) return;
    const bed = this.bed;
    const perPlate = Array.from({ length: this.count }, (_, i) => {
      const pb = plateBed(bed, i, this.count);
      const dx = pb.min[0] - bed.min[0], dy = pb.min[1] - bed.min[1];
      const heights = this.volumes.map((v) => {
        const f = footprintBounds(v.polygon);
        let h = 0;
        for (const b of objects) {
          if (b.max.x < f.min[0] + dx || b.min.x > f.max[0] + dx || b.max.y < f.min[1] + dy || b.min.y > f.max[1] + dy) continue;
          if (b.max.z < v.zMin) continue;
          h = Math.max(h, b.max.z);
        }
        return Math.round(h * 10) / 10;
      });
      return { dx, dy, heights };
    });
    const key = JSON.stringify([this.volumes.length, this.showAllVolumes, perPlate.map((p) => p.heights)]);
    if (key === this.volumesKey) return;
    this.volumesKey = key;
    const color = this.theme.exclude;
    this.group.children.forEach((pg) => {
      const old = pg.getObjectByName('collision-volumes') as Group | undefined;
      if (old) { old.removeFromParent(); disposeObject3D(old); }
      if (!this.volumes.length) return;
      const p = perPlate[pg.userData.plate as number];
      const g = buildCollisionVolumes(this.volumes, color, {
        showAll: this.showAllVolumes,
        heightFor: (v) => p.heights[this.volumes.indexOf(v)] ?? 0,
      });
      g.position.set(p.dx, p.dy, 0);
      pg.add(g);
    });
    this.styleActive();
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    if (this.group) { this.scene.remove(this.group); disposeObject3D(this.group); this.group = null; }
  }
}

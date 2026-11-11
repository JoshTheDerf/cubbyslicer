/**
 * IDEX/IQEX parallel printing in the 3D views (Orca 2.5 PartPlate
 * render_imex_zones / calc_imex_ghosts, GCodeViewer carriage boxes): the
 * zone fills, collision strips and margin bands on a plate, the translucent
 * "ghost" of what each other carriage prints, and the preview's toolhead
 * boxes. Geometry comes from plates/imex.ts; everything here is world space.
 */
import {
  BoxGeometry, Color, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, type BufferGeometry, type Material, type Object3D, type Raycaster,
} from 'three';
import type { HeadTransform, ImexTheme, ImexZoneLayout, Rect } from '../plates/imex';
import { disposeObject3D } from './bed';

/** A head's map as a 4×4 (XY affine, Z untouched). */
export function headMatrix(t: Pick<HeadTransform, 'sx' | 'sy' | 'tx' | 'ty'>, out = new Matrix4()): Matrix4 {
  return out.set(t.sx, 0, 0, t.tx, 0, t.sy, 0, t.ty, 0, 0, 1, 0, 0, 0, 0, 1);
}

function rectMesh(r: Rect, colour: string, opacity: number, z: number, name: string): Mesh {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(colour), transparent: true, opacity, depthWrite: false, side: DoubleSide }));
  m.position.set(r.x0 + w / 2, r.y0 + h / 2, z);
  m.name = name;
  m.renderOrder = 1;
  return m;
}

/** Zone fills (copy / mirror), collision strips and margin bands for one plate. */
export function buildImexZones(layout: ImexZoneLayout, theme: ImexTheme): Group {
  const g = new Group();
  g.name = 'imex-zones';
  for (const r of layout.copyZones) g.add(rectMesh(r, theme.copy[0], theme.copy[1], 0.006, 'imex-copy'));
  for (const r of layout.mirrorZones) g.add(rectMesh(r, theme.mirror[0], theme.mirror[1], 0.006, 'imex-mirror'));
  for (const r of layout.collisionZones) g.add(rectMesh(r, theme.danger[0], theme.danger[1], 0.009, 'imex-collision'));
  for (const r of layout.marginBands) g.add(rectMesh(r, theme.margin[0], theme.margin[1], 0.009, 'imex-margin'));
  return g;
}

// ---- ghosts (Prepare) ------------------------------------------------------------------

export interface GhostSource {
  id: string;
  /** The object's mesh (its world matrix is followed every frame, so ghosts track gizmo drags). */
  mesh: Mesh;
  plate: number;
  /** Printed (ghosts are only drawn for printable, visible objects). */
  printed: boolean;
}

export interface PlateHeads { heads: HeadTransform[]; colourOf?(head: number): Color | null }

interface Ghost { key: string; source: Mesh; head: HeadTransform; obj: Mesh; mat: MeshBasicMaterial; colour: Color | null }

const H = new Matrix4();

/**
 * Ghost copies: for each object on a plate in a parallel mode, one
 * translucent copy per Copy / Mirror carriage (mirrored with a reflection, so
 * the material is double-sided). Model parts that share the object's material
 * ride along.
 */
export class ImexGhosts {
  readonly group = new Group();
  private ghosts = new Map<string, Ghost>();

  constructor() { this.group.name = 'imex-ghosts'; }

  sync(sources: readonly GhostSource[], perPlate: ReadonlyArray<PlateHeads | null>): void {
    const seen = new Set<string>();
    for (const s of sources) {
      const ph = perPlate[s.plate];
      if (!s.printed || !ph) continue;
      const parts = s.mesh.children.filter((c): c is Mesh => (c as Mesh).isMesh && (c as Mesh).material === s.mesh.material);
      const shape = [s.mesh.geometry.uuid, ...parts.map((p) => p.geometry.uuid)].join('|');
      for (const head of ph.heads) {
        const key = `${s.id}|${head.head}`;
        seen.add(key);
        let g = this.ghosts.get(key);
        if (g && (g.source !== s.mesh || g.obj.userData.shape !== shape)) { this.drop(g); g = undefined; }
        if (!g) {
          const mat = new MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false, side: DoubleSide });
          const obj = new Mesh(s.mesh.geometry, mat);
          obj.userData.shape = shape;
          obj.name = `imex-ghost-${head.head}`;
          obj.matrixAutoUpdate = false;
          obj.renderOrder = 3;
          for (const p of parts) {
            const c = new Mesh(p.geometry, mat);
            c.userData.source = p;
            obj.add(c);
          }
          g = { key, source: s.mesh, head, obj, mat, colour: null };
          this.ghosts.set(key, g);
          this.group.add(obj);
        }
        g.head = head;
        g.colour = ph.colourOf?.(head.head) ?? null;
      }
    }
    for (const g of [...this.ghosts.values()]) if (!seen.has(g.key)) this.drop(g);
  }

  /** Follow the sources (call before each render). */
  update(): void {
    for (const g of this.ghosts.values()) {
      const src = g.source;
      g.obj.visible = src.visible;
      if (!src.visible) continue;
      src.updateMatrixWorld();
      g.obj.matrix.multiplyMatrices(headMatrix(g.head, H), src.matrixWorld);
      g.obj.matrixWorldNeedsUpdate = true;
      for (const c of g.obj.children) {
        const p = c.userData.source as Object3D;
        c.position.copy(p.position); c.quaternion.copy(p.quaternion); c.scale.copy(p.scale);
      }
      g.mat.color.copy(g.colour ?? ((src.material as Material & { color?: Color }).color ?? new Color(0x888888)));
    }
  }

  get count(): number { return this.ghosts.size; }

  /** The carriage whose ghost is under the ray (desktop's m_hover_ghost_head), with its distance. */
  hit(raycaster: Raycaster): { head: number; distance: number } | null {
    let best: { head: number; distance: number } | null = null;
    for (const g of this.ghosts.values()) {
      if (!g.obj.visible) continue;
      g.obj.updateMatrixWorld(true);
      const h = raycaster.intersectObject(g.obj, true)[0];
      if (h && (!best || h.distance < best.distance)) best = { head: g.head.head, distance: h.distance };
    }
    return best;
  }

  private drop(g: Ghost): void {
    this.group.remove(g.obj);
    g.mat.dispose(); // geometry belongs to the source object
    this.ghosts.delete(g.key);
  }

  dispose(): void { for (const g of [...this.ghosts.values()]) this.drop(g); }
}

// ---- toolhead boxes (Preview) ----------------------------------------------------------

/** One translucent box per carriage, `size` = imex_nozzle_clearance_x × _y (height = the larger). */
export function buildCarriageBoxes(size: [number, number], colours: readonly string[]): Group {
  const g = new Group();
  g.name = 'imex-carriages';
  const h = Math.max(size[0], size[1]);
  const geo: BufferGeometry = new BoxGeometry(size[0], size[1], h);
  geo.translate(size[0] / 2, size[1] / 2, h / 2);
  colours.forEach((c, i) => {
    const m = new Mesh(geo, new MeshBasicMaterial({ color: new Color(c), transparent: true, opacity: 0.3, depthWrite: false }));
    m.userData.shared = i > 0;
    m.name = `imex-carriage-${i}`;
    g.add(m);
  });
  return g;
}

export { disposeObject3D };

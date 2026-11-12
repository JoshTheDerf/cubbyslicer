/**
 * The brush cursor of the painting tools (support / seam / colour / fuzzy skin
 * painting and texture displacement masks): a ring of the brush radius lying
 * on the surface under the pointer.
 */
import { DoubleSide, Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from 'three';
import type { PrepareScene, ToolHit } from '../viewport/scene';

export class BrushCursor {
  private ring: Mesh | null = null;

  /** Show the ring at `hit` (null / !show hides it). */
  place(sc: PrepareScene, hit: ToolHit | null, radius: number, show: boolean): void {
    if (!this.ring) {
      this.ring = new Mesh(new RingGeometry(0.92, 1, 48), new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, depthTest: false, transparent: true, opacity: 0.85 }));
      this.ring.renderOrder = 10;
      sc.scene.add(this.ring);
    }
    this.ring.visible = show && !!hit;
    if (show && hit) {
      this.ring.position.copy(hit.point).addScaledVector(hit.normal, 0.05);
      this.ring.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), hit.normal);
      this.ring.scale.setScalar(radius);
    }
    sc.requestRender();
  }

  dispose(): void {
    if (!this.ring) return;
    this.ring.removeFromParent();
    this.ring.geometry.dispose();
    (this.ring.material as MeshBasicMaterial).dispose();
    this.ring = null;
  }
}

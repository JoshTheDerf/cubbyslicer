// The section view's cut handed to the engine's painting (TriangleSelector::ClippingPlane in the mesh frame).
import { describe, expect, it } from 'vitest';
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { SectionView, clipPlaneIn } from './viewEffects';

const clipped = (c: number[], p: Vector3) => c[0] * p.x + c[1] * p.y + c[2] * p.z - c[3] > 0;

describe('section clip for painting', () => {
  it('cuts the same points in the mesh frame as in the world', () => {
    const m = new Matrix4().compose(new Vector3(100, 50, 3), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.7), new Vector3(2, 1, 0.5));
    const n = new Vector3(1, 2, -0.5).normalize();
    const off = 120;
    const c = clipPlaneIn(n, off, m);
    for (const local of [new Vector3(0, 0, 0), new Vector3(10, -4, 8), new Vector3(-20, 30, 1), new Vector3(5, 5, -9)]) {
      const world = local.clone().applyMatrix4(m);
      expect(clipped(c, local)).toBe(n.dot(world) > off);
    }
  });

  it('matches what the view clips, and is off when the section view is', () => {
    const sv = new SectionView();
    const m = new Matrix4().makeTranslation(10, 20, 0);
    expect(sv.clipIn(m)).toBeUndefined();
    sv.update(0.5, new Vector3(0, 0, 1), new Box3(new Vector3(-10, -10, 0), new Vector3(10, 10, 20)));
    const c = sv.clipIn(m)!;
    for (const z of [2, 9, 11, 18]) {
      const local = new Vector3(1, 1, z);
      expect(clipped(c, local)).toBe(sv.clips(local.clone().applyMatrix4(m)));
    }
    expect(clipped(c, new Vector3(0, 0, 18))).toBe(true);
    sv.dispose();
  });
});

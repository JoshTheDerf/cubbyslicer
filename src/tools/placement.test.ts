import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { surfaceFrame, surfaceOffset } from './placement';

describe('emboss placement', () => {
  it('maps local +Z to the surface normal and keeps text upright on walls', () => {
    const q = surfaceFrame(new Vector3(0, -1, 0)); // front wall
    const z = new Vector3(0, 0, 1).applyQuaternion(q);
    const y = new Vector3(0, 1, 0).applyQuaternion(q);
    const x = new Vector3(1, 0, 0).applyQuaternion(q);
    expect(z.y).toBeCloseTo(-1);
    expect(y.z).toBeCloseTo(1); // up is world up
    expect(x.x).toBeCloseTo(1); // reads left → right seen from the front
  });

  it('reads along +X on top faces', () => {
    const q = surfaceFrame(new Vector3(0, 0, 1));
    expect(new Vector3(1, 0, 0).applyQuaternion(q).x).toBeCloseTo(1);
    expect(new Vector3(0, 1, 0).applyQuaternion(q).y).toBeCloseTo(1);
  });

  it('embeds parts slightly, engraves negative volumes to depth', () => {
    expect(surfaceOffset('part', 2)).toBeCloseTo(-0.2);
    expect(surfaceOffset('negative', 2)).toBeCloseTo(-1.95);
    expect(surfaceOffset('modifier', 0.3)).toBeCloseTo(-0.27);
  });
});

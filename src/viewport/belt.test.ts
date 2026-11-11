import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { FlatConfig } from '../engine/types';
import { axisRemap, beltBackTransform, beltDesignedMatrix, beltOpenY, buildPlateUp, machineFrame } from './belt';
import { Feature } from '../preview/parser/features';
import type { ParsedGcode } from '../preview/parser/types';
import { validatePlate } from '../project/validate';

// Orca 2.5 fdm_belt_common + MyBeltPrinter 0.4 (350 × 350, 300 high).
const BELT: FlatConfig = {
  belt_printer: '1', belt_slice_rotation: 'x', belt_slice_rotation_angle: '45', build_plate_tilt_x: '45',
  gcode_remap_x: 'rev_x', gcode_remap_y: 'pos_z', gcode_remap_z: 'pos_y',
  printable_area: ['0x0', '350x0', '350x350', '0x350'], printable_height: '300',
};
const BED = { max: [350, 350] as [number, number] };

/** What Orca writes for a model point: MachineFrame(AxisRemap(p)). */
function forward(p: Vector3): Vector3 {
  return p.clone().applyMatrix4(axisRemap(BELT, BED, 300)!).applyMatrix4(machineFrame(BELT)!);
}

describe('belt transforms', () => {
  it('45° X belt: x mirrored, height scaled by 1/sin, belt = y + height', () => {
    const g = forward(new Vector3(10, 20, 30));
    expect(g.x).toBeCloseTo(340);
    expect(g.y).toBeCloseTo(30 * Math.SQRT2);
    expect(g.z).toBeCloseTo(50);
  });
  it('back transform recovers the model point', () => {
    const back = beltBackTransform(BELT, BED, 300)!;
    for (const p of [new Vector3(0, 0, 0), new Vector3(10, 20, 30), new Vector3(200, -50, 5)]) {
      const q = forward(p).applyMatrix4(back);
      expect(q.distanceTo(p)).toBeLessThan(1e-6);
    }
  });
  it('no transform on a flat-bed printer', () => {
    expect(beltBackTransform({}, BED, 300)).toBeNull();
    expect(buildPlateUp({})).toBeNull();
    expect(beltOpenY({})).toBe(false);
  });
  it('the layers lean along +Y on a 45° X belt', () => {
    const up = buildPlateUp(BELT)!;
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(Math.SQRT1_2);
    expect(up.z).toBeCloseTo(Math.SQRT1_2);
  });
  it('designed view anchors the body on the model box', () => {
    // Two layers; layer 1 has a support segment (ignored) and a wall from model (5,5,1) to (25,5,1).
    const pts = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(5, 5, 1), new Vector3(9, 9, 9), new Vector3(25, 5, 1)].map(forward);
    // Offset everything as a belt_z_origin would.
    const flat = new Float32Array(pts.flatMap((p) => [p.x, p.y, p.z + 7]));
    const data = {
      segmentCount: 4, points: flat, layerCount: 2, layerStart: new Uint32Array([0, 1, 4]),
      feature: new Uint8Array([Feature.OuterWall, Feature.Travel, Feature.Support, Feature.OuterWall]),
    } as unknown as ParsedGcode;
    const m = beltDesignedMatrix(data, beltBackTransform(BELT, BED, 300)!, { min: [105, 55, 0], max: [130, 60, 2] });
    const a = new Vector3(flat[6], flat[7], flat[8]).applyMatrix4(m);
    const b = new Vector3(flat[12], flat[13], flat[14]).applyMatrix4(m);
    // Like Orca, extrusion end vertices anchor: the wall's end lands on the model's min corner; shape kept.
    expect(b.x).toBeCloseTo(105); expect(b.y).toBeCloseTo(55); expect(b.z).toBeCloseTo(0);
    expect(b.x - a.x).toBeCloseTo(20); expect(b.y - a.y).toBeCloseTo(0); expect(b.z - a.z).toBeCloseTo(0);
  });
});

describe('belt placement', () => {
  const bed = { polygon: [[0, 0], [350, 0], [350, 350], [0, 350]] as Array<[number, number]>, min: [0, 0] as [number, number], max: [350, 350] as [number, number], maxHeight: 300, excludeAreas: [] };
  const long = { id: 'a', hull: [[100, -100], [150, -100], [150, 500], [100, 500]] as Array<[number, number]>, min: [100, -100, 0] as [number, number, number], max: [150, 500, 20] as [number, number, number] };
  it('an open Y axis lets a part run past the bed along the belt, not sideways', () => {
    expect(validatePlate([long], bed).get('a')).toEqual(['outside']);
    expect(validatePlate([long], bed, { openY: true }).get('a')).toBeUndefined();
    const wide = { ...long, hull: [[300, 0], [400, 0], [400, 20], [300, 20]] as Array<[number, number]> };
    expect(validatePlate([wide], bed, { openY: true }).get('a')).toEqual(['outside']);
  });
});

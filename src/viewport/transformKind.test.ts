import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { transformKind } from './scene';

const trs = (p: [number, number, number], angle: number, s: number) =>
  new Matrix4().compose(new Vector3(...p), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), angle), new Vector3(s, s, s));

describe('transformKind', () => {
  it('tells a move, a rotate about a pivot and a scale about an anchor apart', () => {
    expect(transformKind(trs([12, -3, 0], 0, 1))).toBe('translate');
    expect(transformKind(trs([4, 2, 0], Math.PI / 6, 1))).toBe('rotate');
    expect(transformKind(trs([1, 1, 0], 0, 1.5))).toBe('scale');
    expect(transformKind(new Matrix4())).toBe('translate');
  });
});

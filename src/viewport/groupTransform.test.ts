import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../project/math';
import { groupMove, groupRotate, groupScale, type GroupItem } from './groupTransform';

const item = (id: string, position: Vec3): GroupItem => ({ id, position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('group transforms', () => {
  const items = [item('a', [10, 0, 0]), item('b', [30, 0, 0])];

  it('moves every object by the same delta', () => {
    expect(groupMove(items, [5, -2, 0]).map((p) => p.position)).toEqual([[15, -2, 0], [35, -2, 0]]);
  });

  it('rotates positions about the centre and turns each object', () => {
    const [a, b] = groupRotate(items, 2, Math.PI / 2, [20, 0, 0]);
    close(a.position, [20, -10, 0]);
    close(b.position, [20, 10, 0]);
    close(a.rotation!, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  });

  it('scales spacing and objects about the centre', () => {
    const [a, b] = groupScale(items, 2, [20, 0, 0]);
    expect(a.position).toEqual([0, 0, 0]);
    expect(b.position).toEqual([40, 0, 0]);
    expect(a.scale).toEqual([2, 2, 2]);
  });
});

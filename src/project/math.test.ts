import { describe, expect, it } from 'vitest';
import { composeTRS, mat4InvertAffine, mat4Multiply, quatFromEuler } from './math';

describe('mat4InvertAffine', () => {
  it('inverts a TRS matrix', () => {
    const m = composeTRS([12, -3, 40], quatFromEuler(0.3, -1.1, 2.0), [2, 0.5, 1.5]);
    const p = mat4Multiply(m, mat4InvertAffine(m));
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    p.forEach((v, i) => expect(v).toBeCloseTo(id[i], 9));
  });
});

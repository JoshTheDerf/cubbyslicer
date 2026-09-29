import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { occtToParsed, stepBaseName, isStepName, type OcctResult } from './step';

const require = createRequire(import.meta.url);

describe('STEP import', () => {
  it('recognises STEP names', () => {
    expect(isStepName('a.STEP')).toBe(true);
    expect(isStepName('b.stp')).toBe(true);
    expect(isStepName('c.stl')).toBe(false);
    expect(stepBaseName('/x/y/Bracket v2.step')).toBe('Bracket v2');
  });

  it('tessellates a cube with OpenCascade and converts it to a welded object', async () => {
    const occtimportjs = require('occt-import-js');
    const occt = await occtimportjs();
    const dir = resolve(require.resolve('occt-import-js'), '../../test/testfiles/simple-basic-cube/cube.stp');
    const res = occt.ReadStepFile(new Uint8Array(readFileSync(dir)), { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.003, angularDeflection: 0.5 }) as OcctResult;
    const parsed = occtToParsed(res, 'cube.stp', false);
    expect(parsed.objects.length).toBe(1);
    const o = parsed.objects[0];
    expect(o.name).toBe('cube');
    expect(o.indices.length / 3).toBe(12);
    expect(o.positions.length / 3).toBe(8); // welded
  }, 60000);

  it('merges or splits multiple solids', () => {
    const mesh = (dx: number) => ({
      attributes: { position: { array: [dx, 0, 0, dx + 1, 0, 0, dx, 1, 0, dx, 0, 1] } },
      index: { array: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] },
    });
    const res: OcctResult = { success: true, meshes: [{ ...mesh(0), name: 'A' }, { ...mesh(10), name: 'B' }] };
    expect(occtToParsed(res, 'two.step', false).objects.length).toBe(1);
    const split = occtToParsed(res, 'two.step', true).objects;
    expect(split.map((o) => o.name)).toEqual(['A', 'B']);
    // Split solids keep their relative placement.
    expect(split[1].transform![12] - split[0].transform![12]).toBeCloseTo(10);
  });

  it('rejects failed reads', () => {
    expect(() => occtToParsed({ success: false, meshes: [] }, 'bad.step', false)).toThrow(/couldn't read/);
  });
});

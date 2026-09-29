import { describe, expect, it } from 'vitest';
import { parseObj } from './obj';
import { parseModel } from './parse';

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('OBJ face colours', () => {
  it('groups faces by usemtl material', () => {
    const r = parseObj(enc('mtllib m.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nusemtl Red\nf 1 2 3\nusemtl Blue\nf 1 2 4\nf 1 3 4\nusemtl Red\nf 2 3 4\n'));
    expect(r.mtllibs).toEqual(['m.mtl']);
    expect(r.faceGroups!.groups.map((g) => g.name)).toEqual(['Red', 'Blue']);
    expect([...r.faceGroups!.tri]).toEqual([0, 1, 1, 0]);
  });

  it('groups faces by vertex colour when there are no materials', () => {
    const r = parseObj(enc('v 0 0 0 1 0 0\nv 1 0 0 1 0 0\nv 0 1 0 1 0 0\nv 0 0 1 0 0 1\nf 1 2 3\nf 1 2 4\n'));
    expect(r.faceGroups!.groups[0].color).toBe('#FF0000');
    expect(r.faceGroups!.tri.length).toBe(2);
    expect(r.faceGroups!.tri[0]).not.toBe(r.faceGroups!.tri[1]);
  });

  it('has no groups for plain OBJ and keeps groups aligned through welding', () => {
    expect(parseObj(enc('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')).faceGroups).toBeUndefined();
    // A degenerate face in the middle is dropped by the weld; groups stay aligned.
    const res = parseModel('x.obj', enc('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nusemtl A\nf 1 2 3\nusemtl B\nf 1 1 2\nusemtl C\nf 1 2 4\n'));
    const fg = res.objects[0].faceGroups!;
    expect(res.objects[0].indices.length / 3).toBe(2);
    expect([...fg.tri]).toEqual([0, 2]);
  });
});

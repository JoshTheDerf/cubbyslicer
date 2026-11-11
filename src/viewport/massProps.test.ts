import { describe, expect, it } from 'vitest';
import { centerOf, inertiaOf, markerDetails, meshMass } from './massProps';
import { massMarkers, prepareMassBodies } from './massMarkers';
import type { MeshData, ProjectObject } from '../project/types';
import { setSectionRatio, toggleSection, viewportState } from './controller';

const cube = (s: number) => {
  const v = [0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, 0, 0, s, s, 0, s, s, s, s, 0, s, s];
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float32Array(v), indices: new Uint32Array(f) };
};
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('meshMass (its_mass_properties)', () => {
  it('a 10 mm cube at density 1: 1 g, centre in the middle, I = m(a² + a²)/12', () => {
    const c = cube(10);
    const s = meshMass(c.positions, c.indices, I, 1);
    expect(s.volume).toBeCloseTo(1000, 6);
    expect(s.mass).toBeCloseTo(1000, 6);
    expect(centerOf(s)).toEqual([5, 5, 5].map((v) => expect.closeTo(v, 6)));
    for (const v of inertiaOf(s)) expect(v).toBeCloseTo((1000 * 200) / 12, 3);
  });
  it('follows the transform (moved, scaled ×2)', () => {
    const c = cube(10);
    const s = meshMass(c.positions, c.indices, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 100, 50, 0, 1], 1.24);
    expect(s.volume).toBeCloseTo(8000, 4);
    expect(s.mass).toBeCloseTo(8000 * 1.24, 3);
    expect(centerOf(s)[0]).toBeCloseTo(110, 6);
  });
  it('details rows as desktop formats them', () => {
    const c = cube(10);
    const s = meshMass(c.positions, c.indices, I, 1.24);
    const d = markerDetails({ kind: 'object', sum: s, box: { min: [0, 0, 0], max: [10, 10, 10] } });
    expect(d.title).toBe('Object center of mass');
    expect(Object.fromEntries(d.rows)).toEqual({
      Weight: '1.24 g', Volume: '1.00 cm³', 'Center in bounding box': 'X: 5.00, Y: 5.00, Z: 5.00 mm',
      'Bounding box size': 'X: 10.00, Y: 10.00, Z: 10.00 mm', 'Moment of inertia': 'X: 21, Y: 21, Z: 21 g·mm²',
    });
  });
});

describe('massMarkers (CenterOfMass::model_markers)', () => {
  const meshes = new Map<string, MeshData>();
  const c = cube(10);
  meshes.set('m', { id: 'm', positions: c.positions, indices: c.indices, triangleCount: 12, bbox: { min: [0, 0, 0], max: [10, 10, 10] } } as unknown as MeshData);
  const obj = (id: string, x: number, extra: Partial<ProjectObject> = {}): ProjectObject => ({
    id, name: id, meshId: 'm', position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], overrides: {}, visible: true, printable: true, ...extra,
  } as unknown as ProjectObject);
  it('one marker per object at its filament density, one per plate; parts get their own markers', () => {
    const objects = [
      obj('a', 0),
      obj('b', 50, { overrides: { extruder: '2' }, parts: [{ id: 'p', name: 'p', meshId: 'm', type: 'part', position: [20, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], overrides: {} }] }),
    ];
    const ms = massMarkers({ objects, mesh: (id) => meshes.get(id), config: { filament_density: ['1', '2'] }, plateOf: () => 0 });
    const kinds = ms.map((m) => m.kind);
    expect(kinds).toEqual(['plate', 'object', 'object', 'body', 'body']);
    expect(ms[1].sum.mass).toBeCloseTo(1000);
    expect(ms[2].sum.mass).toBeCloseTo(4000); // two cubes at density 2
    expect(ms[2].assembly).toBe(true);
    expect(ms[0].sum.mass).toBeCloseTo(5000);
    expect(centerOf(ms[2].sum)[0]).toBeCloseTo(65);
  });
  const part = (id: string, x: number, type = 'part', extruder?: string) => ({ id, name: id, meshId: 'm', type, position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], overrides: extruder ? { extruder } : {} });
  it('solid_bodies: overlapping parts unite into one body, the later part weighs where they overlap', async () => {
    // Own cube [0,10] + a part at x 5 → [5,15]: one body of 1500 mm³; the overlap (500 mm³) is the part's (density 2).
    const objects = [obj('a', 0, { parts: [part('p', 5, 'part', '2')] } as Partial<ProjectObject>)];
    const input = { objects, mesh: (id: string) => meshes.get(id), config: { filament_density: ['1', '2'] }, plateOf: () => 0 };
    expect(await prepareMassBodies(input)).toBe(true);
    const ms = massMarkers(input);
    expect(ms.map((m) => m.kind)).toEqual(['plate', 'object']); // one body: no body markers
    expect(ms[1].sum.volume).toBeCloseTo(1500, 3);
    expect(ms[1].sum.mass).toBeCloseTo(500 * 1 + 1000 * 2, 3);
    expect(centerOf(ms[1].sum)[0]).toBeCloseTo((500 * 2.5 + 2000 * 10) / 2500, 3);
  });
  it('solid_bodies: separate parts are separate bodies; a negative volume is cut away', async () => {
    const objects = [obj('a', 0, { parts: [part('p', 20), part('n', 15, 'negative')] } as Partial<ProjectObject>)];
    const input = { objects, mesh: (id: string) => meshes.get(id), config: { filament_density: ['1'] }, plateOf: () => -1 };
    await prepareMassBodies(input);
    const ms = massMarkers(input);
    expect(ms.map((m) => m.kind)).toEqual(['object', 'body', 'body']);
    // The negative [15,25] takes half of the second cube.
    expect(ms[0].sum.volume).toBeCloseTo(1500, 3);
    expect(ms.slice(1).map((m) => Math.round(m.sum.volume)).sort()).toEqual([1000, 500]);
  });
  it('an unset density falls back to desktop’s 1.245; hidden objects have no marker', () => {
    const ms = massMarkers({ objects: [obj('a', 0), obj('h', 30, { visible: false })], mesh: (id) => meshes.get(id), config: {}, plateOf: () => -1 });
    expect(ms.map((m) => m.kind)).toEqual(['object']);
    expect(ms[0].sum.mass).toBeCloseTo(1245);
  });
});

describe('section view state (GLCanvas3D::set_section_view_ratio / toggle_section_view)', () => {
  it('first toggle cuts at 0.5 and aims at the camera; off remembers the last cut', () => {
    const s = viewportState.section;
    const aim0 = s.aim;
    toggleSection();
    expect(s.ratio).toBe(0.5);
    expect(s.aim).toBe(aim0 + 1);
    s.normal = [0, -1, 0];
    setSectionRatio(0.73);
    expect(s.aim).toBe(aim0 + 1); // later cuts keep their angle
    toggleSection();
    expect(s.ratio).toBe(0);
    toggleSection();
    expect(s.ratio).toBe(0.73);
    setSectionRatio(2);
    expect(s.ratio).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import { buildCollisionVolumes, collisionVolumesFromConfig, parseCollisionVolumes } from './collisionVolumes';

describe('collision volumes', () => {
  it('parses full-height and Z-limited volumes (Orca syntax)', () => {
    const v = parseCollisionVolumes('0x0,10x0,10x10,0x10 | 5..20;points=20x0,30x0,30x10 |..3;40x0,50x0,50x5', 100);
    expect(v).toHaveLength(3);
    expect(v[0]).toMatchObject({ zMin: 0, zMax: 100, hasZRange: false });
    expect(v[1]).toMatchObject({ zMin: 5, zMax: 20, hasZRange: true });
    expect(v[2]).toMatchObject({ zMin: 0, zMax: 3, hasZRange: true });
  });
  it('makes footprints counter-clockwise and skips invalid volumes', () => {
    const [v] = parseCollisionVolumes('0x10,10x10,10x0,0x0', 50);
    expect(v.polygon[0]).toEqual([0, 0]); // reversed
    expect(parseCollisionVolumes('0x0,1x1 | 0x0,1x0,2x0 | 9..2;0x0,1x0,1x1 | abc', 50)).toEqual([]);
    // A range clamped to a plane is not a volume.
    expect(parseCollisionVolumes('200..300;0x0,1x0,1x1', 50)).toEqual([]);
  });
  it('resolves modes per extruder', () => {
    const base = { printable_height: '100', bed_exclude_volumes: '0x0,10x0,10x10', extruder_offset: ['0x0', '25x0'] };
    expect(collisionVolumesFromConfig(base)).toHaveLength(1);
    const offset = collisionVolumesFromConfig({ ...base, bed_exclude_volume_mode: 'toolhead_offset' });
    expect(offset.map((v) => [v.extruder, v.polygon[1][0]])).toEqual([[0, 10], [1, 35]]);
    const per = collisionVolumesFromConfig({ ...base, bed_exclude_volume_mode: 'per_extruder', extruder_bed_exclude_volumes: ['', '1..2;0x0,5x0,5x5'] });
    expect(per).toEqual([expect.objectContaining({ extruder: 1, zMin: 1, zMax: 2 })]);
    expect(collisionVolumesFromConfig({ printable_height: '100' })).toEqual([]);
  });
  it('draws bed marks always and prisms only near objects or with "show all"', () => {
    const vols = parseCollisionVolumes('0x0,10x0,10x10 | 5..20;20x0,30x0,30x10', 100);
    const quiet = buildCollisionVolumes(vols, new Color(1, 0, 0), { showAll: false, heightFor: () => 0 });
    expect(quiet.children.filter((c) => c.name === 'collision-prism')).toHaveLength(0);
    expect(quiet.children.filter((c) => c.name === 'collision-floor')).toHaveLength(1); // the raised one gets a ribbon only
    const all = buildCollisionVolumes(vols, new Color(1, 0, 0), { showAll: true, heightFor: () => 0 });
    expect(all.children.filter((c) => c.name === 'collision-prism')).toHaveLength(2);
    const near = buildCollisionVolumes(vols, new Color(1, 0, 0), { showAll: false, heightFor: () => 12 });
    expect(near.children.filter((c) => c.name === 'collision-prism')).toHaveLength(2);
  });
});

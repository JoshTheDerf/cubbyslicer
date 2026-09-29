import { describe, expect, it } from 'vitest';
import { isOrcaProject, parseOrca3mf, sniffOrcaProject } from './orca3mf';
import { parse3mf } from './threemf';
import { orcaProject3mf, orcaSlicedOnly3mf } from './__fixtures__/orca3mf';

const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe('Orca project 3MF', () => {
  it('is recognised as a project', () => {
    expect(sniffOrcaProject(buf(orcaProject3mf()))).toBe(true);
    expect(isOrcaProject({})).toBe(false);
  });

  it('reads objects, volumes, settings, paint and plates', () => {
    const p = parseOrca3mf(buf(orcaProject3mf()));
    expect(p.objects.map((o) => o.name)).toEqual(['Box with modifier', 'Small box']);
    const [a, b] = p.objects;
    expect(a.volumes.map((v) => [v.name, v.type])).toEqual([['Box', 'part'], ['Dense core', 'modifier']]);
    expect(a.config).toMatchObject({ extruder: '1', wall_loops: '4' });
    expect(a.volumes[0].config).toMatchObject({ extruder: '2' });
    expect(a.volumes[1].config).toEqual({ sparse_infill_density: '80%' });
    expect(a.volumes[0].paint.color).toEqual([[2, '8']]);
    expect(b.instances.map((i) => i.plate)).toEqual([0, 1]);
    expect(p.plates.map((pl) => [pl.name, pl.locked, !!pl.gcode])).toEqual([['Main', false, false], ['Spares', true, true]]);
    expect(p.printableArea).toEqual([[0, 0], [256, 0], [256, 256], [0, 256]]);
    expect(p.settings?.print_settings_id).toBe('0.20mm Standard @BBL X1C');
  });

  it('opens a G-code-only sliced 3MF', () => {
    const p = parseOrca3mf(buf(orcaSlicedOnly3mf()));
    expect(p.objects).toEqual([]);
    expect(p.plates.length).toBe(1);
    expect(new TextDecoder().decode(p.plates[0].gcode)).toContain('G28');
  });

  it('still imports as plain meshes (Import models)', () => {
    const r = parse3mf(buf(orcaProject3mf()));
    expect(r.objects.length).toBe(3);
  });
});

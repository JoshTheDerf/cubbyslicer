import { beforeEach, describe, expect, it } from 'vitest';
import * as S from '../project/store';
import { resolvedConfig } from '../app/state';
import { weldVertices, recenter } from '../project/mesh';
import { cubeSoup } from '../project/testutil';
import type { ParsedObject } from '../project/types';
import { sanitizeObjects, sanitizePlates } from '../project/persistence/format';
import * as L from './store';
import * as PL from '../plates/store';

function cube(name = 'Cube', size = 20): ParsedObject {
  const w = weldVertices(cubeSoup(size), null);
  recenter(w.positions);
  return { name, positions: w.positions, indices: w.indices, transform: null };
}

beforeEach(() => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250', layer_height: '0.2', nozzle_diameter: ['0.4'] };
  S.resetProject();
});

describe('height range modifiers', () => {
  it('adds 0–2 mm first, then after the last range; undoable', () => {
    const [id] = S.addParsedObjects([cube()]);
    const a = L.addLayerRange(id)!;
    const b = L.addLayerRange(id)!;
    const o = S.getObject(id)!;
    expect(o.layerRanges!.map((r) => [r.min, r.max])).toEqual([[0, 2], [2, 4]]);
    expect(o.layerRanges![0].overrides).toEqual({ layer_height: '0.2' });
    expect(L.setLayerRangeBounds(id, b, 1, 5)).toBe(false); // overlaps a
    expect(L.setLayerRangeBounds(id, b, 3, 5)).toBe(true);
    L.setRangeOverride(id, a, 'wall_loops', '5');
    expect(L.getRangeOverrides(id, a)).toEqual({ layer_height: '0.2', wall_loops: '5' });
    S.undo();
    expect(L.getRangeOverrides(id, a)).toEqual({ layer_height: '0.2' });
    S.undo();
    expect(L.getRange(id, b)!.min).toBe(2);
    L.removeLayerRange(id, a);
    expect(S.getObject(id)!.layerRanges!.length).toBe(1);
  });

  it('goes into the slice job and the plate signature', () => {
    const [id] = S.addParsedObjects([cube()]);
    const sig0 = S.plateSliceSignature(0);
    const r = L.addLayerRange(id)!;
    L.setRangeOverride(id, r, 'sparse_infill_density', '50%');
    expect(S.plateSliceSignature(0)).not.toBe(sig0);
    const [so] = S.getSliceObjects(0);
    expect(so.layerRanges).toEqual([{ min: 0, max: 2, config: { layer_height: '0.2', sparse_infill_density: '50%' } }]);
  });
});

describe('variable layer height', () => {
  it('stores, resets and sends a profile (fitted to the object height)', () => {
    const [id] = S.addParsedObjects([cube('C', 20)]);
    const o = S.getObject(id)!;
    const p = L.paramsFor(o);
    expect(p.objectHeight).toBeCloseTo(20);
    const prof = L.profileOf(o);
    expect(prof.at(-2)).toBeCloseTo(20);
    let edited = prof;
    for (let i = 0; i < 20; i++) edited = L.brush(o, edited, 10, 'decrease', 0.005);
    L.setLayerProfile(id, edited);
    expect(L.hasCustomProfile(S.getObject(id))).toBe(true);
    const [so] = S.getSliceObjects(0);
    expect(so.layerHeightProfile!.at(-2)).toBeCloseTo(20);
    L.resetLayerProfile(id);
    expect(S.getObject(id)!.layerHeightProfile).toBeUndefined();
    S.undo();
    expect(S.getObject(id)!.layerHeightProfile!.length).toBeGreaterThan(4);
  });
});

describe('plate settings + custom G-codes', () => {
  it('applies plate config, stores gcodes by z, undo and staleness', () => {
    S.addParsedObjects([cube()]);
    const sig0 = S.plateSliceSignature(0);
    PL.setPlateConfig(0, { print_sequence: 'by object', spiral_mode: '1' });
    expect(S.plateSliceSignature(0)).not.toBe(sig0);
    expect(PL.applyPlateConfig({ layer_height: '0.2', print_sequence: 'by layer' }, PL.plateConfig(0), (k) => k !== 'spiral_mode'))
      .toEqual({ layer_height: '0.2', print_sequence: 'by object' });
    const sig1 = S.plateSliceSignature(0);
    expect(PL.addCustomGcode(0, { z: 1.2, type: 'pause', extra: 'Insert magnets' })).toBe(true);
    expect(PL.addCustomGcode(0, { z: 0.6, type: 'color_change', extruder: 1, color: '#ff0000' })).toBe(true);
    // one tick per layer: a pause doesn't replace a colour change, a tool change switches it
    expect(PL.addCustomGcode(0, { z: 0.6, type: 'pause' })).toBe(false);
    expect(PL.addCustomGcode(0, { z: 0.6, type: 'tool_change', extruder: 2 })).toBe(true);
    expect(PL.plateCustomGcodes(0).map((g) => [g.z, g.type])).toEqual([[0.6, 'tool_change'], [1.2, 'pause']]);
    expect(S.plateSliceSignature(0)).not.toBe(sig1);
    PL.updateCustomGcode(0, 1.2, { extra: 'Nuts' });
    expect(PL.plateCustomGcodes(0)[1].extra).toBe('Nuts');
    PL.removeCustomGcode(0, 1.2);
    expect(PL.plateCustomGcodes(0).length).toBe(1);
    S.undo();
    expect(PL.plateCustomGcodes(0).length).toBe(2);
  });

  it('round-trips through serialisation', () => {
    const [id] = S.addParsedObjects([cube()]);
    L.addLayerRange(id);
    L.setLayerProfile(id, [0, 0.2, 5, 0.1, 20, 0.2]);
    PL.setPlateConfig(0, { curr_bed_type: 'Textured PEI Plate' });
    PL.addCustomGcode(0, { z: 2, type: 'custom', extra: 'M117 hi' });
    const json = JSON.parse(JSON.stringify({ objects: S.serializeObjects(), plates: S.serializePlates() }));
    const objs = sanitizeObjects(json.objects, new Set([S.getObject(id)!.meshId]));
    const plates = sanitizePlates(json.plates)!;
    expect(objs[0].layerHeightProfile).toEqual([0, 0.2, 5, 0.1, 20, 0.2]);
    expect(objs[0].layerRanges!.length).toBe(1);
    expect(plates[0].config).toEqual({ curr_bed_type: 'Textured PEI Plate' });
    expect(plates[0].customGcodes).toEqual([{ z: 2, type: 'custom', extra: 'M117 hi' }]);
    expect(sanitizePlates([{ name: 'x', customGcodes: [{ z: -1, type: 'pause' }, { z: 1, type: 'bogus' }] }])![0].customGcodes).toBeUndefined();
  });
});

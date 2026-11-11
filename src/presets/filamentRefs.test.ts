import { describe, expect, it } from 'vitest';
import { meshPaint, objects, plates } from '../project/store';
import type { ProjectObject } from '../project/types';
import { applySlotChange, clampFilamentIndexKeys, clampModelFilamentRefs, paintStateMap, processFilamentWrites, remapFilamentId, remapOverrides, remapPaintMap, remapPaintString, remapSlotLists } from './filamentRefs';

/** One leaf, as FacetsAnnotation::get_triangle_as_string writes it (read from the end). */
const leaf = (s: number) => (s < 3 ? (s << 2).toString(16) : s < 18 ? `${(s - 3).toString(16)}C` : `${(s - 18).toString(16)}FC`).toUpperCase();
/** A triangle split in 4 (code 3) with leaves a, b, c, d in reading order. */
const split4 = (a: number, b: number, c: number, d: number) => `${leaf(d)}${leaf(c)}${leaf(b)}${leaf(a)}3`;

describe('filament numbers', () => {
  it('delete: the slot → replacement or default, later ones − 1', () => {
    const c = { kind: 'delete' as const, slot: 2 };
    expect(remapFilamentId(1, c, 1)).toBe(1);
    expect(remapFilamentId(2, c, 1)).toBe(1);
    expect(remapFilamentId(2, c, null)).toBeNull();
    expect(remapFilamentId(5, c, 1)).toBe(4);
    expect(remapFilamentId(2, { ...c, replace: 3 }, 1)).toBe(3);
    expect(remapFilamentId(0, c, 1)).toBe(0);
  });
  it('insert: references at or after the first new slot move up', () => {
    const c = { kind: 'insert' as const, at: 3, count: 2 };
    expect(remapFilamentId(2, c, 1)).toBe(2);
    expect(remapFilamentId(3, c, 1)).toBe(5);
  });
  it('override bags: extruder (default given), support filaments removed / renumbered, nothing else', () => {
    const c = { kind: 'delete' as const, slot: 2 };
    expect(remapOverrides({ extruder: '2', support_filament: '2', support_interface_filament: '3', outer_wall_filament_id: '3', layer_height: '0.2' }, c, 1))
      .toEqual({ extruder: '1', support_interface_filament: '2', outer_wall_filament_id: '3', layer_height: '0.2' });
    // Insert (add_custom_filament): extruder only.
    expect(remapOverrides({ extruder: '3', support_filament: '3' }, { kind: 'insert', at: 3, count: 1 }, 1)).toEqual({ extruder: '4', support_filament: '3' });
    const same = { extruder: '1' };
    expect(remapOverrides(same, c, 1)).toBe(same);
    expect(remapOverrides({ extruder: '2' }, c, 0)).toEqual({ extruder: '0' });
  });
  it('per-slot lists lose / gain the slot; plate sequences drop it (first layer + every other-layers entry)', () => {
    expect(remapSlotLists({ filament_map: ['1', '2', '1'], first_layer_print_sequence: ['3', '2', '1'] }, { kind: 'delete', slot: 2 }, true))
      .toEqual({ filament_map: ['1', '1'], first_layer_print_sequence: ['2', '1'] });
    // Auto first layer order (0) is left alone; other layers: [begin, end, order…] per entry.
    expect(remapSlotLists({ first_layer_print_sequence: ['0'], other_layers_print_sequence: ['2', '5', '1', '2', '3', '6', '9', '3', '2', '1'], other_layers_print_sequence_nums: '2' },
      { kind: 'delete', slot: 2 }, true)).toEqual({ first_layer_print_sequence: ['0'], other_layers_print_sequence: ['2', '5', '1', '2', '6', '9', '2', '1'], other_layers_print_sequence_nums: '2' });
    // Project lists: the new entry in place (set_num_filaments defaults: map 1, nozzle 0, volume Standard)…
    expect(remapSlotLists({ filament_volume_map: ['1', '1'], filament_nozzle_map: ['1', '1'] }, { kind: 'insert', at: 2, count: 1 }))
      .toEqual({ filament_volume_map: ['1', '0', '1'], filament_nozzle_map: ['1', '0', '1'] });
    // …plates append (PartPlate::on_filament_added), the volume entry from the first extruder's type.
    expect(remapSlotLists({ filament_map: ['2', '2'], filament_volume_map: ['0', '0'] }, { kind: 'insert', at: 2, count: 1 }, true, '1'))
      .toEqual({ filament_map: ['2', '2', '1'], filament_volume_map: ['0', '0', '1'] });
  });
  it('process filament numbers after a delete (Plater copy + reset_invalid_filament)', () => {
    const del = { kind: 'delete' as const, slot: 1 };
    const get = (v: Record<string, string>) => (k: string) => v[k];
    // 3 → 2 slots: support 3 is past the end → the Plater copy's 2; support 2 stays (not renumbered).
    expect(processFilamentWrites(get({ support_filament: '3', support_interface_filament: '2' }), del, 2, () => false)).toEqual({ support_filament: '2' });
    // Deleting the last one: its support value goes to 0.
    expect(processFilamentWrites(get({ support_filament: '3' }), { kind: 'delete', slot: 3 }, 2, () => false)).toEqual({ support_filament: '0' });
    // Wipe tower / wall ids keep an out-of-range value (the Plater copy is the same); top / bottom / solid ids → 0.
    expect(processFilamentWrites(get({ wipe_tower_filament: '3', outer_wall_filament_id: '3', top_surface_filament_id: '3' }), del, 2, () => false)).toEqual({ top_surface_filament_id: '0' });
    // Support / wipe tower on a mixed slot → 0; feature ids may use one.
    expect(processFilamentWrites(get({ wipe_tower_filament: '2', sparse_infill_filament_id: '2' }), del, 2, (n) => n === 2)).toEqual({ wipe_tower_filament: '0' });
  });
  it('full_fff_config clamps', () => {
    expect(clampFilamentIndexKeys({ support_filament: '5', wipe_tower_filament: '-1', inner_wall_filament_id: '4', top_surface_filament_id: '2' }, 3))
      .toEqual({ support_filament: '3', wipe_tower_filament: '0', inner_wall_filament_id: '0', top_surface_filament_id: '2' });
  });
});

describe('colour paint states (TriangleSelector bitstream)', () => {
  it('leaf encodings round-trip', () => {
    for (const s of [0, 1, 2, 3, 4, 17, 18, 31]) expect(remapPaintString(leaf(s), (x) => x)).toBe(leaf(s));
  });
  it('remaps leaves of split triangles, re-encoding when the length changes', () => {
    const del = paintStateMap({ kind: 'delete', slot: 2 });
    expect(remapPaintString(split4(1, 2, 3, 19), del)).toBe(split4(1, 0, 2, 18));
    expect(remapPaintString(split4(1, 1, 1, 1), del)).toBe(split4(1, 1, 1, 1));
    const ins = paintStateMap({ kind: 'insert', at: 3, count: 1 });
    expect(remapPaintString(split4(2, 3, 17, 0), ins)).toBe(split4(2, 4, 18, 0));
  });
  it('Orca\'s own two-colour triangle string', () => {
    // Model::obj_import_vertex_color_deal: result0 + result1 + result1 + "2" (one side split, 2 children).
    const s = `${leaf(3)}${leaf(1)}${leaf(1)}2`;
    expect(remapPaintString(s, paintStateMap({ kind: 'delete', slot: 1 }))).toBe(`${leaf(2)}${leaf(0)}${leaf(0)}2`);
  });
  it('drops triangles that become unpainted', () => {
    expect(remapPaintMap([[0, leaf(2)], [5, leaf(3)]], { kind: 'delete', slot: 2 })).toEqual([[5, leaf(2)]]);
  });
});

describe('applySlotChange', () => {
  it('renumbers objects, parts, ranges, paint, plates and the process values in one step', () => {
    const obj = {
      id: 'o1', name: 'A', meshId: 'm1', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true, printable: true, color: '',
      overrides: { extruder: '3' },
      parts: [{ id: 'p1', name: 'mod', meshId: 'm2', type: 'modifier', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], overrides: { extruder: '2' } }],
      layerRanges: [{ id: 'r1', min: 0, max: 1, overrides: { extruder: '2' } }],
    } as unknown as ProjectObject;
    objects.value = [obj];
    meshPaint.value = { m1: { color: [[0, leaf(3)], [1, leaf(2)]] } };
    plates.value = [{ name: '', locked: false, config: { filament_map: ['1', '2', '1'] }, customGcodes: [{ z: 1, type: 'tool_change', extruder: 2 }, { z: 2, type: 'tool_change', extruder: 3 }, { z: 3, type: 'color_change', extruder: 3 }] }];
    const project: Record<string, string | string[]> = { filament_map: ['1', '2', '2'] };
    const process: Record<string, string> = { support_filament: '3' };
    applySlotChange({ kind: 'delete', slot: 2 }, {
      project,
      value: (_k, key) => process[key],
      setValue: (_k, key, v) => { process[key] = String(v); },
    }, 2);
    const o = objects.value[0];
    expect(o.overrides.extruder).toBe('2');
    expect(o.parts![0].overrides.extruder).toBe('1');
    expect(o.layerRanges![0].overrides.extruder).toBe('0');
    expect(meshPaint.value.m1.color).toEqual([[0, leaf(2)]]);
    expect(plates.value[0].config!.filament_map).toEqual(['1', '1']);
    // Tool changes renumbered / dropped; colour changes untouched.
    expect(plates.value[0].customGcodes).toEqual([{ z: 2, type: 'tool_change', extruder: 2 }, { z: 3, type: 'color_change', extruder: 3 }]);
    expect(project.filament_map).toEqual(['1', '2']);
    expect(process.support_filament).toBe('2');
  });
});

describe('clampModelFilamentRefs (opening a project onto fewer filaments)', () => {
  const obj = (overrides: Record<string, string>, parts: Array<Record<string, string>> = []): ProjectObject => ({
    id: 'o', name: 'o', meshId: 'm', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true, printable: true, color: '', overrides,
    ...(parts.length ? { parts: parts.map((ov, i) => ({ id: `p${i}`, name: 'p', meshId: `pm${i}`, type: 'ModelPart', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], overrides: ov })) } : {}),
  }) as ProjectObject;
  it('objects past the last slot (or 0) → 1; parts past it lose their own; support filaments past it are removed', () => {
    const data = {
      objects: [
        obj({ extruder: '8', support_filament: '5', support_interface_filament: '2' }),
        obj({ extruder: '3' }, [{ extruder: '6', support_filament: '4' }, { extruder: '2' }, { extruder: '0' }]),
        obj({ extruder: '0' }),
        obj({}),
      ],
    };
    expect(clampModelFilamentRefs(data, 3)).toBe(true);
    expect(data.objects[0].overrides).toEqual({ extruder: '1', support_interface_filament: '2' });
    expect(data.objects[1].overrides).toEqual({ extruder: '3' });
    expect(data.objects[1].parts!.map((p) => p.overrides)).toEqual([{}, { extruder: '2' }, {}]);
    expect(data.objects[2].overrides).toEqual({ extruder: '1' });
    expect(data.objects[3].overrides).toEqual({});
    expect(clampModelFilamentRefs(data, 3)).toBe(false);
  });
  it('colour paint past the last slot → unpainted; plate per-slot lists resized', () => {
    const data = {
      objects: [],
      paint: { m: { color: [[0, split4(1, 4, 3, 0)], [1, leaf(5)], [2, leaf(2)]] as Array<[number, string]> } },
      plates: [{ config: { filament_map: ['1', '2', '2', '1', '2'], filament_volume_map: ['1'], filament_nozzle_map: '0,0,1' } }] as never,
    };
    expect(clampModelFilamentRefs(data, 3)).toBe(true);
    expect(data.paint.m.color).toEqual([[0, split4(1, 0, 3, 0)], [2, leaf(2)]]);
    expect((data.plates as Array<{ config: Record<string, unknown> }>)[0].config).toEqual({ filament_map: ['1', '2', '2'], filament_volume_map: ['1', '0', '0'], filament_nozzle_map: '0,0,1' });
  });
});

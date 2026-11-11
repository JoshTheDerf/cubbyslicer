import { describe, expect, it, vi } from 'vitest';
import type { SliceObjectInput } from '../engine/types';
import type { WipeTowerFootprintArgs, WipeTowerFootprintResult } from '../engine/tools';
import { paintStatesUsed } from '../lib/paintStates';
import { anchorOf, placeTower, plateFilaments, plateHeights, setAnchor, towerMayPrint, withTowerAnchor } from './wipeTower';

const cube = (z0: number, h: number): Pick<SliceObjectInput, 'positions' | 'indices' | 'transform'> => ({
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, h]), indices: new Uint32Array([0, 1, 2]),
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 50, 50, z0, 1],
});
const obj = (o: Partial<SliceObjectInput>): SliceObjectInput => ({ id: 'o', name: 'o', ...cube(0, 10), ...o });
const cfg = { filament_colour: ['#f00', '#0f0', '#00f', '#fff', '#888'], enable_prime_tower: '1', layer_height: '0.2' };

describe('paintStatesUsed (TriangleSplittingData::update_used_states)', () => {
  it('reads leaf states, the extended "11" prefix and split trees', () => {
    expect([...paintStatesUsed('4')]).toEqual([1]);
    expect([...paintStatesUsed('8')]).toEqual([2]);
    expect([...paintStatesUsed('0C')]).toEqual([3]);
    expect([...paintStatesUsed('EC')]).toEqual([17]);
    expect([...paintStatesUsed('0FC')]).toEqual([18]);
    expect([...paintStatesUsed('EFC')]).toEqual([32]);
    // Split into 4 (code 3): children 1, 2, 0, 3.
    expect([...paintStatesUsed('0C0843')].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('plateFilaments (PartPlate::get_extruders(true))', () => {
  it('objects, parts, paint, support, per-feature filaments, tool changes; mixed slots expanded', () => {
    const job = {
      config: { ...cfg, enable_support: '0', support_filament: '4', sparse_infill_filament_id: '0', filament_is_mixed: ['0', '0', '0', '0', '1'], filament_mixed_components: ['', '', '', '', '1,3'] },
      objects: [
        obj({ config: { extruder: '2' }, paint: { color: [[0, '8'], [1, '0C']] } }),
        obj({ parts: [{ id: 'p', name: 'p', type: 'negative', ...cube(0, 1), config: { extruder: '4' } }, { id: 'm', name: 'm', type: 'modifier', ...cube(0, 1), config: { extruder: '5' } }] }),
      ],
      options: { customGcodes: [{ z: 5, type: 'tool_change' as const, extruder: 4 }] },
    };
    expect(plateFilaments(job)).toEqual([1, 2, 3, 4]);
    // Support on: its filament joins.
    expect(plateFilaments({ config: { ...cfg, enable_support: '1', support_filament: '5' }, objects: [obj({})] })).toEqual([1, 5]);
    expect(plateFilaments({ config: { ...cfg, enable_support: '1', support_filament: '0' }, objects: [obj({ config: { enable_support: '0' } })] })).toEqual([1]);
  });
  it('tallest object and thinnest layer', () => {
    expect(plateHeights({ config: cfg, objects: [obj({}), obj({ ...cube(0, 30), config: { layer_height: '0.12' } })] })).toEqual({ maxHeight: 30, layerHeight: 0.12 });
    expect(plateHeights({ config: cfg, objects: [obj({ parts: [{ id: 'p', name: 'p', type: 'part', ...cube(0, 1), config: { layer_height: '0.1' } }] })] }).layerHeight).toBe(0.1);
    expect(plateHeights({ config: cfg, objects: [obj({ layerRanges: [{ min: 1, max: 2, config: { layer_height: '0.08' } }] })] }).layerHeight).toBe(0.08);
    expect(plateHeights({ config: cfg, objects: [obj({ layerHeightProfile: [0, 0.2, 5, 0.06] })] }).layerHeight).toBe(0.06);
  });
  it('only plates with a tower call the engine', () => {
    expect(towerMayPrint(cfg, [1])).toBe(false);
    expect(towerMayPrint(cfg, [1, 2])).toBe(true);
    expect(towerMayPrint({ ...cfg, enable_prime_tower: '0' }, [1, 2])).toBe(false);
    expect(towerMayPrint({ ...cfg, timelapse_type: 'Smooth' }, [1])).toBe(true);
  });
});

describe('placeTower', () => {
  const result = (x: number, y: number, dx = 0, dy = 0): WipeTowerFootprintResult => ({
    printed: true, towerType: 'Type2', width: 35, depth: 40, height: 10, brim: 3, coneMargin: 0, rotation: 0, filaments: [1, 2],
    outline: [], footprint: [], printableArea: [], placement: { x: x + dx, y: y + dy, moved: dx !== 0 || dy !== 0, fits: true }, defaultPosition: { x: 165, y: 250, fits: true },
  });
  const job = { config: cfg, objects: [obj({ config: { extruder: '1' }, paint: { color: [[0, '8']] } })] };
  it('a new plate starts at desktop\'s default spot (sized for 2 filaments), then gets checked', async () => {
    const call = vi.fn(async (a: WipeTowerFootprintArgs) => result(a.position?.[0] ?? 0, a.position?.[1] ?? 0));
    const r = await placeTower(job, null, call, 'N9');
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0]).toMatchObject({ minFilaments: 2, filaments: [1, 2], maxHeight: 10, layerHeight: 0.2, printerModelId: 'N9' });
    expect(call.mock.calls[1][0].position).toEqual([165, 250]);
    expect(r?.placement).toMatchObject({ x: 165, y: 250 });
  });
  it('a saved anchor is only checked (and moved when it does not fit)', async () => {
    const call = vi.fn(async (a: WipeTowerFootprintArgs) => result(a.position![0], a.position![1], 0, -60));
    const r = await placeTower(job, [20, 280], call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(r?.placement).toMatchObject({ x: 20, y: 220, moved: true });
  });
  it('no tower: no engine call', async () => {
    const call = vi.fn();
    expect(await placeTower({ config: cfg, objects: [obj({})] }, null, call)).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });
});

describe('anchors', () => {
  it('per plate in the project, at index 0 in a job', () => {
    expect(anchorOf({ wipe_tower_x: ['10', '20'], wipe_tower_y: ['30', '40'] }, 1)).toEqual([20, 40]);
    expect(anchorOf({ wipe_tower_x: ['10'], wipe_tower_y: ['30'] }, 1)).toBeNull();
    expect(setAnchor(['10'], 2, 55.12345)).toEqual(['10', '10', '55.123']);
    expect(withTowerAnchor({ wipe_tower_x: ['1', '2'] }, 5, 6)).toEqual({ wipe_tower_x: ['5'], wipe_tower_y: ['6'] });
  });
});

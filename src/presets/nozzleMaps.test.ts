import { describe, expect, it } from 'vitest';
import type { FlatConfig } from '../engine/types';
import {
  effectiveNozzleStats, finishNozzleMaps, hasNozzleRack, nozzleList, parseNozzleStats, seedNozzleStats, statsAfterTypeSwitch,
} from './nozzleMaps';

// Bambu Lab H2C 0.4: left extruder one nozzle, right extruder a 6-nozzle rack.
const h2c: FlatConfig = {
  nozzle_diameter: ['0.4', '0.4'], extruder_max_nozzle_count: ['1', '6'], filament_diameter: ['1.75', '1.75', '1.75'],
  nozzle_volume_type: ['Standard', 'Hybrid'], filament_map_mode: 'Manual', filament_map: ['1', '2', '2'], filament_volume_map: ['0', '0', '1'],
  flush_multiplier: ['1'],
};

const without = (c: FlatConfig, k: string): FlatConfig => Object.fromEntries(Object.entries(c).filter(([key]) => key !== k));

describe('extruder_nozzle_stats', () => {
  it('seeds like desktop: each extruder its max count of its type, Hybrid as Standard', () => {
    expect(seedNozzleStats(['Standard', 'Hybrid'], [1, 6])).toEqual(['Standard#1', 'Standard#6']);
    expect(seedNozzleStats(['High Flow', 'High Flow'], [1, 6])).toEqual(['High Flow#1', 'High Flow#6']);
  });
  it('keeps a split that fits, reseeds one that does not', () => {
    // An extruder may have no nozzles while the other has some (desktop reseeds only missing stats).
    expect(effectiveNozzleStats(['', 'Standard#3|High Flow#3'], ['Standard', 'Hybrid'], [1, 6])).toEqual(['Standard#0', 'Standard#3|High Flow#3']);
    expect(effectiveNozzleStats(['Standard#1', 'High Flow#0'], ['Standard', 'High Flow'], [1, 6])).toEqual(['Standard#1', 'High Flow#0']);
    // Not both.
    expect(effectiveNozzleStats(['Standard#0', ''], ['Standard', 'Hybrid'], [1, 6])).toEqual(['Standard#1', 'Standard#6']);
    expect(effectiveNozzleStats(['Standard#1', 'Standard#4|High Flow#3'], ['Standard', 'Hybrid'], [1, 6])).toEqual(['Standard#1', 'Standard#6']);
    // A single-type extruder holds only its own type.
    expect(effectiveNozzleStats(['Standard#1', 'Standard#3|High Flow#3'], ['Standard', 'High Flow'], [1, 6])).toEqual(['Standard#1', 'High Flow#6']);
    expect(effectiveNozzleStats(undefined, ['Standard', 'Hybrid'], [1, 6])).toEqual(['Standard#1', 'Standard#6']);
  });
  it('a type switch moves the whole rack to that type; Hybrid keeps the split', () => {
    expect(statsAfterTypeSwitch(['Standard#1', 'Standard#3|High Flow#3'], 1, 'High Flow', 6)).toEqual(['Standard#1', 'High Flow#6']);
    expect(statsAfterTypeSwitch(['Standard#1', 'Standard#6'], 1, 'Hybrid', 6)).toEqual(['Standard#1', 'Standard#6']);
  });
  it('parses tokens and lists nozzles in desktop\'s order', () => {
    expect(parseNozzleStats('Standard#3|High Flow#3|bad|Hybrid#2')).toEqual({ Standard: 3, 'High Flow': 3 });
    expect(nozzleList(['Standard#1', 'High Flow#3|Standard#3']).map((n) => `${n.extruder}:${n.type}`)).toEqual([
      '0:Standard', '1:Standard', '1:Standard', '1:Standard', '1:High Flow', '1:High Flow', '1:High Flow',
    ]);
  });
});

describe('finishNozzleMaps', () => {
  it('H2C Manual: stats per extruder, the volume map as sent, one flush multiplier per extruder', () => {
    const out = finishNozzleMaps({ ...h2c, extruder_nozzle_stats: ['Standard#1', 'Standard#3|High Flow#3'] });
    expect(hasNozzleRack(h2c)).toBe(true);
    expect(out.extruder_nozzle_stats).toEqual(['Standard#1', 'Standard#3|High Flow#3']);
    expect(out.filament_volume_map).toEqual(['0', '0', '1']);
    expect(out.flush_multiplier).toEqual(['1', '1']);
    expect(out.filament_nozzle_map).toBeUndefined();
  });
  it('fills filament_volume_map from each filament\'s extruder, also for slots added later', () => {
    const out = finishNozzleMaps({ ...without(h2c, 'filament_volume_map'), filament_map_mode: 'Auto For Flush', filament_diameter: ['1.75', '1.75', '1.75', '1.75'] });
    expect(out.filament_map).toEqual(['1', '2', '2', '1']);
    expect(out.filament_volume_map).toEqual(['0', '2', '2', '0']);
  });
  it('Manual: a filament on a single-type extruder takes that type', () => {
    const out = finishNozzleMaps({ ...h2c, nozzle_volume_type: ['Standard', 'High Flow'], filament_volume_map: ['1', '0', '0'] });
    expect(out.filament_volume_map).toEqual(['0', '1', '1']);
  });
  it('Nozzle Manual: a concrete volume map and a nozzle per filament (H2C example 0,1,4)', () => {
    const cfg = { ...h2c, filament_map_mode: 'Nozzle Manual', extruder_nozzle_stats: ['Standard#1', 'Standard#3|High Flow#3'] };
    const out = finishNozzleMaps(cfg);
    expect(out.filament_nozzle_map).toEqual(['0', '1', '4']);
    expect(out.filament_volume_map).toEqual(['0', '0', '1']);
    // A Hybrid ("any") entry takes the extruder's first nozzle; a sent map that fits stays and the volume map follows it.
    expect(finishNozzleMaps({ ...cfg, filament_volume_map: ['0', '2', '1'] }).filament_nozzle_map).toEqual(['0', '1', '4']);
    const kept = finishNozzleMaps({ ...cfg, filament_nozzle_map: ['0', '5', '2'] });
    expect(kept.filament_nozzle_map).toEqual(['0', '5', '2']);
    expect(kept.filament_volume_map).toEqual(['0', '1', '0']);
  });
  it('flush_multiplier: desktop\'s default 0.3, extra extruders 1.0', () => {
    expect(finishNozzleMaps(without(h2c, 'flush_multiplier')).flush_multiplier).toEqual(['0.3', '1']);
    expect(finishNozzleMaps({ ...h2c, flush_multiplier: ['1.5', '1.2', '9'] }).flush_multiplier).toEqual(['1.5', '1.2']);
  });
  it('single-extruder printers keep their nozzle maps unless they carry one', () => {
    const p1s: FlatConfig = { nozzle_diameter: ['0.4'], filament_diameter: ['1.75', '1.75'], flush_multiplier: ['1'] };
    expect(finishNozzleMaps(p1s)).toEqual(p1s);
    expect(finishNozzleMaps({ ...p1s, filament_volume_map: ['0'] }).filament_volume_map).toEqual(['0', '0']);
  });
  it('is idempotent', () => {
    const once = finishNozzleMaps({ ...h2c, filament_map_mode: 'Nozzle Manual' });
    expect(finishNozzleMaps(once)).toEqual(once);
  });
});

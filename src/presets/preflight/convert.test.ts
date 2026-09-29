import { describe, expect, it } from 'vitest';
import { orcaToPreflight, splitOrcaCompat, translateGcode } from './convert';
import type { ConfigSchema } from '../../engine/types';

const VECTORS = new Set(['temperature', 'first_layer_temperature', 'nozzle_diameter', 'first_layer_bed_temperature', 'filament_type']);
const isVector = (k: string) => VECTORS.has(k);

describe('translateGcode', () => {
  it('indexes bare vector references inside {…} expressions', () => {
    expect(translateGcode('M104 S{temperature}', isVector)).toBe('M104 S{temperature[0]}');
    expect(translateGcode('{if (nozzle_diameter == 0.2)}x{endif}', isVector)).toBe('{if (nozzle_diameter[0] == 0.2)}x{endif}');
    // Orca name aliased to a preFlight vector (nozzle_temperature → temperature)
    expect(translateGcode('{nozzle_temperature}', isVector)).toBe('{nozzle_temperature[0]}');
  });
  it('leaves indexed names, strings, scalars, assignments and [bracket] syntax alone', () => {
    const g = '{if filament_type[0]=="PLA" and layer_height > 0.1}{local temperature = 5}M109 S[temperature] ; {"temperature"}';
    expect(translateGcode(g, isVector)).toBe(g);
  });
});

describe('orcaToPreflight printer fix-ups', () => {
  const native = () => true;
  it('Klipper: machine limits for time estimate only, no temperature auto-emit, G92 E0 per layer', () => {
    const out = orcaToPreflight('printer', {
      gcode_flavor: 'klipper', machine_limits_usage: 'emit_to_gcode', use_relative_e_distances: '1', layer_gcode: 'SET_PRINT_STATS_INFO',
    }, native);
    expect(out.machine_limits_usage).toBe('time_estimate_only');
    expect(out.autoemit_temperature_commands).toBe('0');
    expect(out.layer_gcode).toBe('SET_PRINT_STATS_INFO\nG92 E0');
  });
  it('resolves percentage accelerations', () => {
    const isNative = (k: string) => ['default_acceleration', 'external_perimeter_acceleration', 'infill_acceleration', 'solid_infill_acceleration', 'bridge_acceleration'].includes(k);
    const out = orcaToPreflight('process', {
      default_acceleration: '10000', outer_wall_acceleration: '5000', sparse_infill_acceleration: '100%',
      internal_solid_infill_acceleration: '50%', bridge_acceleration: '50%',
    }, isNative);
    expect(out.infill_acceleration).toBe('10000');
    expect(out.solid_infill_acceleration).toBe('5000');
    expect(out.bridge_acceleration).toBe('2500');
  });
});

describe('splitOrcaCompat', () => {
  const schema = {
    engine: 'orca', version: 'x', options: {
      activate_air_filtration: { type: 'bools', scope: 'filament' },
      textured_plate_temp: { type: 'ints', scope: 'filament' },
      hot_plate_temp: { type: 'ints', scope: 'filament' },
      curr_bed_type: { type: 'enum', scope: 'other', enumValues: ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Textured PEI Plate'] },
    },
  } as unknown as ConfigSchema;
  it('moves orca:* keys to typed placeholder vars and re-picks the plate bed temperature', () => {
    const { config, vars } = splitOrcaCompat({
      bed_temperature: ['55'], first_layer_bed_temperature: ['55'], bed_shape: ['0x0', '256x0', '256x256', '0x256'],
      'orca:activate_air_filtration': ['0'], 'orca:hot_plate_temp': ['55'], 'orca:textured_plate_temp': ['65'],
      'orca:curr_bed_type': 'Textured PEI Plate',
    }, schema);
    expect(Object.keys(config).some((k) => k.startsWith('orca:'))).toBe(false);
    expect(vars.activate_air_filtration).toEqual({ type: 'bools', value: ['0'] });
    expect(config.bed_temperature).toEqual(['65']);
    expect(vars.first_layer_center_no_wipe_tower.value).toEqual(['128', '128']);
  });
  it('keeps a user-edited bed temperature', () => {
    const { config } = splitOrcaCompat({
      bed_temperature: ['70'], 'orca:hot_plate_temp': ['55'], 'orca:textured_plate_temp': ['65'], 'orca:curr_bed_type': 'Textured PEI Plate',
    }, schema);
    expect(config.bed_temperature).toEqual(['70']);
  });
});

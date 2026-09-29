import { describe, expect, it } from 'vitest';
import type { ConfigSchema } from '../../engine/types';
import { filamentOverrides, filamentPresetName, printerOverrides, printerPresetName, rectBed } from './createPreset';

const schema = (keys: string[]) => ({ engine: 'orca', version: '', options: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])) }) as unknown as ConfigSchema;

describe('create printer / filament', () => {
  it('names presets like Orca', () => {
    expect(printerPresetName({ vendor: 'Acme', model: 'Box 300', nozzle: '0.4' })).toBe('Acme Box 300 0.4 nozzle');
    expect(filamentPresetName({ vendor: 'Acme', type: 'PETG', serial: 'HF' })).toBe('Acme PETG HF');
  });

  it('builds the bed with Orca origin semantics', () => {
    expect(rectBed(220, 200, 0, 0)).toEqual(['0x0', '220x0', '220x200', '0x200']);
    expect(rectBed(200, 200, 100, 100)).toEqual(['-100x-100', '100x-100', '100x100', '-100x100']);
  });

  it('writes Orca or preFlight printer keys and fills every extruder', () => {
    const f = { vendor: 'Acme', model: 'Box', nozzle: '0.6', width: 250, depth: 210, originX: 0, originY: 0, height: 180 };
    const o = printerOverrides(f, schema(['printer_model', 'printer_variant', 'nozzle_diameter', 'printable_area', 'printable_height']), ['0.4', '0.4']);
    expect(o).toEqual({ printer_model: 'Box', printer_variant: '0.6', nozzle_diameter: ['0.6', '0.6'], printable_area: ['0x0', '250x0', '250x210', '0x210'], printable_height: '180' });
    const pf = printerOverrides(f, schema(['nozzle_diameter', 'bed_shape', 'max_print_height']), ['0.4']);
    expect(pf).toEqual({ nozzle_diameter: ['0.6'], bed_shape: ['0x0', '250x0', '250x210', '0x210'], max_print_height: '180' });
  });

  it('filament overrides: vendor, changed type, printers', () => {
    const o = filamentOverrides({ vendor: 'Acme', type: 'PETG', serial: '', printers: ['P1'] }, schema(['filament_vendor', 'filament_type']), { filament_type: ['PLA'] });
    expect(o).toEqual({ filament_vendor: ['Acme'], filament_type: ['PETG'], compatible_printers: ['P1'], compatible_printers_condition: '' });
    const same = filamentOverrides({ vendor: '', type: 'PLA', serial: '', printers: [] }, null, { filament_type: ['PLA'] });
    expect(same.filament_type).toBeUndefined();
    expect(same.filament_vendor).toEqual(['Generic']);
  });
});

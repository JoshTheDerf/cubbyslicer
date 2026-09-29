import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { readPresetFile } from '../../presets/bundleImport';
import type { UserPreset } from '../../presets/userPresets';
import { filamentBaseName, filamentBundle, ORCA_PRESET_VERSION, presetJson, presetsZip, printerBundle } from './bundleExport';

const mk = (kind: UserPreset['kind'], name: string, values: UserPreset['values'], inherits?: string): UserPreset => ({
  id: `user:${name}`, engine: 'orca', kind, name, inherits, parentId: inherits ? `sys:X/${inherits}` : undefined, values, createdAt: 0, updatedAt: 0,
});

const printer = mk('printer', 'My Voron 0.4 nozzle', { printable_area: ['0x0', '300x0', '300x300', '0x300'], nozzle_diameter: ['0.4'] }, 'Voron 2.4 300 0.4 nozzle');
const fil = mk('filament', 'Acme PLA @My Voron', { filament_vendor: ['Acme'], compatible_printers: ['My Voron 0.4 nozzle'] }, 'Generic PLA @System');
const other = mk('filament', 'Other PETG', { filament_vendor: ['Other'] }, 'Generic PETG @System');
const proc = mk('process', '0.20mm Fast @My Voron', { layer_height: '0.2', compatible_printers: ['My Voron 0.4 nozzle'] }, '0.20mm Standard @Voron');

describe('preset bundle export (Orca ExportConfigsDialog)', () => {
  it('writes Orca user-preset JSON with version and inherits', () => {
    const j = presetJson(fil);
    expect(j).toMatchObject({ type: 'filament', name: 'Acme PLA @My Voron', from: 'User', instantiation: 'true', inherits: 'Generic PLA @System', version: ORCA_PRESET_VERSION });
    expect(j.filament_settings_id).toEqual(['Acme PLA @My Voron']);
  });

  it('builds a .orca_printer with the printer, its filaments and processes', async () => {
    const b = printerBundle(printer, [printer, fil, other, proc], { now: new Date(2026, 0, 2, 3, 4, 5) });
    expect(b.filename).toBe('My Voron 0.4 nozzle.orca_printer');
    const files = unzipSync(b.data);
    const structure = JSON.parse(strFromU8(files['bundle_structure.json']));
    expect(structure).toMatchObject({
      bundle_type: 'printer config bundle', printer_preset_name: 'My Voron 0.4 nozzle',
      printer_config: ['printer/My Voron 0.4 nozzle.json'], filament_config: ['filament/Acme PLA @My Voron.json'], process_config: ['process/0.20mm Fast @My Voron.json'],
    });
    expect(structure.bundle_id).toBe('offline_My Voron 0.4 nozzle_20260102030405');
    // round trip through the importer
    const r = await readPresetFile(b.filename, b.data);
    expect(r.warnings).toEqual([]);
    expect(r.presets.map((p) => `${p.kind}:${p.name}`).sort()).toEqual(['filament:Acme PLA @My Voron', 'printer:My Voron 0.4 nozzle', 'process:0.20mm Fast @My Voron']);
    expect(r.presets.find((p) => p.kind === 'printer')!.raw.inherits).toBe('Voron 2.4 300 0.4 nozzle');
  });

  it('builds a .orca_filament grouped by vendor', async () => {
    const b = filamentBundle('Acme PLA', [{ preset: fil, vendor: 'Voron' }, { preset: fil, vendor: 'Voron' }]);
    const files = unzipSync(b.data);
    expect(Object.keys(files).sort()).toEqual(['Voron/Acme PLA @My Voron.json', 'bundle_structure.json']);
    const s = JSON.parse(strFromU8(files['bundle_structure.json']));
    expect(s).toMatchObject({ bundle_type: 'filament config bundle', filament_name: 'Acme PLA', printer_vendor: [{ vendor: 'Voron', filament_path: ['Voron/Acme PLA @My Voron.json'] }] });
    const r = await readPresetFile(b.filename, b.data);
    expect(r.presets).toHaveLength(1);
    expect(r.presets[0].kind).toBe('filament');
  });

  it('builds flat preset zips', async () => {
    const b = presetsZip('filament', [fil, other]);
    expect(b.filename).toBe('Filament presets.zip');
    const r = await readPresetFile(b.filename, b.data);
    expect(r.presets.map((p) => p.name).sort()).toEqual(['Acme PLA @My Voron', 'Other PETG']);
    expect(filamentBaseName('Acme PLA @My Voron')).toBe('Acme PLA');
  });
});

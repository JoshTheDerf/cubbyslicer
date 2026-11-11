import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { acceptedBedZipName, bedAssetExtension, readPresetFile } from '../../presets/bundleImport';
import { withStoredBedAssets } from '../../presets/userPresetOps';
import type { UserPreset } from '../../presets/userPresets';
import { dataUrlBytes, printerBundle } from './bundleExport';

const mk = (kind: UserPreset['kind'], name: string, values: UserPreset['values'], inherits?: string): UserPreset => ({
  id: `user:${name}`, engine: 'orca', kind, name, inherits, parentId: inherits ? `sys:X/${inherits}` : undefined, values, createdAt: 0, updatedAt: 0,
});

const printer = mk('printer', 'My Voron', { bed_custom_texture: 'cubby-asset:abc/bed.PNG', bed_custom_model: 'cubby-asset:def/plate.stl' }, 'Voron 2.4 300 0.4 nozzle');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const stl = strToU8('solid x\nendsolid x\n');

describe('printer bundle bed texture / model (Orca append_printer_bed_assets)', () => {
  it('packs bed/0/texture<ext> and bed/0/model.stl and lists them under printer_asset', () => {
    const b = printerBundle(printer, [printer], { bedAssets: { bed_custom_texture: { name: 'bed.PNG', data: png }, bed_custom_model: { name: 'plate.stl', data: stl } } });
    const files = unzipSync(b.data);
    expect(Object.keys(files).sort()).toEqual(['bed/0/model.stl', 'bed/0/texture.PNG', 'bundle_structure.json', 'printer/My Voron.json']);
    expect(files['bed/0/texture.PNG']).toEqual(png);
    expect(b.count).toBe(1);
    const s = JSON.parse(strFromU8(files['bundle_structure.json']));
    expect(s.printer_asset).toEqual({ 'printer/My Voron.json': { bed_custom_texture: 'bed/0/texture.PNG', bed_custom_model: 'bed/0/model.stl' } });
    // The printer JSON keeps its own value, as desktop does.
    expect(JSON.parse(strFromU8(files['printer/My Voron.json'])).bed_custom_texture).toBe('cubby-asset:abc/bed.PNG');
  });

  it('leaves out files the bed dialog would not accept, and printer_asset when nothing is packed', () => {
    const b = printerBundle(printer, [printer], { bedAssets: { bed_custom_texture: { name: 'bed.jpg', data: png } } });
    const files = unzipSync(b.data);
    expect(Object.keys(files).sort()).toEqual(['bundle_structure.json', 'printer/My Voron.json']);
    expect(JSON.parse(strFromU8(files['bundle_structure.json']))).not.toHaveProperty('printer_asset');
  });

  it('reads them back onto the printer', async () => {
    const b = printerBundle(printer, [printer], { bedAssets: { bed_custom_texture: { name: 'bed.svg', data: png }, bed_custom_model: { name: 'plate.stl', data: stl } } });
    const r = await readPresetFile(b.filename, b.data);
    expect(r.warnings).toEqual([]);
    expect(r.presets).toHaveLength(1);
    const a = r.presets[0].bedAssets!;
    expect(a.bed_custom_texture).toEqual({ name: 'texture.svg', data: png });
    expect(a.bed_custom_model).toEqual({ name: 'model.stl', data: stl });
  });

  it('reads a desktop-shaped bundle and ignores entries outside bed/<n>/', async () => {
    const files: Record<string, Uint8Array> = {
      'printer/P.json': strToU8(JSON.stringify({ type: 'machine', name: 'P', inherits: 'X', bed_custom_texture: 'C:\\beds\\a.png' })),
      'bed/0/texture.png': png,
      'evil/texture.png': png,
      'bundle_structure.json': strToU8(JSON.stringify({
        bundle_type: 'printer config bundle', printer_config: ['printer/P.json'],
        printer_asset: { 'printer/P.json': { bed_custom_texture: 'bed/0/texture.png', bed_custom_model: 'evil/../model.stl' }, 'printer/Missing.json': { bed_custom_texture: 'bed/0/texture.png' } },
      })),
    };
    const r = await readPresetFile('P.orca_printer', zipSync(files));
    expect(r.presets[0].bedAssets).toEqual({ bed_custom_texture: { name: 'texture.png', data: png } });
    expect(r.warnings).toHaveLength(1);
  });

  it('points the imported printer at the stored copies', async () => {
    const stored: string[] = [];
    const raw = await withStoredBedAssets(
      { raw: { name: 'P', bed_custom_texture: 'C:\\beds\\a.png' }, bedAssets: { bed_custom_texture: { name: 'texture.png', data: png } } },
      async (f) => { stored.push(f.name); return `cubby-asset:new/${f.name}`; },
    );
    expect(stored).toEqual(['texture.png']);
    expect(raw).toEqual({ name: 'P', bed_custom_texture: 'cubby-asset:new/texture.png' });
  });
});

describe('bed file names', () => {
  it('matches Orca bed_asset_extension / accepted_bed_zip_name', () => {
    expect(bedAssetExtension('a/b.Svg', 'bed_custom_texture')).toBe('.Svg');
    expect(bedAssetExtension('a.stl', 'bed_custom_texture')).toBe('');
    expect(bedAssetExtension('dir.png/model', 'bed_custom_model')).toBe('');
    expect(acceptedBedZipName('bed\\12\\model.STL', 'bed_custom_model')).toBe('bed/12/model.STL');
    expect(acceptedBedZipName('bed/0/plate.stl', 'bed_custom_model')).toBeNull();
    expect(acceptedBedZipName('bed/x/model.stl', 'bed_custom_model')).toBeNull();
    expect(acceptedBedZipName('bed/0/sub/model.stl', 'bed_custom_model')).toBeNull();
  });

  it('decodes stored data URLs', () => {
    expect(dataUrlBytes('data:image/png;base64,AQID')).toEqual(new Uint8Array([1, 2, 3]));
    expect(strFromU8(dataUrlBytes('data:image/svg+xml,%3Csvg%2F%3E'))).toBe('<svg/>');
  });
});

import { describe, expect, it } from 'vitest';
import { generatePresetSettingId } from './settingId';

describe('generate_preset_setting_id', () => {
  it('matches Orca 2.5’s golden vectors (tests/libslic3r/test_preset_setting_id.cpp)', async () => {
    for (const [vendor, type, name, id] of [
      ['Afinia', 'filament', 'Afinia ABS @Afinia H400', 'TL34qSVkppBvMvgH'],
      ['Afinia', 'process', '0.20mm Standard @Afinia H400', 'FzmtNsy7XQvpd7w0'],
      ['Afinia', 'machine', 'Afinia H400 0.4 nozzle', 'r4FZagW0S8uoaJPd'],
      ['Anycubic', 'filament', 'Generic PLA @Anycubic Kobra 2', 'YIWGGLQ8Oepd30Fv'],
      ['Creality', 'process', '0.16mm Optimal @Creality Ender-3 V3', '2Nrbq8PxssUPBLza'],
      ['Elegoo', 'machine', 'Elegoo Neptune 4 0.4 nozzle', '69QdWuRQwAZk9rFu'],
    ]) expect(await generatePresetSettingId(vendor, type, name), `${vendor}/${type}/${name}`).toBe(id);
    expect(await generatePresetSettingId('', 'filament', 'x')).toBe('');
  });
});

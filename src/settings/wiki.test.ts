import { describe, expect, it } from 'vitest';
import { settingWikiUrl } from './wiki';
import { orcaWikiPaths } from './layout/orcaWiki.generated';
import { settingItems } from '../app/actions/project/palette';

describe('settings wiki links (Orca Line::label_path → OptionsGroup::get_url)', () => {
  it('builds the URL from the row path as written, per Tab.cpp source', () => {
    // append_single_option_line("layer_height", "quality_settings_layer_height")
    expect(settingWikiUrl('orca', 'layer_height')).toBe('https://www.orcaslicer.com/wiki/quality_settings_layer_height');
    // A multi-option Line with label_path (Nozzle: initial layer + other layers).
    expect(settingWikiUrl('orca', 'nozzle_temperature_initial_layer')).toBe('https://www.orcaslicer.com/wiki/material_temperatures#nozzle');
    // An Option variable: option = get_option("filename_format"); append_single_option_line(option, path).
    expect(orcaWikiPaths.filename_format).toBe('others_settings_g_code_output#filename-format');
    // TabPrinter::append_option_line over a loop with a prefix ("machine_max_jerk_" + axis).
    expect(orcaWikiPaths.machine_max_jerk_e).toBe('printer_motion_ability#maximum-jerk');
    expect(orcaWikiPaths.machine_max_speed_z).toBe('printer_motion_ability#speed-limitation');
    // Rows without a path have no link (append_single_option_line("enable_mixed_color_sublayer")).
    expect(settingWikiUrl('orca', 'enable_mixed_color_sublayer')).toBeUndefined();
    expect(settingWikiUrl('orca', 'toString')).toBeUndefined();
    // preFlight has no Orca wiki paths.
    expect(settingWikiUrl('preflight', 'layer_height')).toBeUndefined();
  });

  it('a setting in the Speed Dial carries its wiki page', () => {
    const [it1] = settingItems([{ key: 'layer_height', label: 'Layer height', tab: 'process', pageTitle: 'Quality', groupTitle: 'Layer height',
      helpUrl: settingWikiUrl('orca', 'layer_height') }], () => {});
    expect(it1.helpUrl).toBe('https://www.orcaslicer.com/wiki/quality_settings_layer_height');
  });
});

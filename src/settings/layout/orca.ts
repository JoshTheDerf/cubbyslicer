/**
 * OrcaSlicer settings layout: the generated Tab.cpp table, small fixes for
 * rows Orca builds as custom widgets, and the keys Tab.cpp never places.
 */
import { orcaGenerated } from './orca.generated';
import { patchLayout } from './patch';
import type { EngineLayoutSource } from './types';

export const orcaLayout: EngineLayoutSource = patchLayout(orcaGenerated, [
  // Orca keeps these commented out ("Minimum feedrates"); they still drive the G-code, so they stay editable.
  { tab: 'machine', page: 'Motion ability', group: 'Advanced', keys: ['machine_min_extruding_rate', 'machine_min_travel_rate'] },
  // Written by Orca from `thumbnails` (TabPrinter::build_fff m_on_change); shown next to it.
  { tab: 'machine', page: 'Basic information', group: 'Advanced', keys: ['thumbnails_format'], after: 'thumbnails' },
  // The IDEX "Modes" grid (IMEXModesCtrl, plates/ImexModesEditor.vue) edits imex_mode_names / _active_tools / _gcodes together.
  { tab: 'machine', page: 'Multimaterial', group: 'IDEX/IQEX Configuration', keys: ['imex_mode_names'], after: 'imex_viz_theme' },
]);

/**
 * Preset keys (print / object / filament / machine scope) that Orca's Tab.cpp
 * doesn't place on a page, or that CubbySlicer doesn't show although it does. `layout/build.test.ts` fails when a schema key is
 * neither placed nor listed here, so an Orca upgrade can't silently drop a
 * setting into "More".
 * - `more`: no other editor in CubbySlicer; listed on the auto "More" page.
 * - `hidden`: never a settings row (preset bookkeeping, nozzle-variant tables
 *   the presets layer resolves, or values another dialog owns).
 */
export const ORCA_UNPLACED: Readonly<Record<string, 'more' | 'hidden'>> = {
  // Preset identity / bookkeeping.
  printer_technology: 'hidden', printer_model: 'hidden', printer_variant: 'hidden', inherits: 'hidden',
  default_filament_profile: 'hidden', default_print_profile: 'hidden', upward_compatible_machine: 'hidden',
  // Nozzle-variant tables (Orca 2.5 extruder variants): resolved by the presets layer / bridge, edited through
  // the variant switch (presets track), never as raw rows.
  extruder_type: 'hidden', default_nozzle_volume_type: 'hidden', extruder_variant_list: 'hidden',
  printer_extruder_id: 'hidden', printer_extruder_variant: 'hidden', master_extruder_id: 'hidden',
  print_extruder_id: 'hidden', print_extruder_variant: 'hidden', filament_extruder_variant: 'hidden',
  physical_extruder_map: 'hidden', extruder_max_nozzle_count: 'hidden',
  // Owned by other dialogs: bed texture / model (Bed shape), plate type (plate settings), per-plate IDEX mode,
  // the plugins list (plugins).
  bed_custom_texture: 'hidden', bed_custom_model: 'hidden', default_bed_type: 'hidden',
  imex_parallel_mode: 'hidden', imex_head_filament_map: 'hidden', plugins: 'hidden',
  // Edited with imex_mode_names in the Modes grid.
  imex_mode_active_tools: 'hidden', imex_mode_gcodes: 'hidden',
  // Physical printer connection (Orca's print host dialog). CubbySlicer keeps print hosts in printhost/store.
  print_host: 'hidden', print_host_webui: 'hidden', printhost_apikey: 'hidden', printhost_port: 'hidden',
  printhost_cafile: 'hidden', printhost_user: 'hidden', printhost_password: 'hidden', printhost_ssl_ignore_revoke: 'hidden',
  printhost_authorization_type: 'hidden', host_type: 'hidden', flashforge_serial_number: 'hidden',
  // Bambu device data and calibration internals.
  filament_dev_ams_drying_ams_limitations: 'hidden', filament_dev_ams_drying_temperature: 'hidden',
  filament_dev_ams_drying_time: 'hidden', filament_dev_ams_drying_heat_distortion_temperature: 'hidden',
  filament_dev_chamber_drying_bed_temperature: 'hidden', filament_dev_chamber_drying_time: 'hidden',
  filament_dev_drying_softening_temperature: 'hidden', filament_dev_drying_cooling_temperature: 'hidden',
  calib_flowrate_topinfill_special_order: 'hidden', wiping_volumes_extruders: 'hidden',
  // Placed by Tab.cpp but not applicable here: desktop network agents (no device manager), and the filament /
  // printer plugin overrides (no 2.5 option of those kinds references plugins). slicing_pipeline_plugin and
  // print_plugin_config_overrides are shown, with editors from src/plugins (SettingRow, gui types plugin_*).
  printer_agent: 'hidden', printer_plugin_config_overrides: 'hidden', filament_plugin_config_overrides: 'hidden',

  // Printer capabilities and machine data Orca sets from the profile only.
  support_parallel_printheads: 'more', parallel_printheads_bed_exclude_areas: 'more', nozzle_height: 'more', grab_length: 'more',
  extruder_colour: 'more', required_nozzle_HRC: 'more', support_cooling_filter: 'more', support_fast_purge_mode: 'more',
  wrapping_detection_layers: 'more', wrapping_exclude_area: 'more', head_wrap_detect_zone: 'more', farthest_point_timelapse: 'more',
  enable_long_retraction_when_cut: 'more', deretract_speed_extruder_change: 'more',
  machine_max_force_Y: 'more', machine_bed_mass_Y: 'more', machine_max_printed_mass: 'more',
  // Hotend / nozzle change (H2C) timing and temperatures.
  machine_hotend_change_time: 'more', machine_prepare_compensation_time: 'more', group_algo_with_time: 'more',
  enable_pre_heating: 'more', hotend_cooling_rate: 'more', hotend_heating_rate: 'more',
  filament_change_length_nc: 'more', filament_retract_length_nc: 'more', filament_prime_volume: 'more', filament_prime_volume_nc: 'more',
  filament_ramming_travel_time: 'more', filament_ramming_travel_time_nc: 'more',
  filament_ramming_volumetric_speed: 'more', filament_ramming_volumetric_speed_nc: 'more',
  filament_pre_cooling_temperature: 'more', filament_pre_cooling_temperature_nc: 'more', filament_preheat_temperature_delta: 'more',
  // Flushing data (Bambu flushing dialog) and filament capabilities.
  filament_flush_temp: 'more', filament_flush_temp_fast: 'more', filament_flush_volumetric_speed: 'more', nozzle_flush_dataset: 'more',
  support_object_skip_flush: 'more', volumetric_speed_coefficients: 'more', filament_cooling_before_tower: 'more',
  filament_printable: 'more', filament_extruder_compatibility: 'more',
  // Commented out of Tab.cpp but still read by the engine.
  close_additional_fan_first_x_layers: 'more', additional_fan_full_speed_layer: 'more', first_x_layer_fan_speed: 'more',
  ironing_expansion: 'more', enforce_support_layers: 'more', support_interface_loop_pattern: 'more', travel_speed_z: 'more',
  prime_tower_flat_ironing: 'more', belt_purge_tower_object: 'more',
};

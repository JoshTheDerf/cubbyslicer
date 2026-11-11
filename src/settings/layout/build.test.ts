import { describe, expect, it } from 'vitest';
import type { ConfigSchema, EngineId } from '../../engine/types';
import orcaSchema from '../__fixtures__/orca-schema.sample.json';
import preflightSchema from '../__fixtures__/preflight-schema.sample.json';
import { buildLayout, HIDDEN_KEYS, LAYOUTS, locateKeys, tabIdOfScope, UNPLACED } from './build';

const schemas: Record<EngineId, ConfigSchema> = {
  orca: orcaSchema as unknown as ConfigSchema,
  preflight: preflightSchema as unknown as ConfigSchema,
};

describe.each(['orca', 'preflight'] as EngineId[])('%s layout', (engine) => {
  const schema = schemas[engine];

  it('reaches every preset-scope key (none dropped)', () => {
    const layout = buildLayout(schema, engine);
    const loc = locateKeys(layout);
    const missing: string[] = [];
    for (const [k, def] of Object.entries(schema.options)) {
      const tab = tabIdOfScope(def.scope);
      if (!tab || HIDDEN_KEYS.has(k) || UNPLACED[engine][k] === 'hidden') continue;
      const where = loc.get(k);
      if (!where) missing.push(k);
      else expect(where.tab).toBe(tab);
    }
    expect(missing).toEqual([]);
  });

  it('places every preset key on a page or lists it as not shown (an engine upgrade fails here, not silently in "More")', () => {
    const placed = new Set<string>();
    for (const pages of Object.values(LAYOUTS[engine])) for (const p of pages) for (const g of p.groups) for (const k of g.keys) placed.add(k);
    const unplaced = UNPLACED[engine];
    const unlisted = Object.entries(schema.options)
      .filter(([k, d]) => tabIdOfScope(d.scope) && !HIDDEN_KEYS.has(k) && !placed.has(k) && !unplaced[k]).map(([k]) => k);
    // preFlight has no curated list: its unplaced keys go to "More" by design.
    if (engine === 'orca') expect(unlisted).toEqual([]);
    // Stale entries: listed for "More" although the layout now places them, or gone from the schema.
    expect(Object.keys(unplaced).filter((k) => placed.has(k) && unplaced[k] === 'more')).toEqual([]);
    expect(Object.keys(unplaced).filter((k) => !schema.options[k])).toEqual([]);
  });

  it('never places a key in the wrong tab or twice on a non-extruder page', () => {
    const layout = buildLayout(schema, engine);
    for (const tab of Object.values(layout)) {
      const seen = new Set<string>();
      for (const page of tab.pages) {
        if (page.perExtruder) continue;
        for (const g of page.groups) for (const k of g.keys) {
          expect(tabIdOfScope(schema.options[k].scope)).toBe(tab.id);
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
      }
    }
  });

  it('mirrors the engine Tab.cpp pages with one per-extruder page', () => {
    const one = buildLayout(schema, engine);
    const extr = one.printer.pages.filter((p) => p.perExtruder);
    expect(extr).toHaveLength(1);
    expect(extr[0].groups.flatMap((g) => g.keys)).toContain('nozzle_diameter');
    const titles = one.process.pages.map((p) => p.title);
    if (engine === 'orca') {
      expect(titles.slice(0, 6)).toEqual(['Quality', 'Strength', 'Speed', 'Support', 'Multimaterial', 'Others']);
      expect(one.printer.pages.map((p) => p.title)).toEqual(expect.arrayContaining(['Basic information', 'Machine G-code', 'Motion ability']));
      const motion = one.printer.pages.find((p) => p.title === 'Motion ability')!;
      expect(motion.groups.find((g) => g.title === 'Speed limitation')?.keys).toEqual(['machine_max_speed_x', 'machine_max_speed_y', 'machine_max_speed_z', 'machine_max_speed_e']);
    } else {
      expect(titles).toEqual(expect.arrayContaining(['Layers and perimeters', 'Infill', 'Support material', 'Speed']));
    }
  });

  it('layout source only references keys the schema knows (stale layout detection)', () => {
    const src = LAYOUTS[engine];
    const unknown: string[] = [];
    for (const pages of Object.values(src)) for (const p of pages) for (const g of p.groups) for (const k of g.keys) if (!schema.options[k]) unknown.push(k);
    expect(unknown).toEqual([]);
  });
});

describe('orca 2.5 layout', () => {
  const schema = schemas.orca;
  const layout = buildLayout(schema, 'orca');
  const page = (tab: 'process' | 'filament' | 'printer', title: string) => layout[tab].pages.find((p) => p.title === title)!;
  const group = (tab: 'process' | 'filament' | 'printer', title: string, g: string) => page(tab, title).groups.find((x) => x.title === g)?.keys ?? [];

  it('has the belt, machine-frame, belt purge tower and IDEX groups', () => {
    expect(group('printer', 'Basic information', 'Belt printer')).toEqual(['belt_printer', 'belt_printer_infinite_y', 'belt_slice_rotation_angle', 'belt_slice_rotation', 'belt_support_floor_offset']);
    expect(group('printer', 'Basic information', 'Machine frame transforms')).toEqual(['gcode_remap_x', 'gcode_remap_y', 'gcode_remap_z', 'belt_frame_tilt_decouple', 'belt_frame_tilt_angle']);
    expect(group('printer', 'Multimaterial', 'Belt purge tower')).toEqual(['enable_belt_purge_tower']);
    expect(group('printer', 'Multimaterial', 'IDEX/IQEX Configuration')).toEqual(expect.arrayContaining(['is_imex', 'imex_gantry_count', 'imex_mode_names']));
    expect(group('printer', 'Basic information', 'Printable space')).toEqual(expect.arrayContaining(['bed_exclude_volumes', 'bed_exclude_volume_mode']));
  });

  it('keeps keys appended after another group was created in their own group (Tab.cpp optgroup variables)', () => {
    expect(group('printer', 'Basic information', 'Advanced')).toEqual(expect.arrayContaining(['thumbnails', 'thumbnails_format', 'use_relative_e_distances', 'use_firmware_retraction', 'time_cost']));
  });

  it('puts loop-built retraction and Z-hop groups on the per-extruder pages', () => {
    const ex = layout.printer.pages.filter((p) => p.perExtruder);
    expect(ex.map((p) => p.title)).toEqual(['Extruder']);
    const keys = (g: string) => ex[0].groups.find((x) => x.title === g)?.keys ?? [];
    expect(keys('Retraction')).toEqual(['retraction_length', 'retract_restart_extra', 'retraction_speed', 'deretraction_speed', 'retraction_minimum_travel',
      'retract_when_changing_layer', 'wipe', 'wipe_distance', 'retract_before_wipe', 'retract_after_wipe']);
    expect(keys('Z-Hop')).toEqual(['retract_lift_enforce', 'z_hop_types', 'z_hop', 'travel_slope', 'retract_lift_above', 'retract_lift_below']);
    expect(ex[0].groups.flatMap((g) => g.keys)).toContain('extruder_bed_exclude_volumes');
    // Motion ability is an "extruder page" in Tab.cpp only for its variant switch; its keys are normal/silent pairs.
    expect(page('printer', 'Motion ability').perExtruder).toBeUndefined();
  });

  it('places the filament overrides built from inline key loops', () => {
    expect(group('filament', 'Setting Overrides', 'Retraction')[0]).toBe('filament_retraction_length');
    expect(group('filament', 'Setting Overrides', 'Retraction when switching material')).toEqual(['filament_retract_length_toolchange', 'filament_retract_restart_extra_toolchange']);
  });

  it('hides nozzle-variant tables and dialog-owned keys', () => {
    const loc = locateKeys(layout);
    for (const k of ['print_extruder_variant', 'printer_extruder_id', 'bed_custom_texture', 'imex_parallel_mode']) expect(loc.has(k)).toBe(false);
  });
});

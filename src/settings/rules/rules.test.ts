import { describe, expect, it } from 'vitest';
import type { ConfigSchema, ConfigValue } from '../../engine/types';
import { parseDefault } from '../../presets/values';
import orcaSchema from '../__fixtures__/orca-schema.sample.json';
import { CppError, evalCpp, parseCpp } from './cpp';
import { choicesFor, coupledEdits, evaluateRules, makeEnv } from './index';
import { HAND_LOCALS, HELPER_ENUM_VALUES } from './orca';
import { orcaRulesGenerated as R } from './orca.generated';
import type { ConfigScopeRef, RuleContext, RuleFamily, RuleText } from './types';

const schema = orcaSchema as unknown as ConfigSchema;
const FAMILIES: RuleFamily[] = ['print', 'printer', 'filament'];
const SELF_SCOPE: Record<RuleFamily, string[]> = { print: ['print', 'object'], printer: ['machine'], filament: ['filament'] };

/** A context over schema defaults plus edits; reading a key the schema doesn't know (or of the wrong tab) throws. */
function ctxOf(family: RuleFamily, edits: Partial<Record<ConfigScopeRef, Record<string, ConfigValue>>> = {}, extra: Partial<RuleContext> = {}): RuleContext {
  return {
    read(scope, key) {
      const e = edits[scope]?.[key];
      if (e !== undefined) return e;
      const def = schema.options[key];
      if (!def) throw new Error(`rule reads unknown key ${key}`);
      const ok = scope === 'self' ? SELF_SCOPE[family].includes(def.scope) : scope === 'printer' ? def.scope === 'machine' : def.scope === 'other';
      if (!ok) throw new Error(`rule reads ${key} (${def.scope}) from ${scope} config`);
      return parseDefault(def);
    },
    variantIndex: 0, isBBL: false, mode: 1, extruderCount: 1, isGlobal: true,
    ...extra,
  };
}
const conds = (t: RuleText | undefined): string[] => (t && typeof t === 'object' ? [t.if, ...conds(t.then), ...conds(t.else)] : []);

describe('generated rules', () => {
  it('cover the 2.5 belt, IDEX and collision-volume toggles', () => {
    const keys = (f: RuleFamily) => new Set(R[f].toggles.map((t) => t.key));
    for (const k of ['belt_printer_infinite_y', 'belt_slice_rotation_angle', 'gcode_remap_x', 'enable_belt_purge_tower', 'imex_gantry_count', 'bed_exclude_volumes', 'extruder_bed_exclude_volumes']) expect(keys('printer').has(k)).toBe(true);
    for (const k of ['belt_purge_tower_width', 'leading_brim_length', 'raft_expansion', 'wipe_inward_distance', 'unsupported_wall_last']) expect(keys('print').has(k)).toBe(true);
    expect(keys('filament').has('initial_layer_fan_speed')).toBe(true);
  });

  it.each(FAMILIES)('%s: every toggled key exists in the schema', (f) => {
    // Toggled in Orca but not options: the GUI-only extruder count, and a typo of retraction_length in TabPrinter (inert there too).
    const notOptions = new Set(['extruders_count', 'retract_length']);
    expect(R[f].toggles.map((t) => t.key).filter((k) => !schema.options[k] && !notOptions.has(k))).toEqual([]);
  });

  it.each(FAMILIES)('%s: hand-ported locals match the C++ they port (fails when Orca changes them)', (f) => {
    for (const [name, h] of Object.entries(HAND_LOCALS[f])) expect({ name, cpp: R[f].locals[name] }).toEqual({ name, cpp: h.cpp });
  });

  it.each(FAMILIES)('%s: every condition, guard and local runs without a hand port missing', (f) => {
    const failures: string[] = [];
    for (const variant of [{}, { printer: { belt_printer: '1', gcode_flavor: 'marlin2', machine_max_junction_deviation: ['0.02', '0.02'] } }]) {
      const env = makeEnv(R, f, ctxOf(f, variant as never, { isBBL: 'printer' in variant }));
      for (const name of Object.keys(R[f].locals)) {
        if (HAND_LOCALS[f][name]) continue;
        try { env.local(name); } catch (e) { failures.push(`local ${name}: ${(e as Error).message}`); }
      }
      for (const t of R[f].toggles) {
        for (const c of [t.when ?? 'true', ...(t.guards ?? []), ...conds(t.reason), ...conds(t.text)]) {
          try { evalCpp(c, env, { $key: t.key }); } catch (e) { failures.push(`${t.key}: ${c}: ${(e as Error).message}`); }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('enum constants and helper values are real option values', () => {
    const all = new Set(Object.values(schema.options).flatMap((d) => d.enumValues ?? []));
    expect(Object.entries(R.enums).filter(([, v]) => !all.has(v))).toEqual([]);
    for (const vals of Object.values(HELPER_ENUM_VALUES)) expect(vals.filter((v) => !all.has(v))).toEqual([]);
  });
});

describe('cpp evaluator', () => {
  const env = makeEnv(R, 'print', ctxOf('print', { self: { wall_loops: '3', sparse_infill_density: '15%', infill_anchor_max: '400%', sparse_infill_pattern: 'gyroid' } }));
  it('reads config values, enums, locals and lambdas', () => {
    expect(evalCpp('config->opt_int("wall_loops") > 0', env)).toBe(true);
    expect(evalCpp('config->option<ConfigOptionPercent>("sparse_infill_density")->value', env)).toBe(15);
    expect(evalCpp('pattern == ipGyroid && !have_adaptive_infill', env)).toBe(true);
    expect(evalCpp('[](InfillPattern p) { return p == ipGyroid; }(pattern)', env)).toBe(true);
    expect(evalCpp('true ? 1 : 2', env)).toBe(1);
  });
  it('rejects what it cannot run', () => {
    expect(() => parseCpp('a = b')).toThrow(CppError);
    expect(() => evalCpp('no_such_local', env)).toThrow(CppError);
  });
});

/** Row state of `key` with the given edits (cases read from ConfigManipulation.cpp / Tab.cpp v2.5.0). */
function row(f: RuleFamily, key: string, edits: Partial<Record<ConfigScopeRef, Record<string, ConfigValue>>> = {}, extra: Partial<RuleContext> = {}) {
  return evaluateRules('orca', f, ctxOf(f, edits, extra)).get(key) ?? {};
}

describe('Orca 2.5 rules', () => {
  it('belt printer section shows only for belt printers (TabPrinter::toggle_options)', () => {
    expect(row('printer', 'belt_printer_infinite_y')).toEqual({ hidden: true, reason: 'Enable belt printer mode to use this setting.' });
    expect(row('printer', 'belt_printer_infinite_y', { self: { belt_printer: '1' } })).toEqual({});
    expect(row('printer', 'belt_slice_rotation_angle', { self: { belt_printer: '1', belt_slice_rotation: 'none' } }).disabled).toBe(true);
    expect(row('printer', 'belt_frame_tilt_decouple', { self: { belt_printer: '1' } }, { mode: 2 })).toEqual({});
    expect(row('printer', 'belt_frame_tilt_decouple', { self: { belt_printer: '1' } }, { mode: 1 }).hidden).toBe(true);
    expect(row('printer', 'enable_belt_purge_tower').hidden).toBe(true);
    expect(row('printer', 'build_plate_tilt_x', { self: { belt_printer: '1' } }).disabled).toBe(true);
  });

  it('IDEX settings need is_imex', () => {
    expect(row('printer', 'imex_gantry_count')).toEqual({ disabled: true, reason: 'Enable IDEX/IQEX printer mode to use this setting.' });
    expect(row('printer', 'imex_gantry_count', { self: { is_imex: '1' } })).toEqual({});
    expect(row('printer', 'imex_mode_names').disabled).toBe(true);
  });

  it('collision volumes follow the volume mode and extruder count', () => {
    expect(row('printer', 'bed_exclude_volume_mode').hidden).toBe(true);
    expect(row('printer', 'bed_exclude_volume_mode', {}, { extruderCount: 2 })).toEqual({});
    expect(row('printer', 'bed_exclude_volumes', { self: { bed_exclude_volume_mode: 'per_extruder' } }, { extruderCount: 2 }).hidden).toBe(true);
    expect(row('printer', 'extruder_bed_exclude_volumes', { self: { bed_exclude_volume_mode: 'per_extruder' } }, { extruderCount: 2 })).toEqual({});
    expect(row('printer', 'extruder_bed_exclude_volumes').hidden).toBe(true);
  });

  it('retract before / after wipe exclude each other at 100% (Tab.cpp:6957-6973)', () => {
    const base = { retraction_length: ['0.8'], wipe: ['1'] };
    expect(row('printer', 'retract_after_wipe', { self: { ...base, retract_before_wipe: ['100%'] } }).disabled).toBe(true);
    expect(row('printer', 'retract_after_wipe', { self: { ...base, retract_before_wipe: ['70%'], retract_after_wipe: ['0%'] } })).toEqual({});
    expect(coupledEdits('printer', 'retract_before_wipe', ['70%'], (k) => (k === 'retract_after_wipe' ? ['50%'] : undefined), 0)).toEqual({ retract_after_wipe: ['30%'] });
    expect(coupledEdits('printer', 'retract_after_wipe', ['20%'], (k) => (k === 'retract_before_wipe' ? ['70%'] : undefined), 0)).toEqual({});
  });

  it('process: infill, prime tower, raft and seam rules', () => {
    expect(row('print', 'sparse_infill_pattern', { self: { sparse_infill_density: '0%' } })).toEqual({ hidden: true, reason: 'This setting is hidden because sparse infill density is zero.' });
    const rib = { enable_prime_tower: '1', wipe_tower_wall_type: 'rib' };
    expect(row('print', 'wipe_tower_rib_width', { self: rib })).toEqual({});
    expect(row('print', 'prime_tower_width', { self: rib }).disabled).toBe(true);
    expect(row('print', 'wipe_tower_rib_width', { self: rib, printer: { belt_printer: '1' } }).hidden).toBe(true);
    expect(row('print', 'raft_expansion').hidden).toBe(true);
    expect(row('print', 'raft_expansion', { self: { raft_layers: '2', support_type: 'tree(auto)', support_style: 'tree_slim' } })).toEqual({
      disabled: true, reason: 'Slim, Strong and Hybrid tree supports use first layer expansion instead of raft expansion.' });
    expect(row('print', 'wipe_inward_distance').hidden).toBe(true);
    expect(row('print', 'wipe_inward_distance', { self: { wipe_inward: '1' } })).toEqual({});
    expect(row('print', 'unsupported_wall_last', { self: { detect_overhang_wall: '0' } }).hidden).toBe(true);
    expect(row('print', 'enable_arc_fitting', { printer: { belt_printer: '1' } }).disabled).toBe(true);
  });

  it('brim width becomes the ear radius for automatic ears (set_option_label)', () => {
    expect(row('print', 'brim_width', { self: { brim_type: 'brim_ears' } }).label).toBe('Brim ear radius');
    expect(row('print', 'brim_width', { self: { brim_type: 'outer_only' } }).label).toBe('Brim width');
  });

  it('jerk gives way to junction deviation on Marlin 2', () => {
    const jd = { printer: { gcode_flavor: 'marlin2', machine_max_junction_deviation: ['0.02', '0.02'] } };
    expect(row('print', 'default_jerk', jd).disabled).toBe(true);
    expect(row('print', 'outer_wall_jerk', jd).hidden).toBe(true);
    expect(row('print', 'default_jerk')).toEqual({});
    expect(row('printer', 'machine_max_jerk_x', { self: { gcode_flavor: 'marlin2', machine_max_junction_deviation: ['0.02', '0'] } }).disabled).toBe(true);
  });

  it('filament: first-layer fan, pressure advance and retraction overrides', () => {
    expect(row('filament', 'initial_layer_fan_speed', { self: { close_fan_the_first_x_layers: ['1'] } }).hidden).toBe(true);
    expect(row('filament', 'initial_layer_fan_speed', { self: { close_fan_the_first_x_layers: ['0'] } })).toEqual({});
    expect(row('filament', 'pressure_advance', { self: { enable_pressure_advance: ['0'] } }).disabled).toBe(true);
    expect(row('filament', 'filament_z_hop', { self: { filament_retraction_length: ['0'] } }).disabled).toBe(true);
    expect(row('filament', 'filament_z_hop', { self: { filament_retraction_length: ['nil'] } })).toEqual({});
  });

  it('per-object panels only grey out (no hiding)', () => {
    const r = evaluateRules('orca', 'print', ctxOf('print', { self: { sparse_infill_density: '0%' } }), { hide: false });
    expect(r.get('sparse_infill_pattern')).toBeUndefined();
  });

  it('narrows enum choices like the tab does', () => {
    expect(choicesFor('orca', 'print', 'support_style', ctxOf('print', { self: { support_type: 'tree(auto)' } }))?.values).toContain('organic');
    expect(choicesFor('orca', 'print', 'support_style', ctxOf('print'))?.values).toEqual(['default', 'grid', 'snug']);
    expect(choicesFor('orca', 'print', 'brim_type', ctxOf('print'))?.values).not.toContain('leading_edge_only');
    expect(choicesFor('orca', 'printer', 'imex_tool_layout', ctxOf('printer'))?.labels).toEqual(['Left', 'Right']);
    expect(choicesFor('preflight', 'print', 'support_style', ctxOf('print'))).toBeNull();
  });
});

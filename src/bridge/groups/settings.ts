/**
 * Bridge tools: engine settings. Search, read and change values globally
 * (as unsaved edits of the printer / process / filament tab, like typing in
 * the sidebar) or as overrides on an object, a part / modifier, a height
 * range or a plate. Values are checked against the engine schema.
 */
import { argNumber, argString, type BridgeTool } from '@cubby/shared/bridge';
import { resolvedConfig } from '../../app/state';
import type { ConfigOptionDef, ConfigValue } from '../../engine/types';
import { currentPresets, presetsSettled, type EnginePresets } from '../../presets/store';
import type { PresetKind } from '../../presets/types';
import { normalizeValue } from '../../presets/values';
import { validateValue } from '../../settings/validate';
import { getObjectOverrides, setObjectOverride } from '../../settings/projectAdapter';
import { getRange } from '../../layers/store';
import { PLATE_KEYS, plateConfig, setPlateConfig } from '../../plates/store';
import { DEFINITIONS_KEY, MIXED_SETTING_GROUPS, mixedSetting, setMixedSetting } from '../../mixed/store';
import { settingValue } from '../logic';
import { slotArg } from './presets';
import { num, obj, objectArg, partArg, plateArg, settled, str } from './util';

/** Project-level values that belong to no preset (the app's own dialogs write them). */
const PROJECT_KEYS = new Set(['filament_map', 'filament_map_mode', 'flush_volumes_matrix', 'flush_multiplier', 'wiping_volumes_matrix', 'wiping_volumes_use_custom_matrix']);
const MIXED_KEYS = new Set(MIXED_SETTING_GROUPS.flatMap((g) => g.keys));
/** Per-object / part / range overrides: process settings plus the filament (extruder). */
const OBJECT_OK = (d: ConfigOptionDef, key: string) => d.scope === 'print' || key === 'extruder';

type Target =
  | { kind: 'global' }
  | { kind: 'object'; objectId: string; partId?: string; rangeId?: string; label: string }
  | { kind: 'plate'; plate: number };

function targetOf(args: Record<string, unknown>): Target {
  const plate = plateArg(args, 'plate');
  if (plate !== undefined) {
    if (args.objectId !== undefined) throw new Error('Pass either plate or objectId, not both.');
    return { kind: 'plate', plate };
  }
  if (args.objectId === undefined) {
    if (args.partId !== undefined || args.rangeId !== undefined) throw new Error('partId / rangeId need objectId.');
    return { kind: 'global' };
  }
  const o = objectArg(args);
  if (args.partId !== undefined) { const p = partArg(o, args.partId); return { kind: 'object', objectId: o.id, partId: p.id, label: `${o.name} › ${p.name}` }; }
  if (args.rangeId !== undefined) {
    const r = getRange(o.id, String(args.rangeId));
    if (!r) throw new Error(`Object ${o.id} has no height range "${String(args.rangeId)}". Its ranges: ${(o.layerRanges ?? []).map((x) => `${x.id} (${x.min}–${x.max} mm)`).join(', ') || 'none'}.`);
    return { kind: 'object', objectId: o.id, rangeId: r.id, label: `${o.name} › ${r.min}–${r.max} mm` };
  }
  return { kind: 'object', objectId: o.id, label: o.name };
}

/** A JSON value for setting `def` in engine form, or the reason it is rejected (names the allowed values). */
export function parseSetting(def: ConfigOptionDef, raw: unknown): { value: ConfigValue } | { error: string } {
  let v: ConfigValue;
  try { v = normalizeValue(def, settingValue(raw)); } catch (e) { return { error: (e as Error).message }; }
  const problems = validateValue(def, v);
  if (problems.length) return { error: problems.map((x) => x.message).join('; ') + (def.enumValues ? ` (one of: ${def.enumValues.join(', ')})` : '') };
  return { value: v };
}

function tabOf(def: ConfigOptionDef): PresetKind {
  return def.scope === 'machine' ? 'printer' : def.scope === 'filament' ? 'filament' : 'process';
}

const TARGET_ARGS = {
  objectId: str('Set overrides on this object (ids from list_objects).'),
  partId: str('With objectId: on this part / modifier / negative part / support blocker or enforcer.'),
  rangeId: str('With objectId: on this height range modifier (height_range).'),
  plate: num('Plate settings of this plate (1-based): only ' + PLATE_KEYS.join(', ') + '.'),
  filament: num('Filament slot (1-based) for filament settings (default 1).'),
};

export function settingsTools(): BridgeTool[] {
  return [
    {
      name: 'find_settings',
      description: 'Search the engine’s settings by key, label or tooltip (e.g. "infill", "support", "brim"). Returns keys, labels, tab (printer / process / filament), current values, units, limits and allowed values, for get_settings / set_settings.',
      inputSchema: obj({ query: str('Words to look for.'), limit: num('Max rows (default 25).') }, ['query']),
      async run(args) {
        const q = argString(args, 'query')!.toLowerCase();
        const limit = argNumber(args, 'limit', { optional: true }) ?? 25;
        await presetsSettled();
        const schema = currentPresets.value.schema.value;
        if (!schema) throw new Error('The engine schema isn’t loaded yet.');
        const cfg = resolvedConfig.value;
        const words = q.split(/\s+/).filter(Boolean);
        const text = (k: string, d: ConfigOptionDef) => `${k} ${d.label} ${d.fullLabel} ${d.tooltip}`.toLowerCase();
        const rows = Object.entries(schema.options)
          .filter(([k, d]) => d.type !== 'none' && words.every((w) => text(k, d).includes(w)))
          .sort(([a, da], [b, db]) => Number(!(a.includes(q) || da.label.toLowerCase().includes(q))) - Number(!(b.includes(q) || db.label.toLowerCase().includes(q))))
          .slice(0, limit)
          .map(([key, d]) => ({
            key, label: d.fullLabel || d.label, category: d.category, tab: d.scope === 'other' ? 'project' : tabOf(d), type: d.type, unit: d.sidetext || undefined,
            value: cfg[key], min: d.min ?? undefined, max: d.max ?? undefined, values: d.enumValues, perObject: OBJECT_OK(d, key) || undefined,
          }));
        return { data: { count: rows.length, settings: rows } };
      },
    },

    {
      name: 'get_settings',
      description:
        'Read settings by key, e.g. ["layer_height", "sparse_infill_density", "enable_support"]. Without a target: the resolved values the next slice uses. ' +
        'With objectId (+ partId / rangeId) or plate: that target’s overrides and the value it slices with. Omit keys to list every override of the target.',
      inputSchema: obj({ keys: { type: 'array', items: { type: 'string' }, description: 'Setting keys (see find_settings).' }, ...TARGET_ARGS }),
      async run(args) {
        const keys = args.keys;
        if (keys !== undefined && (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string'))) throw new Error('keys must be a list of setting keys.');
        await presetsSettled();
        const t = targetOf(args);
        const cfg = resolvedConfig.value;
        if (t.kind === 'global') {
          if (!keys) throw new Error('Pass keys (find_settings looks them up). compare_presets lists unsaved edits.');
          const out: Record<string, unknown> = {};
          const unknown: string[] = [];
          for (const k of keys as string[]) { if (k in cfg) out[k] = cfg[k]; else unknown.push(k); }
          return { data: { values: out, unknown: unknown.length ? unknown : undefined, hint: unknown.length ? 'Use find_settings to look up keys.' : undefined } };
        }
        const own: Readonly<Record<string, ConfigValue>> = t.kind === 'plate' ? plateConfig(t.plate) : getObjectOverrides(t.objectId, t.partId, t.rangeId);
        const list = (keys as string[] | undefined) ?? Object.keys(own);
        const values = Object.fromEntries(list.map((k) => [k, { override: own[k], global: cfg[k] }]));
        return { data: { target: t.kind === 'plate' ? `plate ${t.plate + 1}` : t.label, overrides: { ...own }, values } };
      },
    },

    {
      name: 'set_settings',
      description:
        'Change settings, e.g. { "values": { "layer_height": 0.2, "sparse_infill_density": "15%", "enable_support": true } }. null resets a key. ' +
        'Without a target each key goes to its own tab (printer / process / filament slot) as an unsaved edit, like typing in the sidebar (save_preset keeps it). ' +
        'objectId / partId / rangeId: per-object, per-part (modifier) or height-range overrides (process settings and "extruder"). plate: plate settings (bed type, print sequence, spiral vase, filament order). ' +
        'Filament colours: set_filaments; flushing: set_flushing_volumes; mixed filaments: edit_mixed_filaments. Returns what changed and anything rejected with the reason.',
      inputSchema: obj({ values: { type: 'object', description: 'Setting key → value (string, number, boolean, a list for per-extruder values, or null to reset).' }, ...TARGET_ARGS }, ['values']),
      async run(args) {
        const values = args.values as Record<string, unknown>;
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('values must be an object.');
        await presetsSettled();
        const p: EnginePresets = currentPresets.value;
        const schema = p.schema.value;
        if (!schema) throw new Error('The engine schema isn’t loaded yet.');
        const t = targetOf(args);
        const slot = slotArg(args, p);
        const applied: string[] = [];
        const rejected: Record<string, string> = {};
        const plateNext: Record<string, ConfigValue> = t.kind === 'plate' ? { ...plateConfig(t.plate) } : {};
        for (const [key, raw] of Object.entries(values)) {
          const def = schema.options[key];
          if (!def) { rejected[key] = 'unknown key (see find_settings)'; continue; }
          if (def.readonly) { rejected[key] = 'read-only'; continue; }
          const reset = raw === null;
          let v: ConfigValue | undefined;
          if (!reset) {
            const r = parseSetting(def, raw);
            if ('error' in r) { rejected[key] = r.error; continue; }
            v = r.value;
          }
          if (t.kind === 'plate') {
            if (!(PLATE_KEYS as readonly string[]).includes(key)) { rejected[key] = `not a plate setting (plate settings: ${PLATE_KEYS.join(', ')})`; continue; }
            if (reset) delete plateNext[key]; else plateNext[key] = v!;
          } else if (t.kind === 'object') {
            if (!OBJECT_OK(def, key)) { rejected[key] = `a ${def.scope === 'machine' ? 'printer' : def.scope} setting can’t be set per object`; continue; }
            setObjectOverride(t.objectId, key, reset ? undefined : v, t.partId, t.rangeId);
          } else if (key === DEFINITIONS_KEY) {
            rejected[key] = 'use edit_mixed_filaments'; continue;
          } else if (key === 'filament_colour') {
            rejected[key] = 'use set_filaments'; continue;
          } else if (key === 'curr_bed_type') {
            p.setBedType(reset ? null : String(Array.isArray(v) ? v[0] : v));
          } else if (MIXED_KEYS.has(key)) {
            setMixedSetting(key, reset ? String(def.default ?? '') : String(Array.isArray(v) ? v[0] : v));
          } else if (PROJECT_KEYS.has(key)) {
            if (reset) delete p.project[key]; else p.project[key] = v!;
          } else {
            const kind = tabOf(def);
            if (reset) p.revert(kind, key, kind === 'filament' ? slot : 0);
            else p.setValue(kind, key, v, kind === 'filament' ? slot : 0);
          }
          applied.push(key);
        }
        if (t.kind === 'plate' && applied.length) setPlateConfig(t.plate, plateNext);
        await settled();
        const cfg = resolvedConfig.value;
        const now: Record<string, unknown> = {};
        for (const k of applied) {
          if (t.kind === 'object') now[k] = getObjectOverrides(t.objectId, t.partId, t.rangeId)[k] ?? null;
          else if (t.kind === 'plate') now[k] = plateConfig(t.plate)[k] ?? null;
          else now[k] = MIXED_KEYS.has(k) ? mixedSetting(k) : cfg[k];
        }
        return {
          data: {
            ok: applied.length > 0 || Object.keys(rejected).length === 0,
            target: t.kind === 'global' ? 'presets (unsaved edits)' : t.kind === 'plate' ? `plate ${t.plate + 1}` : t.label,
            applied: now, rejected: Object.keys(rejected).length ? rejected : undefined,
          },
        };
      },
    },
  ];
}

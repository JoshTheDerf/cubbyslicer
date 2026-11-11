/**
 * Enable / show state of settings rows for the active presets (Orca's
 * ConfigManipulation / Tab*::toggle_options, see ./rules). One computed per
 * preset kind, slot and extruder page; it re-runs when a value a rule reads
 * changes.
 */
import { computed, type ComputedRef } from 'vue';
import { activeEngine } from '../app/state';
import type { ConfigOptionDef, ConfigValue } from '../engine/types';
import { currentPresets } from '../presets/store';
import type { PresetKind } from '../presets/types';
import { variantKey } from '../presets/variants';
import { choicesFor, coupledEdits, evaluateRules, type RowState, type RuleContext, type RuleFamily } from './rules';
import { extruderCount, MODE_RANK } from './useLayout';
import { settingsUi } from './uiState';
import { afterSettingEdit } from './applyAutoChanges';

const FAMILY: Record<PresetKind, RuleFamily> = { process: 'print', printer: 'printer', filament: 'filament' };

/**
 * Rule context for a preset kind. `slot`: filament slot; `extruder`: the printer page's extruder
 * (Orca's variant index). `self` overrides the tab's own values (per-object overrides over the process).
 */
export function ruleContext(kind: PresetKind, slot = 0, extruder?: number, self?: (key: string) => ConfigValue | undefined): RuleContext {
  const p = currentPresets.value;
  const schema = p.schema.value;
  return {
    read(scope, key) {
      if (scope === 'printer') return p.value('printer', key);
      if (scope === 'project') return key === 'curr_bed_type' ? p.bedType() ?? undefined : p.project[key];
      const v = self?.(key) ?? p.value(kind, key, slot);
      // Per-variant keys (Orca 2.5): the rules see the selected variant's column only, whatever index the C++ reads.
      const el = Array.isArray(v) ? p.variantElement(kind, key, slot, extruder) : undefined;
      if (el === undefined || !Array.isArray(v)) return v;
      const stride = variantKey(schema, key)?.stride ?? 1;
      return v.slice(el, el + stride).length ? v.slice(el, el + stride) : v.slice(0, stride);
    },
    variantIndex: extruder ?? 0,
    isBBL: p.selectedInfo('printer').vendor === 'BBL',
    mode: MODE_RANK[settingsUi.mode],
    extruderCount: extruderCount.value,
    isGlobal: !self,
  };
}

const cache = new Map<string, ComputedRef<Map<string, RowState>>>();
/** Row states of a preset tab (keys without a rule are absent). */
export function rowStates(kind: PresetKind, slot = 0, extruder?: number): Map<string, RowState> {
  const id = `${kind}:${slot}:${extruder ?? '-'}`;
  let c = cache.get(id);
  if (!c) {
    c = computed(() => (currentPresets.value.schema.value ? evaluateRules(activeEngine.value, FAMILY[kind], ruleContext(kind, slot, extruder)) : new Map()));
    cache.set(id, c);
  }
  return c.value;
}

/** The option definition with enum choices narrowed the way Orca's tab narrows them (support style, brim type, …). */
export function narrowedDef(kind: PresetKind, key: string, def: ConfigOptionDef, ctx: RuleContext, current: string): ConfigOptionDef {
  if (!def.enumValues?.length) return def;
  const c = choicesFor(activeEngine.value, FAMILY[kind], key, ctx);
  if (!c) return def;
  const values = def.enumValues.filter((v) => c.values.includes(v) || v === current);
  const labels = values.map((v) => {
    const i = c.values.indexOf(v);
    return (i >= 0 ? c.labels?.[i] : undefined) ?? def.enumLabels?.[def.enumValues!.indexOf(v)] ?? v;
  });
  return { ...def, enumValues: values, enumLabels: labels };
}

/**
 * Set a value plus the values Orca rewrites with it (retract before / after wipe), then run Orca's
 * automatic changes and their dialogs (./applyAutoChanges.ts). Resolves when those are done.
 */
export function setWithCoupled(kind: PresetKind, key: string, value: ConfigValue, slot = 0, element = 0): Promise<void> {
  const p = currentPresets.value;
  p.setValue(kind, key, value, slot);
  for (const [k, v] of Object.entries(coupledEdits(FAMILY[kind], key, value, (k2) => p.value(kind, k2, slot), element))) p.setValue(kind, k, v, slot);
  return afterSettingEdit(kind, key, value, slot, element);
}

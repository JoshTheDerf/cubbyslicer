/**
 * Bridge tools: Full Spectrum mixed (virtual) filaments. The engine owns the
 * list (auto pairs from the physical colours plus the user's rows); edits go
 * through the same store call as the Mixed filaments panel.
 */
import type { BridgeTool } from '@cubby/shared/bridge';
import { activeEngine } from '../../app/state';
import { editMixedFilaments, MIXED_SETTING_GROUPS, mixedEnabled, mixedFilaments, mixedLabel, mixedSetting, refreshMixedFilaments, type MixedEdit } from '../../mixed/store';
import { currentPresets, presetsSettled } from '../../presets/store';
import { oneOf } from '../logic';
import { obj } from './util';

function rows() {
  return mixedFilaments.value.map((m) => ({
    filament: m.id, stableId: m.stableId, label: mixedLabel(m), color: m.color, custom: m.custom, kind: m.kind,
    components: m.components, a: m.a, b: m.b, percent: m.percent, distribution: m.distribution, gradient: m.gradient.enabled ? m.gradient : undefined,
  }));
}

function requireFs(): void {
  if (!mixedEnabled.value) throw new Error(`Mixed filaments need the Full Spectrum engine (now ${activeEngine.value}); switch with set_engine "fullspectrum".`);
  if (currentPresets.value.selection.filaments.length < 2) throw new Error('Mixed filaments need at least 2 physical filaments (set_filaments count 2).');
}

export function mixedTools(): BridgeTool[] {
  return [
    {
      name: 'list_mixed_filaments',
      description: 'Full Spectrum mixed filaments: colours made by alternating thin layers of physical filaments. Each has a filament number (after the physical ones) usable for objects, parts and colour painting. Also lists the colour-mixing settings (change them with set_settings).',
      inputSchema: obj({}),
      async run() {
        await presetsSettled();
        requireFs();
        await refreshMixedFilaments();
        return {
          data: {
            physical: currentPresets.value.selection.filaments.length, mixed: rows(),
            settings: MIXED_SETTING_GROUPS.map((g) => ({ group: g.title, values: Object.fromEntries(g.keys.map((k) => [k, mixedSetting(k)])) })),
          },
        };
      },
    },

    {
      name: 'edit_mixed_filaments',
      description:
        'Change mixed filaments (Full Spectrum). edits, applied in order: { op: "add", a, b, percent } (blend physical filaments a and b, percent of b), ' +
        '{ op: "add_definition", definition } (components [{ id, percent }], kind blend | pattern, distribution simple | layer_cycle, cadence { a, b }, gradient { enabled, start, end, stops, solidWidths }, pattern [[ids]] …), ' +
        '{ op: "set", stableId, definition }, { op: "percent", stableId, percent }, { op: "remove", stableId }. stableId comes from list_mixed_filaments.',
      inputSchema: obj({ edits: { type: 'array', items: { type: 'object' }, description: 'Edits.' } }, ['edits']),
      async run(args) {
        await presetsSettled();
        requireFs();
        const edits = args.edits;
        if (!Array.isArray(edits) || !edits.length) throw new Error('edits must be a non-empty list.');
        const phys = currentPresets.value.selection.filaments.length;
        const ids = new Set(mixedFilaments.value.map((m) => m.stableId));
        for (const [i, e] of edits.entries()) {
          if (!e || typeof e !== 'object') throw new Error(`edits[${i}] must be an object.`);
          const r = e as Record<string, unknown>;
          const op = oneOf(r.op, ['add', 'add_definition', 'set', 'remove', 'percent'] as const, `edits[${i}].op`);
          if (op === 'add') {
            for (const k of ['a', 'b'] as const) if (!Number.isInteger(r[k]) || (r[k] as number) < 1 || (r[k] as number) > phys) throw new Error(`edits[${i}].${k} must be a physical filament 1-${phys}.`);
            if (typeof r.percent !== 'number' || r.percent < 0 || r.percent > 100) throw new Error(`edits[${i}].percent must be 0-100.`);
          }
          if ((op === 'set' || op === 'remove' || op === 'percent') && !ids.has(r.stableId as number)) throw new Error(`edits[${i}].stableId must be one of ${[...ids].join(', ') || '(none yet)'} (list_mixed_filaments).`);
          if ((op === 'add_definition' || op === 'set') && (!r.definition || typeof r.definition !== 'object')) throw new Error(`edits[${i}].definition must be an object.`);
        }
        const ok = await editMixedFilaments(edits as MixedEdit[]);
        if (!ok) throw new Error('The engine rejected the edit (see the app’s notification).');
        return { data: { ok: true, mixed: rows() } };
      },
    },
  ];
}

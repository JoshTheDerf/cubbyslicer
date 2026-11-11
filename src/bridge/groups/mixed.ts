/**
 * Bridge tools: mixed filaments (OrcaSlicer 2.5 colour mixing). A mix is a
 * filament slot after the physical ones that prints 2–3 physical filaments in
 * sub-layers by ratio, optionally as a gradient over Z; edits go through the
 * same store calls as the sidebar's Mixed filament section.
 */
import type { BridgeTool } from '@cubby/shared/bridge';
import { activeEngine } from '../../app/state';
import { ENGINE_LABELS } from '../../engine/capabilities';
import { parseGradientCurve, type GradientAnchor } from '../../mixed/mixer';
import { defError, evenRatios, mixedLabel, MIN_COMPONENT_RATIO, MAX_COMPONENTS, type MixedDef } from '../../mixed/model';
import {
  addMixedFilament, canAddMixed, mixedEnabled, mixedFilaments, mixedIssues, physicalTypes, removeAllMixedFilaments, removeMixedFilament, updateMixedFilament,
} from '../../mixed/store';
import { currentPresets, presetsSettled } from '../../presets/store';
import { oneOf } from '../logic';
import { obj } from './util';

function rows() {
  const issues = new Map(mixedIssues.value.map((i) => [i.id, i.reason]));
  return mixedFilaments.value.map((m) => ({
    filament: m.id, label: mixedLabel(m), color: m.color, components: m.components, ratios: m.ratios,
    gradient: m.gradient ? { direction: m.direction === 'ab' ? 'A→B' : 'B→A', perPart: m.perPart, curve: m.curve.length ? m.curve.map((a) => [a.x, a.y]) : undefined } : undefined,
    problem: issues.get(m.id) === 'missing' ? 'a component filament is missing' : issues.get(m.id) === 'types' ? 'components have different filament types' : undefined,
  }));
}

function requireMixing(): void {
  if (!mixedEnabled.value) {
    throw new Error(`Mixed filaments need OrcaSlicer 2.5 (now ${ENGINE_LABELS[activeEngine.value]}${activeEngine.value === 'orca' ? ' with an older engine build' : ''}).`);
  }
}

/** A definition from tool arguments, on top of `base` (edit) or the defaults (add). */
function defFrom(r: Record<string, unknown>, i: number, base?: MixedDef): MixedDef {
  const at = `edits[${i}]`;
  const ints = (v: unknown, what: string) => {
    if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x))) throw new Error(`${at}.${what} must be a list of whole numbers.`);
    return v as number[];
  };
  const components = r.components !== undefined ? ints(r.components, 'components') : base?.components ?? [1, 2];
  const ratios = r.ratios !== undefined ? ints(r.ratios, 'ratios')
    : base && base.components.length === components.length ? base.ratios : evenRatios(components.length);
  const gradient = r.gradient !== undefined ? r.gradient === true : base?.gradient ?? false;
  const direction = r.direction !== undefined ? (oneOf(r.direction, ['ab', 'ba'] as const, `${at}.direction`)) : base?.direction ?? 'ab';
  let curve: GradientAnchor[] = base?.curve ?? [];
  if (r.curve !== undefined) {
    if (r.curve === null || (Array.isArray(r.curve) && !r.curve.length)) curve = [];
    else if (Array.isArray(r.curve)) {
      curve = parseGradientCurve((r.curve as unknown[]).map((p) => (Array.isArray(p) ? p.slice(0, 2).join(',') : '')).join('|'));
      if (!curve.length) throw new Error(`${at}.curve needs 2+ points [x, y] (x 0–1 height, y 0.1–0.9 share of the first component).`);
    } else throw new Error(`${at}.curve must be a list of [x, y] points or null.`);
  }
  const d: MixedDef = { components, ratios, gradient, direction, curve: gradient ? curve : [], perPart: gradient && (r.perPart !== undefined ? r.perPart === true : base?.perPart ?? false) };
  const err = defError(d, physicalTypes());
  if (err) throw new Error(`${at}: ${err}`);
  return d;
}

export function mixedTools(): BridgeTool[] {
  return [
    {
      name: 'list_mixed_filaments',
      description:
        'Mixed filaments (OrcaSlicer colour mixing): filament slots after the physical ones that print 2–3 physical filaments in thin sub-layers by ratio ' +
        '(or alternating layers when the process setting enable_mixed_color_sublayer is off), optionally as a gradient over the height. ' +
        'Each has a filament number usable for objects, parts, height ranges and colour painting. Lists them with their components, ratios (%) and colour.',
      inputSchema: obj({}),
      async run() {
        await presetsSettled();
        requireMixing();
        return { data: { physical: currentPresets.value.selection.filaments.length, mixed: rows() } };
      },
    },

    {
      name: 'edit_mixed_filaments',
      description:
        'Change mixed filaments. edits, applied in order: ' +
        '{ op: "add", components: [physical filament numbers, 2–3], ratios?: [% each, sum 100, each ≥ 10; default even], gradient?: bool (2 components), direction?: "ab" | "ba", perPart?: bool, curve?: [[x, y], …] } ' +
        '(the new mix gets the next filament number after the existing ones); { op: "set", filament, …same fields }; { op: "remove", filament }; { op: "clear" } (remove all). ' +
        'Components must share a filament type. A gradient runs from the first component towards the second (direction "ab") or back ("ba"); ' +
        'curve points are x = height 0–1, y = share of the first component 0.1–0.9. Removing a mix doesn’t renumber filaments used by objects.',
      inputSchema: obj({ edits: { type: 'array', items: { type: 'object' }, description: 'Edits.' } }, ['edits']),
      async run(args) {
        await presetsSettled();
        requireMixing();
        const edits = args.edits;
        if (!Array.isArray(edits) || !edits.length) throw new Error('edits must be a non-empty list.');
        if (currentPresets.value.selection.filaments.length < 2) throw new Error('Mixed filaments need at least 2 physical filaments (set_filaments count 2).');
        const added: number[] = [];
        for (const [i, e] of edits.entries()) {
          if (!e || typeof e !== 'object') throw new Error(`edits[${i}] must be an object.`);
          const r = e as Record<string, unknown>;
          const op = oneOf(r.op, ['add', 'set', 'remove', 'clear'] as const, `edits[${i}].op`);
          if (op === 'clear') { removeAllMixedFilaments(); continue; }
          if (op === 'add') {
            if (!canAddMixed.value) throw new Error(`edits[${i}]: no room for another filament slot (32 at most).`);
            const id = addMixedFilament(defFrom(r, i));
            if (id) added.push(id);
            continue;
          }
          const m = mixedFilaments.value.find((x) => x.id === r.filament);
          if (!m) throw new Error(`edits[${i}].filament must be one of ${mixedFilaments.value.map((x) => x.id).join(', ') || '(none yet)'} (list_mixed_filaments).`);
          if (op === 'remove') removeMixedFilament(m.id);
          else updateMixedFilament(m.id, defFrom(r, i, m));
        }
        return { data: { ok: true, added: added.length ? added : undefined, mixed: rows(), limits: { components: `2–${MAX_COMPONENTS}`, minRatio: MIN_COMPONENT_RATIO } } };
      },
    },
  ];
}

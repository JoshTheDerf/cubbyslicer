/**
 * Bridge tools: overall state, engine switch, undo / redo, preferences,
 * flushing volumes and the generic command fallback over the action
 * registry (the same commands as the menus, palette and shortcuts).
 */
import { argNumber, argString, type BridgeTool } from '@cubby/shared/bridge';
import { activeEngine, activeView, lastSlice, resolvedConfig } from '../../app/state';
import { useSliceController } from '../../app/slice';
import { getAction, getActionContext, getAllActions } from '../../app/actions';
import { preferences, sanitizePreferences, type Preferences } from '../../app/preferences';
import { confirmRequest, ui } from '../../app/shell/uiState';
import { ENGINE_LABELS } from '../../engine/client';
import type { EngineId } from '../../engine/types';
import { currentPresets, ENGINES, presetsSettled, setActiveEngine } from '../../presets/store';
import { activePlate, historyState, objects, plates, projectName, redo, selectedIds, selectedPart, undo } from '../../project/store';
import { plateLabel } from '../../project/plates';
import { paintUi } from '../../paint/state';
import { toolState } from '../../tools/state';
import { layersUi } from '../../layers/store';
import { setupWizardState } from '../../settings/uiState';
import { physicalPrinter } from '../../printhost/store';
import { hostMeta } from '../../printhost/registry';
import { autoMatrixFor, flushNozzles, readFlush, writeFlush } from '../../dialogs/flush/flushStore';
import { oneOf } from '../logic';
import { bool, filamentRows, num, obj, objectBrief, oneOfS, presetRow, round, settled, str } from './util';

/** Commands that need a click in the browser (native pickers / save dialogs) or would cut the bridge. */
const BLOCKED: Record<string, string> = {
  'file.open': 'Use open_project (a file path) or open_cloud_file.',
  'file.import': 'Use import_model (a file path or URL).',
  'file.save': 'Use save_project.',
  'file.save-as': 'Use save_project or export_3mf.',
  'export.plate-3mf': 'Use export_3mf with kind "plate".',
  'export.plate-stl': 'Use export_stl.',
  'export.selection-stl': 'Use export_stl with ids.',
  'slice.export-gcode': 'Use export_gcode.',
  'slice.export-gcode-e': 'Use export_gcode.',
  'slice.export-all-gcode': 'Use export_gcode with plate "all".',
  'claude.connect': 'The bridge is already connected.',
  'claude.disconnect': 'Ask the user to disconnect from the Help menu.',
};

export function presetSummary() {
  const p = currentPresets.value;
  return {
    engine: activeEngine.value,
    printer: presetRow(p.selectedInfo('printer')),
    process: presetRow(p.selectedInfo('process')),
    filaments: filamentRows(),
  };
}

export function coreTools(): BridgeTool[] {
  const slicer = useSliceController();
  return [
    {
      name: 'get_state',
      description:
        'Current slicer state: engine, presets (printer / process / filaments with colours), bed, plates, objects (short rows; list_objects has full detail), ' +
        'selection, view, open tool, slice status, print host and undo labels. Also says when the app waits for the user to answer a prompt. ' +
        'Frames: Z-up, mm; positions are bed coordinates of the object’s plate; plates and filaments are numbered from 1.',
      inputSchema: obj({}),
      async run() {
        await presetsSettled();
        const r = lastSlice.value;
        const p = currentPresets.value;
        const pp = physicalPrinter.value;
        const b = resolvedConfig.value;
        const plateStates = slicer.plateStates.value;
        return {
          data: {
            project: projectName.value,
            ...presetSummary(),
            engines: ENGINES.map((e) => ({ id: e, label: ENGINE_LABELS[e] })),
            unsavedPresetEdits: { printer: p.dirtyCount('printer'), process: p.dirtyCount('process'), filaments: p.selection.filaments.map((_, i) => p.dirtyCount('filament', i)) },
            bed: { printableArea: b.printable_area ?? b.bed_shape ?? null, maxHeight: b.printable_height ?? b.max_print_height ?? null, bedType: p.bedType() },
            plates: plates.value.map((pl, i) => ({
              plate: i + 1, name: plateLabel(pl, i), locked: pl.locked, objects: objects.value.filter((o) => objectBrief(o.id).plate === i + 1).length,
              slice: plateStates[i] ?? 'none', settings: pl.config, customGcodes: pl.customGcodes?.length || undefined,
            })),
            activePlate: activePlate.value + 1,
            view: activeView.value,
            objects: objects.value.map((o) => objectBrief(o.id)),
            selection: { ids: selectedIds.value, part: selectedPart.value ?? undefined },
            openTool: paintUi.layer ? `paint:${paintUi.layer}` : toolState.active ?? (layersUi.editing ? 'variable layer height' : undefined),
            slice: { status: slicer.status.value, sliced: !!r, stale: slicer.isStale.value, error: slicer.error.value, progress: slicer.status.value === 'slicing' ? slicer.progress.value : undefined },
            printHost: pp ? { type: pp.config.type, label: hostMeta(pp.config.type)?.label, host: pp.config.host, source: pp.source } : null,
            undo: historyState.value.undo, redo: historyState.value.redo,
            busy: ui.busy ?? undefined,
            waitingForUser: confirmRequest.value ? { title: confirmRequest.value.title, message: confirmRequest.value.message } : undefined,
            setupWizardOpen: setupWizardState.open || undefined,
          },
        };
      },
    },

    {
      name: 'set_engine',
      description: 'Switch the slicing engine: "orca" (OrcaSlicer, large printer library), "fullspectrum" (Snapmaker Orca fork with mixed filaments) or "preflight" (PrusaSlicer-based). Each engine keeps its own presets and edits. Returns the presets now selected.',
      inputSchema: obj({ engine: oneOfS(ENGINES, 'Engine id.') }, ['engine']),
      async run(args) {
        const e = oneOf(args.engine, ENGINES, 'engine') as EngineId;
        setActiveEngine(e);
        await settled();
        return { data: { ok: true, ...presetSummary() } };
      },
    },

    {
      name: 'undo',
      description: 'Undo the last slicer edit (or `steps` edits): anything in the undo history (objects, parts, plates, paint, layer heights, per-object settings…). Preset edits are not in the history; use discard_preset_changes.',
      inputSchema: obj({ steps: num('How many (default 1, max 50).') }),
      run(args) {
        const n = Math.max(1, Math.min(50, Math.floor(argNumber(args, 'steps', { optional: true }) ?? 1)));
        const done: string[] = [];
        for (let i = 0; i < n; i++) { const l = undo(); if (!l) break; done.push(l); }
        return { data: { ok: done.length > 0, undone: done, next: historyState.value.undo, canRedo: !!historyState.value.redo } };
      },
    },

    {
      name: 'redo',
      description: 'Redo the last undone edit (or `steps`).',
      inputSchema: obj({ steps: num('How many (default 1, max 50).') }),
      run(args) {
        const n = Math.max(1, Math.min(50, Math.floor(argNumber(args, 'steps', { optional: true }) ?? 1)));
        const done: string[] = [];
        for (let i = 0; i < n; i++) { const l = redo(); if (!l) break; done.push(l); }
        return { data: { ok: done.length > 0, redone: done, next: historyState.value.redo } };
      },
    },

    {
      name: 'list_actions',
      description: 'App commands from the action registry (id, title, category, key, available now, on/off state). Run one with run_action. Use this for anything no other tool covers.',
      inputSchema: obj({
        category: str('Filter by category, e.g. "Object", "Plate", "View", "Preview", "Settings", "Calibration".'),
        query: str('Filter by words in the id, title or aliases.'),
        availableOnly: bool('Only commands that can run now.'),
      }),
      run(args) {
        const ctx = getActionContext();
        const c = argString(args, 'category', { optional: true })?.toLowerCase();
        const words = (argString(args, 'query', { optional: true }) ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        let list = getAllActions().filter((a) => !a.hidden || !a.paletteHidden).map((a) => ({
          id: a.id, title: ctx && a.dynamicTitle ? a.dynamicTitle(ctx) : a.title, category: a.category,
          available: ctx ? (a.when ? !!a.when(ctx) : true) && !BLOCKED[a.id] : false,
          state: ctx && a.state ? a.state(ctx) : undefined,
          key: a.binding && !a.binding.displayOnly ? [a.binding.ctrlOrMeta ? 'Ctrl' : '', a.binding.shift ? 'Shift' : '', a.binding.alt ? 'Alt' : '', a.binding.key ?? a.binding.code ?? ''].filter(Boolean).join('+') : undefined,
          aliases: a.aliases,
          note: BLOCKED[a.id],
        }));
        if (c) list = list.filter((a) => a.category.toLowerCase() === c);
        if (words.length) list = list.filter((a) => words.every((w) => `${a.id} ${a.title} ${(a.aliases ?? []).join(' ')}`.toLowerCase().includes(w)));
        if (args.availableOnly === true) list = list.filter((a) => a.available);
        const categories = [...new Set(getAllActions().map((a) => a.category))];
        return { data: { count: list.length, categories, actions: list.map(({ aliases: _a, ...rest }) => rest) } };
      },
    },

    {
      name: 'run_action',
      description:
        'Run an app command by id (from list_actions), exactly like its menu item or shortcut. Many act on the selection (see select_objects) or the active plate. ' +
        'Commands that open a dialog show it to the user. Commands that need a native file picker are refused with the tool to use instead.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({ id: str('Command id, e.g. "object.mirror.x", "arrange.all", "view.preview", "preview.toggle.travel".') }, ['id']),
      async run(args) {
        const id = argString(args, 'id')!;
        const a = getAction(id);
        if (!a) {
          const near = getAllActions().filter((x) => x.id.includes(id.split('.').pop() ?? id)).slice(0, 8).map((x) => x.id);
          throw new Error(`No command "${id}".${near.length ? ` Similar: ${near.join(', ')}.` : ''} Use list_actions.`);
        }
        if (BLOCKED[id]) throw new Error(`"${id}" needs a click in the browser. ${BLOCKED[id]}`);
        const ctx = getActionContext();
        if (!ctx) throw new Error('The app is still starting. Try again in a moment.');
        if (a.when && !a.when(ctx)) throw new Error(`"${id}" (${a.title}) can’t run now: it needs a different state (e.g. a selection, a sliced plate or the other view). Check get_state.`);
        await a.run(ctx);
        return { data: { ok: true, ran: id, title: a.dynamicTitle ? a.dynamicTitle(ctx) : a.title, state: a.state ? a.state(ctx) : undefined, undo: historyState.value.undo } };
      },
    },

    {
      name: 'get_preferences',
      description: 'App preferences (Preferences dialog): units, default engine, camera behaviour, auto-arrange after import, auto flushing volumes, keyboard hints.',
      inputSchema: obj({}),
      run() { return { data: { preferences: { ...preferences } } }; },
    },

    {
      name: 'set_preferences',
      description: 'Change app preferences, e.g. { "values": { "autoArrangeImport": true, "units": "metric" } }. units: metric | imperial; defaultEngine: last | orca | preflight | fullspectrum; autoFlush: all | color | off; orbitSpeed 0.1–5; the rest are booleans.',
      inputSchema: obj({ values: { type: 'object', description: 'Preference → value.' } }, ['values']),
      run(args) {
        const v = args.values as Record<string, unknown>;
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('values must be an object.');
        const unknown = Object.keys(v).filter((k) => !(k in preferences));
        if (unknown.length) throw new Error(`Unknown preference${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Valid: ${Object.keys(preferences).join(', ')}.`);
        const next = sanitizePreferences({ ...preferences, ...v });
        const rejected = Object.keys(v).filter((k) => next[k as keyof Preferences] !== v[k]);
        Object.assign(preferences, next);
        return { data: { ok: !rejected.length, preferences: { ...preferences }, rejected: rejected.length ? rejected : undefined } };
      },
    },

    {
      name: 'get_flushing_volumes',
      description: 'Flushing volumes (mm³) between filaments for multi-material prints: matrix[from][to] per nozzle, the multiplier, and the auto-calculated matrix from the filament colours.',
      inputSchema: obj({}),
      async run() {
        await presetsSettled();
        const f = readFlush();
        return { data: { filaments: f.n, nozzles: f.nozzles, colours: f.colours, matrices: f.matrices, multipliers: f.multipliers, auto: Array.from({ length: flushNozzles() }, (_, z) => autoMatrixFor(z)) } };
      },
    },

    {
      name: 'set_flushing_volumes',
      description: 'Set the flushing volumes (like the Flushing volumes dialog). matrices: one n×n matrix per nozzle (mm³, from row → to column, diagonal 0), or auto: true to recalculate from the colours. multipliers: one per nozzle (Orca only).',
      inputSchema: obj({
        matrices: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, description: 'Per nozzle: rows of numbers.' },
        auto: bool('Use the auto-calculated matrices.'),
        multipliers: { type: 'array', items: { type: 'number' }, description: 'Per nozzle.' },
      }),
      async run(args) {
        await presetsSettled();
        const f = readFlush();
        if (f.n < 2) throw new Error('Flushing volumes need at least 2 filaments (set_filaments).');
        let matrices = f.matrices;
        if (args.auto === true) matrices = Array.from({ length: f.nozzles }, (_, z) => autoMatrixFor(z));
        else if (args.matrices !== undefined) {
          const m = args.matrices as unknown;
          const ok = Array.isArray(m) && m.length === f.nozzles && m.every((mat) => Array.isArray(mat) && mat.length === f.n
            && mat.every((row: unknown) => Array.isArray(row) && row.length === f.n && row.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)));
          if (!ok) throw new Error(`matrices must be ${f.nozzles} matri${f.nozzles === 1 ? 'x' : 'ces'} of ${f.n}×${f.n} non-negative numbers.`);
          matrices = m as number[][][];
        }
        const multipliers = Array.isArray(args.multipliers) ? (args.multipliers as number[]).map((x) => round(Number(x), 3)) : f.multipliers;
        writeFlush({ matrices, multipliers });
        await settled();
        const now = readFlush();
        return { data: { ok: true, matrices: now.matrices, multipliers: now.multipliers } };
      },
    },
  ];
}

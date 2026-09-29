/**
 * Bridge tools: presets. Listing and selecting (with the same "unsaved
 * changes" choice the preset combo asks for), filament slots and colours,
 * user preset save / rename / delete, comparing against the system preset,
 * importing / exporting Orca preset files, and the first-run setup path.
 */
import { argNumber, argString, base64ToBytes, bytesToBase64, type BridgeTool } from '@cubby/shared/bridge';
import { activeEngine } from '../../app/state';
import type { ConfigValue, EngineId } from '../../engine/types';
import { currentPresets, ENGINES, presetsSettled, setActiveEngine, type EnginePresets } from '../../presets/store';
import type { PresetKind } from '../../presets/types';
import { valuesEqual } from '../../presets/values';
import { lsSet } from '../../presets/kv';
import { panelRequest, SETUP_DONE_KEY, setupWizardState } from '../../settings/uiState';
import { oneOf } from '../logic';
import { bridge } from '../store';
import { presetSummary } from './core';
import { bool, filamentRows, num, obj, oneOfS, presetRow, settled, str, strList } from './util';

const KINDS: PresetKind[] = ['printer', 'process', 'filament'];
const HEX = /^#[0-9a-f]{6}$/i;

/** Filament slot from `filament` (1-based) or the older `filamentIndex` (0-based). Default slot 1. */
export function slotArg(args: Record<string, unknown>, p: EnginePresets): number {
  const n = p.selection.filaments.length;
  const one = argNumber(args, 'filament', { optional: true });
  const zero = argNumber(args, 'filamentIndex', { optional: true });
  const i = one !== undefined ? one - 1 : zero ?? 0;
  if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`"filament" must be a slot from 1 to ${n} (set_filaments changes the count).`);
  return i;
}

async function findPreset(p: EnginePresets, kind: PresetKind, name: string): Promise<string | undefined> {
  const pool = kind === 'printer' ? p.printerInfos.value : kind === 'process' ? p.compatible.value.process : p.compatible.value.filament;
  const found = pool.find((x) => x.name === name) ?? pool.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  if (kind === 'printer') return (await p.catalog.findByName('printer', name).catch(() => null))?.id;
  return undefined;
}

async function selectById(p: EnginePresets, kind: PresetKind, id: string, index: number, keep: boolean): Promise<void> {
  if (kind === 'printer') await p.selectPrinter(id, { keepOverrides: keep });
  else if (kind === 'process') await p.selectProcess(id, { keepOverrides: keep });
  else await p.selectFilament(index, id, { keepOverrides: keep });
}

function labelOf(p: EnginePresets, key: string): string {
  const d = p.schema.value?.options[key];
  return d ? d.fullLabel || d.label : key;
}

const FILAMENT_ARGS = {
  filament: num('Filament slot, 1-based (default 1). Only for kind "filament".'),
  filamentIndex: num('Older form: filament slot, 0-based.'),
};

export function presetTools(): BridgeTool[] {
  return [
    {
      name: 'list_presets',
      description:
        'List presets. kind "printer": the installed printers, or with `query` also matching printers from the vendor library (select one to install it). ' +
        'kind "process" / "filament": presets compatible with the selected printer. `query` filters by name words.',
      inputSchema: obj({
        kind: oneOfS(KINDS, 'Preset kind.'),
        query: str('Case-insensitive name filter, e.g. "Prusa MK4" or "PLA".'),
        limit: num('Max rows (default 40).'),
      }, ['kind']),
      async run(args) {
        const kind = oneOf(args.kind, KINDS, 'kind');
        const q = (argString(args, 'query', { optional: true }) ?? '').toLowerCase().trim();
        const limit = argNumber(args, 'limit', { optional: true }) ?? 40;
        await presetsSettled();
        const p = currentPresets.value;
        const words = q.split(/\s+/).filter(Boolean);
        const hit = (name: string) => words.every((w) => name.toLowerCase().includes(w));
        if (kind === 'printer') {
          const installed = p.printerInfos.value.filter((x) => !q || hit(x.name)).map((x) => ({ ...presetRow(x), installed: true }));
          const library: Array<Record<string, unknown>> = [];
          if (q) {
            for (const v of await p.catalog.vendors().catch(() => [])) {
              if (library.length >= limit) break;
              const vendorHit = words.some((w) => v.name.toLowerCase().includes(w));
              const models = await p.catalog.models(v.id).catch(() => []);
              for (const m of models) {
                for (const variant of m.variants) {
                  const name = variant.preset.name;
                  if ((vendorHit ? words.filter((w) => !v.name.toLowerCase().includes(w)).every((w) => `${m.name} ${name}`.toLowerCase().includes(w)) : hit(`${v.name} ${m.name} ${name}`))
                    && !installed.some((i) => i.id === variant.preset.id)) {
                    library.push({ id: variant.preset.id, name, vendor: v.name, model: m.name, installed: false });
                  }
                }
              }
            }
          }
          return { data: { selected: p.selectedInfo('printer').id, installed: installed.slice(0, limit), library: library.slice(0, limit) } };
        }
        const list = (kind === 'process' ? p.compatible.value.process : p.compatible.value.filament).filter((x) => !q || hit(x.name));
        return { data: { selected: kind === 'process' ? p.selection.process : p.selection.filaments, count: list.length, presets: list.slice(0, limit).map(presetRow) } };
      },
    },

    {
      name: 'select_preset',
      description:
        'Select a printer, process or filament preset by id (from list_presets) or exact name. A library printer is installed on selection; a new printer also picks its default process and filaments. ' +
        'When the current preset has unsaved edits, pass unsaved: "discard", "keep" (carry the edits over) or "save" (user presets only), like the app asks.',
      inputSchema: obj({
        kind: oneOfS(KINDS, 'Preset kind.'),
        id: str('Preset id, e.g. "sys:Prusa/Prusa MK4 0.4 nozzle".'),
        name: str('Exact preset name (when you don’t have the id).'),
        unsaved: oneOfS(['discard', 'keep', 'save'], 'What to do with unsaved edits of the current preset.'),
        ...FILAMENT_ARGS,
      }, ['kind']),
      async run(args) {
        const kind = oneOf(args.kind, KINDS, 'kind');
        await presetsSettled();
        const p = currentPresets.value;
        const index = kind === 'filament' ? slotArg(args, p) : 0;
        let id = argString(args, 'id', { optional: true });
        const name = argString(args, 'name', { optional: true });
        if (!id && name) {
          id = await findPreset(p, kind, name);
          if (!id) throw new Error(`No ${kind} preset named "${name}". Use list_presets.`);
        }
        if (!id) throw new Error('Pass id or name.');
        const dirty = p.dirtyCount(kind, index);
        let keep = false;
        if (dirty && id !== p.selectedId(kind, index)) {
          const choice = args.unsaved === undefined ? undefined : oneOf(args.unsaved, ['discard', 'keep', 'save'] as const, 'unsaved');
          if (!choice) throw new Error(`The current ${kind} preset "${p.selectedInfo(kind, index).name}" has ${dirty} unsaved edit${dirty > 1 ? 's' : ''}. Pass unsaved: "discard", "keep" or "save" (or save_preset first).`);
          if (choice === 'save') {
            if (p.selectedInfo(kind, index).source !== 'user') throw new Error('The current preset is a system preset: save it with save_preset and a name first, or pass unsaved: "discard" / "keep".');
            await p.save(kind, index);
          }
          keep = choice === 'keep';
        }
        await selectById(p, kind, id, index, keep);
        await settled();
        const got = p.selectedId(kind, index);
        if (got !== id) throw new Error(`"${id}" isn’t available for the selected printer (still ${p.selectedInfo(kind, index).name}). Use list_presets.`);
        return { data: { ok: true, ...presetSummary() } };
      },
    },

    {
      name: 'remove_printer',
      description: 'Uninstall a library printer from the printer list (Add / remove printers). User printer presets are deleted with delete_preset instead.',
      inputSchema: obj({ id: str('Printer preset id from list_presets.') }, ['id']),
      async run(args) {
        const id = argString(args, 'id')!;
        await presetsSettled();
        const p = currentPresets.value;
        if (!p.installedPrinters.value.includes(id)) throw new Error(`"${id}" isn’t an installed library printer. Installed: ${p.installedPrinters.value.join(', ') || 'none'}.`);
        await p.uninstallPrinter(id);
        await settled();
        return { data: { ok: true, ...presetSummary() } };
      },
    },

    {
      name: 'set_filaments',
      description:
        'Filament slots (multi-material / multi-tool): set the slot count, slot colours ("#RRGGBB", "" = the preset’s colour) and remove a slot. ' +
        'New slots copy the last slot’s preset; pick presets per slot with select_preset. Colours drive the preview, colour painting and flushing volumes.',
      inputSchema: obj({
        count: num('Number of filament slots (1–64).'),
        colors: strList('Colour per slot, in order; entries you leave out keep their colour.'),
        color: str('Colour for one slot (with "filament").'),
        filament: num('Slot for "color", 1-based.'),
        remove: num('Remove this slot (1-based), keeping the others’ presets and colours.'),
      }),
      async run(args) {
        await presetsSettled();
        const p = currentPresets.value;
        const count = argNumber(args, 'count', { optional: true });
        const remove = argNumber(args, 'remove', { optional: true });
        if (remove !== undefined) {
          const n = p.selection.filaments.length;
          if (!Number.isInteger(remove) || remove < 1 || remove > n) throw new Error(`"remove" must be a slot from 1 to ${n}.`);
          if (n <= 1) throw new Error('There is only one filament slot.');
          await p.removeFilament(remove - 1);
        }
        if (count !== undefined) {
          if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('"count" must be a whole number from 1 to 64.');
          await p.setFilamentCount(count);
        }
        const colors = Array.isArray(args.colors) ? args.colors : [];
        for (const [i, c] of colors.entries()) {
          if (typeof c !== 'string' || (c && !HEX.test(c))) throw new Error(`colors[${i}] must be "#RRGGBB" or "".`);
          if (i < p.selection.filaments.length) p.setFilamentColour(i, c);
        }
        const one = argString(args, 'color', { optional: true });
        if (one !== undefined) {
          if (one && !HEX.test(one)) throw new Error('"color" must be "#RRGGBB" or "".');
          p.setFilamentColour(slotArg(args, p), one);
        }
        await settled();
        return { data: { ok: true, filaments: filamentRows() } };
      },
    },

    {
      name: 'save_preset',
      description:
        'Save the unsaved edits of a tab (printer / process / filament slot). With `name`: save as a new user preset (on top of the system preset) and select it. ' +
        'Without: write into the selected user preset (system presets need a name).',
      inputSchema: obj({ kind: oneOfS(KINDS, 'Preset kind.'), name: str('New preset name (save as).'), ...FILAMENT_ARGS }, ['kind']),
      async run(args) {
        const kind = oneOf(args.kind, KINDS, 'kind');
        await presetsSettled();
        const p = currentPresets.value;
        const index = kind === 'filament' ? slotArg(args, p) : 0;
        const name = argString(args, 'name', { optional: true })?.trim();
        if (name) {
          if (name.length > 120) throw new Error('The name is too long (120 characters max).');
          const u = await p.saveAs(kind, name, index);
          await settled();
          return { data: { ok: true, saved: { id: u.id, name: u.name }, ...presetSummary() } };
        }
        const info = p.selectedInfo(kind, index);
        if (info.source !== 'user') throw new Error(`"${info.name}" is a ${info.source} preset: pass "name" to save your edits as a new user preset.`);
        if (!p.dirtyCount(kind, index)) return { data: { ok: true, saved: { id: info.id, name: info.name }, note: 'Nothing to save: no unsaved edits.' } };
        await p.save(kind, index);
        await settled();
        return { data: { ok: true, saved: { id: info.id, name: info.name }, ...presetSummary() } };
      },
    },

    {
      name: 'rename_preset',
      description: 'Rename a user preset (id from list_presets; ids start with "user:").',
      inputSchema: obj({ id: str('User preset id.'), name: str('New name.') }, ['id', 'name']),
      async run(args) {
        const id = argString(args, 'id')!;
        const name = argString(args, 'name')!.trim();
        await presetsSettled();
        const p = currentPresets.value;
        if (!p.users.get(id)) throw new Error(`"${id}" isn’t a user preset (only user presets can be renamed).`);
        if (!name) throw new Error('"name" must not be empty.');
        const u = await p.renamePreset(id, name);
        return { data: { ok: true, id: u.id, name: u.name } };
      },
    },

    {
      name: 'delete_preset',
      description: 'Delete a user preset. It can’t be undone, so the user confirms in the browser. Anything using it falls back to its system parent.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({ id: str('User preset id (from list_presets).') }, ['id']),
      async run(args) {
        const id = argString(args, 'id')!;
        await presetsSettled();
        const p = currentPresets.value;
        const u = p.users.get(id);
        if (!u) throw new Error(`"${id}" isn’t a user preset (system presets can’t be deleted).`);
        const ok = await bridge.confirm({ key: 'preset-delete', title: 'Delete preset?', message: `Claude Code wants to delete the user preset “${u.name}”. This cannot be undone.`, confirmLabel: 'Delete' });
        if (!ok) return { data: { ok: false, error: 'The user declined.' } };
        await p.deletePreset(id);
        await settled();
        return { data: { ok: true, deleted: u.name, ...presetSummary() } };
      },
    },

    {
      name: 'discard_preset_changes',
      description: 'Discard the unsaved edits of a tab (printer / process / filament slot), back to the preset’s values.',
      inputSchema: obj({ kind: oneOfS(KINDS, 'Preset kind.'), ...FILAMENT_ARGS }, ['kind']),
      async run(args) {
        const kind = oneOf(args.kind, KINDS, 'kind');
        await presetsSettled();
        const p = currentPresets.value;
        const index = kind === 'filament' ? slotArg(args, p) : 0;
        const n = p.dirtyCount(kind, index);
        p.revertAll(kind, index);
        await settled();
        return { data: { ok: true, discarded: n } };
      },
    },

    {
      name: 'compare_presets',
      description:
        'What differs in a tab: the unsaved edits (preset value → edited value) and, for a user preset, its own values against the system preset it is based on. ' +
        'Use before saving or to explain the current settings.',
      inputSchema: obj({ kind: oneOfS(KINDS, 'Preset kind.'), ...FILAMENT_ARGS }, ['kind']),
      async run(args) {
        const kind = oneOf(args.kind, KINDS, 'kind');
        await presetsSettled();
        const p = currentPresets.value;
        const index = kind === 'filament' ? slotArg(args, p) : 0;
        const info = p.selectedInfo(kind, index);
        const ov = kind === 'filament' ? p.overrides.filaments[index] ?? {} : p.overrides[kind];
        const unsaved = Object.entries(ov).map(([key, v]) => ({ key, label: labelOf(p, key), preset: p.presetValue(kind, key, index), edited: v as ConfigValue }));
        let vsSystem: Array<{ key: string; label: string; system: ConfigValue | undefined; value: ConfigValue }> | undefined;
        let parent: string | undefined;
        if (info.source === 'user') {
          const u = p.users.get(info.id);
          const par = u?.parentId ? await p.resolvePreset(kind, u.parentId) : null;
          parent = par?.info.name ?? u?.inherits;
          vsSystem = Object.entries(u?.values ?? {})
            .filter(([k, v]) => !valuesEqual(v as ConfigValue, par?.values[k] as ConfigValue | undefined))
            .map(([key, v]) => ({ key, label: labelOf(p, key), system: par?.values[key] as ConfigValue | undefined, value: v as ConfigValue }));
        }
        return { data: { preset: presetRow(info), systemParent: parent, unsaved, vsSystem, note: info.source === 'system' && !unsaved.length ? 'A system preset with no edits: nothing differs.' : undefined } };
      },
    },

    {
      name: 'import_presets',
      description: 'Import preset files as user presets: Orca / Bambu JSON presets or bundles (.orca_printer, .orca_filament, .bbscfg, .zip). Give a local path (through cubby-mcp) or name + dataBase64.',
      fileInput: true,
      inputSchema: obj({ name: str('File name with extension.'), dataBase64: str('File bytes, base64.') }, ['name', 'dataBase64']),
      async run(args) {
        const name = argString(args, 'name')!;
        const data = base64ToBytes(argString(args, 'dataBase64')!);
        await presetsSettled();
        const r = await currentPresets.value.importFiles([{ name, data }]);
        await settled();
        return { data: { ok: r.imported.length > 0, imported: r.imported.map((u) => ({ id: u.id, kind: u.kind, name: u.name })), warnings: r.warnings.length ? r.warnings : undefined } };
      },
    },

    {
      name: 'export_preset',
      description: 'Save the selected preset of a tab (with unsaved edits) as an Orca preset JSON file. flatten: true writes every value instead of the difference from the system preset.',
      fileOutput: true,
      inputSchema: obj({ kind: oneOfS(KINDS, 'Preset kind.'), flatten: bool('Full values (default false).'), ...FILAMENT_ARGS }, ['kind']),
      async run(args) {
        const kind = oneOf(args.kind, KINDS, 'kind');
        await presetsSettled();
        const p = currentPresets.value;
        const index = kind === 'filament' ? slotArg(args, p) : 0;
        const { filename, json } = await p.exportPreset(kind, index, args.flatten === true);
        const bytes = new TextEncoder().encode(JSON.stringify(json, null, 4));
        return { data: { ok: true, name: filename }, file: { name: filename, mimeType: 'application/json', base64: bytesToBase64(bytes) } };
      },
    },

    {
      name: 'setup',
      description:
        'The first-run setup path in one call (engine → printer → filaments), then closes the setup wizard if it is showing. ' +
        'printer: a preset id or exact name (library printers are installed); filaments: one preset id or name per slot. Anything left out stays as it is.',
      inputSchema: obj({
        engine: oneOfS(ENGINES, 'Engine.'),
        printer: str('Printer preset id or name.'),
        process: str('Process preset id or name.'),
        filaments: strList('Filament preset id or name per slot (slot 1 first).'),
      }),
      async run(args) {
        const engine = args.engine === undefined ? undefined : oneOf(args.engine, ENGINES, 'engine') as EngineId;
        if (engine && engine !== activeEngine.value) setActiveEngine(engine);
        await settled();
        const p = currentPresets.value;
        const resolveId = async (kind: PresetKind, v: string) => (/^(sys|user|default):/.test(v) ? v : await findPreset(p, kind, v));
        const printer = argString(args, 'printer', { optional: true });
        if (printer) {
          const id = await resolveId('printer', printer);
          if (!id) throw new Error(`No printer "${printer}". Use list_presets with a query.`);
          await p.selectPrinter(id);
          await settled();
          if (p.selectedId('printer') !== id) throw new Error(`Couldn’t select printer "${printer}".`);
        }
        const process = argString(args, 'process', { optional: true });
        if (process) {
          const id = await resolveId('process', process);
          if (!id) throw new Error(`No process "${process}" for this printer. Use list_presets.`);
          await p.selectProcess(id);
        }
        const fil = Array.isArray(args.filaments) ? args.filaments.filter((x): x is string => typeof x === 'string') : [];
        if (fil.length > p.selection.filaments.length) await p.setFilamentCount(fil.length);
        for (const [i, f] of fil.entries()) {
          const id = await resolveId('filament', f);
          if (!id) throw new Error(`No filament "${f}" for this printer. Use list_presets with kind "filament".`);
          await p.selectFilament(i, id);
        }
        await settled();
        lsSet(SETUP_DONE_KEY, true);
        if (setupWizardState.open) panelRequest.closeSetupWizard++;
        return { data: { ok: true, ...presetSummary() } };
      },
    },
  ];
}

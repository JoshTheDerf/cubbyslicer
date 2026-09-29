/**
 * Slicer tools for the Claude Code bridge. Each one goes through the same
 * store functions the UI uses (import, arrange, preset selection, slice,
 * print host upload), so a tool call behaves like the matching click and
 * lands in undo history.
 *
 * Sending to a printer and changing the print host ask the user in this tab
 * first, unless they allowed it without asking for this session.
 */
import { argNumber, argString, base64ToBytes, bytesToBase64, type BridgeTool, type JsonSchema } from '@cubby/shared/bridge';
import type { ConfigValue } from '../engine/types';
import { activeEngine, lastSlice, resolvedConfig } from '../app/state';
import { activeGcode, useSliceController } from '../app/slice';
import { importBuffer } from '../app/shell/actions';
import { currentPresets, presetsSettled } from '../presets/store';
import type { PresetInfo, PresetKind } from '../presets/types';
import { normalizeValue } from '../presets/values';
import {
  activePlate, arrangeObjects, clearPlate, getMesh, getObject, historyState, objectInfo, objectIssues, objectPlate, objects,
  objectsOnPlate, plates, projectName, redo, removeObjects, setActivePlate, setObjectOverride, undo,
} from '../project/store';
import { buildOrca3mf } from '../project/persistence/orca3mfWriter';
import { build3mf } from '../project/export/threemf';
import { STORAGE_PREFIX, emptyConfig, normalizeConfig, sanitizeUploadName } from '../printhost/config';
import { HOSTS, hostMeta } from '../printhost/registry';
import { boundPrinter, hostContext, physicalPrinter, savePhysicalPrinter } from '../printhost/store';
import { describeError, sendToPrinterDetailed, testConnection } from '../printhost/send';
import type { HostType, PhysicalPrinterConfig } from '../printhost/types';
import { bridge } from './store';

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required });
const KINDS: PresetKind[] = ['printer', 'process', 'filament'];

function presetRow(p: PresetInfo) {
  return { id: p.id, name: p.name, source: p.source, vendor: p.vendor, ...(p.filamentType ? { type: p.filamentType } : {}) };
}

function round(v: number, d = 2): number { const f = 10 ** d; return Math.round(v * f) / f; }

function objectRow(id: string) {
  const o = getObject(id)!;
  const info = objectInfo.value.get(id);
  const mesh = getMesh(o.meshId);
  return {
    id: o.id, name: o.name, plate: (objectPlate.value.get(id) ?? -1) + 1, printable: o.printable,
    size: info ? info.max.map((v, i) => round(v - info.min[i])) : null,
    position: o.position.map((v) => round(v)),
    triangles: mesh?.triangleCount ?? 0,
    issues: objectIssues.value.get(id) ?? [],
    overrides: Object.keys(o.overrides).length ? o.overrides : undefined,
  };
}

function presetSummary() {
  const p = currentPresets.value;
  return {
    engine: activeEngine.value,
    printer: presetRow(p.selectedInfo('printer')),
    process: presetRow(p.selectedInfo('process')),
    filaments: p.selection.filaments.map((_, i) => presetRow(p.selectedInfo('filament', i))),
  };
}

/** Wait for a preset change to settle into the resolved config. */
async function settled(): Promise<void> {
  await presetsSettled();
  await new Promise((r) => setTimeout(r, 200));
  await presetsSettled();
}

function printHostRow(c: PhysicalPrinterConfig) {
  const meta = hostMeta(c.type);
  return { type: c.type, label: meta?.label ?? c.type, host: c.host, hasApiKey: !!c.apiKey, support: meta?.support ?? 'none' };
}

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function sum(a: number[] | undefined): number { return (a ?? []).reduce((s, v) => s + v, 0); }

export function slicerTools(): BridgeTool[] {
  const slicer = useSliceController();

  return [
    {
      name: 'get_state',
      description: 'Current slicer state: engine, selected printer / process / filament presets, plates, objects (size mm, plate, issues), slice status and the print host.',
      inputSchema: obj({}),
      async run() {
        await presetsSettled();
        const r = lastSlice.value;
        return {
          data: {
            project: projectName.value,
            ...presetSummary(),
            bed: resolvedConfig.value.printable_area ?? null,
            plates: plates.value.length,
            activePlate: activePlate.value + 1,
            objects: objects.value.map((o) => objectRow(o.id)),
            slice: { status: slicer.status.value, sliced: !!r, stale: slicer.isStale.value, error: slicer.error.value },
            printHost: physicalPrinter.value ? { ...printHostRow(physicalPrinter.value.config), source: physicalPrinter.value.source } : null,
            canUndo: historyState.value.undo, canRedo: historyState.value.redo,
          },
        };
      },
    },

    {
      name: 'list_presets',
      description:
        'List presets. kind "printer": the installed printers, or with `query` also matching printers from the vendor library (install one by selecting it). ' +
        'kind "process" / "filament": presets compatible with the selected printer. `query` filters by name.',
      inputSchema: obj({
        kind: { type: 'string', enum: KINDS },
        query: { type: 'string', description: 'Case-insensitive name filter, e.g. "Prusa MK4" or "PLA".' },
        limit: { type: 'number', description: 'Max rows (default 40).' },
      }, ['kind']),
      async run(args) {
        const kind = argString(args, 'kind') as PresetKind;
        if (!KINDS.includes(kind)) throw new Error('kind must be printer, process or filament.');
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
      description: 'Select a printer, process or filament preset by id (from list_presets) or exact name. Selecting a library printer installs it; a new printer also picks its default process and filament.',
      inputSchema: obj({
        kind: { type: 'string', enum: KINDS },
        id: { type: 'string', description: 'Preset id, e.g. "sys:Prusa/Prusa MK4 0.4 nozzle".' },
        name: { type: 'string', description: 'Exact preset name (when you don’t have the id).' },
        filamentIndex: { type: 'number', description: 'Filament slot, 0-based (default 0).' },
      }, ['kind']),
      async run(args) {
        const kind = argString(args, 'kind') as PresetKind;
        let id = argString(args, 'id', { optional: true });
        const name = argString(args, 'name', { optional: true });
        const index = argNumber(args, 'filamentIndex', { optional: true }) ?? 0;
        await presetsSettled();
        const p = currentPresets.value;
        if (!id && name) {
          const pool = kind === 'printer' ? p.printerInfos.value : kind === 'process' ? p.compatible.value.process : p.compatible.value.filament;
          const found = pool.find((x) => x.name === name) ?? pool.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (!found && kind === 'printer') {
            const lib = await p.catalog.findByName('printer', name).catch(() => null);
            if (lib) id = lib.id;
          } else id = found?.id;
          if (!id) throw new Error(`No ${kind} preset named "${name}". Use list_presets.`);
        }
        if (!id) throw new Error('Pass id or name.');
        if (kind === 'printer') await p.selectPrinter(id);
        else if (kind === 'process') await p.selectProcess(id);
        else await p.selectFilament(index, id);
        await settled();
        const got = kind === 'filament' ? p.selectedId('filament', index) : p.selectedId(kind);
        if (got !== id) throw new Error(`"${id}" isn’t available for the selected printer (still ${p.selectedInfo(kind, index).name}).`);
        return { data: { ok: true, ...presetSummary() } };
      },
    },

    {
      name: 'find_settings',
      description: 'Search the engine’s settings by key, label or tooltip (e.g. "infill", "support", "brim"). Returns keys, labels, current values, units and allowed values, for get_settings / set_settings.',
      inputSchema: obj({ query: { type: 'string' }, limit: { type: 'number', description: 'Max rows (default 25).' } }, ['query']),
      async run(args) {
        const q = argString(args, 'query')!.toLowerCase();
        const limit = argNumber(args, 'limit', { optional: true }) ?? 25;
        await presetsSettled();
        const schema = currentPresets.value.schema.value;
        if (!schema) throw new Error('The engine schema isn’t loaded yet.');
        const cfg = resolvedConfig.value;
        const rows = Object.entries(schema.options)
          .filter(([k, d]) => d.type !== 'none' && (k.includes(q) || d.label.toLowerCase().includes(q) || d.fullLabel.toLowerCase().includes(q) || d.tooltip.toLowerCase().includes(q)))
          .sort(([a, da], [b, db]) => Number(!(a.includes(q) || da.label.toLowerCase().includes(q))) - Number(!(b.includes(q) || db.label.toLowerCase().includes(q))))
          .slice(0, limit)
          .map(([key, d]) => ({
            key, label: d.fullLabel || d.label, category: d.category, scope: d.scope, type: d.type, unit: d.sidetext || undefined,
            value: cfg[key], min: d.min ?? undefined, max: d.max ?? undefined, values: d.enumValues,
          }));
        return { data: { count: rows.length, settings: rows } };
      },
    },

    {
      name: 'get_settings',
      description: 'Read resolved settings (the values the next slice uses) by key, e.g. ["layer_height", "sparse_infill_density", "enable_support"].',
      inputSchema: obj({ keys: { type: 'array', items: { type: 'string' } } }, ['keys']),
      async run(args) {
        const keys = args.keys;
        if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) throw new Error('keys must be a list of setting keys.');
        await presetsSettled();
        const cfg = resolvedConfig.value;
        const schema = currentPresets.value.schema.value;
        const out: Record<string, unknown> = {};
        const unknown: string[] = [];
        for (const k of keys) { if (k in cfg) out[k] = cfg[k]; else unknown.push(k); }
        return { data: { values: out, unknown: unknown.length ? unknown : undefined, hint: unknown.length && schema ? 'Use find_settings to look up keys.' : undefined } };
      },
    },

    {
      name: 'set_settings',
      description:
        'Change settings, e.g. { "values": { "layer_height": 0.2, "sparse_infill_density": "15%", "enable_support": true } }. ' +
        'By default each key goes to its own tab (process / printer / filament) as an unsaved edit, like typing it in the sidebar. ' +
        'Pass objectId to set a per-object override instead. Returns what changed and anything rejected.',
      inputSchema: obj({
        values: { type: 'object', description: 'Setting key → value (string, number, boolean, or a list for per-extruder values).' },
        objectId: { type: 'string', description: 'Apply as overrides on this object (from get_state).' },
        filamentIndex: { type: 'number', description: 'Filament slot for filament settings (default 0).' },
      }, ['values']),
      async run(args) {
        const values = args.values as Record<string, unknown>;
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('values must be an object.');
        const objectId = argString(args, 'objectId', { optional: true });
        const index = argNumber(args, 'filamentIndex', { optional: true }) ?? 0;
        if (objectId && !getObject(objectId)) throw new Error(`No object ${objectId}.`);
        await presetsSettled();
        const p = currentPresets.value;
        const schema = p.schema.value;
        if (!schema) throw new Error('The engine schema isn’t loaded yet.');
        const applied: Record<string, ConfigValue> = {};
        const rejected: Record<string, string> = {};
        for (const [key, raw] of Object.entries(values)) {
          const def = schema.options[key];
          if (!def) { rejected[key] = 'unknown key (see find_settings)'; continue; }
          if (def.readonly) { rejected[key] = 'read-only'; continue; }
          const v = normalizeValue(def, typeof raw === 'boolean' ? (raw ? '1' : '0') : Array.isArray(raw) ? raw.map(String) : String(raw));
          if (def.enumValues && typeof v === 'string' && !def.enumValues.includes(v)) { rejected[key] = `must be one of ${def.enumValues.join(', ')}`; continue; }
          if (objectId) setObjectOverride(objectId, key, v);
          else {
            const kind: PresetKind = def.scope === 'machine' ? 'printer' : def.scope === 'filament' ? 'filament' : 'process';
            p.setValue(kind, key, v, kind === 'filament' ? index : 0);
          }
          applied[key] = v;
        }
        await settled();
        const now: Record<string, unknown> = {};
        for (const k of Object.keys(applied)) now[k] = objectId ? getObject(objectId)?.overrides[k] : resolvedConfig.value[k];
        return { data: { ok: Object.keys(applied).length > 0 || Object.keys(rejected).length === 0, applied: now, rejected: Object.keys(rejected).length ? rejected : undefined } };
      },
    },

    {
      name: 'import_model',
      description: 'Add a model (STL, 3MF, OBJ, STEP) to the active plate. Give dataBase64 + name, or (through cubby-mcp) a local path or URL. cad_to_slicer calls this for you.',
      fileInput: true,
      timeoutMs: 300_000,
      inputSchema: obj({
        name: { type: 'string', description: 'File name with extension, e.g. "bracket.stl".' },
        dataBase64: { type: 'string', description: 'File bytes, base64.' },
        replacePlate: { type: 'boolean', description: 'Clear the active plate first (default false).' },
        arrange: { type: 'boolean', description: 'Arrange the plate afterwards (default true).' },
      }, ['name', 'dataBase64']),
      async run(args) {
        const name = argString(args, 'name')!;
        const bytes = base64ToBytes(argString(args, 'dataBase64')!);
        if (args.replacePlate === true) clearPlate(activePlate.value);
        const ids = await importBuffer(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        if (!ids.length) throw new Error(`Couldn’t import ${name} (see the app’s notification for details).`);
        let unplaced = 0;
        if (args.arrange !== false) unplaced = arrangeObjects(undefined, 6, 'plate');
        return { data: { ok: true, imported: ids.map(objectRow), unplaced: unplaced || undefined } };
      },
    },

    {
      name: 'remove_objects',
      description: 'Delete objects by id, or every object on the active plate with all: true.',
      inputSchema: obj({ ids: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' } }),
      run(args) {
        if (args.all === true) { const n = objectsOnPlate(activePlate.value).length; clearPlate(activePlate.value); return { data: { ok: true, removed: n } }; }
        const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === 'string' && !!getObject(x)) : [];
        if (!ids.length) throw new Error('Pass ids (from get_state) or all: true.');
        removeObjects(ids);
        return { data: { ok: true, removed: ids.length } };
      },
    },

    {
      name: 'arrange',
      description: 'Arrange objects on the active plate (or every plate), like the Arrange button.',
      inputSchema: obj({ spacing: { type: 'number', description: 'Gap in mm (default 6).' }, allPlates: { type: 'boolean' } }),
      run(args) {
        const unplaced = arrangeObjects(undefined, argNumber(args, 'spacing', { optional: true }) ?? 6, args.allPlates === true ? 'all' : 'plate');
        return { data: { ok: true, unplaced, objects: objects.value.map((o) => objectRow(o.id)) } };
      },
    },

    {
      name: 'slice',
      description: 'Slice the active plate (or a given plate) and return print time, filament use, layer count and warnings. Takes seconds to minutes.',
      timeoutMs: 20 * 60_000,
      inputSchema: obj({ plate: { type: 'number', description: 'Plate number, 1-based (default: the active plate).' } }),
      async run(args, ctx) {
        const plate = argNumber(args, 'plate', { optional: true });
        if (plate !== undefined) {
          if (!Number.isInteger(plate) || plate < 1 || plate > plates.value.length) throw new Error(`plate must be 1-${plates.value.length}.`);
          setActivePlate(plate - 1);
        }
        const stop = watchProgress(slicer, ctx.progress);
        const abort = () => slicer.cancel();
        ctx.signal.addEventListener('abort', abort);
        let ok: boolean;
        try { ok = await slicer.slice(); } finally { stop(); ctx.signal.removeEventListener('abort', abort); }
        const r = lastSlice.value;
        if (!ok || !r) {
          const rep = slicer.errorReport.value;
          return { data: { ok: false, error: slicer.error.value ?? 'Slicing failed.', warnings: rep?.warnings } };
        }
        const s = r.report.stats;
        const issues = objectsOnPlate(activePlate.value).flatMap((o) => (objectIssues.value.get(o.id) ?? []).map((i) => `${o.name}: ${i}`));
        return {
          data: {
            ok: true, plate: activePlate.value + 1,
            ...presetSummary(),
            stats: s ? {
              printTime: fmtTime(s.printTimeSec), printTimeSec: Math.round(s.printTimeSec), layers: s.layers, maxZmm: round(s.maxZ),
              filamentG: round(sum(s.filamentG)), filamentM: round(sum(s.filamentMm) / 1000), filamentCost: sum(s.filamentCost) ? round(sum(s.filamentCost)) : undefined,
            } : null,
            warnings: r.report.warnings.map((w) => w.message),
            plateIssues: issues.length ? issues : undefined,
            gcodeBytes: r.gcode.byteLength,
          },
        };
      },
    },

    {
      name: 'export_gcode',
      description: 'Save the active plate’s sliced G-code to a file (cubby-mcp writes it to savePath and returns the path). Slice first.',
      fileOutput: true,
      inputSchema: obj({}),
      run() {
        const g = activeGcode();
        if (!g) throw new Error('The plate is not sliced yet. Call slice first.');
        return { data: { ok: true, name: g.name }, file: { name: g.name, mimeType: 'text/x-gcode', base64: bytesToBase64(g.bytes) } };
      },
    },

    {
      name: 'export_3mf',
      description: 'Save a 3MF: "project" (OrcaSlicer project with plates and settings, default) or "plate" (the active plate’s meshes only).',
      fileOutput: true,
      inputSchema: obj({ kind: { type: 'string', enum: ['project', 'plate'] } }),
      run(args) {
        const kind = args.kind === 'plate' ? 'plate' : 'project';
        const stem = (projectName.value || 'project').replace(/[^\w.-]+/g, '_');
        if (kind === 'plate') {
          const list = objectsOnPlate(activePlate.value);
          if (!list.length) throw new Error('The active plate is empty.');
          return { data: { ok: true, kind }, file: { name: `${stem}_plate${activePlate.value + 1}.3mf`, mimeType: 'model/3mf', base64: bytesToBase64(build3mf(list, getMesh)) } };
        }
        return { data: { ok: true, kind }, file: { name: `${stem}.3mf`, mimeType: 'model/3mf', base64: bytesToBase64(buildOrca3mf()) } };
      },
    },

    {
      name: 'list_print_hosts',
      description: 'List print hosts (physical printers) saved in this browser, one per printer preset, and which one the selected printer uses. API keys are never returned.',
      inputSchema: obj({}),
      async run() {
        await presetsSettled();
        const saved: Array<Record<string, unknown>> = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key?.startsWith(STORAGE_PREFIX)) continue;
            const [engine, ...rest] = key.slice(STORAGE_PREFIX.length).split(':');
            const presetId = rest.join(':');
            const j = JSON.parse(localStorage.getItem(key) ?? '{}') as { config?: unknown; disabled?: boolean };
            if (j.disabled || !j.config) continue;
            const c = normalizeConfig(j.config);
            const info = currentPresets.value.printerInfos.value.find((x) => x.id === presetId);
            saved.push({ engine, printerPreset: info?.name ?? presetId, ...printHostRow(c) });
          }
        } catch { /* storage blocked */ }
        const cur = physicalPrinter.value;
        return {
          data: {
            selectedPrinter: boundPrinter.value.name,
            active: cur ? { ...printHostRow(cur.config), source: cur.source } : null,
            saved,
            hostTypes: HOSTS.filter((h) => h.support !== 'none').map((h) => ({ type: h.type, label: h.label, support: h.support })),
          },
        };
      },
    },

    {
      name: 'set_print_host',
      description: 'Save the print host for the selected printer preset (like Physical printer… in the app). The user confirms in the browser. Use test_print_host to check it.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({
        type: { type: 'string', description: 'Host type, e.g. "octoprint", "moonraker", "prusalink", "duet" (see list_print_hosts.hostTypes).' },
        host: { type: 'string', description: 'Address, e.g. "http://192.168.1.50" or "printer.local".' },
        apiKey: { type: 'string', description: 'API key / password when the host needs one.' },
      }, ['type', 'host']),
      async run(args) {
        const type = argString(args, 'type')! as HostType;
        const meta = hostMeta(type);
        if (!meta) throw new Error(`Unknown host type "${type}".`);
        if (meta.support === 'none') throw new Error(`${meta.label} can’t be used from a browser. ${meta.note ?? ''}`.trim());
        const config = normalizeConfig({ ...emptyConfig(type), ...(physicalPrinter.value?.config.type === type ? physicalPrinter.value.config : {}), type, host: argString(args, 'host'), apiKey: argString(args, 'apiKey', { optional: true }) ?? physicalPrinter.value?.config.apiKey ?? '' });
        const ok = await bridge.confirm({
          key: 'printhost-config',
          title: 'Change the print host?',
          message: `Claude Code wants to send G-code for “${boundPrinter.value.name}” to ${meta.label} at ${config.host}.`,
          confirmLabel: 'Save',
        });
        if (!ok) return { data: { ok: false, error: 'The user declined.' } };
        savePhysicalPrinter(config);
        return { data: { ok: true, printHost: printHostRow(config), printer: boundPrinter.value.name } };
      },
    },

    {
      name: 'test_print_host',
      description: 'Check the selected printer’s print host answers (version / API check).',
      inputSchema: obj({}),
      async run(_args, ctx) {
        const pp = physicalPrinter.value;
        if (!pp) throw new Error('No print host is set for the selected printer. Use set_print_host.');
        try {
          const r = await testConnection(pp.config, ctx.signal);
          return { data: { ok: true, message: r.message, detail: r.detail, host: pp.config.host } };
        } catch (e) {
          const d = describeError(e);
          return { data: { ok: false, error: d.message, detail: d.detail, host: pp.config.host } };
        }
      },
    },

    {
      name: 'send_to_printer',
      description: 'Upload the sliced G-code to the selected printer’s print host, and start the print when print is true. The user confirms in the browser unless they allowed it for this session. Slice first.',
      timeoutMs: 15 * 60_000,
      inputSchema: obj({
        print: { type: 'boolean', description: 'Start printing after the upload (default false: upload only).' },
        filename: { type: 'string', description: 'Name on the printer (default: the slicer’s G-code name).' },
        folder: { type: 'string', description: 'Folder on the printer, when the host has folders.' },
      }),
      async run(args) {
        const pp = physicalPrinter.value;
        if (!pp) throw new Error('No print host is set for the selected printer. Use set_print_host.');
        const g = activeGcode();
        if (!g) throw new Error('The plate is not sliced yet. Call slice first.');
        if (slicer.isStale.value) throw new Error('The slice is out of date (the plate or settings changed). Slice again first.');
        const meta = hostMeta(pp.config.type);
        const print = args.print === true && !!meta?.canPrint(hostContext(pp.config));
        const filename = sanitizeUploadName(argString(args, 'filename', { optional: true }) ?? g.name);
        const folder = argString(args, 'folder', { optional: true }) ?? '';
        const stats = lastSlice.value?.report.stats;
        const ok = await bridge.confirm({
          key: print ? 'print' : 'upload',
          title: print ? 'Start a print?' : 'Upload to the printer?',
          message: `Claude Code wants to ${print ? 'upload and start printing' : 'upload'} ${filename} (${stats ? `${fmtTime(stats.printTimeSec)}, ${round(sum(stats.filamentG), 1)} g` : `${Math.round(g.bytes.byteLength / 1024)} KB`}) on ${meta?.label ?? pp.config.type} at ${pp.config.host}.`,
          confirmLabel: print ? 'Print' : 'Upload',
        });
        if (!ok) return { data: { ok: false, error: 'The user declined.' } };
        const r = await sendToPrinterDetailed({ filename, folder, print });
        return { data: { ...r, filename, requestedPrint: args.print === true, printing: r.ok && !!r.printed } };
      },
    },

    {
      name: 'undo',
      description: 'Undo the last slicer edit (import, arrange, delete, override…).',
      inputSchema: obj({}),
      run() { const label = undo(); return { data: { ok: !!label, undone: label, next: historyState.value.undo } }; },
    },

    {
      name: 'redo',
      description: 'Redo the last undone slicer edit.',
      inputSchema: obj({}),
      run() { const label = redo(); return { data: { ok: !!label, redone: label } }; },
    },
  ];
}

/** Forward slice progress to the bridge while `slicer.slice()` runs. */
function watchProgress(slicer: ReturnType<typeof useSliceController>, report: (p: number, total?: number, message?: string) => void): () => void {
  let last = -1;
  const t = setInterval(() => {
    const p = slicer.progress.value;
    if (p !== last) { last = p; report(p, 100, slicer.message.value); }
  }, 500);
  return () => clearInterval(t);
}

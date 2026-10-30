/**
 * Bridge tools: print hosts (named physical printers, each running one or
 * more printer presets; this tab sends to one of the selected preset's).
 * Changing or removing a host and every upload / print ask the user in this
 * tab first, unless they allowed it for the session.
 */
import { argString, type BridgeTool } from '@cubby/shared/bridge';
import { lastSlice } from '../../app/state';
import { activeGcode, useSliceController } from '../../app/slice';
import { activePlate, setActivePlate } from '../../project/store';
import { presetsSettled } from '../../presets/store';
import { emptyConfig, normalizeConfig, sanitizeUploadName } from '../../printhost/config';
import { HOSTS, hostMeta } from '../../printhost/registry';
import {
  boundPrinter, deviceStore, hostContext, physicalPrinter, printerChoices, printhostUi, removePhysicalPrinter, savePhysicalPrinter, selectDevice,
  type PrinterChoice,
} from '../../printhost/store';
import { describeError, sendToPrinterDetailed, testConnection } from '../../printhost/send';
import { browserEnv } from '../../printhost/transport';
import type { AuthType, HostType, PhysicalPrinterConfig } from '../../printhost/types';
import { bridge } from '../store';
import { oneOf } from '../logic';
import { bool, fmtTime, num, obj, plateArg, round, str, sum } from './util';

function printHostRow(c: PhysicalPrinterConfig) {
  const meta = hostMeta(c.type);
  return {
    type: c.type, label: meta?.label ?? c.type, host: c.host, hasApiKey: !!c.apiKey, user: c.user || undefined, hasPassword: !!c.password,
    authType: c.authType, printer: c.printer || undefined, webUi: c.webUi || undefined, variant: c.variant || undefined, wsUrl: c.wsUrl || undefined,
    support: meta?.support ?? 'none', canPrint: meta ? meta.canPrint(hostContext(c)) : false,
  };
}

const DEVICE_ARG = 'Physical printer id or name (list_print_hosts); default: the one this tab sends to.';

/** The selected preset's device named by `device` (id or name), else this tab's. */
function choiceArg(args: Record<string, unknown>): PrinterChoice {
  const want = argString(args, 'device', { optional: true });
  if (!want) {
    const pp = physicalPrinter.value;
    if (!pp) throw new Error(`No physical printer runs the selected printer preset “${boundPrinter.value.name}”. Use set_print_host.`);
    return pp;
  }
  const w = want.trim().toLowerCase();
  const c = printerChoices.value.find((x) => x.id === want || x.name.toLowerCase() === w);
  if (c) return c;
  const names = printerChoices.value.map((x) => `“${x.name}”`).join(', ');
  throw new Error(`No physical printer “${want}” runs “${boundPrinter.value.name}”.${names ? ` It has: ${names}.` : ''} Select a different printer preset to use printers of another model.`);
}

const STR_FIELDS = ['host', 'apiKey', 'user', 'password', 'printer', 'webUi', 'serial', 'variant', 'wsUrl'] as const;

export function printHostTools(): BridgeTool[] {
  const slicer = useSliceController();
  return [
    {
      name: 'list_print_hosts',
      description: 'Physical printers saved in this browser (shared by its tabs): name, address and the printer presets each one runs. `choices` are the ones that run the selected printer preset and `active` is the one this tab sends to (two identical printers share a preset; switch with select_print_host). Also the host types a browser can reach. API keys and passwords are never returned. Printer status (temperatures, job progress) isn’t available: the drivers only test, upload and start prints.',
      inputSchema: obj({}),
      async run() {
        await presetsSettled();
        const cur = physicalPrinter.value;
        return {
          data: {
            selectedPrinter: boundPrinter.value.name,
            active: cur ? { id: cur.id, name: cur.name, ...printHostRow(cur.config), source: cur.source } : null,
            choices: printerChoices.value.map((c) => ({ id: c.id, name: c.name, host: c.config.host, source: c.source })),
            devices: deviceStore.value.devices.map((d) => ({ id: d.id, name: d.name, presets: d.presets.map((p) => p.name), ...printHostRow(d.config) })),
            hostTypes: HOSTS.filter((h) => h.support !== 'none').map((h) => ({ type: h.type, label: h.label, support: h.support, apiKey: h.apiKeyLabel ?? undefined, userPassword: h.authTypes || undefined, printerSlug: h.printerSlug || undefined, serial: h.serial || undefined, folder: h.folder || undefined, variants: h.variants?.map((v) => v.value), note: h.note })),
            uploading: printhostUi.uploading ? { status: printhostUi.status, progress: printhostUi.progress } : undefined,
          },
        };
      },
    },

    {
      name: 'select_print_host',
      description: 'Choose which physical printer this tab sends to, among those running the selected printer preset (list_print_hosts.choices). Other tabs keep their own choice.',
      inputSchema: obj({ device: str('Physical printer id or name.') }, ['device']),
      async run(args) {
        await presetsSettled();
        const c = choiceArg(args);
        selectDevice(c.id);
        return { data: { ok: true, active: { id: c.id, name: c.name, host: c.config.host } } };
      },
    },

    {
      name: 'set_print_host',
      description:
        'Save a physical printer (like Physical printer… in the app): updates `device`, or the one this tab sends to, or adds one when `add` is true or none exists. ' +
        'New printers run the selected printer preset; this tab then sends to it. The user confirms in the browser. Fields: name, type (see list_print_hosts.hostTypes), host, apiKey, ' +
        'user / password + authType "user" (PrusaLink digest), printer (Repetier printer slug), webUi, serial (Flashforge), variant (Elegoo: cc | cc2 | other), wsUrl. Check it with test_print_host.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({
        type: str('Host type, e.g. "octoprint", "moonraker", "prusalink", "duet".'), host: str('Address, e.g. "http://192.168.1.50" or "printer.local".'),
        apiKey: str('API key / access code.'), user: str('User name.'), password: str('Password.'), authType: str('"key" (default) or "user".'),
        printer: str('Printer slug on multi-printer hosts.'), webUi: str('Device web UI URL when different.'), serial: str('Serial number.'), variant: str('Protocol variant.'), wsUrl: str('WebSocket URL override.'),
        name: str('Name shown in the app, e.g. "Voron left" (default: the printer preset’s name).'),
        device: str('Physical printer id or name to update.'), add: bool('Add a new physical printer, e.g. a second printer of the same model.'),
      }, ['type', 'host']),
      async run(args) {
        await presetsSettled();
        const type = argString(args, 'type')! as HostType;
        const meta = hostMeta(type);
        if (!meta) throw new Error(`Unknown host type "${type}". Types: ${HOSTS.filter((h) => h.support !== 'none').map((h) => h.type).join(', ')}.`);
        if (meta.support === 'none') throw new Error(`${meta.label} can’t be used from a browser. ${meta.note ?? ''}`.trim());
        const add = args.add === true;
        const target = add ? null : args.device !== undefined ? choiceArg(args) : physicalPrinter.value;
        const editId = target?.source === 'saved' ? target.id : null;
        const prev = target?.config.type === type ? target.config : {};
        const patch: Partial<PhysicalPrinterConfig> = {};
        for (const k of STR_FIELDS) { const v = argString(args, k, { optional: true }); if (v !== undefined) patch[k] = v; }
        if (args.authType !== undefined) patch.authType = oneOf(args.authType, ['key', 'user'] as const, 'authType') as AuthType;
        const config = normalizeConfig({ ...emptyConfig(type), ...prev, ...patch, type });
        const ok = await bridge.confirm({
          key: 'printhost-config',
          title: 'Change the print host?',
          message: `Your agent wants to ${editId ? `change “${target!.name}” to` : 'add a printer for'} “${boundPrinter.value.name}” at ${meta.label} ${config.host}.`,
          confirmLabel: 'Save',
        });
        if (!ok) return { data: { ok: false, error: 'The user declined.' } };
        const dev = savePhysicalPrinter(config, { id: editId, name: argString(args, 'name', { optional: true }) ?? (editId ? undefined : target?.name) });
        return { data: { ok: true, device: { id: dev.id, name: dev.name, presets: dev.presets.map((p) => p.name) }, printHost: printHostRow(config), printer: boundPrinter.value.name } };
      },
    },

    {
      name: 'remove_print_host',
      description: 'Forget a physical printer (default: the one this tab sends to; for a host set in the printer preset itself, hides it). The user confirms in the browser.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({ device: str(DEVICE_ARG) }),
      async run(args) {
        const pp = choiceArg(args);
        const ok = await bridge.confirm({ key: 'printhost-remove', title: 'Remove the physical printer?', message: `Your agent wants to remove “${pp.name}” (${pp.config.host}).`, confirmLabel: 'Remove' });
        if (!ok) return { data: { ok: false, error: 'The user declined.' } };
        removePhysicalPrinter(pp.id);
        return { data: { ok: true, removed: pp.name, printer: boundPrinter.value.name } };
      },
    },

    {
      name: 'test_print_host',
      description: 'Check a physical printer answers (version / API check).',
      inputSchema: obj({ device: str(DEVICE_ARG) }),
      async run(args, ctx) {
        const pp = choiceArg(args);
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
      name: 'list_host_printers',
      description: 'Printers on a multi-printer host (Repetier Server), for the "printer" field of set_print_host.',
      inputSchema: obj({ device: str(DEVICE_ARG) }),
      async run(args) {
        const pp = choiceArg(args);
        const d = hostMeta(pp.config.type)?.driver;
        if (!d?.listPrinters) throw new Error(`${hostMeta(pp.config.type)?.label ?? pp.config.type} has a single printer.`);
        try { return { data: { ok: true, printers: await d.listPrinters(hostContext(pp.config), browserEnv()) } }; } catch (e) { const x = describeError(e); return { data: { ok: false, error: x.message, detail: x.detail } }; }
      },
    },

    {
      name: 'send_to_printer',
      description: 'Upload the sliced G-code of the active plate (or `plate`) to the physical printer this tab sends to (or `device`, which then becomes this tab’s), and start the print when print is true. The user confirms in the browser unless they allowed it for this session. Slice first.',
      timeoutMs: 15 * 60_000,
      inputSchema: obj({
        print: bool('Start printing after the upload (default false: upload only).'),
        filename: str('Name on the printer (default: the slicer’s G-code name).'),
        folder: str('Folder on the printer, when the host has folders.'),
        plate: num('Plate to send (1-based, default active).'),
        device: str(DEVICE_ARG),
      }),
      async run(args) {
        const pp = choiceArg(args);
        const plate = plateArg(args);
        if (plate !== undefined && plate !== activePlate.value) setActivePlate(plate);
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
          message: `Your agent wants to ${print ? 'upload and start printing' : 'upload'} ${filename} (${stats ? `${fmtTime(stats.printTimeSec)}, ${round(sum(stats.filamentG), 1)} g` : `${Math.round(g.bytes.byteLength / 1024)} KB`}) on “${pp.name}” (${meta?.label ?? pp.config.type} at ${pp.config.host}).`,
          confirmLabel: print ? 'Print' : 'Upload',
        });
        if (!ok) return { data: { ok: false, error: 'The user declined.' } };
        if (physicalPrinter.value?.id !== pp.id) selectDevice(pp.id);
        const r = await sendToPrinterDetailed({ filename, folder, print });
        return { data: { ...r, device: pp.name, filename, requestedPrint: args.print === true, printing: r.ok && !!r.printed, printNote: args.print === true && !print ? `${meta?.label ?? 'This host'} can only upload here; start the print on the printer.` : undefined } };
      },
    },
  ];
}

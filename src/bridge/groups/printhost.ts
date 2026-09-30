/**
 * Bridge tools: print hosts (physical printers, one per printer preset).
 * Changing or removing the host and every upload / print ask the user in
 * this tab first, unless they allowed it for the session.
 */
import { argString, type BridgeTool } from '@cubby/shared/bridge';
import { lastSlice } from '../../app/state';
import { activeGcode, useSliceController } from '../../app/slice';
import { activePlate, setActivePlate } from '../../project/store';
import { currentPresets, presetsSettled } from '../../presets/store';
import { STORAGE_PREFIX, emptyConfig, normalizeConfig, sanitizeUploadName } from '../../printhost/config';
import { HOSTS, hostMeta } from '../../printhost/registry';
import { boundPrinter, hostContext, physicalPrinter, printhostUi, removePhysicalPrinter, savePhysicalPrinter } from '../../printhost/store';
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

const STR_FIELDS = ['host', 'apiKey', 'user', 'password', 'printer', 'webUi', 'serial', 'variant', 'wsUrl'] as const;

export function printHostTools(): BridgeTool[] {
  const slicer = useSliceController();
  return [
    {
      name: 'list_print_hosts',
      description: 'Print hosts (physical printers) saved in this browser, one per printer preset, the one the selected printer uses, and the host types a browser can reach. API keys and passwords are never returned. Printer status (temperatures, job progress) isn’t available: the drivers only test, upload and start prints.',
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
            hostTypes: HOSTS.filter((h) => h.support !== 'none').map((h) => ({ type: h.type, label: h.label, support: h.support, apiKey: h.apiKeyLabel ?? undefined, userPassword: h.authTypes || undefined, printerSlug: h.printerSlug || undefined, serial: h.serial || undefined, folder: h.folder || undefined, variants: h.variants?.map((v) => v.value), note: h.note })),
            uploading: printhostUi.uploading ? { status: printhostUi.status, progress: printhostUi.progress } : undefined,
          },
        };
      },
    },

    {
      name: 'set_print_host',
      description:
        'Save the print host for the selected printer preset (like Physical printer… in the app). The user confirms in the browser. Fields: type (see list_print_hosts.hostTypes), host, apiKey, ' +
        'user / password + authType "user" (PrusaLink digest), printer (Repetier printer slug), webUi, serial (Flashforge), variant (Elegoo: cc | cc2 | other), wsUrl. Check it with test_print_host.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({
        type: str('Host type, e.g. "octoprint", "moonraker", "prusalink", "duet".'), host: str('Address, e.g. "http://192.168.1.50" or "printer.local".'),
        apiKey: str('API key / access code.'), user: str('User name.'), password: str('Password.'), authType: str('"key" (default) or "user".'),
        printer: str('Printer slug on multi-printer hosts.'), webUi: str('Device web UI URL when different.'), serial: str('Serial number.'), variant: str('Protocol variant.'), wsUrl: str('WebSocket URL override.'),
      }, ['type', 'host']),
      async run(args) {
        const type = argString(args, 'type')! as HostType;
        const meta = hostMeta(type);
        if (!meta) throw new Error(`Unknown host type "${type}". Types: ${HOSTS.filter((h) => h.support !== 'none').map((h) => h.type).join(', ')}.`);
        if (meta.support === 'none') throw new Error(`${meta.label} can’t be used from a browser. ${meta.note ?? ''}`.trim());
        const prev = physicalPrinter.value?.config.type === type ? physicalPrinter.value.config : {};
        const patch: Partial<PhysicalPrinterConfig> = {};
        for (const k of STR_FIELDS) { const v = argString(args, k, { optional: true }); if (v !== undefined) patch[k] = v; }
        if (args.authType !== undefined) patch.authType = oneOf(args.authType, ['key', 'user'] as const, 'authType') as AuthType;
        const config = normalizeConfig({ ...emptyConfig(type), ...prev, ...patch, type });
        const ok = await bridge.confirm({
          key: 'printhost-config',
          title: 'Change the print host?',
          message: `Your agent wants to send G-code for “${boundPrinter.value.name}” to ${meta.label} at ${config.host}.`,
          confirmLabel: 'Save',
        });
        if (!ok) return { data: { ok: false, error: 'The user declined.' } };
        savePhysicalPrinter(config);
        return { data: { ok: true, printHost: printHostRow(config), printer: boundPrinter.value.name } };
      },
    },

    {
      name: 'remove_print_host',
      description: 'Forget the print host of the selected printer preset (also hides a host set in the preset itself). The user confirms in the browser.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({}),
      async run() {
        const pp = physicalPrinter.value;
        if (!pp) throw new Error('No print host is set for the selected printer.');
        const ok = await bridge.confirm({ key: 'printhost-remove', title: 'Remove the print host?', message: `Your agent wants to remove the print host for “${boundPrinter.value.name}” (${pp.config.host}).`, confirmLabel: 'Remove' });
        if (!ok) return { data: { ok: false, error: 'The user declined.' } };
        removePhysicalPrinter();
        return { data: { ok: true, printer: boundPrinter.value.name } };
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
      name: 'list_host_printers',
      description: 'Printers on a multi-printer host (Repetier Server), for the "printer" field of set_print_host.',
      inputSchema: obj({}),
      async run() {
        const pp = physicalPrinter.value;
        if (!pp) throw new Error('No print host is set for the selected printer.');
        const d = hostMeta(pp.config.type)?.driver;
        if (!d?.listPrinters) throw new Error(`${hostMeta(pp.config.type)?.label ?? pp.config.type} has a single printer.`);
        try { return { data: { ok: true, printers: await d.listPrinters(hostContext(pp.config), browserEnv()) } }; } catch (e) { const x = describeError(e); return { data: { ok: false, error: x.message, detail: x.detail } }; }
      },
    },

    {
      name: 'send_to_printer',
      description: 'Upload the sliced G-code of the active plate (or `plate`) to the selected printer’s print host, and start the print when print is true. The user confirms in the browser unless they allowed it for this session. Slice first.',
      timeoutMs: 15 * 60_000,
      inputSchema: obj({
        print: bool('Start printing after the upload (default false: upload only).'),
        filename: str('Name on the printer (default: the slicer’s G-code name).'),
        folder: str('Folder on the printer, when the host has folders.'),
        plate: num('Plate to send (1-based, default active).'),
      }),
      async run(args) {
        const pp = physicalPrinter.value;
        if (!pp) throw new Error('No print host is set for the selected printer. Use set_print_host.');
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
          message: `Your agent wants to ${print ? 'upload and start printing' : 'upload'} ${filename} (${stats ? `${fmtTime(stats.printTimeSec)}, ${round(sum(stats.filamentG), 1)} g` : `${Math.round(g.bytes.byteLength / 1024)} KB`}) on ${meta?.label ?? pp.config.type} at ${pp.config.host}.`,
          confirmLabel: print ? 'Print' : 'Upload',
        });
        if (!ok) return { data: { ok: false, error: 'The user declined.' } };
        const r = await sendToPrinterDetailed({ filename, folder, print });
        return { data: { ...r, filename, requestedPrint: args.print === true, printing: r.ok && !!r.printed, printNote: args.print === true && !print ? `${meta?.label ?? 'This host'} can only upload here; start the print on the printer.` : undefined } };
      },
    },
  ];
}

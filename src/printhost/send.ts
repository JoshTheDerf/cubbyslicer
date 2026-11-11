/**
 * Upload the last slice to the configured host (Orca's PrintHostJobQueue, one
 * job at a time) with a progress toast, Cancel, and result toasts.
 */
import { lastSlice } from '../app/state';
import { dismissToast, toast } from '../ui';
import { hostMeta } from './registry';
import { hostContext, openPhysicalPrinterDialog, physicalPrinter, printerChoices, printhostUi, rememberDevice } from './store';
import { browserEnv } from './transport';
import { HostError, type PhysicalPrinterConfig, type TestResult, type UploadJob } from './types';
import { webUiUrl } from './url';
import { gcodeForOutput } from '../plugins/gcode';

const PROGRESS_ID = 'printhost-upload';
let abort: AbortController | null = null;

export function openWebUi(config?: PhysicalPrinterConfig): void {
  const c = config ?? physicalPrinter.value?.config;
  const url = c ? webUiUrl(c.host, c.webUi) : '';
  if (url) window.open(url, '_blank', 'noopener');
}

export function cancelUpload(): void { abort?.abort(); }

export function describeError(e: unknown): { message: string; detail?: string } {
  if (e instanceof HostError) {
    // Network messages are multi-line guidance; lead with the first line.
    const [first, ...rest] = e.message.split('\n');
    const detail = [rest.join('\n'), e.detail].filter(Boolean).join('\n\n');
    return { message: first, detail: detail || undefined };
  }
  return { message: (e as Error)?.message ?? String(e) };
}

export async function testConnection(config: PhysicalPrinterConfig, signal?: AbortSignal): Promise<TestResult> {
  const meta = hostMeta(config.type);
  if (!meta?.driver) throw new HostError('unsupported', `${meta?.label ?? config.type} can’t be used from a browser.`, meta?.note);
  return meta.driver.test(hostContext(config), browserEnv(), signal);
}

function fmtBytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export interface SendOptions {
  filename: string;
  folder: string;
  print: boolean;
  /** Qidi Box: Box slot per filament (see UploadJob.slotMapping). */
  slotMapping?: number[];
  /** Creality CFS mapping (see UploadJob.cfs). */
  cfs?: UploadJob['cfs'];
}

export async function sendToPrinter(opts: SendOptions): Promise<boolean> {
  return (await sendToPrinterDetailed(opts)).ok;
}

export interface SendOutcome {
  ok: boolean;
  /** Result or error text (as toasted). */
  message: string;
  detail?: string;
  printed?: boolean;
  /** Where the host stored the file, when it says. */
  path?: string;
  host?: string;
}

/** `sendToPrinter` with the outcome spelled out (the MCP bridge reports it back). */
export async function sendToPrinterDetailed(opts: SendOptions): Promise<SendOutcome> {
  const pp = physicalPrinter.value;
  const slice = lastSlice.value;
  if (!pp) { toast.info('Set up a physical printer first.'); openPhysicalPrinterDialog(); return { ok: false, message: 'No physical printer is set up for the selected printer preset.' }; }
  if (!slice) { toast.info('Slice the plate before sending it to the printer.'); return { ok: false, message: 'The plate is not sliced.' }; }
  if (printhostUi.uploading) { toast.info('An upload is already running.'); return { ok: false, message: 'An upload is already running.' }; }
  const meta = hostMeta(pp.config.type);
  if (!meta?.driver) { toast.error(`${meta?.label ?? pp.config.type} can’t be used from a browser.`, { detail: meta?.note }); return { ok: false, message: `${meta?.label ?? pp.config.type} can’t be used from a browser.`, detail: meta?.note }; }

  // Post-processing plugins run on a copy for every upload (Orca: host = the print host type).
  const gcode = await gcodeForOutput(slice.gcode, meta.label, opts.filename);
  if (!gcode) return { ok: false, message: 'A G-code post-processing plugin failed.' };
  const file = new Blob([gcode as BlobPart], { type: 'text/x-gcode' });
  const ctx = hostContext(pp.config);
  const print = opts.print && meta.canPrint(ctx);
  // With several printers of one model, every message says which one.
  const where = printerChoices.value.length > 1 ? pp.name : meta.label;
  abort = new AbortController();
  printhostUi.uploading = true;
  printhostUi.progress = 0;
  printhostUi.status = 'Connecting';
  let lastPct = -1;
  const show = () => toast.info(`${printhostUi.status} ${opts.filename}…`, {
    id: PROGRESS_ID, timeout: 0,
    detail: `${where} · ${printhostUi.progress > 0 ? `${printhostUi.progress}% of ${fmtBytes(file.size)}` : fmtBytes(file.size)}`,
    action: { label: 'Cancel', run: cancelUpload },
  });
  show();
  try {
    const res = await meta.driver.upload(ctx, { file, filename: opts.filename, folder: opts.folder, print, slotMapping: opts.slotMapping, cfs: opts.cfs }, browserEnv(), {
      signal: abort.signal,
      onStatus: (s) => { printhostUi.status = s; show(); },
      onProgress: (loaded, total) => {
        const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        printhostUi.progress = pct;
        if (pct !== lastPct && (pct - lastPct >= 2 || pct === 100)) { lastPct = pct; show(); }
      },
    });
    dismissToast(PROGRESS_ID);
    if (pp.source === 'saved') rememberDevice(pp.id);
    const web = webUiUrl(pp.config.host, pp.config.webUi);
    toast.success(where === meta.label ? res.message : `${pp.name}: ${res.message}`, {
      detail: res.path ? `Saved as ${res.path}` : undefined,
      action: web ? { label: 'Open printer', run: () => openWebUi(pp.config) } : undefined,
      timeout: 7000,
    });
    return { ok: true, message: res.message, printed: res.printed, path: res.path, host: pp.config.host };
  } catch (e) {
    dismissToast(PROGRESS_ID);
    if (e instanceof HostError && e.kind === 'cancelled') { toast.info('Upload cancelled.'); return { ok: false, message: 'Upload cancelled.', host: pp.config.host }; }
    const d = describeError(e);
    toast.error(`Couldn’t send to ${where}: ${d.message}`, { detail: d.detail, timeout: 15000 });
    return { ok: false, message: `Couldn’t send to ${where}: ${d.message}`, detail: d.detail, host: pp.config.host };
  } finally {
    printhostUi.uploading = false;
    printhostUi.status = '';
    abort = null;
  }
}

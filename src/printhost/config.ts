/** Pure config helpers (no app state) — unit-tested. */
import type { AuthType, HostType, PhysicalPrinterConfig } from './types';
import { HOST_BY_TYPE } from './registry';

export const STORAGE_PREFIX = 'cubby.printhost.';

export function storageKey(engine: string, presetId: string): string {
  return `${STORAGE_PREFIX}${engine}:${presetId}`;
}

export function emptyConfig(type: HostType = 'octoprint'): PhysicalPrinterConfig {
  return { type, host: '', apiKey: '', user: '', password: '', authType: 'key', printer: '', webUi: '', serial: '', variant: '', wsUrl: '' };
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function normalizeConfig(raw: unknown): PhysicalPrinterConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const type = str(r.type);
  return {
    type: (HOST_BY_TYPE[type] ? type : 'octoprint') as HostType,
    host: str(r.host).trim(),
    apiKey: str(r.apiKey),
    user: str(r.user),
    password: str(r.password),
    authType: (r.authType === 'user' ? 'user' : 'key') as AuthType,
    printer: str(r.printer),
    webUi: str(r.webUi).trim(),
    serial: str(r.serial).trim(),
    variant: str(r.variant).trim(),
    wsUrl: str(r.wsUrl).trim(),
  };
}

/**
 * Orca keeps the print host in the printer preset (print_host, printhost_apikey,
 * host_type, printhost_port, printhost_user, printhost_password,
 * printhost_authorization_type, print_host_webui, flashforge_serial_number).
 * Returns null when the preset has no print_host.
 */
export function configFromPreset(get: (key: string) => string | undefined): PhysicalPrinterConfig | null {
  const host = (get('print_host') ?? '').trim();
  if (!host) return null;
  return normalizeConfig({
    type: get('host_type') || 'octoprint',
    host,
    apiKey: get('printhost_apikey'),
    user: get('printhost_user'),
    password: get('printhost_password'),
    authType: get('printhost_authorization_type'),
    printer: get('printhost_port'),
    webUi: get('print_host_webui'),
    serial: get('flashforge_serial_number'),
  });
}

/** Default upload name: keep the slicer's name, force a .gcode extension, strip path separators. */
export function sanitizeUploadName(name: string, fallback = 'plate.gcode'): string {
  let n = (name ?? '').trim().replace(/[\\/:*?"<>|]+/g, '_');
  if (!n) n = fallback;
  if (!/\.(gcode|gco|g|bgcode)$/i.test(n)) n += '.gcode';
  return n;
}

/**
 * Every Orca `host_type`, with what a browser can do with it, the fields the
 * physical-printer dialog shows, and per-host CORS / setup hints.
 */
import type { HostType, PrintCapabilityInput, PrintHostDriver } from './types';
import { astrobox, octoprint } from './hosts/octoprint';
import { moonraker } from './hosts/moonraker';
import { prusalink } from './hosts/prusalink';
import { duet } from './hosts/duet';
import { repetier } from './hosts/repetier';
import { esp3d, flashair, mks } from './hosts/simple';
import { elegooKind, elegoolink } from './hosts/elegoo';
import { crealityprint } from './hosts/creality';
import { flashforge } from './hosts/flashforge';

export type HostSupport = 'full' | 'upload' | 'none';

export interface HostHint { text: string; code?: string }

export interface HostMeta {
  type: HostType;
  label: string;
  support: HostSupport;
  driver?: PrintHostDriver;
  /** Unsupported: why. Supported: a limitation worth stating. */
  note?: string;
  /** Label of the API key field; null hides it. */
  apiKeyLabel: string | null;
  apiKeyPlaceholder?: string;
  /** PrusaLink: API key vs HTTP digest user/password. */
  authTypes?: boolean;
  /** Repetier: printer slug (`printhost_port`). */
  printerSlug?: boolean;
  /** Flashforge: serial number. */
  serial?: boolean;
  /** The send dialog offers a folder (or group) field. */
  folder: false | 'folder' | 'group';
  hostPlaceholder: string;
  canPrint(ctx: PrintCapabilityInput): boolean;
  /** Show the WebSocket URL override (hosts that start prints over a WebSocket). */
  wsUrl?: string;
  /** Protocol variant choices (Elegoo model). */
  variants?: Array<{ value: string; label: string }>;
  hints(origin: string): HostHint[];
}

/** Reverse proxy that adds CORS (and HTTPS) in front of a printer that can't send CORS headers itself. */
export function proxyHint(origin: string, target = '192.168.1.50'): HostHint {
  return {
    text: 'If the printer can’t send CORS headers, put a reverse proxy in front of it that does (and gives it an https:// address). Caddy example:',
    code: [
      'printer.example.com {',
      `  header Access-Control-Allow-Origin "${origin}"`,
      '  header Access-Control-Allow-Headers "*"',
      '  header Access-Control-Allow-Methods "GET, POST, PUT, OPTIONS"',
      '  header Access-Control-Expose-Headers "WWW-Authenticate"',
      '  @preflight method OPTIONS',
      '  respond @preflight 204',
      `  reverse_proxy ${target}`,
      '}',
    ].join('\n'),
  };
}

const always = () => true;
const never = () => false;

export const HOSTS: HostMeta[] = [
  {
    type: 'octoprint', label: 'OctoPrint', support: 'full', driver: octoprint,
    apiKeyLabel: 'API key', apiKeyPlaceholder: 'OctoPrint → Settings → Application Keys', folder: 'folder', hostPlaceholder: 'octopi.local or http://192.168.1.20', canPrint: always,
    hints: (origin) => [
      { text: 'Enable CORS: OctoPrint → Settings → API → “Allow Cross Origin (CORS)”, save and restart OctoPrint. Or in config.yaml:', code: 'api:\n  allowCrossOrigin: true' },
      { text: `Create an application key (Settings → Application Keys) and paste it above. Requests will come from ${origin}.` },
    ],
  },
  {
    type: 'moonraker', label: 'Moonraker (Klipper)', support: 'full', driver: moonraker,
    apiKeyLabel: 'API key (optional)', apiKeyPlaceholder: 'Only if this client isn’t a trusted client', folder: 'folder', hostPlaceholder: 'mainsailos.local or http://192.168.1.30', canPrint: always,
    hints: (origin) => [
      { text: 'Allow this site in moonraker.conf, then restart Moonraker:', code: `[authorization]\ncors_domains:\n    ${origin}` },
      { text: 'Without trusted_clients covering your computer, Moonraker also needs its API key (Mainsail/Fluidd → Settings → API key, or GET /access/api_key).' },
    ],
  },
  {
    type: 'prusalink', label: 'PrusaLink', support: 'full', driver: prusalink,
    apiKeyLabel: 'API key / password', apiKeyPlaceholder: 'Printer → Settings → Network → PrusaLink', authTypes: true, folder: 'folder', hostPlaceholder: 'http://192.168.1.40', canPrint: always,
    note: 'HTTP digest login only works if the printer exposes its WWW-Authenticate header to other sites; the API key always works when CORS does.',
    hints: (origin) => [
      { text: `PrusaLink must answer CORS for ${origin} (and allow the X-Api-Key, Content-Type, Overwrite, Print-After-Upload and Authorization headers). Prusa firmware has no setting for this; if Test reports a network error, use a proxy.` },
      proxyHint(origin),
    ],
  },
  {
    type: 'duet', label: 'Duet', support: 'full', driver: duet,
    apiKeyLabel: 'Board password', apiKeyPlaceholder: 'reprap (default)', folder: 'folder', hostPlaceholder: 'duet3.local or http://192.168.1.60', canPrint: always,
    note: 'Works with standalone RepRapFirmware (rr_* API) and Duet Software Framework (/machine API).',
    hints: (origin) => [
      { text: 'Allow this site in config.g (RepRapFirmware 3 / DSF), then restart the board:', code: `M586 C"${origin}"` },
    ],
  },
  {
    type: 'repetier', label: 'Repetier', support: 'full', driver: repetier,
    apiKeyLabel: 'API key', apiKeyPlaceholder: 'Repetier-Server → Global settings → Connectivity', printerSlug: true, folder: 'group', hostPlaceholder: 'http://192.168.1.70:3344', canPrint: always,
    hints: (origin) => [
      { text: `Repetier-Server must answer CORS for ${origin}. If Test reports a network error, use a proxy.` },
      proxyHint(origin, '192.168.1.70:3344'),
    ],
  },
  {
    type: 'astrobox', label: 'AstroBox', support: 'full', driver: astrobox,
    apiKeyLabel: 'API key', folder: 'folder', hostPlaceholder: 'astrobox.local', canPrint: always,
    hints: (origin) => [{ text: `AstroBox uses the OctoPrint API; it must allow cross-origin requests from ${origin}.` }, proxyHint(origin)],
  },
  {
    type: 'esp3d', label: 'ESP3D', support: 'full', driver: esp3d,
    apiKeyLabel: null, folder: false, hostPlaceholder: 'esp3d.local or 192.168.1.80', canPrint: always,
    note: 'Files are renamed to 8.3 names (ESP3D’s limit).',
    hints: (origin) => [{ text: `ESP3D must send CORS headers for ${origin}; most builds don’t — if Test reports a network error, use a proxy.` }, proxyHint(origin, '192.168.1.80')],
  },
  {
    type: 'elegoolink', label: 'Elegoo Link', support: 'full', driver: elegoolink,
    apiKeyLabel: 'Access code (CC2)', apiKeyPlaceholder: '123456 (default)', folder: false, hostPlaceholder: '192.168.1.90',
    canPrint: (c) => elegooKind(c.printerModel, c.variant) !== 'cc2',
    wsUrl: 'ws://<printer>:3030/websocket',
    variants: [
      { value: 'auto', label: 'From the printer preset' },
      { value: 'cc', label: 'Centauri Carbon (SDCP)' },
      { value: 'cc2', label: 'Centauri Carbon 2' },
      { value: 'other', label: 'Other (OctoPrint API)' },
    ],
    note: 'Centauri Carbon: HTTP upload + SDCP WebSocket (port 3030) to start. Centauri Carbon 2: upload only. Other Elegoo printers use the OctoPrint API. For remote use, put the printer behind an HTTPS reverse proxy / tunnel and set the WebSocket URL to its wss:// address.',
    hints: (origin) => [
      { text: `The printer must answer CORS for ${origin}. Starting a print opens ws://<printer>:3030 — browsers block insecure WebSockets from HTTPS pages, so “Upload & Print” may upload and then ask you to start on the printer.` },
      proxyHint(origin, '192.168.1.90'),
    ],
  },
  {
    type: 'crealityprint', label: 'Creality Print', support: 'full', driver: crealityprint,
    apiKeyLabel: 'Token (optional)', folder: 'folder', hostPlaceholder: '192.168.1.100', canPrint: always, wsUrl: 'ws://<printer>:9999/',
    note: 'Starting the print opens ws://<printer>:9999. K2 multi-colour (CFS) mapping isn’t available; K2 prints use the spool holder.',
    hints: (origin) => [
      { text: `The printer must answer CORS for ${origin}. Browsers block insecure ws:// from HTTPS pages, so “Upload & Print” may only upload.` },
      proxyHint(origin, '192.168.1.100'),
    ],
  },
  {
    type: 'flashforge', label: 'Flashforge (local API)', support: 'full', driver: flashforge,
    apiKeyLabel: 'Check (access) code', apiKeyPlaceholder: 'Printer screen → Settings → Network', serial: true, folder: false, hostPlaceholder: '192.168.1.110', canPrint: always,
    note: 'Adventurer 5M / 5M Pro / AD5X local HTTP API on port 8898. Older Flashforge printers only have a raw TCP console (port 8899), which browsers can’t open.',
    hints: (origin) => [{ text: `The printer must answer CORS for ${origin} on port 8898 (including preflight for its custom headers). If Test reports a network error, use a proxy.` }, proxyHint(origin, '192.168.1.110:8898')],
  },
  {
    type: 'flashair', label: 'FlashAir', support: 'upload', driver: flashair, canPrint: never,
    apiKeyLabel: null, folder: 'folder', hostPlaceholder: 'flashair.local or 192.168.0.1',
    note: 'Upload only (a Wi-Fi SD card can’t start a print). Needs firmware 2.00.02+ and UPLOAD=1 in SD_WLAN/CONFIG.',
    hints: (origin) => [{ text: `FlashAir must allow requests from ${origin}; it doesn’t send CORS headers by itself, so a proxy is usually needed.` }, proxyHint(origin, '192.168.0.1')],
  },
  {
    type: 'mks', label: 'MKS', support: 'upload', driver: mks, canPrint: never,
    apiKeyLabel: null, folder: false, hostPlaceholder: '192.168.1.120',
    note: 'Upload only: MKS starts prints (and Orca tests the connection) over a raw TCP console on port 8080, which browsers can’t open.',
    hints: (origin) => [{ text: `The MKS Wi-Fi module must allow requests from ${origin}; use a proxy if Test reports a network error.` }, proxyHint(origin, '192.168.1.120')],
  },
  // ---- not possible from a browser ----
  {
    type: 'prusaconnect', label: 'Prusa Connect', support: 'none', apiKeyLabel: null, folder: false, hostPlaceholder: '', canPrint: never, hints: () => [],
    note: 'Cloud service at connect.prusa3d.com; its API doesn’t allow requests from other websites (CORS), so a web page can’t upload to it. Use PrusaLink on the LAN instead.',
  },
  {
    type: 'obico', label: 'Obico', support: 'none', apiKeyLabel: null, folder: false, hostPlaceholder: '', canPrint: never, hints: () => [],
    note: 'Logs in with an OAuth flow registered to the OrcaSlicer desktop app (client id + app redirect), which a website can’t reuse.',
  },
  {
    type: 'simplyprint', label: 'SimplyPrint', support: 'none', apiKeyLabel: null, folder: false, hostPlaceholder: '', canPrint: never, hints: () => [],
    note: 'Uses an OAuth app bound to OrcaSlicer’s client id with a localhost redirect; there is no browser-usable login for other sites.',
  },
  {
    type: '3dprinteros', label: '3DPrinterOS', support: 'none', apiKeyLabel: null, folder: false, hostPlaceholder: '', canPrint: never, hints: () => [],
    note: 'Cloud login flow tied to the desktop app; its API doesn’t allow requests from other websites (CORS).',
  },
];

/** Printers that don't appear in the host list at all, for the "can't work" note. */
export const OTHER_UNSUPPORTED: Array<{ label: string; note: string }> = [
  { label: 'Bambu Lab (LAN / cloud)', note: 'Bambu printers take jobs over MQTT (TLS, port 8883) and FTPS (port 990). Browsers can’t open raw TLS sockets, so this is impossible from a web page — export the G-code / 3MF and use Bambu Studio, Handy or an SD card.' },
  { label: 'Flashforge (legacy TCP)', note: 'Printers without the port-8898 HTTP API only accept a raw TCP G-code console (port 8899). Browsers can’t open raw TCP sockets.' },
];

export const HOST_BY_TYPE: Record<string, HostMeta> = Object.fromEntries(HOSTS.map((h) => [h.type, h]));

export function hostMeta(type: string | undefined): HostMeta | undefined {
  return type ? HOST_BY_TYPE[type] : undefined;
}

export function isSupported(type: string | undefined): boolean {
  const m = hostMeta(type);
  return !!m && m.support !== 'none' && !!m.driver;
}

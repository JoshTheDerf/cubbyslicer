/**
 * Physical printer / print host ("Send to printer", "Upload & Print").
 *
 * Mirrors OrcaSlicer's PrintHost (src/slic3r/Utils/PrintHost.hpp): one driver
 * per `host_type`, each implementing test + upload (+ optional start print).
 * Drivers only build requests and interpret responses; all I/O goes through
 * the injected `HostEnv` (HTTP transport, WebSocket factory, clock), so they
 * are unit-testable with a mocked transport.
 */

/** Orca's `host_type` enum values (public/wasm/orca/schema.json). */
export type HostType =
  | 'octoprint' | 'prusalink' | 'prusaconnect' | 'moonraker' | 'duet' | 'flashair' | 'astrobox' | 'repetier'
  | 'mks' | 'esp3d' | 'crealityprint' | 'obico' | 'flashforge' | 'simplyprint' | 'elegoolink' | '3dprinteros';

export type AuthType = 'key' | 'user';

/** One physical printer, bound to a printer preset (like Orca's physical printers). */
export interface PhysicalPrinterConfig {
  type: HostType;
  /** Orca `print_host`: hostname, IP or URL (http:// assumed when no scheme). */
  host: string;
  /** Orca `printhost_apikey`: API key / password / access code / token. */
  apiKey: string;
  /** Orca `printhost_user` / `printhost_password` (PrusaLink HTTP digest). */
  user: string;
  password: string;
  /** Orca `printhost_authorization_type`. */
  authType: AuthType;
  /** Orca `printhost_port`: the printer *name/slug* on multi-printer hosts (Repetier). Not a TCP port. */
  printer: string;
  /** Orca `print_host_webui`: device UI URL when it differs from `host`. */
  webUi: string;
  /** Orca `flashforge_serial_number` (Flashforge local API). */
  serial: string;
  /**
   * Protocol variant override. Elegoo Link: '' = from the preset's printer_model,
   * 'cc' = Centauri Carbon (SDCP), 'cc2' = Centauri Carbon 2, 'other' = OctoPrint API.
   */
  variant: string;
  /**
   * WebSocket URL override for hosts that start prints over a WebSocket
   * (Elegoo SDCP ws://host:3030/websocket, Creality ws://host:9999/). Lets a
   * printer behind a reverse proxy / tunnel be used remotely (wss://…).
   */
  wsUrl: string;
}

/** What a driver needs besides the saved config. */
export interface HostContext extends PhysicalPrinterConfig {
  /** Orca `printer_model` of the bound preset (ElegooLink picks CC / CC2 / OctoPrint-compatible by it). */
  printerModel?: string;
}

/** What decides whether Upload & Print is possible. */
export type PrintCapabilityInput = Pick<HostContext, 'printerModel'> & Partial<Pick<HostContext, 'variant'>>;

export interface UploadJob {
  file: Blob;
  /** File name on the printer, e.g. "cube.gcode". */
  filename: string;
  /** Optional folder / group on the printer ("" = default). */
  folder: string;
  /** Start printing after the upload. */
  print: boolean;
}

export interface UploadCallbacks {
  /** Bytes sent / total. `total` 0 = indeterminate. */
  onProgress?: (loaded: number, total: number) => void;
  /** Phase text ("Uploading", "Starting print"...). */
  onStatus?: (text: string) => void;
  signal?: AbortSignal;
}

export interface TestResult {
  message: string;
  /** Extra info (server version, printer model...). */
  detail?: string;
}

export interface UploadResult {
  message: string;
  /** The print was started. */
  printed: boolean;
  /** Path the host stored the file at, when it reports one. */
  path?: string;
}

// ---- transport ------------------------------------------------------------------

export interface HostRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: Blob | FormData | string;
  /** ms; default 15 s for small requests, none for uploads. */
  timeoutMs?: number;
}

export interface HostResponse {
  status: number;
  /** Response header lookup (only CORS-exposed headers are visible cross-origin). */
  header(name: string): string | null;
  text: string;
}

export interface RequestOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/** Performs one request. Resolves with any HTTP status; rejects with HostError('network' | 'cancelled' | 'timeout'). */
export type Transport = (req: HostRequest, opts?: RequestOptions) => Promise<HostResponse>;

/** The subset of the browser WebSocket we use. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export interface HostEnv {
  http: Transport;
  ws: (url: string) => WsLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Random UUID (Elegoo SDCP request ids). */
  uuid: () => string;
}

export type HostErrorKind = 'network' | 'timeout' | 'cancelled' | 'http' | 'auth' | 'protocol' | 'unsupported' | 'config';

export class HostError extends Error {
  constructor(public kind: HostErrorKind, message: string, public detail?: string, public status?: number) {
    super(message);
    this.name = 'HostError';
  }
}

export interface PrintHostDriver {
  test(ctx: HostContext, env: HostEnv, signal?: AbortSignal): Promise<TestResult>;
  upload(ctx: HostContext, job: UploadJob, env: HostEnv, cb?: UploadCallbacks): Promise<UploadResult>;
  /** Printers on a multi-printer host (Repetier `printhost_port`). */
  listPrinters?(ctx: HostContext, env: HostEnv): Promise<string[]>;
}

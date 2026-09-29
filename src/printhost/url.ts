/**
 * Host address handling, following Orca's make_url(): no scheme → http://,
 * exactly one slash between base and path. `user:pass@host` (Orca's "HAProxy
 * with basic auth" form) is turned into an Authorization header because
 * fetch / XHR reject URLs that carry credentials.
 */
import { HostError } from './types';

export interface ParsedHost {
  /** "http://host[:port][/prefix]/" — always ends with a slash. */
  base: string;
  /** Scheme + host + port only. */
  origin: string;
  hostname: string;
  protocol: 'http:' | 'https:';
  /** "Basic …" when the address carried user:password@. */
  basicAuth?: string;
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function parseHost(raw: string): ParsedHost {
  const s = (raw ?? '').trim();
  if (!s) throw new HostError('config', 'Enter the printer’s hostname, IP address or URL.');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw new HostError('config', `“${s}” is not a valid hostname, IP address or URL.`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HostError('config', `Only http:// and https:// addresses are supported (got ${u.protocol}//).`);
  let basicAuth: string | undefined;
  if (u.username || u.password) {
    basicAuth = `Basic ${b64(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`)}`;
    u.username = '';
    u.password = '';
  }
  u.search = '';
  u.hash = '';
  let path = u.pathname;
  if (!path.endsWith('/')) path += '/';
  return { base: `${u.origin}${path}`, origin: u.origin, hostname: u.hostname, protocol: u.protocol as 'http:' | 'https:', basicAuth };
}

/** base + path (path without a leading slash; a leading slash is tolerated). */
export function joinUrl(base: string, path: string): string {
  return base + path.replace(/^\/+/, '');
}

/** Same host, different port and scheme (Elegoo SDCP ws://host:3030, Flashforge http://host:8898, Creality ws://host:9999). */
export function withPort(raw: string, port: number, protocol: 'http:' | 'ws:' = 'http:'): string {
  const p = parseHost(raw);
  const host = p.hostname.includes(':') && !p.hostname.startsWith('[') ? `[${p.hostname}]` : p.hostname;
  const secure = p.protocol === 'https:';
  const scheme = protocol === 'ws:' ? (secure ? 'wss:' : 'ws:') : (secure ? 'https:' : 'http:');
  return `${scheme}//${host}:${port}/`;
}

/** Percent-escape each path element but keep the slashes (PrusaLink PUT, Duet DSF). */
export function escapePath(path: string): string {
  return path.split('/').filter((x) => x !== '').map(encodeURIComponent).join('/');
}

/** "folder/sub" + "name.gcode" → "folder/sub/name.gcode" (no leading slash). */
export function joinRemote(folder: string, filename: string): string {
  const f = (folder ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return f ? `${f}/${filename}` : filename;
}

/** Private / link-local / loopback IP literal or mDNS name — the addresses Chrome's Local Network Access treats as local. */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

/** Orca PrintHost::get_print_host_webui(): print_host_webui, else print_host; http:// when no scheme. */
export function webUiUrl(host: string, webUi: string): string {
  const u = (webUi || host || '').trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : `http://${u}`;
}

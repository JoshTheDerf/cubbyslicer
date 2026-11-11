/**
 * Plugin permission helpers shared by the main thread and the plugin runtime
 * worker's network gate (port of PluginAuditManager.cpp normalize_network_url /
 * network_permission_matches, and the browser meaning of each grant).
 */
import type { PluginPermissions } from '../types';

/** `scheme://host` for an http(s) URL with a host, else '' (normalize_network_url). */
export function normalizeNetworkUrl(url: string): string {
  const i = url.indexOf('://');
  if (i <= 0) return '';
  const scheme = url.slice(0, i).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return '';
  const rest = url.slice(i + 3);
  const end = rest.search(/[/?#]/);
  let authority = end < 0 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  let host: string;
  if (authority.startsWith('[')) host = authority.slice(0, authority.indexOf(']') + 1);
  else host = authority.split(':')[0];
  host = host.toLowerCase();
  return host && host !== '[]' ? `${scheme}://${host}` : '';
}

/** Whether a granted list allows a URL (host-wide `scheme://host` grants, or an exact legacy URL). */
export function networkAllowed(granted: readonly string[], url: string): boolean {
  const target = normalizeNetworkUrl(url);
  for (const g of granted) {
    if (g === url) return true;
    const n = normalizeNetworkUrl(g);
    if (n && n === g && n === target) return true;
  }
  return false;
}

/** Union of two permission sets (a load-time request merged into the saved grants). */
export function mergePermissions(a: PluginPermissions, b: Partial<PluginPermissions>): PluginPermissions {
  const u = (x: string[], y: string[] = []) => [...new Set([...x, ...y])];
  return {
    fs_read: u(a.fs_read, b.fs_read), fs_readwrite: u(a.fs_readwrite, b.fs_readwrite), network_http: u(a.network_http, b.network_http),
    network_socket: u(a.network_socket, b.network_socket), process: u(a.process, b.process), threading: a.threading || !!b.threading,
    events: u(a.events, b.events), full_access: a.full_access || !!b.full_access,
  };
}

/** The part of `request` not already covered by `granted` ("targets already granted are not asked for again"). */
export function outstandingRequest(granted: PluginPermissions, request: PluginPermissions): PluginPermissions | null {
  const d = (want: string[], have: string[]) => want.filter((w) => !have.includes(w));
  const out: PluginPermissions = {
    fs_read: d(request.fs_read, granted.fs_read), fs_readwrite: d(request.fs_readwrite, granted.fs_readwrite),
    network_http: d(request.network_http, granted.network_http), network_socket: d(request.network_socket, granted.network_socket),
    process: d(request.process, granted.process), threading: request.threading && !granted.threading, events: [], full_access: false,
  };
  const any = out.fs_read.length || out.fs_readwrite.length || out.network_http.length || out.network_socket.length || out.process.length || out.threading;
  return any ? out : null;
}

/** What each grant can do in the browser (the Permissions tab and the prompt say this). */
export const PERMISSION_BROWSER_NOTES = {
  fs: 'Paths are inside the plugin runtime’s virtual file system (/orca/data is the plugin data folder). Your computer’s files are not reachable.',
  network_http: 'Requests go through the browser: the site must allow cross-origin requests (CORS).',
  network_socket: 'Raw sockets are not available in the browser. The grant is kept but nothing can use it.',
  process: 'Starting programs is not possible in the browser. The grant is kept but nothing can use it.',
  threading: 'The browser Python runtime has no threads. The grant is recorded; starting a thread still fails.',
} as const;

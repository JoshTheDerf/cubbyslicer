/**
 * `.install_state.json` (OrcaSlicer PluginFsUtils.cpp read/write_install_state)
 * and the naming rules for installed packages (PluginDescriptor.hpp).
 *
 * The reader is lenient exactly where Orca's is (missing keys default, old
 * array-form `threading` migrates, only a JSON boolean enables full access);
 * an unparseable sidecar is reported as unreadable so the caller can set it
 * aside as `.install_state.json.corrupt`, as Orca does.
 */
import type { InstallState, PluginPermissions } from '../types';

export const INSTALL_STATE_FILE = '.install_state.json';

/** filesystem_safe_escape: keep [A-Za-z0-9_.-], collapse other runs to one '_'. */
export function filesystemSafeEscape(value: string): string {
  let out = '';
  for (const ch of value) {
    if (/^[A-Za-z0-9_.-]$/.test(ch)) { out += ch; continue; }
    if (!out || !out.endsWith('_')) out += '_';
  }
  return out || 'path';
}

/** The local plugin key: the escaped file stem (make_local_plugin_key). */
export const localPluginKey = (fileName: string): string => filesystemSafeEscape(fileName.replace(/\.[^.]*$/, ''));
/** The install folder: the escaped file name (local_plugin_install_dir). */
export const installDirName = (fileName: string): string => filesystemSafeEscape(fileName);

/** is_ignored_plugin_directory */
export const isIgnoredPluginDirectory = (name: string): boolean =>
  !name || name.startsWith('.') || name.startsWith('__') || name === '_subscribed' || name === 'plugin_data';

export const emptyPermissions = (): PluginPermissions => ({
  fs_read: [], fs_readwrite: [], network_http: [], network_socket: [], process: [], threading: false, events: [], full_access: false,
});

export type ReadResult = { status: 'missing' } | { status: 'unreadable' } | { status: 'readable'; state: InstallState };

/** read_install_state_status on the file's text (null = no file). */
export function parseInstallState(text: string | null): ReadResult {
  if (text === null) return { status: 'missing' };
  let j: unknown;
  try { j = JSON.parse(text); } catch { return { status: 'unreadable' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { status: 'unreadable' };
  const o = j as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const state: InstallState = {
    installed_from: str('installed_from'), installed_version: str('installed_version'), plugin_name: str('plugin_name'),
    cloud_uuid: str('cloud_uuid'), enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    capabilities: [], permissions: emptyPermissions(),
  };
  const p = o.permissions;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const pp = p as Record<string, unknown>;
    const list = (k: keyof PluginPermissions) => (Array.isArray(pp[k]) ? (pp[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    state.permissions.fs_read = list('fs_read');
    state.permissions.fs_readwrite = list('fs_readwrite');
    state.permissions.network_http = list('network_http');
    state.permissions.network_socket = list('network_socket');
    state.permissions.process = list('process');
    state.permissions.events = list('events');
    const th = pp.threading;
    state.permissions.threading = typeof th === 'boolean' ? th : typeof th === 'string' ? th !== '' : Array.isArray(th) ? th.length > 0 : false;
    state.permissions.full_access = pp.full_access === true;
  }
  if (Array.isArray(o.capabilities)) {
    for (const item of o.capabilities) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) if (typeof v === 'boolean') state.capabilities.push([k, v]);
    }
  }
  const c = o.cubby;
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const cc = c as Record<string, unknown>;
    if (cc.source === 'file' || cc.source === 'url' || cc.source === 'example') {
      state.cubby = { source: cc.source, url: typeof cc.url === 'string' ? cc.url : undefined, sha256: typeof cc.sha256 === 'string' ? cc.sha256 : '', installedAt: typeof cc.installedAt === 'number' ? cc.installedAt : 0 };
    }
  }
  return { status: 'readable', state };
}

/** write_install_state: Orca's key order, `json.dump(2)`. */
export function serializeInstallState(s: InstallState): string {
  const j: Record<string, unknown> = {
    installed_from: s.installed_from, installed_version: s.installed_version, plugin_name: s.plugin_name, enabled: s.enabled,
  };
  if (s.cloud_uuid) j.cloud_uuid = s.cloud_uuid;
  j.permissions = {
    fs_read: s.permissions.fs_read, fs_readwrite: s.permissions.fs_readwrite, network_http: s.permissions.network_http,
    network_socket: s.permissions.network_socket, process: s.permissions.process, threading: s.permissions.threading,
    events: s.permissions.events, full_access: s.permissions.full_access,
  };
  j.capabilities = s.capabilities.map(([name, on]) => ({ [name]: on }));
  if (s.cubby) j.cubby = s.cubby;
  // nlohmann::json orders object keys alphabetically.
  return JSON.stringify(sortKeys(j), null, 2);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/** A fresh local install (seed_install_metadata + enabled = true; permissions reset). */
export function newInstallState(name: string, version: string, cubby: InstallState['cubby']): InstallState {
  return { installed_from: 'local', installed_version: version, plugin_name: name, cloud_uuid: '', enabled: true, capabilities: [], permissions: emptyPermissions(), cubby };
}

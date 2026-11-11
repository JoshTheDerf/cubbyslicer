/**
 * The plugin manager (OrcaSlicer PluginManager + PluginLoader, main-thread
 * half): the catalog of installed packages, install / delete / enable /
 * reload, capability configs, the Script and post-process entry points, and
 * the permission prompts. The runtime worker only ever sees what this sends it.
 *
 * Single writers, as in Orca: this module owns the package folders, every
 * `.install_state.json` and `config.json`; the runtime owns `plugin_data/`.
 */
import { reactive, shallowRef } from 'vue';
import type {
  CapabilityId, InstallState, LoadedCapability, PackageFile, PluginDescriptor, PluginPermissions, PluginStatus, ScriptCompletion,
} from '../types';
import { capabilityKey } from '../types';
import { readPythonPluginMetadata } from './metadata/pep723';
import { readWheelMetadata } from './metadata/wheel';
import {
  INSTALL_STATE_FILE, emptyPermissions, installDirName, isIgnoredPluginDirectory, localPluginKey, newInstallState,
  parseInstallState, serializeInstallState,
} from './installState';
import { CapabilityConfigDocument, effectiveConfig, presetOverrideScope, type EffectiveConfig } from './config';
import { mergePermissions, outstandingRequest } from './permissions';
import { pluginFs, requestPersistence, sha256Hex } from './storage';
import { ensureRuntime, request, runScript as runtimeRunScript, runtimeState, send } from '../runtime/client';

export const PLUGINS_DIR = 'orca_plugins';
export const CONFIG_FILE = `${PLUGINS_DIR}/config.json`;

export interface PluginRow {
  desc: PluginDescriptor;
  status: PluginStatus;
  caps: LoadedCapability[];
  error?: string;
  traceback?: string;
  loadMs?: number;
}

export interface LogLine { at: number; level: 'debug' | 'info' | 'warn' | 'error'; text: string; pluginKey?: string }

export const pluginState = reactive({
  /** The catalog has been read at least once. */
  scanned: false,
  rows: [] as PluginRow[],
  logs: [] as LogLine[],
  /** Bumps when configs change (global or preset), so editors refresh. */
  configRevision: 0,
});

export const globalConfig = shallowRef(new CapabilityConfigDocument());

const enc = new TextEncoder();

export function log(level: LogLine['level'], text: string, pluginKey?: string): void {
  pluginState.logs.push({ at: Date.now(), level, text, pluginKey });
  if (pluginState.logs.length > 2000) pluginState.logs.splice(0, pluginState.logs.length - 2000);
  if (level === 'error') console.warn(`[plugins]${pluginKey ? ` ${pluginKey}:` : ''} ${text}`);
}

export const rowOf = (key: string): PluginRow | undefined => pluginState.rows.find((r) => r.desc.pluginKey === key);
export const pluginName = (key: string): string => rowOf(key)?.desc.name || key;

// ---- catalog ------------------------------------------------------------------------------

async function readDescriptor(dir: string): Promise<PluginDescriptor> {
  const fs = await pluginFs();
  const entries = (await fs.list(`${PLUGINS_DIR}/${dir}`)).filter((e) => e.kind === 'file');
  const py = entries.filter((e) => e.name.toLowerCase().endsWith('.py'));
  const whl = entries.filter((e) => e.name.toLowerCase().endsWith('.whl'));
  const base: PluginDescriptor = {
    pluginKey: localPluginKey(dir), name: dir, description: '', author: '', version: '', root: dir, entryFile: '', kind: 'py',
    dependencies: [], vendoredWheels: [], metadataValid: false, state: null,
  };
  // Exactly one entry: one .py (vendored wheels allowed beside it) or one .whl (PluginFsUtils.cpp:1381-1432).
  if (py.length > 1) return { ...base, error: 'The plugin folder holds more than one .py file' };
  if (!py.length && whl.length !== 1) return { ...base, error: whl.length ? 'The plugin folder holds more than one .whl file' : 'The plugin folder holds no .py or .whl file' };
  const entry = py[0] ?? whl[0];
  const desc: PluginDescriptor = {
    ...base, entryFile: entry.name, kind: py.length ? 'py' : 'whl', pluginKey: localPluginKey(entry.name),
    vendoredWheels: py.length ? whl.map((w) => w.name) : [],
  };
  try {
    const bytes = await fs.readBytes(`${PLUGINS_DIR}/${dir}/${entry.name}`);
    if (!bytes) throw new Error('The entry file could not be read');
    if (desc.kind === 'py') {
      const m = readPythonPluginMetadata(new TextDecoder().decode(bytes));
      Object.assign(desc, { name: m.name || desc.pluginKey, description: m.description, author: m.author, version: m.version, dependencies: m.dependencies, requiresPython: m.requiresPython || undefined });
    } else {
      const m = readWheelMetadata(bytes);
      Object.assign(desc, { name: m.name, description: m.description, author: m.author, version: m.version, dependencies: m.dependencies, entryPackage: m.entryPackage, requiresPython: m.requiresPython || undefined });
    }
    desc.metadataValid = true;
  } catch (e) {
    desc.error = (e as Error).message;
  }
  const sidecarPath = `${PLUGINS_DIR}/${dir}/${INSTALL_STATE_FILE}`;
  const st = parseInstallState(await fs.readText(sidecarPath));
  if (st.status === 'readable') desc.state = st.state;
  else if (st.status === 'unreadable') {
    // Set aside, like Orca: the package is then not auto-loaded until enabled again.
    const text = await fs.readText(sidecarPath);
    if (text !== null) await fs.write(`${sidecarPath}.corrupt`, text);
    await fs.remove(sidecarPath);
    log('warn', `${INSTALL_STATE_FILE} could not be read; moved to ${INSTALL_STATE_FILE}.corrupt`, desc.pluginKey);
  }
  return desc;
}

/** Re-read the installed packages (keeps runtime status of the ones still there). */
export async function scanCatalog(): Promise<void> {
  const fs = await pluginFs();
  const dirs = (await fs.list(PLUGINS_DIR)).filter((e) => e.kind === 'directory' && !isIgnoredPluginDirectory(e.name)).map((e) => e.name);
  const descs = await Promise.all(dirs.map(readDescriptor));
  const rows: PluginRow[] = descs.sort((a, b) => a.name.localeCompare(b.name)).map((desc) => {
    const prev = rowOf(desc.pluginKey);
    const status: PluginStatus = prev && (prev.status === 'loaded' || prev.status === 'loading') ? prev.status : desc.error ? 'error' : desc.state?.enabled ? (prev?.status ?? 'disabled') : 'disabled';
    return { desc, status, caps: prev?.caps ?? [], error: desc.error ?? prev?.error, traceback: prev?.traceback, loadMs: prev?.loadMs };
  });
  pluginState.rows = rows;
  globalConfig.value = CapabilityConfigDocument.parseFile(await fs.readText(CONFIG_FILE));
  pluginState.scanned = true;
}

async function writeState(desc: PluginDescriptor, state: InstallState): Promise<void> {
  const fs = await pluginFs();
  await fs.write(`${PLUGINS_DIR}/${desc.root}/${INSTALL_STATE_FILE}`, serializeInstallState(state));
  desc.state = state;
}

function stateOf(desc: PluginDescriptor): InstallState {
  return desc.state ?? { ...newInstallState(desc.name, desc.version, undefined), enabled: false };
}

// ---- load / unload -----------------------------------------------------------------------------

async function packageFiles(desc: PluginDescriptor): Promise<PackageFile[]> {
  const fs = await pluginFs();
  const out: PackageFile[] = [];
  for (const name of [desc.entryFile, ...desc.vendoredWheels]) {
    const b = await fs.readBytes(`${PLUGINS_DIR}/${desc.root}/${name}`);
    if (b) out.push({ path: name, data: b.slice().buffer });
  }
  return out;
}

const loads = new Map<string, Promise<void>>();

export function loadPlugin(key: string): Promise<void> {
  const prev = loads.get(key) ?? Promise.resolve();
  const p = prev.then(() => doLoad(key));
  loads.set(key, p.catch(() => {}));
  return p;
}

async function doLoad(key: string): Promise<void> {
  const row = rowOf(key);
  if (!row || !row.desc.metadataValid) return;
  row.status = 'loading';
  row.error = undefined;
  row.traceback = undefined;
  try {
    await ensureRuntime();
  } catch (e) {
    row.status = 'error';
    row.error = `The Python runtime could not start: ${(e as Error).message}`;
    return;
  }
  const state = stateOf(row.desc);
  const files = await packageFiles(row.desc);
  const r = await request<{ t: 'loaded'; capabilities: LoadedCapability[]; ms: number } | { t: 'loadFailed'; error: string; traceback?: string }>(
    (reqId) => ({ t: 'load', reqId, descriptor: JSON.parse(JSON.stringify(row.desc)), files, enable: state.capabilities, grants: state.permissions }),
    files.map((f) => f.data),
  );
  if (r.t === 'loadFailed') {
    row.status = 'error';
    row.error = r.error;
    row.traceback = r.traceback;
    row.caps = [];
    log('error', r.traceback || r.error, key);
    onPluginsChanged();
    return;
  }
  row.status = 'loaded';
  row.caps = r.capabilities;
  row.loadMs = r.ms;
  log('info', `Loaded in ${r.ms} ms: ${r.capabilities.map((c) => `${c.name} (${c.type})`).join(', ')}`, key);
  // Record the capability list in the sidecar (new capabilities default to enabled).
  const next = { ...stateOf(row.desc), capabilities: r.capabilities.map((c) => [c.name, c.enabled] as [string, boolean]), installed_version: row.desc.version, plugin_name: row.desc.name };
  await writeState(row.desc, next);
  pushConfigs();
  onPluginsChanged();
}

export async function unloadPlugin(key: string): Promise<void> {
  const row = rowOf(key);
  if (runtimeState.value.phase === 'ready') await request((reqId) => ({ t: 'unload', reqId, pluginKey: key }));
  if (row) { row.caps = []; if (row.status !== 'error') row.status = 'disabled'; }
  onPluginsChanged();
}

/** Orca: load every package whose sidecar says enabled (at startup). */
export async function loadEnabledPlugins(): Promise<void> {
  for (const r of pluginState.rows) if (r.desc.metadataValid && r.desc.state?.enabled && r.status !== 'loaded') await loadPlugin(r.desc.pluginKey);
}

// ---- install / delete / enable ---------------------------------------------------------------------

export interface InspectResult {
  fileName: string;
  key: string;
  dir: string;
  name: string;
  version: string;
  author: string;
  description: string;
  dependencies: string[];
  sha256: string;
  exists: boolean;
  bytes: Uint8Array;
}

/** inspect_local_plugin_package: validate and read the metadata of a package before installing it. */
export async function inspectPackage(fileName: string, bytes: Uint8Array): Promise<InspectResult> {
  const lower = fileName.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.'));
  if (ext !== '.py' && ext !== '.whl') throw new Error(`Plugin package must be a .py or .whl file, got: ${ext}`);
  let meta: { name: string; version: string; author: string; description: string; dependencies: string[] };
  if (ext === '.py') {
    const m = readPythonPluginMetadata(new TextDecoder().decode(bytes));
    meta = { ...m, name: m.name || localPluginKey(fileName) };
  } else meta = readWheelMetadata(bytes);
  const dir = installDirName(fileName);
  const fs = await pluginFs();
  const exists = (await fs.list(`${PLUGINS_DIR}/${dir}`)).length > 0;
  return { fileName, key: localPluginKey(fileName), dir, ...meta, sha256: await sha256Hex(bytes), exists, bytes };
}

/** install_plugin: replace the folder, reset the sidecar (permissions cleared), load. */
export async function installPackage(info: InspectResult, source: 'file' | 'url' | 'example', url?: string): Promise<void> {
  const fs = await pluginFs();
  const old = rowOf(info.key);
  if (old?.status === 'loaded' || pluginState.rows.some((r) => r.desc.root === info.dir && r.status === 'loaded')) {
    await unloadPlugin(old?.desc.pluginKey ?? info.key);
  }
  await fs.remove(`${PLUGINS_DIR}/${info.dir}`);
  await fs.write(`${PLUGINS_DIR}/${info.dir}/${info.fileName}`, info.bytes);
  await fs.write(`${PLUGINS_DIR}/${info.dir}/${INSTALL_STATE_FILE}`,
    serializeInstallState(newInstallState(info.name, info.version, { source, url, sha256: info.sha256, installedAt: Date.now() })));
  void requestPersistence();
  log('info', `Installed ${info.fileName} (${info.name} ${info.version}, sha256 ${info.sha256.slice(0, 16)}…)`, info.key);
  await scanCatalog();
  await loadPlugin(info.key);
}

export async function fetchPackage(url: string): Promise<{ fileName: string; bytes: Uint8Array }> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('Enter a full http(s) URL.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Enter a full http(s) URL.');
  let res: Response;
  try { res = await fetch(u.href, { credentials: 'omit' }); } catch {
    throw new Error("Couldn't download it. The site may not allow downloads from other web pages (CORS); download the file and install it from your computer instead.");
  }
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const fileName = decodeURIComponent(m?.[1] ?? u.pathname.split('/').pop() ?? '');
  return { fileName, bytes: new Uint8Array(await res.arrayBuffer()) };
}

export async function deletePlugin(key: string): Promise<void> {
  const row = rowOf(key);
  if (!row) return;
  await unloadPlugin(key);
  const fs = await pluginFs();
  await fs.remove(`${PLUGINS_DIR}/${row.desc.root}`);
  log('info', `Deleted ${row.desc.entryFile || row.desc.root}`, key);
  await scanCatalog();
}

export async function setPluginEnabled(key: string, enabled: boolean): Promise<void> {
  const row = rowOf(key);
  if (!row) return;
  await writeState(row.desc, { ...stateOf(row.desc), enabled });
  if (enabled) await loadPlugin(key);
  else await unloadPlugin(key);
}

export async function setCapabilityEnabled(id: CapabilityId, enabled: boolean): Promise<void> {
  const row = rowOf(id.pluginKey);
  if (!row) return;
  const st = stateOf(row.desc);
  const caps = st.capabilities.filter(([n]) => n !== id.name);
  const at = st.capabilities.findIndex(([n]) => n === id.name);
  caps.splice(at < 0 ? caps.length : at, 0, [id.name, enabled]);
  await writeState(row.desc, { ...st, capabilities: caps });
  const c = row.caps.find((x) => x.type === id.type && x.name === id.name);
  if (c) c.enabled = enabled;
  if (runtimeState.value.phase === 'ready') send({ t: 'setEnabled', id, enabled });
  onPluginsChanged();
}

/** Reload (Orca "Reload" / "Delete cache and reload": the runtime always starts from fresh files). */
export async function reloadPlugin(key: string): Promise<void> {
  await unloadPlugin(key);
  await scanCatalog();
  await loadPlugin(key);
}

// ---- permissions -----------------------------------------------------------------------------------

export type PermissionAsker = (pluginKey: string, request: PluginPermissions, kind: 'load' | 'runtime', detail?: string) => Promise<boolean>;
let asker: PermissionAsker = async () => false;
export function setPermissionAsker(a: PermissionAsker): void { asker = a; }

/** Load-time request_permissions(): one combined prompt; granted targets persist in the sidecar. */
export async function handlePermissionRequest(key: string, req: PluginPermissions): Promise<{ granted: boolean; grants?: PluginPermissions }> {
  const row = rowOf(key);
  if (!row) return { granted: false };
  const st = stateOf(row.desc);
  const missing = outstandingRequest(st.permissions, req);
  if (!missing) return { granted: true, grants: st.permissions };
  const ok = await asker(key, missing, 'load');
  if (!ok) return { granted: false };
  const grants = mergePermissions(st.permissions, missing);
  await writeState(row.desc, { ...st, permissions: grants });
  return { granted: true, grants };
}

const promptedDenials = new Set<string>();

/** A denied runtime access (Orca's off-main-thread rule): ask; a "yes" is saved for the next attempt. */
export async function handleRuntimeDenial(key: string, category: string, target: string, persistable: boolean, message: string): Promise<void> {
  log('warn', `[AUDIT BLOCKED] ${message}`, key);
  if (!persistable || !target) return;
  const sig = `${key}\u0000${category}\u0000${target}`;
  if (promptedDenials.has(sig)) return;
  promptedDenials.add(sig);
  const row = rowOf(key);
  if (!row) return;
  const req = emptyPermissions();
  if (category === 'Http') req.network_http = [target];
  else if (category === 'FsRead') req.fs_read = [target];
  else req.fs_readwrite = [target];
  const ok = await asker(key, req, 'runtime', message);
  promptedDenials.delete(sig);
  if (!ok) return;
  const st = stateOf(row.desc);
  const grants = mergePermissions(st.permissions, req);
  await writeState(row.desc, { ...st, permissions: grants });
  send({ t: 'setGrants', pluginKey: key, grants });
}

export async function revokePermission(key: string, bucket: keyof PluginPermissions, target?: string): Promise<void> {
  const row = rowOf(key);
  if (!row) return;
  const st = stateOf(row.desc);
  const p = { ...st.permissions } as PluginPermissions;
  if (bucket === 'threading' || bucket === 'full_access') (p[bucket] as boolean) = false;
  else (p[bucket] as string[]) = (p[bucket] as string[]).filter((t) => t !== target);
  await writeState(row.desc, { ...st, permissions: p });
  if (runtimeState.value.phase === 'ready') send({ t: 'setGrants', pluginKey: key, grants: p });
}

// ---- configs ------------------------------------------------------------------------------------

export interface PresetOverrideAccess {
  /** The overrides option text of the edited preset, or null when the engine schema has no such key. */
  read(kind: 'process' | 'filament' | 'printer', key: string): string | null;
  write(kind: 'process' | 'filament' | 'printer', key: string, value: string): void;
}
let presetAccess: PresetOverrideAccess = { read: () => null, write: () => {} };
export function setPresetOverrideAccess(a: PresetOverrideAccess): void { presetAccess = a; }

function overridesFor(id: CapabilityId): CapabilityConfigDocument | null {
  const scope = presetOverrideScope(id.type);
  if (!scope) return null;
  const raw = presetAccess.read(scope.kind, scope.key);
  if (raw === null) return null;
  try { return CapabilityConfigDocument.parseOverrides(raw); } catch (e) { log('error', (e as Error).message); return null; }
}

export function capabilityConfig(id: CapabilityId): EffectiveConfig {
  return effectiveConfig(globalConfig.value, overridesFor(id), id);
}

/** Whether per-preset overrides are possible for this capability with the running engine schema. */
export function presetOverrideAvailable(id: CapabilityId): boolean {
  const scope = presetOverrideScope(id.type);
  return !!scope && presetAccess.read(scope.kind, scope.key) !== null;
}

const versionOf = (key: string) => rowOf(key)?.desc.state?.installed_version || rowOf(key)?.desc.version || '';

async function writeGlobal(): Promise<void> {
  const fs = await pluginFs();
  await fs.write(CONFIG_FILE, globalConfig.value.toFile());
  pluginState.configRevision++;
  pushConfigs();
}

/** save_config() / the Config tab: the global layer. */
export async function saveGlobalConfig(id: CapabilityId, config: unknown): Promise<void> {
  const doc = CapabilityConfigDocument.fromEntries(globalConfig.value.serializeEntries());
  doc.upsert({ id, pluginVersion: versionOf(id.pluginKey), config });
  globalConfig.value = doc;
  await writeGlobal();
}

export async function eraseGlobalConfig(id: CapabilityId): Promise<void> {
  const doc = CapabilityConfigDocument.fromEntries(globalConfig.value.serializeEntries());
  if (doc.erase(id)) { globalConfig.value = doc; await writeGlobal(); }
}

/** The preset layer (PresetPluginConfigService::set/remove_preset_override). */
export function setPresetOverride(id: CapabilityId, config: unknown | undefined): boolean {
  const scope = presetOverrideScope(id.type);
  if (!scope) return false;
  const raw = presetAccess.read(scope.kind, scope.key);
  if (raw === null) return false;
  const doc = CapabilityConfigDocument.parseOverrides(raw);
  if (config === undefined) doc.erase(id);
  else doc.upsert({ id, pluginVersion: versionOf(id.pluginKey), config });
  presetAccess.write(scope.kind, scope.key, doc.toOverrides());
  pluginState.configRevision++;
  pushConfigs();
  return true;
}

export async function defaultConfigOf(id: CapabilityId): Promise<unknown> {
  const r = await request<{ t: 'reply'; ok: boolean; value?: unknown; error?: string }>((reqId) => ({ t: 'defaultConfig', reqId, id }));
  if (!r.ok) throw new Error(r.error);
  return r.value ?? {};
}

export async function configUiOf(id: CapabilityId): Promise<string> {
  const r = await request<{ t: 'reply'; ok: boolean; value?: unknown; error?: string }>((reqId) => ({ t: 'configUi', reqId, id }));
  if (!r.ok) throw new Error(r.error);
  return typeof r.value === 'string' ? r.value : '';
}

/** Push every loaded capability's effective config to the runtime (get_config() reads it there). */
export function pushConfigs(): void {
  if (runtimeState.value.phase !== 'ready') return;
  const entries: [string, string, string, string, string][] = [];
  for (const r of pluginState.rows) for (const c of r.caps) {
    const e = capabilityConfig(c);
    entries.push([c.pluginKey, c.type, c.name, JSON.stringify(e.config ?? {}), e.storedPluginVersion]);
  }
  send({ t: 'configs', entries });
}

// ---- Script capabilities --------------------------------------------------------------------------

/** Run a Script capability; resolves with its completion (Orca's ScriptCompletion). */
export async function runScriptCapability(id: CapabilityId): Promise<ScriptCompletion> {
  const row = rowOf(id.pluginKey);
  const cap = row?.caps.find((c) => c.type === 'script' && c.name === id.name);
  if (!row || row.status !== 'loaded' || !cap || !cap.enabled) return { cancelled: false, error: 'The plugin capability is not loaded.' };
  const c = await runtimeRunScript(id);
  if (c.error) log('error', `${id.name}: ${c.error}`, id.pluginKey);
  else if (c.result) log('info', `${id.name}: ${c.result.status}${c.result.message ? ` — ${c.result.message}` : ''}`, id.pluginKey);
  return c;
}

/** Orca PluginsDialog::complete_with_error: a failed run from the dialog records the error and unloads the plugin. */
export async function failPlugin(key: string, error: string): Promise<void> {
  await unloadPlugin(key);
  const row = rowOf(key);
  if (row) { row.status = 'error'; row.error = error; }
}

// ---- change notification ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
export function onPluginsChange(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function onPluginsChanged(): void { for (const f of listeners) f(); }

/** Every loaded, enabled capability of a type. */
export function loadedCapabilities(type?: LoadedCapability['type']): LoadedCapability[] {
  return pluginState.rows.filter((r) => r.status === 'loaded').flatMap((r) => r.caps).filter((c) => c.enabled && (!type || c.type === type));
}

export const encodeText = (s: string): Uint8Array => enc.encode(s);
export { capabilityKey };

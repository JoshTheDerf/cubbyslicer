/**
 * Shared types of the Orca Python plugin system (OrcaSlicer 2.5.0 plugins, run
 * on Pyodide in the plugin runtime worker). Names follow Orca: capability type
 * strings are Orca's `plugin_capability_type_to_string`, the sidecar and config
 * shapes are Orca's file formats.
 */

/** Orca capability type strings (PythonPluginInterface.hpp plugin_capability_type_to_string). */
export type CapabilityType = 'script' | 'slicing-pipeline' | 'pages' | 'resource-texture'
  | 'printer-connection' | 'analysis' | 'importer' | 'exporter' | 'visualization' | 'unknown';

export const CAPABILITY_TYPE_LABEL: Record<CapabilityType, string> = {
  'printer-connection': 'Printer connection', pages: 'Pages', analysis: 'Analysis', importer: 'Importer',
  exporter: 'Exporter', visualization: 'Visualization', script: 'Script', 'slicing-pipeline': 'Slicing Pipeline',
  'resource-texture': 'Resource Texture', unknown: 'Unknown',
};

export interface CapabilityId { pluginKey: string; type: CapabilityType; name: string }
/** `${pluginKey}\u0000${type}\u0000${name}` */
export type CapabilityKey = string;
export const capabilityKey = (c: CapabilityId): CapabilityKey => `${c.pluginKey}\u0000${c.type}\u0000${c.name}`;

/** = Orca sidecar "permissions" (PluginFsUtils.hpp PluginPermissions). */
export interface PluginPermissions {
  fs_read: string[];
  fs_readwrite: string[];
  network_http: string[];
  network_socket: string[];
  process: string[];
  threading: boolean;
  events: string[];
  full_access: boolean;
}

/** = Orca .install_state.json, plus an optional `cubby` block Orca's reader ignores. */
export interface InstallState {
  installed_from: 'local' | 'cloud' | string;
  installed_version: string;
  plugin_name: string;
  cloud_uuid: string;
  enabled: boolean;
  /** Capability enable flags in order; written as Orca's `[{"<name>": bool}]`. */
  capabilities: [string, boolean][];
  permissions: PluginPermissions;
  cubby?: CubbyInstallInfo;
}

export interface CubbyInstallInfo {
  source: 'file' | 'url' | 'example';
  url?: string;
  sha256: string;
  installedAt: number;
}

/** One installed package (a folder under orca_plugins/). */
export interface PluginDescriptor {
  pluginKey: string;
  name: string;
  description: string;
  author: string;
  version: string;
  /** The folder name under orca_plugins/ (the escaped entry file name). */
  root: string;
  entryFile: string;
  kind: 'py' | 'whl';
  /** Wheel import package (Import-Name / top_level.txt / normalized Name). */
  entryPackage?: string;
  dependencies: string[];
  requiresPython?: string;
  /** Other .whl files next to the entry file (vendored dependencies). */
  vendoredWheels: string[];
  metadataValid: boolean;
  error?: string;
  state: InstallState | null;
}

export type PluginStatus = 'disabled' | 'loading' | 'loaded' | 'error' | 'unsupported';

export interface LoadedCapability extends CapabilityId {
  enabled: boolean;
  hasConfigUi: boolean;
  /** printer-connection capabilities load but are never called. */
  supported: boolean;
  textureFiles?: string[];
  textureError?: string;
  /** A Pages capability's get_icon() image (SVG or PNG, base64), when it resolved to a file. */
  icon?: { mime: string; data: string };
}

export interface ExecutionResult {
  status: 'Success' | 'Skipped' | 'RecoverableError' | 'FatalError';
  message: string;
  data: string;
}
export interface ScriptCompletion { result?: ExecutionResult; error?: string; cancelled: boolean }

export interface LifecycleCtx {
  name?: string; code?: 'Ok' | 'Error' | 'Warn'; msg?: string; id?: number; previous_name?: string;
  device_id?: string; job_id?: string; source?: string; index?: number; dirty?: boolean;
}

/** Files of one package handed to the runtime at load (read from storage on the main thread). */
export interface PackageFile { path: string; data: ArrayBuffer }

// ---- main → plugin runtime worker -------------------------------------------

export interface RuntimeInit {
  t: 'init';
  /** URL of the staged Pyodide runtime (…/pyodide/0.27.8/). */
  pyodideBase: string;
  /** HostChannel (synchronous host calls); null when the page is not cross-origin isolated. */
  hostChannel: SharedArrayBuffer | null;
  /** Reserved for the slicing-pipeline HookChannel (engine worker ↔ runtime, phase 2). */
  hookChannel: SharedArrayBuffer | null;
  /** Pyodide interrupt buffer (SIGINT = 2), null without isolation. */
  interrupt: SharedArrayBuffer | null;
  /** CallbackChannel (UI callbacks reach a runtime blocked in a wait); null without isolation. */
  callbackChannel: SharedArrayBuffer | null;
  appInfo: Record<string, unknown>;
}

export type ToRuntime =
  | RuntimeInit
  | { t: 'load'; reqId: number; descriptor: PluginDescriptor; files: PackageFile[]; enable: [string, boolean][]; grants: PluginPermissions; skipDeps?: boolean }
  | { t: 'unload'; reqId: number; pluginKey: string }
  | { t: 'setEnabled'; id: CapabilityId; enabled: boolean }
  | { t: 'setGrants'; pluginKey: string; grants: PluginPermissions }
  | { t: 'runScript'; runId: number; id: CapabilityId }
  | { t: 'cancelScripts'; pluginKey: string }
  | { t: 'lifecycle'; event: string; ctx: LifecycleCtx }
  | { t: 'configUi'; reqId: number; id: CapabilityId }
  | { t: 'pageUi'; reqId: number; id: CapabilityId }
  | { t: 'pageMessage'; id: CapabilityId; data: unknown }
  | { t: 'defaultConfig'; reqId: number; id: CapabilityId }
  | { t: 'postProcess'; reqId: number; caps: { id: CapabilityId; config: unknown; configVersion: string }[]; gcode: ArrayBuffer; host: string; outputName: string; fullConfig: Record<string, string> }
  /** A UI callback (page message, submit, close, notification click) for a window / panel the runtime created. */
  | { t: 'uiEvent'; handle: string; kind: 'message' | 'submit' | 'close' | 'click' | 'cancel'; data?: unknown }
  /** UI callbacks are waiting in the CallbackChannel (drained here when the runtime is idle). */
  | { t: 'callbacks' }
  /** The answer to a load-time permission request. */
  | { t: 'permissionAnswer'; reqId: number; granted: boolean; grants?: PluginPermissions }
  /** A HookChannel to one engine worker (slicing-pipeline hooks); the port carries its hookBegin pings. */
  | { t: 'hookChannel'; id: number; sab: SharedArrayBuffer; port: MessagePort }
  | { t: 'hookChannelClosed'; id: number }
  /** Effective capability configs: [pluginKey, type, name, configJson, pluginVersion] (replaces all). */
  | { t: 'configs'; entries: [string, string, string, string, string][] };

// ---- plugin runtime worker → main ------------------------------------------

export type FromRuntime =
  | { t: 'ready'; pythonVersion: string; bootMs: number; isolated: boolean }
  | { t: 'bootFailed'; error: string }
  | { t: 'loaded'; reqId: number; pluginKey: string; capabilities: LoadedCapability[]; ms: number }
  | { t: 'loadFailed'; reqId: number; pluginKey: string; error: string; traceback?: string }
  | { t: 'unloaded'; reqId: number; pluginKey: string }
  | { t: 'permissionRequest'; reqId: number; pluginKey: string; request: PluginPermissions }
  | { t: 'permissionDenied'; pluginKey: string; capability: string; category: string; event: string; target: string; persistable: boolean; message: string }
  | { t: 'scriptDone'; runId: number; completion: ScriptCompletion }
  | { t: 'hostCall'; callId: number; method: HostMethod; pluginKey: string; capability: string; args: unknown }
  /** The runtime took a HostChannel chunk and wants the next one. */
  | { t: 'hostChunk'; callId: number }
  /** The runtime emptied the CallbackChannel slot; the next batch may be written. */
  | { t: 'callbacksTaken' }
  /** Fire-and-forget host requests (also work without cross-origin isolation). */
  | { t: 'hostPost'; method: HostMethod; pluginKey: string; capability: string; args: unknown }
  | { t: 'reply'; reqId: number; ok: boolean; value?: unknown; error?: string; gcode?: ArrayBuffer }
  | { t: 'log'; pluginKey?: string; level: 'debug' | 'info' | 'warn' | 'error'; text: string };

/** The host API table (src/plugins/host/api.ts). Sync calls go over the HostChannel; posts don't wait. */
export type HostMethod =
  | 'model.snapshot' | 'model.mesh'
  | 'presets.bundle' | 'presets.collection' | 'presets.preset' | 'presets.fullValue' | 'presets.fullKeys'
  | 'plater.state' | 'app.info' | 'app.glInfo' | 'app.selectedPrinter'
  | 'config.get' | 'config.save'
  | 'ui.message' | 'ui.createWindow' | 'ui.createDock' | 'ui.post' | 'ui.show' | 'ui.close'
  | 'ui.progressCreate' | 'ui.progressUpdate' | 'ui.progressPulse' | 'ui.progressStartPulse' | 'ui.progressStopPulse' | 'ui.progressClose'
  | 'ui.notify' | 'page.post'
  /** Not implemented in this pass (phase 3); the shim raises before calling. */
  | 'presets.beginUpdate' | 'presets.commit' | 'plater.export3mf';

export interface HostReply { json: unknown; blobs?: Uint8Array[] }

// ---- slicing pipeline (phase 2; engine ABI pending, see docs/ENGINE-CONTRACT.md) ----

export type SlicingStep = 'posSlice' | 'posPerimeters' | 'posEstimateCurledExtrusions' | 'posPrepareInfill' | 'posInfill'
  | 'posIroning' | 'posContouring' | 'posSupportMaterial' | 'posDetectOverhangsForLift' | 'posSimplifyPath'
  | 'psWipeTower' | 'psSkirtBrim' | 'psGCodePostProcess';

/** Hook BEGIN payload the engine worker will write into the HookChannel (report §B4.2). */
export interface HookBegin {
  seq: number; step: SlicingStep; stepIndex: number; objectId: number | null; scalingFactor: number;
  capabilities: { name: string; pluginKey: string; config: unknown; configVersion: string }[];
}
export interface HookResult { status: ExecutionResult['status'] | 'Exception' | 'Cancelled'; capability?: string; message: string }

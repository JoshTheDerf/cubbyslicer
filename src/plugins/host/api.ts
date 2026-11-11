/**
 * The host API table: what the runtime may ask the app for. Every message from
 * the runtime is untrusted (plugin code can post to it), so methods are looked
 * up in this table only and every argument is checked; nothing here evaluates
 * code or hands out raw store access.
 */
import type { HostMethod } from '../types';
import type { ReplyPayload } from '../runtime/hostChannel';
import { meshReply, modelSnapshot } from './model';
import { beginUpdate, bundleSnapshot, commitUpdate, fullConfig, presetConfig, presetsDirty } from './presets';
import { appInfo, glInfo, projectDirty } from './app';
import {
  askMessage, closeWindow, createWindow, findWindow, notify, postToWindow, progressCreate, progressUpdate,
} from './ui';
import { log, pluginName, saveGlobalConfig } from '../manager/store';
import { postToPage } from './pages';
import type { CapabilityType } from '../types';

type Args = Record<string, unknown>;

class HostError extends Error {
  constructor(message: string, readonly pyType = 'ValueError') { super(message); }
}

const str = (a: Args, k: string, dflt?: string): string => {
  const v = a[k];
  if (typeof v === 'string') return v;
  if (v === undefined && dflt !== undefined) return dflt;
  throw new HostError(`${k} must be a str`, 'TypeError');
};
const int = (a: Args, k: string, dflt?: number): number => {
  const v = a[k];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (v === undefined && dflt !== undefined) return dflt;
  throw new HostError(`${k} must be an int`, 'TypeError');
};
const BUTTONS = new Set(['ok', 'ok_cancel', 'yes_no', 'yes_no_cancel']);
const ICONS = new Set(['info', 'warning', 'error', 'question']);
const CAP_TYPES = new Set<CapabilityType>(['script', 'slicing-pipeline', 'pages', 'resource-texture', 'printer-connection']);

const ok = (json: unknown, blobs?: Uint8Array[]): ReplyPayload => ({ json, blobs });

/** Synchronous calls (answered over the HostChannel). */
const calls: Partial<Record<HostMethod, (key: string, cap: string, a: Args) => Promise<ReplyPayload> | ReplyPayload>> = {
  'model.snapshot': () => ok(modelSnapshot()),
  'model.mesh': (_k, _c, a) => meshReply(str(a, 'mesh')),
  'presets.bundle': () => ok(bundleSnapshot()),
  'presets.preset': async (_k, _c, a) => ok(await presetConfig(str(a, 'collection'), str(a, 'name'), !!a.edited)),
  'presets.fullKeys': () => ok(fullConfig()),
  'plater.state': () => ok({ project_dirty: projectDirty(), presets_dirty: presetsDirty(), project_path: '' }),
  'app.info': () => ok(appInfo()),
  'presets.beginUpdate': async (_k, _c, a) => ok(await beginUpdate(a as Parameters<typeof beginUpdate>[0])),
  'presets.commit': (_k, _c, a) => ok(commitUpdate(a as Parameters<typeof commitUpdate>[0])),
  'plater.export3mf': async () => {
    // Plater::export_3mf_copy: the current project with unsaved changes; the file name and saved state stay.
    const { buildOrca3mfWithThumbnails } = await import('../../project/persistence/orca3mfWriter');
    return { json: null, blobs: [await buildOrca3mfWithThumbnails()] };
  },
  'app.glInfo': () => ok(glInfo()),
  'ui.message': async (key, _c, a) => {
    const buttons = str(a, 'buttons', 'ok'), icon = str(a, 'icon', 'info');
    if (!BUTTONS.has(buttons)) throw new HostError('buttons must be "ok", "ok_cancel", "yes_no" or "yes_no_cancel"');
    if (!ICONS.has(icon)) throw new HostError('icon must be "info", "warning", "error" or "question"');
    return ok(await askMessage(pluginName(key), { text: str(a, 'text'), title: str(a, 'title', 'OrcaSlicer'), buttons, icon }));
  },
  'ui.progressUpdate': (_k, _c, a) => ok(progressUpdate({ handle: int(a, 'handle'), value: int(a, 'value'), message: str(a, 'message', '') })),
  'ui.progressPulse': (_k, _c, a) => ok(progressUpdate({ handle: int(a, 'handle'), pulse: true, message: str(a, 'message', '') })),
};

/** Fire-and-forget requests (no reply; also work without cross-origin isolation). */
const posts: Partial<Record<HostMethod, (key: string, cap: string, a: Args) => void>> = {
  'ui.createWindow': (key, _c, a) => createWindow(key, pluginName(key), {
    handle: int(a, 'handle'), html: str(a, 'html'), title: str(a, 'title', 'OrcaSlicer'), width: int(a, 'width', 820), height: int(a, 'height', 600), modal: !!a.modal,
  }, 'window'),
  'ui.createDock': (key, _c, a) => createWindow(key, pluginName(key), {
    handle: int(a, 'handle'), html: str(a, 'html'), title: str(a, 'title', 'OrcaSlicer'), width: int(a, 'width', 320), height: int(a, 'height', 480), dock: str(a, 'dock', 'right'),
  }, 'dock'),
  'ui.post': (key, _c, a) => { const w = findWindow(int(a, 'handle')); if (w?.pluginKey === key) postToWindow(w.handle, a.data); },
  'ui.show': (key, _c, a) => { const w = findWindow(int(a, 'handle')); if (w?.pluginKey === key) w.visible = !!a.visible; },
  'ui.close': (key, _c, a) => {
    const w = findWindow(int(a, 'handle'));
    if (!w || w.pluginKey === key) closeWindow(int(a, 'handle'), { silent: !!a.silent });
  },
  'ui.progressCreate': (key, _c, a) => progressCreate(pluginName(key), {
    handle: int(a, 'handle'), title: str(a, 'title'), message: str(a, 'message'), maximum: int(a, 'maximum', 100), style: int(a, 'style', 6),
  }),
  'ui.progressUpdate': (_k, _c, a) => { progressUpdate({ handle: int(a, 'handle'), value: int(a, 'value'), message: str(a, 'message', '') }); },
  'ui.progressPulse': (_k, _c, a) => { progressUpdate({ handle: int(a, 'handle'), pulse: true, message: str(a, 'message', '') }); },
  'ui.progressStartPulse': (_k, _c, a) => { progressUpdate({ handle: int(a, 'handle'), pulsing: true, message: str(a, 'message', '') }); },
  'ui.progressStopPulse': (_k, _c, a) => { progressUpdate({ handle: int(a, 'handle'), pulsing: false }); },
  'ui.progressClose': (_k, _c, a) => closeWindow(int(a, 'handle')),
  'ui.notify': (key, _c, a) => notify(pluginName(key), {
    handle: int(a, 'handle'), level: str(a, 'level'), text: str(a, 'text'), hyper_text: str(a, 'hyper_text', ''), clickable: !!a.clickable,
  }),
  'config.save': (key, _c, a) => {
    const type = str(a, 'type') as CapabilityType;
    if (!CAP_TYPES.has(type)) return;
    void saveGlobalConfig({ pluginKey: key, type, name: str(a, 'name') }, a.config);
  },
  'page.post': (key, _c, a) => postToPage(key, str(a, 'name'), a.data),
};

export async function hostCall(method: HostMethod, pluginKey: string, capability: string, args: unknown): Promise<ReplyPayload> {
  const fn = calls[method];
  const a = (args && typeof args === 'object' ? args : {}) as Args;
  if (!fn) return { error: { type: 'RuntimeError', message: `orca.host: "${method}" is not available in CubbySlicer` } };
  try {
    return await fn(pluginKey, capability, a);
  } catch (e) {
    return { error: { type: (e as HostError).pyType ?? 'RuntimeError', message: (e as Error).message } };
  }
}

export function hostPost(method: HostMethod, pluginKey: string, capability: string, args: unknown): void {
  const fn = posts[method];
  if (!fn) { log('warn', `Ignored host request ${String(method).slice(0, 40)}`, pluginKey); return; }
  fn(pluginKey, capability, (args && typeof args === 'object' ? args : {}) as Args);
}

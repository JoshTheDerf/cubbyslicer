/**
 * `orca.host.ui` on the app side: the reactive registry of plugin windows,
 * dock panels (shown floating), message boxes, progress dialogs and the
 * permission prompts, rendered by ui/PluginUiHost.vue. Events from them go
 * back to the runtime as `uiEvent` messages.
 */
import { reactive } from 'vue';
import { dialogRequest } from '../../ui/dialogRequest';
import { send } from '../runtime/client';
import { pushToast, dismissToast, type ToastKind } from '../../ui/toast';
import type { PluginPermissions } from '../types';

export interface PluginWindow {
  handle: number;
  pluginKey: string;
  pluginName: string;
  kind: 'window' | 'dock';
  title: string;
  html: string;
  width: number;
  height: number;
  modal: boolean;
  dock?: string;
  visible: boolean;
  /** Messages posted before the frame was ready. */
  queue: unknown[];
  /** Bumps to make the frame re-deliver its queue. */
  seq: number;
  z: number;
}

/** ui.message(): one box at a time (dialogRequest); '' = closed without a button. */
export interface MessageRequest { pluginName: string; text: string; title: string; buttons: string; icon: string }
export const messageRequest = dialogRequest<MessageRequest, string>('');

export interface ProgressBox {
  handle: number; pluginName: string; title: string; message: string; maximum: number; value: number;
  style: number; pulsing: boolean; cancelled: boolean; skipped: boolean; startedAt: number;
}

/** A permission prompt (load-time request_permissions(), or a runtime denial to remember). */
export interface PermissionRequest {
  pluginKey: string; pluginName: string; request: PluginPermissions; kind: 'load' | 'runtime'; detail?: string;
}
export const permissionRequest = dialogRequest<PermissionRequest, boolean>(false);

export const pluginUi = reactive({
  windows: [] as PluginWindow[],
  progress: [] as ProgressBox[],
  topZ: 1,
});

const PD_CAN_ABORT = 0x1, PD_AUTO_HIDE = 0x4;


export function uiEvent(handle: number, kind: 'message' | 'submit' | 'close' | 'click' | 'cancel', data?: unknown): void {
  send({ t: 'uiEvent', handle: String(handle), kind, data });
}

export function createWindow(pluginKey: string, pluginName: string, a: { handle: number; html: string; title: string; width: number; height: number; modal?: boolean; dock?: string }, kind: 'window' | 'dock'): void {
  pluginUi.windows.push({
    handle: a.handle, pluginKey, pluginName, kind, title: a.title, html: a.html,
    width: a.width, height: a.height, modal: !!a.modal, dock: a.dock, visible: true, queue: [], seq: 0, z: ++pluginUi.topZ,
  });
}

export function findWindow(handle: number): PluginWindow | undefined { return pluginUi.windows.find((w) => w.handle === handle); }

/** Close from the app side (user / page / plugin). `silent` = plugin unloaded: no on_close. */
export function closeWindow(handle: number, opts: { silent?: boolean; submit?: unknown } = {}): void {
  const i = pluginUi.windows.findIndex((w) => w.handle === handle);
  if (i >= 0) {
    pluginUi.windows.splice(i, 1);
    if (!opts.silent) uiEvent(handle, opts.submit !== undefined ? 'submit' : 'close', opts.submit);
    return;
  }
  const p = pluginUi.progress.findIndex((x) => x.handle === handle);
  if (p >= 0) { pluginUi.progress.splice(p, 1); return; }
  dismissToast(`plugin-note-${handle}`);
}

export function closePluginWindows(pluginKey: string): void {
  for (const w of pluginUi.windows.filter((x) => x.pluginKey === pluginKey)) closeWindow(w.handle, { silent: true });
}

export function postToWindow(handle: number, data: unknown): void {
  const w = findWindow(handle);
  if (!w) return;
  w.queue.push(data);
  w.seq++;
}

// Plugin questions are queued: a newer dialogRequest would otherwise cancel the pending one.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

/** Closing the box without a button: "cancel" when there is one, else "no" / "ok". */
const dismissAnswer = (buttons: string): string => (buttons.includes('cancel') ? 'cancel' : buttons === 'yes_no' ? 'no' : 'ok');

export function askMessage(pluginName: string, a: { text: string; title: string; buttons: string; icon: string }): Promise<string> {
  return serial(async () => (await messageRequest.ask({ pluginName, ...a })) || dismissAnswer(a.buttons));
}

export function progressCreate(pluginName: string, a: { handle: number; title: string; message: string; maximum: number; style: number }): void {
  pluginUi.progress.push({ ...a, pluginName, value: 0, pulsing: false, cancelled: false, skipped: false, startedAt: Date.now() });
}

/** Returns false when the user cancelled (update()/pulse() return value). */
export function progressUpdate(a: { handle: number; value?: number; message?: string; pulse?: boolean; pulsing?: boolean }): boolean {
  const p = pluginUi.progress.find((x) => x.handle === a.handle);
  if (!p) return false;
  if (p.cancelled) return false;
  if (a.message) p.message = a.message;
  if (a.value !== undefined) p.value = a.value;
  if (a.pulsing !== undefined) p.pulsing = a.pulsing;
  if (a.pulse) p.pulsing = true;
  if (a.value !== undefined && a.value >= p.maximum && p.style & PD_AUTO_HIDE) closeWindow(p.handle);
  return true;
}

export function progressCancel(handle: number): void {
  const p = pluginUi.progress.find((x) => x.handle === handle);
  if (!p || !(p.style & PD_CAN_ABORT)) return;
  p.cancelled = true;
  uiEvent(handle, 'cancel');
}

const LEVEL_KIND: Record<string, ToastKind> = {
  ErrorNotificationLevel: 'error', SeriousWarningNotificationLevel: 'warn', WarningNotificationLevel: 'warn',
  ImportantNotificationLevel: 'info', RegularNotificationLevel: 'info', HintNotificationLevel: 'info',
  PrintInfoNotificationLevel: 'info', PrintInfoShortNotificationLevel: 'info', ProgressBarNotificationLevel: 'info',
};

export function notify(pluginName: string, a: { handle: number; level: string; text: string; hyper_text: string; clickable: boolean }): void {
  const kind = LEVEL_KIND[a.level] ?? 'info';
  const sticky = kind === 'error' || a.level === 'ImportantNotificationLevel' || a.level === 'SeriousWarningNotificationLevel';
  pushToast(kind, a.text, {
    id: `plugin-note-${a.handle}`, detail: pluginName, timeout: sticky || a.hyper_text ? 0 : undefined,
    action: a.hyper_text ? { label: a.hyper_text, run: () => uiEvent(a.handle, 'click') } : undefined,
  });
}

export function askPermission(p: PermissionRequest): Promise<boolean> {
  return serial(() => permissionRequest.ask(p));
}


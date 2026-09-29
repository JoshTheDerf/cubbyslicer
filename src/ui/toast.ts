/**
 * App-wide toast notifications, rendered by Nuxt UI's toaster (<UApp>).
 *
 * `toast.*` is callable from anywhere (actions, stores, workers' callbacks).
 * Nuxt UI's `useToast()` must be obtained inside a component setup (it
 * injects the toaster's max), so App.vue calls `bindToaster(useToast())`
 * once; anything raised before that is queued and flushed on bind.
 */
import { nextTick } from 'vue';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastOptions {
  detail?: string;
  /** ms; 0 keeps it open until dismissed. */
  timeout?: number;
  action?: { label: string; run: () => void };
  /** Stable id: a toast with the same id updates in place (progress toasts). */
  id?: string;
}

/** The subset of Nuxt UI's `useToast()` we use. */
export interface Toaster {
  add(t: Record<string, unknown>): { id: string | number };
  update(id: string | number, t: Record<string, unknown>): void;
  remove(id: string | number): void;
}

const COLORS: Record<ToastKind, string> = { info: 'info', success: 'success', warn: 'warning', error: 'error' };
const ICONS: Record<ToastKind, string> = {
  info: 'i-lucide-info', success: 'i-lucide-circle-check', warn: 'i-lucide-triangle-alert', error: 'i-lucide-circle-x',
};

let toaster: Toaster | null = null;
const pending: Array<() => void> = [];
const live = new Set<string>();
let seq = 0;

export function bindToaster(t: Toaster | null): void {
  toaster = t;
  if (t) for (const f of pending.splice(0)) f();
}

function payload(kind: ToastKind, message: string, o: ToastOptions): Record<string, unknown> {
  const duration = o.timeout ?? (kind === 'error' ? 8000 : kind === 'warn' ? 6000 : 3500);
  return {
    title: message,
    description: o.detail,
    color: COLORS[kind],
    icon: ICONS[kind],
    duration: duration > 0 ? duration : 0,
    progress: false,
    actions: o.action ? [{ label: o.action.label, color: 'neutral', variant: 'outline', size: 'xs', onClick: o.action.run }] : undefined,
    ui: { description: 'whitespace-pre-line max-h-40 overflow-auto' },
  };
}

export function pushToast(kind: ToastKind, message: string, o: ToastOptions = {}): string {
  const id = o.id ?? `t${++seq}`;
  const run = () => {
    const body = payload(kind, message, o);
    if (o.id && live.has(o.id)) toaster!.update(o.id, body);
    else { toaster!.add({ id, ...body, 'onUpdate:open': (v: boolean) => { if (!v) live.delete(id); } }); live.add(id); }
  };
  if (toaster) run(); else pending.push(run);
  return id;
}

export function dismissToast(id: string): void {
  live.delete(id);
  // Nuxt UI ignores remove() in the tick right after an update(); defer past it.
  const rm = () => { void nextTick(() => toaster?.remove(id)); };
  if (toaster) rm(); else pending.push(rm);
}

export const toast = {
  info: (m: string, o?: ToastOptions) => pushToast('info', m, o),
  success: (m: string, o?: ToastOptions) => pushToast('success', m, o),
  warn: (m: string, o?: ToastOptions) => pushToast('warn', m, o),
  error: (m: string, o?: ToastOptions) => pushToast('error', m, o),
};

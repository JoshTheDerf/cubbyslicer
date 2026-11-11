/** Shell-level UI state (not persisted with the project). */
import { markRaw, reactive, ref, watch } from 'vue';
import { dialogRequest } from '../../ui/dialogRequest';
import { readJson, writeJson } from '../../lib/storage';
import type { ObjectClipboard } from '../../project/store';

const LS_KEY = 'cubby-slicer:layout';

/** Orca's sidebar: one resizable left column (settings + object list). */
export const SIDEBAR_MIN = 300;
export const SIDEBAR_MAX = 560;
export const SIDEBAR_DEFAULT = 380;

interface Layout { sidebarWidth: number; sidebarCollapsed: boolean }

function loadLayout(): Layout {
  const d: Layout = { sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false };
  const p = readJson<Partial<Layout>>(LS_KEY);
  if (p && typeof p === 'object') {
    if (typeof p.sidebarWidth === 'number') d.sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, p.sidebarWidth));
    d.sidebarCollapsed = !!p.sidebarCollapsed;
  }
  return d;
}

export const layout = reactive(loadLayout());
watch(layout, (l) => { writeJson(LS_KEY, l); });

/** Below 1100px the sidebar becomes a slide-over drawer. */
export const compact = ref(false);
/** Narrow desktop (≤ 1366px): secondary top-bar buttons go icon-only. */
export const narrow = ref(false);
/** Phone layout (≤ 640px): icon-only top bar, bottom toolbar, panels collapsed. */
export const phone = ref(false);
/** Primary pointer is touch (coarse): no keyboard hints, long-press for menus. */
export const touch = ref(typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
export const drawerOpen = ref(false);

/** Shell state that isn't a dialog (dialogs: src/dialogs/state.ts). */
export const ui = reactive({
  renamingId: null as string | null,
  /** Bumped when the per-object settings should be revealed (sidebar opens, Objects mode). */
  revealObjectSettings: 0,
  busy: null as string | null,
  /** Mounted ObjectList instances (the settings sidebar renders it in its #objects slot). */
  objectListMounts: 0,
  /** An Auto Orient run is in progress. */
  orienting: false,
  /** In-app object clipboard (Ctrl+C / Ctrl+V). Raw: it holds mesh typed arrays. */
  clipboard: null as ObjectClipboard | null,
});

/** Show `label` in the busy pill while `fn` runs. */
export async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
  ui.busy = label;
  try { return await fn(); } finally { ui.busy = null; }
}

export function setClipboard(c: ObjectClipboard | null): void {
  ui.clipboard = c ? markRaw(c) : null;
}

export function sidebarOpen(): boolean {
  return compact.value ? drawerOpen.value : !layout.sidebarCollapsed;
}

export function toggleSidebar(open = !sidebarOpen()): void {
  if (compact.value) drawerOpen.value = open;
  else layout.sidebarCollapsed = !open;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /** Optional second choice next to the confirm button. */
  altLabel?: string;
  /** Cancel button label ('' = none; default "Cancel"). */
  cancelLabel?: string;
  /** Optional checkbox under the message (its state comes back with the answer). */
  checkLabel?: string;
  /** false: only the buttons answer (no Esc / outside click). */
  dismissible?: boolean;
  /** data-testid prefix for the buttons (`<id>-ok`, `<id>-cancel`, `<id>-check`). */
  testId?: string;
}
export interface ConfirmAnswer { choice: 'confirm' | 'alt' | null; checked: boolean }

/** The one confirm dialog (ShellDialogs.vue), also used by the AI agent bridge. */
export const confirmDialog = dialogRequest<ConfirmOptions, ConfirmAnswer>({ choice: null, checked: false });
/** The pending confirmation (the bridge reports it to the agent; e2e scripts answer it). */
export const confirmRequest = confirmDialog.current;

/** Ask for a full answer (choice + checkbox). */
export function askConfirm(opts: ConfirmOptions): Promise<ConfirmAnswer> { return confirmDialog.ask(opts); }

export async function confirmAction(opts: Omit<ConfirmOptions, 'altLabel' | 'checkLabel'>): Promise<boolean> {
  return (await confirmDialog.ask(opts)).choice === 'confirm';
}

/** Confirm with two choices: 'confirm', 'alt', or null (cancelled). */
export async function chooseAction(opts: Omit<ConfirmOptions, 'checkLabel'> & { altLabel: string }): Promise<'confirm' | 'alt' | null> {
  return (await confirmDialog.ask(opts)).choice;
}

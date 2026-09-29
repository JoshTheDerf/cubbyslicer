/** Shell-level UI state (not persisted with the project). */
import { markRaw, reactive, ref, watch } from 'vue';
import type { ObjectClipboard } from '../../project/store';

const LS_KEY = 'cubby-slicer:layout';

/** Orca's sidebar: one resizable left column (settings + object list). */
export const SIDEBAR_MIN = 300;
export const SIDEBAR_MAX = 560;
export const SIDEBAR_DEFAULT = 380;

interface Layout { sidebarWidth: number; sidebarCollapsed: boolean }

function loadLayout(): Layout {
  const d: Layout = { sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Layout>;
      if (typeof p.sidebarWidth === 'number') d.sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, p.sidebarWidth));
      d.sidebarCollapsed = !!p.sidebarCollapsed;
    }
  } catch { /* defaults */ }
  return d;
}

export const layout = reactive(loadLayout());
watch(layout, (l) => { try { localStorage.setItem(LS_KEY, JSON.stringify(l)); } catch { /* ignore */ } });

/** Below 1100px the sidebar becomes a slide-over drawer. */
export const compact = ref(false);
/** Narrow desktop (≤ 1366px): secondary top-bar buttons go icon-only. */
export const narrow = ref(false);
/** Phone layout (≤ 640px): icon-only top bar, bottom toolbar, panels collapsed. */
export const phone = ref(false);
/** Primary pointer is touch (coarse): no keyboard hints, long-press for menus. */
export const touch = ref(typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
export const drawerOpen = ref(false);

export const ui = reactive({
  shortcutsOpen: false,
  paletteOpen: false,
  aboutOpen: false,
  instancesOpen: false,
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

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /** Optional second choice next to the confirm button. */
  altLabel?: string;
  resolve: (answer: boolean | 'alt') => void;
}
export const confirmRequest = ref<ConfirmRequest | null>(null);

export function confirmAction(opts: Omit<ConfirmRequest, 'resolve' | 'altLabel'>): Promise<boolean> {
  return new Promise((resolve) => {
    confirmRequest.value?.resolve(false);
    confirmRequest.value = { ...opts, resolve: (a) => resolve(a === true) };
  });
}

/** Confirm with two choices: 'confirm', 'alt', or null (cancelled). */
export function chooseAction(opts: Omit<ConfirmRequest, 'resolve'> & { altLabel: string }): Promise<'confirm' | 'alt' | null> {
  return new Promise((resolve) => {
    confirmRequest.value?.resolve(false);
    confirmRequest.value = { ...opts, resolve: (a) => resolve(a === true ? 'confirm' : a === 'alt' ? 'alt' : null) };
  });
}

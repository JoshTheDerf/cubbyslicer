/**
 * Where plugin dock panels sit (orca.host.ui.create_dock_panel). OrcaSlicer 2.5 adds each panel
 * to the main window's wxAUI manager (Plater::priv::add_dock_pane): docked on the requested side
 * ("left", "right", "bottom") or floating ("float"), sized by width / height, and the user can
 * drag it to another side, float it and resize it. Its place is kept under the pane name
 * `plugin:<plugin>:<title>` and comes back when the panel opens again. Here that place is kept
 * per pane name in localStorage (Orca saves the window layout when the app closes; this saves on
 * every change). Importing this costs nothing: no plugin code, no Python.
 */
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { readJson, writeJson } from '../lib/storage';
import { activeView } from '../app/state';
import { mobileDialog } from '../ui/mobileDialog';
import { activePluginPage } from './state';

export type DockSide = 'left' | 'right' | 'bottom';
export const DOCK_SIDES: readonly DockSide[] = ['left', 'right', 'bottom'];

export interface PaneLayout {
  /** Docked side, or floating. */
  dock: DockSide | 'float';
  /** The side it docks on again when the user docks a floating panel (Orca: the pane's dock direction). */
  side: DockSide;
  /** Width of a left / right dock, height of a bottom one (CSS px). */
  size: number;
  /** Floating frame (CSS px), null until it has floated. */
  float: { x: number; y: number; w: number; h: number } | null;
}

const LS_KEY = 'cubby-slicer:plugin-docks';
export const DOCK_MIN = 160;

function load(): Record<string, PaneLayout> {
  const out: Record<string, PaneLayout> = {};
  const p = readJson<Record<string, Partial<PaneLayout>>>(LS_KEY);
  if (!p || typeof p !== 'object') return out;
  for (const [k, v] of Object.entries(p)) {
    if (!v || typeof v !== 'object') continue;
    const side = DOCK_SIDES.includes(v.side as DockSide) ? (v.side as DockSide) : 'right';
    const dock = v.dock === 'float' || DOCK_SIDES.includes(v.dock as DockSide) ? (v.dock as PaneLayout['dock']) : side;
    const f = v.float;
    out[k] = {
      dock, side, size: typeof v.size === 'number' && v.size >= DOCK_MIN ? v.size : 320,
      float: f && [f.x, f.y, f.w, f.h].every((n) => typeof n === 'number' && Number.isFinite(n)) ? { x: f.x, y: f.y, w: f.w, h: f.h } : null,
    };
  }
  return out;
}

/** Saved places by pane name. */
const saved: Record<string, PaneLayout> = load();
/** Places of the open panels, by window handle (reactive: the dock areas and frames read them). */
export const panes = reactive<Record<number, PaneLayout & { name: string; title: string; shown: boolean }>>({});

/** Orca's pane name (DockPanel.cpp plugin_pane_name), made unique among open panels as Plater does ("#2", …). */
export function paneName(pluginKey: string, title: string): string {
  const base = `plugin:${pluginKey}:${title}`.replace(/[|;=\\]/g, '_');
  const open = new Set(Object.values(panes).map((p) => p.name));
  let name = base;
  for (let i = 2; open.has(name); i++) name = `${base}#${i}`;
  return name;
}

/**
 * The place of a panel opening: where it was last left, else as the plugin asked (`dock`, and
 * `width` for a side dock or `height` for the bottom one).
 */
export function openPane(handle: number, pluginKey: string, title: string, dock: string | undefined, width: number, height: number): void {
  const name = paneName(pluginKey, title);
  const s = saved[name];
  if (s) { panes[handle] = { ...s, float: s.float && { ...s.float }, name, title, shown: true }; return; }
  const d: PaneLayout['dock'] = dock === 'float' || DOCK_SIDES.includes(dock as DockSide) ? (dock as PaneLayout['dock']) : 'right';
  const side: DockSide = d === 'float' ? 'right' : d;
  panes[handle] = { dock: d, side, size: Math.max(DOCK_MIN, side === 'bottom' ? height : width), float: null, name, title, shown: true };
}

export function closePane(handle: number): void { delete panes[handle]; }

export function setPaneShown(handle: number, shown: boolean): void { if (panes[handle]) panes[handle].shown = shown; }

/** Handles of the shown panels docked on `side`, oldest first (wxAUI adds a pane after those in its dock). */
export function dockedOn(side: DockSide): number[] {
  return Object.keys(panes).map(Number).filter((h) => panes[h].shown && panes[h].dock === side).sort((a, b) => a - b);
}

/**
 * Dock panels belong to the Prepare and Preview tabs (Orca: the Plater's panes; a floating one
 * hides with them too, Plater::priv::dock_pane_visible): hidden on Design and plugin pages.
 */
export const dockTabActive = computed(() => (activeView.value === 'prepare' || activeView.value === 'preview') && !activePluginPage.value);
/** Phones (≤ 640 px wide or ≤ 500 px tall): no docks, a panel is a bottom sheet over the viewport. */
export const dockSheets = mobileDialog;

/** The element the dock areas line (left dock, viewport + bottom dock, right dock): drag-to-dock hints measure it. */
export const dockRoot = shallowRef<HTMLElement | null>(null);

function persist(handle: number): void {
  const p = panes[handle];
  if (!p) return;
  saved[p.name] = { dock: p.dock, side: p.side, size: p.size, float: p.float && { ...p.float } };
  writeJson(LS_KEY, saved);
}

/** Dock on `side`, or float (at the last floating frame, or `at`). */
export function setPaneDock(handle: number, dock: PaneLayout['dock'], at?: PaneLayout['float']): void {
  const p = panes[handle];
  if (!p) return;
  p.dock = dock;
  if (dock !== 'float') p.side = dock;
  else if (at) p.float = { ...at };
  persist(handle);
}

/** Size of every panel docked on `side` (they share the dock, as wxAUI's panes in one dock row do). */
export function setDockSize(side: DockSide, size: number, save = true): void {
  for (const [h, p] of Object.entries(panes)) {
    if (p.dock !== side) continue;
    p.size = Math.round(Math.max(DOCK_MIN, size));
    if (save) persist(Number(h));
  }
}

export function setPaneFloat(handle: number, f: NonNullable<PaneLayout['float']>, save = true): void {
  const p = panes[handle];
  if (!p) return;
  p.float = { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) };
  if (save) persist(handle);
}

export function savePane(handle: number): void { persist(handle); }

/**
 * View ▸ Reset window layout (Orca Plater::priv::reset_window_layout): a floating panel is
 * docked again, on its side.
 */
export function redockFloatingPanes(): void {
  for (const h of Object.keys(panes)) if (panes[Number(h)].dock === 'float') setPaneDock(Number(h), panes[Number(h)].side);
}

/**
 * Docked panels are drawn over a placeholder the dock area lays out (moving an iframe in the
 * page would reload the plugin's page): the placeholders by window handle, and a counter that
 * bumps whenever the layout around them may have moved them.
 */
export const dockSlots = reactive<Record<number, HTMLElement>>({});
export const dockTick = ref(0);
let ro: ResizeObserver | null = null;
const bump = () => { dockTick.value++; };
export function observeDockLayout(el: Element): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  ro ??= new ResizeObserver(bump);
  ro.observe(el);
  bump();
  return () => ro?.unobserve(el);
}
watch(() => Object.keys(dockSlots).length, bump, { flush: 'post' });

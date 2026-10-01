/**
 * Assembles the live AppContext for the action system from the project
 * store, viewport controller, shell UI state and the slice controller, and
 * boots the registry + keyboard dispatcher. Called once from App.vue setup.
 */
import { onBeforeUnmount, watch } from 'vue';
import { activeView, lastSlice } from '../state';
import { activePlate, historyState, objects, objectPlate, plates, selectedIds } from '../../project/store';
import {
  fitBed, fitSelection, setCameraType, setGizmo, setSnapIncrement, setView, toggleLayOnFace, viewportState, zoomView,
} from '../../viewport/controller';
import { buildActions } from '../actions/buildActions';
import { bindPaintDispatch } from '../actions/families/paint';
import { closePaint, togglePaint } from '../../paint/controller';
import { paintUi } from '../../paint/state';
import { setActionContext, type AppContext, type ActionDispatch } from '../actions/context';
import { installActionKeyListener, setActionScope, uninstallActionKeyListener } from '../actions/dispatch';
import { getAllActions, registerActions } from '../actions/registry';
import { setActionErrorHandler } from '../actions/run';
import { toast } from '../../ui';
import * as cmd from './actions';
import { runArrange } from './arrange';
import { cloud } from '../../cloud/store';
import { saveToCloudLocation } from '../../cloud/commands';
import { fsAccessSupported, local } from '../../localfs/store';
import { importLocal, openLocalProject, saveLocal, saveLocalAs } from '../../localfs/commands';
import type { SliceControllerLike } from './external';
import { sidebarOpen, toggleSidebar, ui } from './uiState';

/** Focus is on nothing in particular (body / viewport canvas) and no page text is selected. */
function focusIdle(): boolean {
  if (typeof document === 'undefined') return true;
  const el = document.activeElement;
  const idle = !el || el === document.body || el.tagName === 'CANVAS';
  if (!idle) return false;
  const s = typeof window.getSelection === 'function' ? window.getSelection() : null;
  return !s || s.isCollapsed || !s.toString();
}

/** A Nuxt UI modal / slide-over / menu, or one of ours, is open. */
function overlayOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
}

export function createAppContext(slicer: SliceControllerLike | null): AppContext {
  const dispatch: ActionDispatch = {
    newProject: cmd.newProject,
    openProject: () => (fsAccessSupported ? openLocalProject() : cmd.openProjectDialog()),
    // Ctrl+S (Orca Save project): back to the CubbyCAD / local file it came from, else Save as
    // (native dialog where the File System Access API exists, else a download).
    saveProject: () => {
      if (cloud.location) void saveToCloudLocation();
      else if (local.location) void saveLocal();
      else if (fsAccessSupported) void saveLocalAs();
      else cmd.saveProject();
    },
    importModels: () => (fsAccessSupported ? importLocal() : cmd.importDialog()),
    exportPlate3mf: cmd.exportPlate3mf,
    exportPlateStl: () => cmd.exportStl(false),
    exportSelectionStl: () => cmd.exportStl(true),
    undo: cmd.doUndo,
    redo: cmd.doRedo,
    selectAll: cmd.selectAll,
    clearSelection: cmd.clearSelection,
    deleteSelection: cmd.deleteSelection,
    deleteAll: cmd.deleteAll,
    copy: cmd.copySelection,
    cut: cmd.cutSelection,
    paste: cmd.pasteClipboard,
    duplicate: () => cmd.doDuplicate(1),
    addInstances: () => { ui.instancesOpen = true; },
    removeInstance: cmd.removeInstanceSel,
    splitToObjects: cmd.splitSelectionToObjects,
    splitToParts: cmd.splitSelectionToParts,
    addSubObject: cmd.addSubObject,
    arrangePlate: cmd.arrangePlate,
    addPlate: cmd.addPlateCmd,
    deletePlate: () => cmd.deletePlateCmd(),
    selectPlate: cmd.selectPlate,
    togglePlateLock: () => cmd.togglePlateLock(),
    clearPlate: () => cmd.clearPlateCmd(),
    sliceAll: cmd.sliceAllNow,
    exportAllGcode: cmd.exportAllGcode,
    rename: cmd.startRename,
    setGizmo,
    toggleLayOnFace: cmd.toggleLayFlat,
    dropToBed: () => cmd.dropToBed(),
    center: () => cmd.centerObjects(),
    mirror: (a) => cmd.mirrorObjects(a),
    rotate90: cmd.rotate90,
    scaleToFit: () => cmd.scaleToFit(),
    toggleHidden: cmd.toggleHiddenSelection,
    togglePrintable: cmd.togglePrintableSelection,
    perObjectSettings: cmd.revealObjectSettings,
    nudge: cmd.nudge,
    autoOrient: cmd.autoOrientObjects,
    arrangeAll: () => { void runArrange('all'); },
    arrangeSelection: () => { void runArrange('selection'); },
    setView,
    fitSelection,
    fitBed,
    zoom: zoomView,
    setCameraType,
    setSnapIncrement,
    setActiveView: (v) => { activeView.value = v; },
    toggleSidebar: () => toggleSidebar(),
    slice: cmd.sliceNow,
    cancelSlice: cmd.cancelSlice,
    exportGcode: cmd.exportGcode,
    openPalette: () => { ui.paletteOpen = true; },
    openShortcuts: () => { ui.shortcutsOpen = true; },
    openAbout: () => { ui.aboutOpen = true; },
  };

  const ctx: AppContext = {
    get view() { return activeView.value; },
    get objectCount() { return objects.value.length; },
    get selection() {
      const set = new Set(selectedIds.value);
      const sel = objects.value.filter((o) => set.has(o.id));
      return {
        count: sel.length,
        ids: sel.map((o) => o.id),
        single: sel.length === 1 ? sel[0].id : null,
        allHidden: sel.length > 0 && sel.every((o) => !o.visible),
        allNotPrintable: sel.length > 0 && sel.every((o) => !o.printable),
      };
    },
    get canUndo() { return !!historyState.value.undo; },
    get canRedo() { return !!historyState.value.redo; },
    get undoLabel() { return historyState.value.undo; },
    get redoLabel() { return historyState.value.redo; },
    get gizmo() { return viewportState.gizmo; },
    get layOnFace() { return viewportState.layOnFace; },
    get cameraType() { return viewportState.camera; },
    get snapIncrement() { return viewportState.snap; },
    get sidebar() { return sidebarOpen(); },
    get clipboard() { return !!ui.clipboard; },
    get orienting() { return ui.orienting; },
    get slice() {
      const status = slicer?.status?.value ?? 'idle';
      return {
        available: !!slicer,
        busy: status === 'slicing',
        hasResult: !!lastSlice.value,
        stale: !!slicer?.isStale?.value,
        slicedPlates: slicer?.plateStates?.value.filter((x) => x !== 'none').length ?? 0,
      };
    },
    get plates() {
      const a = activePlate.value;
      let n = 0;
      for (const p of objectPlate.value.values()) if (p === a) n++;
      return { count: plates.value.length, active: a, locked: !!plates.value[a]?.locked, activeObjects: n };
    },
    get modalOpen() {
      return ui.paletteOpen || ui.shortcutsOpen || ui.aboutOpen || ui.instancesOpen || overlayOpen();
    },
    get focusIdle() { return focusIdle(); },
    dispatch,
  };
  return ctx;
}

/** Boot the action system for the app. Returns the context. */
export function useActionSystem(slicer: SliceControllerLike | null): AppContext {
  bindPaintDispatch({ togglePaint, closePaint, paintLayer: () => paintUi.layer });
  const ctx = createAppContext(slicer);
  setActionContext(ctx);
  const dispose = registerActions(buildActions());
  setActionErrorHandler((a, e) => toast.error(`${a.title} failed.`, { detail: (e as Error)?.message ?? String(e) }));
  installActionKeyListener(getAllActions, () => ctx);
  const stop = watch(activeView, (v) => setActionScope(v), { immediate: true });
  // Leaving Prepare cancels lay-on-face picking.
  watch(activeView, (v) => { if (v !== 'prepare' && viewportState.layOnFace) toggleLayOnFace(false); });
  onBeforeUnmount(() => { stop(); dispose(); uninstallActionKeyListener(); setActionContext(null); });
  return ctx;
}

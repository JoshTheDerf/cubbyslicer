/**
 * The single `AppContext` every action's when/state/run reads (mirrors
 * cad-project/src/actions/context.ts): a live state slice + a stable
 * `dispatch` bag of app operations. Assembled once by the shell
 * (src/app/shell/actionContext.ts); families never import app state, so they
 * are testable with a fixture context (./testing/fixtureContext.ts).
 *
 * Fields are read through getters, so reading them inside a computed tracks
 * the underlying refs and the dispatcher always sees current values.
 */
import type { GizmoMode, ViewPreset } from '../../viewport/controller';

export interface SelectionSlice {
  count: number;
  ids: string[];
  /** The id when exactly one object is selected. */
  single: string | null;
  allHidden: boolean;
  allNotPrintable: boolean;
}

export interface SliceSlice {
  /** A slice controller is wired (src/app/slice.ts). */
  available: boolean;
  busy: boolean;
  hasResult: boolean;
  stale: boolean;
  /** Plates with a sliced result (any plate). */
  slicedPlates?: number;
}

export interface PlatesSlice {
  count: number;
  /** Active plate index. */
  active: number;
  /** The active plate is locked (skipped by arrange all / orient all). */
  locked: boolean;
  /** Objects on the active plate. */
  activeObjects: number;
}

export interface ActionDispatch {
  // file
  newProject(): void | Promise<void>;
  openProject(): void | Promise<void>;
  saveProject(): void;
  importModels(): void | Promise<void>;
  exportPlate3mf(): void;
  exportPlateStl(): void;
  exportSelectionStl(): void;
  // edit
  undo(): void;
  redo(): void;
  selectAll(): void;
  clearSelection(): void;
  deleteSelection(): void;
  deleteAll(): void;
  copy(): void;
  cut(): void;
  paste(): void;
  duplicate(): void;
  /** Open "Set number of instances" for the selection. */
  addInstances(): void;
  removeInstance(): void;
  rename(): void;
  // object
  setGizmo(mode: GizmoMode): void;
  toggleLayOnFace(): void;
  dropToBed(): void;
  center(): void;
  mirror(axis: 0 | 1 | 2): void;
  rotate90(axis: 0 | 1 | 2): void;
  scaleToFit(): void;
  toggleHidden(): void;
  togglePrintable(): void;
  perObjectSettings(): void;
  /** Move the selection by (dx, dy) mm. */
  nudge(dx: number, dy: number): void;
  /** Orca Auto Orient: 'auto' = the selection, or everything when nothing is selected. */
  autoOrient(scope: 'auto' | 'all'): void | Promise<void>;
  splitToObjects(): void;
  splitToParts(): void;
  /** Orca "Add part / negative part / modifier / support blocker / enforcer" on the selected object. */
  addSubObject(type: 'part' | 'negative' | 'modifier' | 'support_blocker' | 'support_enforcer', source: 'box' | 'cylinder' | 'sphere' | 'slab' | 'file'): void | Promise<void>;
  // arrange
  arrangeAll(): void;
  arrangeSelection(): void;
  arrangePlate(): void;
  // plates
  addPlate(): void;
  deletePlate(): void | Promise<void>;
  selectPlate(index: number): void;
  togglePlateLock(): void;
  clearPlate(): void | Promise<void>;
  // view
  setView(p: ViewPreset): void;
  fitSelection(): void;
  fitBed(): void;
  /** +1 zoom in, -1 zoom out. */
  zoom(dir: 1 | -1): void;
  setActiveView(v: 'prepare' | 'preview'): void;
  toggleSidebar(): void;
  // slice
  slice(): void | Promise<void>;
  sliceAll(): void | Promise<void>;
  cancelSlice(): void;
  exportGcode(): void | Promise<void>;
  exportAllGcode(): void;
  // help
  openPalette(): void;
  openShortcuts(): void;
  openAbout(): void;
}

export interface AppContext {
  readonly view: 'prepare' | 'preview';
  readonly objectCount: number;
  readonly selection: SelectionSlice;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  readonly gizmo: GizmoMode;
  readonly layOnFace: boolean;
  /** The settings/objects sidebar is showing. */
  readonly sidebar: boolean;
  /** Something is on the in-app object clipboard. */
  readonly clipboard: boolean;
  /** An Auto Orient run is in progress. */
  readonly orienting: boolean;
  readonly slice: SliceSlice;
  readonly plates: PlatesSlice;
  /** A modal dialog or the palette is open. */
  readonly modalOpen: boolean;
  /** Keyboard focus is on nothing in particular (body / the viewport canvas) and no text is selected. */
  readonly focusIdle: boolean;
  readonly dispatch: ActionDispatch;
}

let current: AppContext | null = null;
export function setActionContext(ctx: AppContext | null): void { current = ctx; }
export function getActionContext(): AppContext | null { return current; }

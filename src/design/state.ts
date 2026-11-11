/**
 * Design tab UI state: selection, picks, view toggles. Not undoable, not saved (Orca keeps
 * these as view preferences or in the GUI only). The document state is in session.ts.
 */
import { reactive } from 'vue';

/** A pick in the viewport. Face / edge ids belong to one `generation` (contract "Ids"). */
export type DesignPick =
  | { kind: 'body'; body: number }
  | { kind: 'face'; body: number; face: number; generation: number }
  | { kind: 'edge'; body: number; edge: number; generation: number };

export const designUi = reactive({
  /** Selected feature rows (indices), in click order; the last is the one being edited. */
  selected: [] as number[],
  /** The viewport / Bodies list pick (one at a time, Orca's single selection). */
  pick: null as DesignPick | null,
  /** Bodies hidden in the Design view (display only, like Orca's body eye). */
  hiddenBodies: [] as number[],
  /** Orca's pinned rows: reference planes at the modeling origin, the printer bed. */
  showOrigin: false,
  showBed: true,
  /** Feature row being renamed inline. */
  renaming: null as number | null,
  /** Body row being renamed inline (F2 on a body, the offer's Rename…). */
  renamingBody: null as number | null,
  /** Phone / compact: the panel sheet is open. */
  panelOpen: false,
  /** The sidebar section shown on phones (one at a time). */
  phoneSection: 'features' as 'features' | 'bodies' | 'variables',
});

/** The feature whose parameters the editor shows (the last selected row). */
export function editedFeature(): number | null {
  const s = designUi.selected;
  return s.length ? s[s.length - 1] : null;
}

export function clearDesignSelection(): void {
  designUi.selected = [];
  designUi.pick = null;
  designUi.renaming = null;
}

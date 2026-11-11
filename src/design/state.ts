/**
 * Design tab UI state: selection, picks, view toggles. Not undoable, not saved (Orca keeps
 * these as view preferences or in the GUI only). The document state is in session.ts.
 */
import { reactive } from 'vue';

/** A pick in the viewport. Face / edge ids belong to one `generation` (contract "Ids"). */
export type DesignPick =
  | { kind: 'body'; body: number }
  | { kind: 'face'; body: number; face: number; generation: number }
  /** `more`: Orca's edge set — the other edges Shift / Ctrl+clicked on the same body, in click order (`edge` is the last). */
  | { kind: 'edge'; body: number; edge: number; generation: number; more?: number[] };

/** Every edge of an edge pick: the set's others, then the current one (Orca's `selected_edges`). */
export function pickEdges(p: DesignPick | null): number[] {
  return p?.kind === 'edge' ? [...(p.more ?? []), p.edge] : [];
}

/**
 * Orca's Shift / Ctrl+click on `edge` of an edge pick's body (DesignSketchTool::handle_solid_click):
 * a new edge joins the set and becomes the current one; one already in the set leaves it; the
 * current one leaving hands over to the previous, and the last one leaving clears the selection.
 */
export function toggleSetEdge(p: Extract<DesignPick, { kind: 'edge' }>, edge: number): Extract<DesignPick, { kind: 'edge' }> | null {
  const more = [...(p.more ?? [])];
  if (edge === p.edge) return more.length ? { ...p, edge: more.pop()!, more } : null;
  if (more.includes(edge)) return { ...p, more: more.filter((e) => e !== edge) };
  return { ...p, edge, more: [...more, p.edge] };
}

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
  /** Orca's Design section view: a horizontal cut at `z` (bed mm), keeping the lower half or, `upper`, the upper one. */
  section: null as null | { z: number; upper: boolean },
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

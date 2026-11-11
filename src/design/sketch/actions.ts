/**
 * Sketcher commands in the action registry. Keys are Orca's sketch key map
 * (DesignPanel.cpp `m_keys_sketch`) in the `sketch` scope, which replaces `design` while a sketch
 * is open (`setActionScopeRefiner`): L line, R rectangle, C circle, A arc, S slot, E ellipse,
 * B spline, P point, G polygon, D dimension, T trim, X extend, O offset, M mirror, F fillet,
 * H chamfer, V value of the selection, K constrain, N look normal, Q construction, Del delete,
 * Enter (end the chain → put the tool down → finish the sketch), Esc (Orca's ladder: the
 * gesture, the tool, the selection — never the sketch). Ctrl+Z / Ctrl+Y are the app's, routed to
 * the sketch's own undo while it is open (session.ts). Shift+S starts a sketch (feature map).
 */
import type { Action } from '../../app/actions/types';
import { activeView } from '../../app/state';
import { reactive } from 'vue';
import { design, setStatus } from '../session';
import { designViewport } from '../viewport';
import { CONSTRAINTS } from './constraints';
import { DRAW_TOOLS } from './shapes';
import {
  applyConstraint, cancelSketch, deleteConstraints, deleteSelection, finishSketch, sk, startSketch, stopChoosing, toggleConstruction, beginSketch,
  requestValue, setConstraintValue, anchorOf, type SketchToolId, fromWire, placeRegions,
} from './session';
import { enterKey, escapeKey, setTool } from './driver';
import { planLocal } from './constraints';
import { editBlocker } from '../session';
import { designUi } from '../state';


/** Toolbar popovers the keys open (K: the constraint menu). */
export const sketchUi = reactive({ constrainOpen: false, modifyOpen: false, textOpen: false });

async function importSvg(): Promise<void> {
  const { pickFiles } = await import('../../app/shell/download');
  const [f] = await pickFiles('.svg,image/svg+xml', false);
  if (!f) return;
  try {
    const { svgRegions } = await import('./outline');
    const err = placeRegions(svgRegions(await f.text()), 'SVG');
    if (err) setStatus('warn', err);
  } catch (e) { setStatus('error', `${f.name}: ${e instanceof Error ? e.message : String(e)}`); }
}

const inSketch = () => activeView.value === 'design' && sk.open;
const S = 'sketch' as const;

export interface EditToolDef { id: SketchToolId; title: string; icon: string; key?: string; hint: string; group: 'modify' | 'transform' | 'dimension' }
export const EDIT_TOOLS: EditToolDef[] = [
  { id: 'dimension', title: 'Dimension', icon: 'i-lucide-ruler-dimension-line', key: 'd', hint: 'Click a line, a circle / arc, or two points', group: 'dimension' },
  { id: 'trim', title: 'Trim', icon: 'i-lucide-scissors', key: 't', hint: 'Click the part of a curve to cut away (to the nearest crossing)', group: 'modify' },
  { id: 'extend', title: 'Extend', icon: 'i-lucide-move-right', key: 'x', hint: 'Click near the end of a line or arc to extend it to the next curve', group: 'modify' },
  { id: 'fillet', title: 'Fillet', icon: 'i-lucide-square-round-corner', key: 'f', hint: 'Round the corner between two lines', group: 'modify' },
  { id: 'chamfer', title: 'Chamfer', icon: 'i-lucide-scissors-line-dashed', key: 'h', hint: 'Bevel the corner between two lines', group: 'modify' },
  { id: 'offset', title: 'Offset', icon: 'i-lucide-copy', key: 'o', hint: 'Offset a chain of curves by a distance', group: 'modify' },
  { id: 'mirror', title: 'Mirror', icon: 'i-lucide-flip-horizontal-2', key: 'm', hint: 'Mirror the selection about a line', group: 'modify' },
  { id: 'use-edges', title: 'Use edges', icon: 'i-lucide-scan-line', hint: 'Project body edges into the sketch (fixed in place)', group: 'modify' },
  { id: 'move', title: 'Move', icon: 'i-lucide-move', hint: 'Move the selection (Ctrl: copy)', group: 'transform' },
  { id: 'rotate', title: 'Rotate', icon: 'i-lucide-rotate-cw', hint: 'Rotate the selection about a pivot', group: 'transform' },
  { id: 'scale', title: 'Scale', icon: 'i-lucide-scaling', hint: 'Scale the selection about a pivot', group: 'transform' },
  { id: 'array', title: 'Linear array', icon: 'i-lucide-grid-3x3', hint: 'Copies of the selection along a step', group: 'transform' },
  { id: 'polar', title: 'Polar array', icon: 'i-lucide-rotate-ccw', hint: 'Copies of the selection around a pivot', group: 'transform' },
];

/** V: type the defining number of the selection (Orca's Value). */
function valueOfSelection(): void {
  if (sk.selCons.length === 1) {
    const c = sk.constraints[sk.selCons[0]];
    if (c && ['distance', 'distance_x', 'distance_y', 'radius', 'diameter', 'angle', 'point_on_line', 'lock_x', 'lock_y'].includes(c.type)) {
      const i = sk.selCons[0];
      requestValue({ label: 'Value', value: fromWire(c.type, c.value), unit: c.type === 'angle' ? '°' : 'mm', at: anchorOf(c), submit: (v) => setConstraintValue(i, v) });
      return;
    }
  }
  const plan = planLocal('distance', sk.sel, sk.entities);
  if (plan?.kind !== 'ask_value') { setStatus('info', 'Value: select a line, an arc / circle, or two points.'); return; }
  void applyConstraint(plan.constraints[0].type === 'distance' ? 'distance' : plan.constraints[0].type);
}

export function sketchActions(): Action[] {
  return [
    { id: 'design.sketch.new', title: 'New sketch…', icon: 'i-lucide-pen-tool', category: 'Design', aliases: ['sketch', 'draw', 'profile', '2d', 'sketch on face'],
      description: 'Sketch on the picked flat face, or choose a plane (Orca’s Sketch).', binding: { key: 's', shift: true, scope: 'design' },
      when: () => activeView.value === 'design' && design.phase === 'open' && !sk.open && !editBlocker(), run: () => { const e = startSketch(); if (e) setStatus('warn', e); } },
    { id: 'design.sketch.plane-cancel', title: 'Stop choosing a sketch plane', icon: 'i-lucide-x', category: 'Design', paletteHidden: true,
      binding: { key: 'escape', scope: 'design', passThroughWhenUnavailable: true }, when: () => activeView.value === 'design' && sk.choosing, run: () => stopChoosing() },
    { id: 'design.sketch.edit', title: 'Edit sketch', icon: 'i-lucide-pencil', category: 'Design', aliases: ['open sketch', 'modify sketch'],
      description: 'Open the selected Sketch feature in the sketcher.',
      when: () => activeView.value === 'design' && !sk.open && !editBlocker() && design.features.some((f, i) => f.type === 'Sketch' && i === lastSelectedSketch()),
      run: () => { const i = lastSelectedSketch(); if (i >= 0) void beginSketch({ feature: i }); } },
    { id: 'design.sketch.finish', title: 'Finish sketch', icon: 'i-lucide-check', category: 'Sketch', aliases: ['confirm sketch', 'ok', 'done', 'commit sketch'],
      description: 'Write the sketch into the design (one undo step).', when: () => inSketch() && !sk.committing, run: () => { void finishSketch(); } },
    { id: 'design.sketch.cancel', title: 'Cancel sketch', icon: 'i-lucide-x', category: 'Sketch', aliases: ['discard sketch'], tone: 'danger',
      description: 'Discard this sketch session; the design is unchanged.', when: () => inSketch(), run: () => { void cancelSketch(); } },
    { id: 'design.sketch.enter', title: 'Finish chain / sketch', icon: 'i-lucide-corner-down-left', category: 'Sketch', paletteHidden: true, hidden: true,
      binding: { key: 'enter', scope: S }, when: () => inSketch() && !sk.value,
      run: async () => { if (await enterKey()) return; if (sk.tool !== 'select') { setTool('select'); return; } await finishSketch(); } },
    { id: 'design.sketch.escape', title: 'Step back', icon: 'i-lucide-undo-dot', category: 'Sketch', paletteHidden: true, hidden: true,
      binding: { key: 'escape', scope: S }, when: () => inSketch() && !sk.value,
      run: () => {
        if (sk.conflict) { sk.conflict = null; return; }
        if (escapeKey()) return;
        if (!sk.entities.length && !sk.regions) { void cancelSketch(); return; }
        setStatus('info', 'Sketch kept — Finish to commit it, Cancel to discard.');
      } },
    { id: 'design.sketch.delete', title: 'Delete', icon: 'i-lucide-trash-2', category: 'Sketch', tone: 'danger', binding: { key: 'delete', scope: S },
      when: () => inSketch() && (sk.sel.length > 0 || sk.selCons.length > 0), run: () => { void (sk.selCons.length && !sk.sel.length ? deleteConstraints(sk.selCons) : deleteSelection()); } },
    { id: 'design.sketch.delete-backspace', title: 'Delete', icon: 'i-lucide-trash-2', category: 'Sketch', hidden: true, paletteHidden: true, binding: { key: 'backspace', scope: S },
      when: () => inSketch() && (sk.sel.length > 0 || sk.selCons.length > 0), run: () => { void (sk.selCons.length && !sk.sel.length ? deleteConstraints(sk.selCons) : deleteSelection()); } },
    { id: 'design.sketch.select-all', title: 'Select all entities', icon: 'i-lucide-box-select', category: 'Sketch', binding: { key: 'a', ctrlOrMeta: true, scope: S },
      when: () => inSketch() && sk.entities.length > 0, run: () => { sk.sel = sk.entities.map((_, e) => ({ e })); sk.selCons = []; } },
    { id: 'design.sketch.construction', title: 'Construction geometry', icon: 'i-lucide-square-dashed', category: 'Sketch', aliases: ['reference geometry', 'helper line'],
      description: 'Toggle construction on the selection, or for new entities (Orca’s Q).', binding: { key: 'q', scope: S }, state: () => (sk.construction ? 'on' : 'off'),
      when: () => inSketch(), run: () => { void toggleConstruction(); } },
    { id: 'design.sketch.normal', title: 'Look at the sketch plane', icon: 'i-lucide-scan-eye', category: 'Sketch', aliases: ['normal to', 'face on'], binding: { key: 'n', scope: S },
      when: () => inSketch(), run: () => { if (sk.plane) designViewport()?.sketchView?.(sk.plane, sk.entities); } },
    { id: 'design.sketch.fit', title: 'Fit the sketch', icon: 'i-lucide-scan', category: 'Sketch', binding: { key: 'home', scope: S },
      when: () => inSketch(), run: () => { if (sk.plane) designViewport()?.sketchView?.(sk.plane, sk.entities); } },
    { id: 'design.sketch.value', title: 'Value of the selection…', icon: 'i-lucide-binary', category: 'Sketch', aliases: ['length', 'radius', 'type value'],
      binding: { key: 'v', scope: S }, when: () => inSketch() && (sk.sel.length > 0 || sk.selCons.length === 1), run: () => valueOfSelection() },
    { id: 'design.sketch.constrain', title: 'Constrain…', icon: 'i-lucide-link', category: 'Sketch', binding: { key: 'k', scope: S },
      when: () => inSketch(), run: () => { sketchUi.constrainOpen = true; } },
    { id: 'design.sketch.tool.select', title: 'Select', icon: 'i-lucide-mouse-pointer-2', category: 'Sketch', binding: { key: 's', alt: true, scope: S }, state: () => (sk.tool === 'select' ? 'on' : 'off'),
      when: () => inSketch(), run: () => setTool('select') },
    ...DRAW_TOOLS.map((t): Action => ({
      id: `design.sketch.tool.${t.id}`, title: t.title, icon: t.icon, category: 'Sketch', description: `${t.hint}.`, aliases: ['draw', t.family],
      ...(t.key ? { binding: { key: t.key, scope: S } } : {}), state: () => (sk.tool === t.id ? 'on' : 'off'),
      when: () => inSketch(), run: () => setTool(t.id),
    })),
    ...EDIT_TOOLS.map((t): Action => ({
      id: `design.sketch.tool.${t.id}`, title: t.title, icon: t.icon, category: 'Sketch', description: `${t.hint}.`,
      ...(t.key ? { binding: { key: t.key, scope: S } } : {}), state: () => (sk.tool === t.id ? 'on' : 'off'),
      when: () => inSketch(), run: () => setTool(t.id),
    })),
    { id: 'design.sketch.text', title: 'Text…', icon: 'i-lucide-type', category: 'Sketch', aliases: ['emboss', 'lettering', 'label', 'font'],
      description: 'Text outlines as a profile (Orca’s Text sketch: rigid regions in a sketch of their own).', when: () => inSketch(), run: () => { sketchUi.textOpen = true; } },
    { id: 'design.sketch.svg', title: 'Import SVG…', icon: 'i-lucide-file-image', category: 'Sketch', aliases: ['vector', 'logo', 'outline', 'svg'],
      description: 'An SVG’s filled shapes as a profile (rigid regions in a sketch of their own).', when: () => inSketch(), run: () => { void importSvg(); } },
    ...CONSTRAINTS.map((c): Action => ({
      id: `design.sketch.constrain.${c.type}`, title: c.label, icon: c.icon, category: 'Sketch', description: `${c.hint}.`, aliases: ['constraint', 'constrain'],
      when: () => inSketch(), run: () => { void applyConstraint(c.type); },
    })),
  ];
}

function lastSelectedSketch(): number {
  const s = designUi.selected;
  const i = s[s.length - 1];
  return i !== undefined && design.features[i]?.type === 'Sketch' ? i : -1;
}

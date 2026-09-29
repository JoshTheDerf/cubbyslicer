/**
 * Preview commands for the app action registry (menus, command palette and
 * the single keyboard dispatcher). All are gated to the Preview view and
 * their key bindings use the registry's `preview` scope. Preview state is
 * module-level (./store), so `ctx` is not needed.
 */
import { activeView } from '../app/state';
import { registerActions } from '../app/actions/registry';
import type { Action, ActionState } from '../app/actions/types';
import { SCHEMES } from './render/colors';
import type { ViewPreset } from './render/PreviewRenderer';
import {
  cameraCommand, colorScheme, layerCount, layerLo, legendCollapsed, previewData, previewOptions,
  setTopLayer, showGcodeViewer, stepLayer, stepMove, toggleOption, moveIndex, layerMoveCount,
  singleLayer, setSingleLayer,
} from './store';

export type PreviewAction = Action;

const CATEGORY = 'Preview';
const inPreview = () => activeView.value === 'preview';
const hasData = () => inPreview() && previewData.value !== null;
const onOff = (b: boolean): ActionState => (b ? 'on' : 'off');

const VIEWS: Array<{ preset: ViewPreset; title: string; key: string }> = [
  { preset: 'iso', title: 'Isometric view', key: '0' },
  { preset: 'top', title: 'Top view', key: '1' },
  { preset: 'bottom', title: 'Bottom view', key: '2' },
  { preset: 'front', title: 'Front view', key: '3' },
  { preset: 'back', title: 'Back view', key: '4' },
  { preset: 'left', title: 'Left view', key: '5' },
  { preset: 'right', title: 'Right view', key: '6' },
];

export const previewActions: PreviewAction[] = [
  // ---- layers ----
  { id: 'preview.layer.up', title: 'Next layer', category: CATEGORY, aliases: ['layer up'], binding: { key: 'arrowup', scope: 'preview' }, when: hasData, run: () => stepLayer(1) },
  { id: 'preview.layer.down', title: 'Previous layer', category: CATEGORY, aliases: ['layer down'], binding: { key: 'arrowdown', scope: 'preview' }, when: hasData, run: () => stepLayer(-1) },
  { id: 'preview.layer.up10', title: 'Up 10 layers', category: CATEGORY, binding: { key: 'arrowup', shift: true, scope: 'preview' }, when: hasData, run: () => stepLayer(10) },
  { id: 'preview.layer.down10', title: 'Down 10 layers', category: CATEGORY, binding: { key: 'arrowdown', shift: true, scope: 'preview' }, when: hasData, run: () => stepLayer(-10) },
  { id: 'preview.layer.first', title: 'First layer', category: CATEGORY, aliases: ['bottom layer'], binding: { key: 'home', scope: 'preview' }, when: hasData, run: () => { layerLo.value = 0; setTopLayer(0); } },
  { id: 'preview.layer.last', title: 'Last layer (show all)', category: CATEGORY, aliases: ['top layer', 'all layers'], binding: { key: 'end', scope: 'preview' }, when: hasData, run: () => { layerLo.value = 0; setTopLayer(layerCount() - 1); } },
  // ---- moves ----
  { id: 'preview.move.next', title: 'Next move', category: CATEGORY, binding: { key: 'arrowright', scope: 'preview' }, when: hasData, run: () => stepMove(1) },
  { id: 'preview.move.prev', title: 'Previous move', category: CATEGORY, binding: { key: 'arrowleft', scope: 'preview' }, when: hasData, run: () => stepMove(-1) },
  { id: 'preview.move.next10', title: 'Forward 10 moves', category: CATEGORY, binding: { key: 'arrowright', shift: true, scope: 'preview' }, when: hasData, run: () => stepMove(10) },
  { id: 'preview.move.prev10', title: 'Back 10 moves', category: CATEGORY, binding: { key: 'arrowleft', shift: true, scope: 'preview' }, when: hasData, run: () => stepMove(-10) },
  { id: 'preview.move.layerStart', title: 'First move of layer', category: CATEGORY, when: hasData, run: () => { moveIndex.value = 0; } },
  { id: 'preview.move.layerEnd', title: 'Last move of layer', category: CATEGORY, when: hasData, run: () => { moveIndex.value = Math.max(0, layerMoveCount() - 1); } },
  // ---- toggles ----
  { id: 'preview.toggle.travel', title: 'Show travel moves', category: CATEGORY, aliases: ['travels'], binding: { key: 't', scope: 'preview' }, when: inPreview, state: () => onOff(previewOptions.value.travel), run: () => toggleOption('travel') },
  { id: 'preview.toggle.wipe', title: 'Show wipe moves', category: CATEGORY, aliases: ['wipes'], when: inPreview, state: () => onOff(previewOptions.value.wipe), run: () => toggleOption('wipe') },
  { id: 'preview.toggle.retracts', title: 'Show retractions', category: CATEGORY, aliases: ['retract'], when: inPreview, state: () => onOff(previewOptions.value.retracts), run: () => toggleOption('retracts') },
  { id: 'preview.toggle.unretracts', title: 'Show deretractions', category: CATEGORY, aliases: ['unretract', 'deretract'], when: inPreview, state: () => onOff(previewOptions.value.unretracts), run: () => toggleOption('unretracts') },
  { id: 'preview.toggle.seams', title: 'Show seams', category: CATEGORY, aliases: ['seam'], when: inPreview, state: () => onOff(previewOptions.value.seams), run: () => toggleOption('seams') },
  { id: 'preview.toggle.toolMarker', title: 'Show tool marker', category: CATEGORY, aliases: ['toolhead', 'nozzle marker'], when: inPreview, state: () => onOff(previewOptions.value.toolMarker), run: () => toggleOption('toolMarker') },
  { id: 'preview.toggle.singleLayer', title: 'Show only the current layer', category: CATEGORY, aliases: ['one layer', 'single layer', 'all layers'], when: hasData, state: () => onOff(singleLayer.value), run: () => setSingleLayer(!singleLayer.value) },
  { id: 'preview.toggle.dimBelow', title: 'Dim layers below top', category: CATEGORY, when: inPreview, state: () => onOff(previewOptions.value.dimBelow), run: () => toggleOption('dimBelow') },
  { id: 'preview.toggle.legend', title: 'Show legend', category: CATEGORY, binding: { key: 'l', scope: 'preview' }, when: inPreview, state: () => onOff(!legendCollapsed.value), run: () => { legendCollapsed.value = !legendCollapsed.value; } },
  { id: 'preview.toggle.gcode', title: 'Show G-code viewer', category: CATEGORY, aliases: ['gcode text', 'source'], binding: { key: 'g', scope: 'preview' }, when: inPreview, state: () => onOff(showGcodeViewer.value), run: () => { showGcodeViewer.value = !showGcodeViewer.value; } },
  // ---- colour schemes ----
  ...SCHEMES.map((s): PreviewAction => ({
    id: `preview.scheme.${s.id}`,
    title: `Colour by ${s.label.toLowerCase()}`,
    category: CATEGORY,
    aliases: ['color scheme', 'colour scheme', s.label],
    when: inPreview,
    state: () => (colorScheme.value === s.id ? 'active' : undefined),
    run: () => { colorScheme.value = s.id; },
  })),
  // ---- camera ----
  ...VIEWS.map((v): PreviewAction => ({
    id: `preview.view.${v.preset}`,
    title: v.title,
    category: CATEGORY,
    aliases: ['camera', v.preset],
    binding: { key: v.key, scope: 'preview' },
    when: inPreview,
    run: () => cameraCommand({ kind: 'view', preset: v.preset }),
  })),
  { id: 'preview.view.fit', title: 'Fit to print', category: CATEGORY, aliases: ['zoom to fit', 'frame'], binding: { key: 'f', scope: 'preview' }, when: inPreview, run: () => cameraCommand({ kind: 'fit' }) },
];

let dispose: (() => void) | null = null;
/** Register the preview actions with the app registry (idempotent). Returns a disposer. */
export function registerPreviewActions(): () => void {
  if (!dispose) dispose = registerActions(previewActions);
  return () => { dispose?.(); dispose = null; };
}

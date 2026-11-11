/**
 * Design tab commands in the action registry (menus, palette, keys, run_action). Keys are
 * scoped to the Design view (`scope: 'design'`), so Prepare's Delete / F2 / Esc keep their
 * meaning there. Orca's Design shortcuts kept: Ctrl+Shift+O origin planes, Ctrl+Shift+B bed,
 * Home fit, F2 rename, Del delete. Orca's Ctrl+Shift+P (Commit to Plate) is the command palette
 * here, so Commit is on the toolbar, the menus and the palette.
 */
import type { Action } from '../app/actions/types';
import { activeView } from '../app/state';
import { preferences } from '../app/preferences';
import { confirmAction } from '../app/shell/uiState';
import { getObject, selectedIds } from '../project/store';
import { toast } from '../ui';
import {
  clearDesign, commitCandidates, commitToPlate, deleteBody, deleteFeatures, editInDesign, moveFeature, selectAllFeatures, setSuppressed, unlinkObjects,
} from './commands';
import { design, designKernel, editBlocker, projectHasDesign, reopenDesign, setStatus } from './session';
import { clearDesignSelection, designUi } from './state';
import { designViewport } from './viewport';
import { cadUi } from '../cad/commands';
import { pickBodyColor } from './bodyColor';
import { cancelPick, finishPick, picking } from './pick';
import { cancelCard, card, checkInterference, confirmCard, openCard, toolAvailable } from './create';
import { CREATE_TOOLS } from './tools';
import type { KeyBinding } from '../app/actions/types';

const inDesign = () => activeView.value === 'design';
const editable = () => inDesign() && !editBlocker();
const sel = () => designUi.selected.filter((i) => design.features[i]);
const one = () => { const s = sel(); return s.length === 1 ? s[0] : null; };
const linkedSelection = () => selectedIds.value.map(getObject).filter((o) => !!o?.design || !!o?.parts?.some((p) => p.design));
const report = (p: Promise<unknown>) => { p.catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e))); };

/** Orca's feature keys (DesignPanel.cpp dropdown families), all Shift+letter in the Design view. */
const KEYS: Partial<Record<string, Omit<KeyBinding, 'scope'>>> = {
  extrude: { key: 'e', shift: true }, revolve: { key: 'r', shift: true }, sweep: { key: 'w', shift: true }, loft: { key: 'l', shift: true },
  fillet: { key: 'f', shift: true }, draft: { key: 'd', shift: true }, shell: { key: 'k', shift: true }, hole: { key: 'h', shift: true }, thread: { key: 't', shift: true },
  pattern: { key: 'n', shift: true }, mirror: { key: 'z', shift: true }, transform: { key: 'y', shift: true }, boolean: { key: 'b', shift: true }, cut: { key: 'x', shift: true },
  plane: { key: 'p', shift: true }, axis: { key: 'a', shift: true },
};
const ALIASES: Partial<Record<string, string[]>> = {
  fillet: ['round', 'chamfer', 'bevel', 'edge'], shell: ['hollow'], hole: ['drill', 'counterbore', 'countersink', 'bolt'], thread: ['screw', 'tap', 'metric'],
  pattern: ['array', 'repeat', 'circular', 'linear'], transform: ['move', 'rotate'], boolean: ['union', 'subtract', 'join', 'intersect', 'combine'],
  cut: ['split', 'slice'], plane: ['datum', 'reference plane'], axis: ['datum axis'], pushpull: ['press pull', 'extrude face', 'offset face'], deleteface: ['remove face', 'defeature'],
};

/** Orca's Section View (DesignPanel::toggle_section_view): on at the model's mid-height, keeping the lower half. */
function toggleSection(): void {
  if (designUi.section) { designUi.section = null; setStatus('info', 'Section view off'); return; }
  designUi.section = { z: designViewport()?.modelMidZ() ?? 0, upper: false };
  setStatus('info', 'Section view on — hides half the model to see inside; PageUp / PageDown move the plane, Flip shows the other half');
}
function flipSection(): void {
  const s = designUi.section;
  if (!s) return;
  designUi.section = { ...s, upper: !s.upper };
  setStatus('info', designUi.section.upper ? 'Section view — showing the upper half' : 'Section view — showing the lower half');
}
/** PageUp / PageDown: Orca moves the plane 2 mm a press. */
function moveSection(dz: number): void { if (designUi.section) designUi.section = { ...designUi.section, z: designUi.section.z + dz }; }
const sectionOn = () => inDesign() && !!designUi.section;

async function pickAndImport(accept: string, each: (f: File) => Promise<void>): Promise<void> {
  const { pickFiles } = await import('../app/shell/download');
  for (const f of await pickFiles(accept, false)) await each(f);
}

export function designActions(): Action[] {
  return [
    { id: 'view.design', title: 'Design', icon: 'i-lucide-pencil-ruler', category: 'View',
      description: 'The experimental Design tab: parametric CAD from OrcaSlicer 2.5.',
      aliases: ['cad', 'parametric', 'feature tree', 'orca design', 'switch view'],
      binding: { key: '3', ctrlOrMeta: true }, when: () => preferences.designTab, state: () => (inDesign() ? 'on' : 'off'),
      run: () => { activeView.value = 'design'; } },
    // Before select-none: Esc stops a long rebuild first.
    { id: 'design.cancel', title: 'Cancel rebuild', icon: 'i-lucide-circle-stop', category: 'Design', aliases: ['stop', 'abort'],
      binding: { key: 'escape', scope: 'design', passThroughWhenUnavailable: true },
      when: () => inDesign() && !!designKernel().status.busy?.cancellable, run: () => { designKernel().cancel(); } },
    { id: 'design.pick.cancel', title: 'Cancel picking', icon: 'i-lucide-x', category: 'Design', paletteHidden: true,
      binding: { key: 'escape', scope: 'design', passThroughWhenUnavailable: true }, when: () => inDesign() && !!picking.spec, run: () => cancelPick() },
    { id: 'design.pick.done', title: 'Done picking', icon: 'i-lucide-check', category: 'Design', paletteHidden: true,
      binding: { key: 'enter', scope: 'design', passThroughWhenUnavailable: true }, when: () => inDesign() && !!picking.spec, run: () => finishPick() },
    { id: 'design.card.cancel', title: 'Cancel feature', icon: 'i-lucide-x', category: 'Design', paletteHidden: true,
      binding: { key: 'escape', scope: 'design', passThroughWhenUnavailable: true }, when: () => inDesign() && !!card.tool && !picking.spec, run: () => cancelCard() },
    { id: 'design.card.confirm', title: 'Confirm feature', icon: 'i-lucide-check', category: 'Design',
      description: 'Add the feature of the open card (OK).',
      when: () => inDesign() && !!card.tool && !card.confirming, run: () => report(confirmCard().then((r) => { if (!r.ok) throw new Error(r.error); })) },
    ...CREATE_TOOLS.map((t): Action => ({
      id: `design.add.${t.id}`, title: `${t.title}…`, icon: t.icon, category: 'Design',
      description: t.hint, aliases: ['feature', 'add feature', t.id, ...(ALIASES[t.id] ?? [])],
      ...(KEYS[t.id] ? { binding: { ...KEYS[t.id]!, scope: 'design' } } : {}),
      when: () => inDesign() && design.phase === 'open' && !toolAvailable(t),
      run: () => report(openCard(t.id).then((e) => { if (e) throw new Error(e); })),
    })),
    { id: 'design.select-none', title: 'Clear design selection', icon: 'i-lucide-x', category: 'Design', paletteHidden: true,
      binding: { key: 'escape', scope: 'design', passThroughWhenUnavailable: true },
      when: () => inDesign() && !card.tool && !picking.spec && (designUi.selected.length > 0 || !!designUi.pick), run: () => clearDesignSelection() },
    { id: 'design.select-all', title: 'Select all features', icon: 'i-lucide-list-checks', category: 'Design',
      binding: { key: 'a', ctrlOrMeta: true, scope: 'design' }, when: () => inDesign() && design.features.length > 0, run: () => selectAllFeatures() },
    { id: 'design.feature.rename', title: 'Rename feature', icon: 'i-lucide-text-cursor-input', category: 'Design',
      binding: { key: 'f2', scope: 'design' }, when: () => editable() && one() !== null, run: () => { designUi.renaming = one(); } },
    { id: 'design.feature.suppress', title: 'Suppress', icon: 'i-lucide-eye-off', category: 'Design', aliases: ['hide feature', 'disable', 'unsuppress', 'show feature', 'enable'],
      dynamicTitle: () => (sel().every((i) => !design.features[i].enabled) ? `Unsuppress${sel().length > 1 ? ` ${sel().length} features` : ''}` : `Suppress${sel().length > 1 ? ` ${sel().length} features` : ''}`),
      dynamicIcon: () => (sel().every((i) => !design.features[i].enabled) ? 'i-lucide-eye' : 'i-lucide-eye-off'),
      description: 'Turn features off (Orca’s eye). Several at once rebuild once; on a design that doesn’t rebuild the toggle is kept anyway, to repair it.',
      when: () => editable() && sel().length > 0,
      run: () => { const s = sel(); report(setSuppressed(s, !s.every((i) => !design.features[i].enabled))); } },
    { id: 'design.feature.move-up', title: 'Move feature up', icon: 'i-lucide-arrow-up', category: 'Design',
      binding: { key: 'arrowup', alt: true, scope: 'design' }, when: () => editable() && (one() ?? 0) > 0, run: () => report(moveFeature(one()!, -1)) },
    { id: 'design.feature.move-down', title: 'Move feature down', icon: 'i-lucide-arrow-down', category: 'Design',
      binding: { key: 'arrowdown', alt: true, scope: 'design' }, when: () => editable() && one() !== null && one()! < design.features.length - 1,
      run: () => report(moveFeature(one()!, 1)) },
    { id: 'design.feature.delete', title: 'Delete feature', icon: 'i-lucide-trash-2', category: 'Design', tone: 'danger',
      dynamicTitle: () => (sel().length > 1 ? `Delete ${sel().length} features` : 'Delete feature'),
      binding: { key: 'delete', scope: 'design' }, when: () => editable() && sel().length > 0, run: () => report(deleteFeatures(sel())) },
    { id: 'design.feature.delete-backspace', title: 'Delete feature', icon: 'i-lucide-trash-2', category: 'Design', hidden: true, paletteHidden: true,
      binding: { key: 'backspace', scope: 'design' }, when: () => editable() && sel().length > 0, run: () => report(deleteFeatures(sel())) },
    { id: 'design.commit', title: 'Commit to plate', icon: 'i-lucide-send-to-back', category: 'Design',
      description: 'Send the design’s bodies to the plate as objects that follow later design edits.',
      aliases: ['send to prepare', 'to plate', 'design to object', 'add to plate'],
      // Orca's Ctrl+Shift+P is the command palette here (Speed Dial): Ctrl+Alt+P instead.
      binding: { key: 'p', ctrlOrMeta: true, alt: true, scope: 'design' },
      when: () => inDesign() && design.phase === 'open' && design.bodies.some((b) => b.face_count > 0),
      dynamicTitle: () => { const n = commitCandidates().length; return n > 1 ? `Commit ${n} bodies to plate` : 'Commit to plate'; },
      run: () => report(commitToPlate()) },
    { id: 'design.fit', title: 'Fit design', icon: 'i-lucide-scan', category: 'Design', aliases: ['home', 'zoom extents', 'iso view'],
      binding: { key: 'home', scope: 'design' }, when: () => inDesign(), run: () => designViewport()?.fitAll() },
    { id: 'design.fit-selection', title: 'Zoom to selection', icon: 'i-lucide-zoom-in', category: 'Design',
      binding: { key: 'z', scope: 'design' }, when: () => inDesign(), run: () => designViewport()?.fitSelection() },
    { id: 'design.toggle-origin', title: 'Show origin planes', icon: 'i-lucide-axis-3d', category: 'Design', aliases: ['reference planes', 'xy plane', 'datum'],
      binding: { key: 'o', ctrlOrMeta: true, shift: true, scope: 'design' }, when: () => inDesign(), state: () => (designUi.showOrigin ? 'on' : 'off'),
      run: () => { designUi.showOrigin = !designUi.showOrigin; } },
    { id: 'design.toggle-bed', title: 'Show bed', icon: 'i-lucide-grid-2x2', category: 'Design', aliases: ['plate', 'build plate'],
      binding: { key: 'b', ctrlOrMeta: true, shift: true, scope: 'design' }, when: () => inDesign(), state: () => (designUi.showBed ? 'on' : 'off'),
      run: () => { designUi.showBed = !designUi.showBed; } },
    { id: 'design.section', title: 'Section view', icon: 'i-lucide-square-split-vertical', category: 'Design', aliases: ['cut view', 'clipping', 'cross section', 'see inside'],
      description: 'Hide the half of the model above a horizontal plane to see inside (Orca’s Section View). PageUp / PageDown move the plane, F flips the half kept.',
      binding: { key: 'x', scope: 'design' }, when: () => inDesign() && design.phase === 'open', state: () => (designUi.section ? 'on' : 'off'), run: toggleSection },
    { id: 'design.section.flip', title: 'Flip section', icon: 'i-lucide-flip-vertical-2', category: 'Design', aliases: ['other half'],
      description: 'Show the opposite half of the section view.',
      binding: { key: 'f', scope: 'design', passThroughWhenUnavailable: true }, when: sectionOn, run: flipSection },
    { id: 'design.section.up', title: 'Move section plane up', icon: 'i-lucide-arrow-up', category: 'Design', paletteHidden: true,
      binding: { key: 'pageup', scope: 'design', passThroughWhenUnavailable: true }, when: sectionOn, run: () => moveSection(2) },
    { id: 'design.section.down', title: 'Move section plane down', icon: 'i-lucide-arrow-down', category: 'Design', paletteHidden: true,
      binding: { key: 'pagedown', scope: 'design', passThroughWhenUnavailable: true }, when: sectionOn, run: () => moveSection(-2) },
    { id: 'design.interference', title: 'Check interference', icon: 'i-lucide-boxes', category: 'Design', aliases: ['overlap', 'clash', 'collision', 'intersecting bodies'],
      description: 'Find bodies that overlap and report the shared volume of each pair (Orca’s Check interference). Changes nothing.',
      when: () => inDesign() && design.phase === 'open', run: () => report(checkInterference()) },
    { id: 'design.reopen', title: 'Reopen design', icon: 'i-lucide-refresh-cw', category: 'Design', aliases: ['reload design', 'retry'],
      when: () => inDesign() && (design.phase === 'closed' || design.phase === 'failed'), run: () => reopenDesign() },
    { id: 'design.clear', title: 'Clear design…', icon: 'i-lucide-eraser', category: 'Design', tone: 'danger', aliases: ['new design', 'erase design', 'delete design'],
      description: 'Erase every feature and body (Orca’s New Design). Committed plate objects stay as plain meshes. Undoable.',
      when: () => inDesign() && projectHasDesign() && !design.readOnly,
      run: async () => {
        if (await confirmAction({ title: 'Clear the design?', message: 'Erase all features and bodies of this project’s design. Objects already on the plate stay, as plain meshes. Ctrl+Z brings the design back.', confirmLabel: 'Clear design', danger: true, testId: 'design-clear' })) clearDesign();
      } },
    { id: 'design.import-step', title: 'Import STEP into the design…', icon: 'i-lucide-file-input', category: 'Design', aliases: ['step', 'stp', 'b-rep', 'open step', 'import body'],
      description: 'Open STEP solids as exact bodies of the design (Orca’s Import STEP).',
      when: () => preferences.designTab, run: () => report(pickAndImport('.step,.stp', async (f) => { const { importStepToDesign } = await import('./io'); const r = await importStepToDesign(f.name, new Uint8Array(await f.arrayBuffer())); if (!r.ok) throw new Error(`${f.name}: ${r.error}`); })) },
    { id: 'design.import-mesh', title: 'Import mesh into the design…', icon: 'i-lucide-box', category: 'Design', aliases: ['stl', 'obj', '3mf', 'mesh body'],
      description: 'Bring an STL / OBJ / 3MF mesh in as a design body (flat regions become faces; Orca’s Import mesh).',
      when: () => preferences.designTab, run: () => report(pickAndImport('.stl,.obj,.3mf', async (f) => {
        const [{ parseModelFile }, { importMeshToDesign }] = await Promise.all([import('../project/import'), import('./io')]);
        const res = await parseModelFile(f.name, await f.arrayBuffer());
        for (const o of res.objects) { const r = await importMeshToDesign(res.objects.length > 1 ? o.name : f.name, o.positions, o.indices); if (!r.ok) throw new Error(`${f.name}: ${r.error}`); }
      })) },
    { id: 'design.export-step', title: 'Export STEP…', icon: 'i-lucide-file-output', category: 'Design', aliases: ['step', 'stp', 'export body', 'b-rep'],
      description: 'Save the visible bodies as one STEP file (AP214, exact B-rep).',
      when: () => inDesign() && design.bodies.some((b) => b.face_count > 0), run: () => report(import('./io').then((m) => m.exportStepFile()).then((t) => toast.success(`Exported ${t}`))) },
    { id: 'design.palette', title: 'Add shape as a body…', icon: 'i-lucide-shapes', category: 'Design', paletteHidden: true, hidden: true,
      when: () => inDesign() && design.phase === 'open', run: () => { cadUi.paletteOpen = !cadUi.paletteOpen; } },
    { id: 'design.body.color', title: 'Body color…', icon: 'i-lucide-palette', category: 'Design', aliases: ['colour', 'paint body'],
      when: () => editable() && !!designUi.pick, run: () => pickBodyColor(designUi.pick!.body) },
    { id: 'design.body.delete', title: 'Delete body', icon: 'i-lucide-trash-2', category: 'Design', tone: 'danger', aliases: ['remove body'],
      description: 'Remove the feature the picked body was made from (Orca’s Delete Body). Ctrl+Z restores it.',
      when: () => editable() && designUi.pick?.kind === 'body' && !designUi.selected.length, run: () => report(deleteBody(designUi.pick!.body)) },
    { id: 'design.body.rename', title: 'Rename body', icon: 'i-lucide-text-cursor-input', category: 'Design',
      binding: { key: 'f2', scope: 'design' }, when: () => editable() && designUi.pick?.kind === 'body' && !designUi.selected.length,
      run: () => { designUi.renamingBody = designUi.pick!.body; } },
    // Prepare: a plate object committed from the design.
    { id: 'object.edit-design', title: 'Edit in Design', icon: 'i-lucide-pencil-ruler', category: 'Object', aliases: ['design body', 'parametric', 'source'],
      description: 'Open the Design tab on the body this object was committed from.',
      when: () => linkedSelection().length === 1 && selectedIds.value.length === 1, run: () => { editInDesign(selectedIds.value[0]); } },
    { id: 'object.unlink-design', title: 'Unlink from design', icon: 'i-lucide-unlink', category: 'Object', aliases: ['detach', 'stop following', 'plain mesh'],
      description: 'The object keeps its mesh but no longer follows design edits.',
      when: () => linkedSelection().length > 0, run: () => unlinkObjects(linkedSelection().map((o) => o!.id)) },
  ];
}

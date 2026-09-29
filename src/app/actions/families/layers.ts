import type { Action } from '../types';
import { activeView } from '../../state';
import { activePlate } from '../../../project/store';
import {
  addLayerRange, editObject, hasCustomProfile, layersUi, resetLayerProfile, runAdaptive, runSmooth, selectedRange,
} from '../../../layers/store';
import { openPlateSettings } from '../../../plates/ui';

// Orca: the "Variable layer height" main-toolbar button (no key in KBShortcutsDialog),
// the object right-click "Height range Modifier", and the plate "Plate settings…".
export function layerActions(): Action[] {
  const single = () => !!editObject.value;
  const editing = () => layersUi.editing && single();
  return [
    { id: 'layers.edit', title: 'Variable layer height', icon: 'i-lucide-layers-3', category: 'Object',
      aliases: ['layer editing', 'adaptive layer height', 'layer height profile', 'vlh'],
      when: (c) => c.view === 'prepare' && (layersUi.editing || !!c.selection.single),
      state: () => (layersUi.editing ? 'active' : undefined),
      run: () => { layersUi.editing = !layersUi.editing; } },
    { id: 'layers.adaptive', title: 'Variable layer height: Adaptive', icon: 'i-lucide-sparkles', category: 'Object',
      aliases: ['adaptive layers'], when: () => editing() && !layersUi.busy,
      run: () => runAdaptive(editObject.value!.id) },
    { id: 'layers.smooth', title: 'Variable layer height: Smooth', icon: 'i-lucide-waves', category: 'Object',
      when: () => editing() && !layersUi.busy, run: () => runSmooth(editObject.value!.id) },
    { id: 'layers.reset', title: 'Variable layer height: Reset', icon: 'i-lucide-rotate-ccw', category: 'Object',
      when: () => single() && hasCustomProfile(editObject.value), run: () => resetLayerProfile(editObject.value!.id) },
    { id: 'object.height-range', title: 'Height range modifier', icon: 'i-lucide-between-horizontal-start', category: 'Object',
      aliases: ['layer range', 'height range', 'layers', 'range modifier'],
      when: (c) => !!c.selection.single && activeView.value === 'prepare',
      run: (c) => {
        const id = c.selection.single!;
        const rid = addLayerRange(id);
        if (rid) { selectedRange.value = { objectId: id, rangeId: rid }; c.dispatch.perObjectSettings(); }
      } },
    { id: 'plate.settings', title: 'Plate settings…', icon: 'i-lucide-settings-2', category: 'Plate',
      aliases: ['plate type', 'bed type', 'print sequence', 'spiral vase', 'filament sequence'],
      run: () => openPlateSettings(activePlate.value) },
  ];
}

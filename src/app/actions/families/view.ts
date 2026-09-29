import { SNAP_OPTIONS } from '@cubby/shared/snap';
import type { Action } from '../types';
import type { ViewPreset } from '../../../viewport/controller';

// Orca: Tab Prepare/Preview, Shift+Tab collapse sidebar, 0-6 camera views (Orca uses Ctrl+0-6,
// which browsers reserve for tab switching; bare digits match the Preview's view keys),
// Z zoom to selection, I / O zoom in / out, K perspective / orthographic camera (Orca).
// Grid snap steps (@cubby/shared/snap, same list as CubbyCAD) are palette / menu only.
const preset = (p: ViewPreset, title: string, icon: string, key: string): Action => ({
  id: `view.camera.${p}`, title, icon, category: 'View', aliases: ['camera', 'view'],
  binding: { key, scope: 'prepare' }, when: (c) => c.view === 'prepare', run: (c) => c.dispatch.setView(p),
});

export function viewActions(): Action[] {
  const inPrepare = (c: { view: string }) => c.view === 'prepare';
  return [
    { id: 'view.prepare', title: 'Prepare', icon: 'i-lucide-box', category: 'View', aliases: ['plater', 'plate', 'switch view'],
      binding: { key: '1', ctrlOrMeta: true }, state: (c) => (c.view === 'prepare' ? 'on' : 'off'),
      run: (c) => c.dispatch.setActiveView('prepare') },
    { id: 'view.preview', title: 'Preview', icon: 'i-lucide-layers', category: 'View', aliases: ['toolpaths', 'layers', 'switch view'],
      binding: { key: '2', ctrlOrMeta: true }, state: (c) => (c.view === 'preview' ? 'on' : 'off'),
      run: (c) => c.dispatch.setActiveView('preview') },
    { id: 'view.toggle-view', title: 'Switch Prepare / Preview', icon: 'i-lucide-arrow-left-right', category: 'View', paletteHidden: true,
      binding: { key: 'tab', whenFocusIdle: true, passThroughWhenUnavailable: true },
      run: (c) => c.dispatch.setActiveView(c.view === 'prepare' ? 'preview' : 'prepare') },
    preset('iso', 'Default view', 'i-lucide-box', '0'),
    preset('top', 'Top view', 'i-lucide-square', '1'),
    preset('bottom', 'Bottom view', 'i-lucide-square-dashed', '2'),
    preset('front', 'Front view', 'i-lucide-panel-top', '3'),
    preset('back', 'Back view', 'i-lucide-panel-bottom', '4'),
    preset('left', 'Left view', 'i-lucide-panel-left', '5'),
    preset('right', 'Right view', 'i-lucide-panel-right', '6'),
    { id: 'view.fit-selection', title: 'Zoom to selection', icon: 'i-lucide-scan', category: 'View', aliases: ['fit selection', 'zoom to', 'focus', 'frame'],
      binding: { key: 'z', scope: 'prepare' }, when: inPrepare, run: (c) => c.dispatch.fitSelection() },
    { id: 'view.fit-plate', title: 'Zoom to plate', icon: 'i-lucide-fullscreen', category: 'View', aliases: ['fit plate', 'zoom out', 'frame bed'],
      binding: { key: 'z', shift: true, scope: 'prepare' }, when: inPrepare, run: (c) => c.dispatch.fitBed() },
    { id: 'view.zoom-in', title: 'Zoom in', icon: 'i-lucide-zoom-in', category: 'View',
      binding: { key: 'i', scope: 'prepare' }, when: inPrepare, run: (c) => c.dispatch.zoom(1) },
    { id: 'view.zoom-out', title: 'Zoom out', icon: 'i-lucide-zoom-out', category: 'View',
      binding: { key: 'o', scope: 'prepare' }, when: inPrepare, run: (c) => c.dispatch.zoom(-1) },
    { id: 'view.camera.perspective', title: 'Perspective camera', icon: 'i-lucide-view', category: 'View', aliases: ['3d', 'projection'],
      state: (c) => (c.cameraType === 'perspective' ? 'on' : 'off'), run: (c) => c.dispatch.setCameraType('perspective') },
    { id: 'view.camera.orthographic', title: 'Orthographic camera', icon: 'i-lucide-square', category: 'View', aliases: ['ortho', 'parallel', 'projection'],
      state: (c) => (c.cameraType === 'orthographic' ? 'on' : 'off'), run: (c) => c.dispatch.setCameraType('orthographic') },
    { id: 'view.camera.toggle-projection', title: 'Switch perspective / orthographic', icon: 'i-lucide-aperture', category: 'View',
      aliases: ['ortho', 'perspective', 'projection', 'camera type'], binding: { key: 'k', scope: 'prepare' }, when: inPrepare,
      run: (c) => c.dispatch.setCameraType(c.cameraType === 'perspective' ? 'orthographic' : 'perspective') },
    ...SNAP_OPTIONS.map((o): Action => ({
      id: `view.snap.${o.value}`, title: o.value ? `Grid snap ${o.label}` : 'Grid snap off', icon: 'i-lucide-magnet', category: 'View',
      aliases: ['snap', 'grid', 'increment'], state: (c) => (c.snapIncrement === o.value ? 'on' : 'off'),
      run: (c) => c.dispatch.setSnapIncrement(o.value),
    })),
    { id: 'view.panel.sidebar', title: 'Sidebar', icon: 'i-lucide-panel-left', category: 'View', aliases: ['settings panel', 'object list', 'collapse sidebar'],
      binding: { key: 'tab', shift: true, whenFocusIdle: true, passThroughWhenUnavailable: true },
      state: (c) => (c.sidebar ? 'on' : 'off'), run: (c) => c.dispatch.toggleSidebar() },
  ];
}

/**
 * Registry lint (mirrors cad-project's registry.lint.unit.test.ts):
 *  1. every layout id is registered;
 *  2. no duplicate ids;
 *  3. no two dispatching actions share a binding in an overlapping scope,
 *     unless the pair is on the documented allowlist (mutually exclusive `when`s);
 *  4. every non-hidden action is reachable from a menu, toolbar or the palette.
 */
import { describe, expect, it } from 'vitest';
import { buildActions } from './buildActions';
import { MENU_BAR, OBJECT_CONTEXT_MENU, PLATE_CONTEXT_MENU } from './layouts/menus';
import { PLATE_TOOLBAR } from './layouts/toolbar';
import { menuLayoutIds } from './project/menu';
import { toolbarLayoutIds } from './project/toolbar';
import { formatBinding } from './formatBinding';
import type { Action } from './types';
import { settingsActions } from '../../settings/actions';
import { previewActions } from '../../preview/actions';
import { printhostActions } from '../../printhost/actions';
import { bridgeActions } from '../../bridge/actions';

// Core actions plus every area's registered contributions, so ids/bindings
// are linted across the whole app, not just the shell.
const ACTIONS = [...buildActions(), ...(settingsActions as unknown as Action[]), ...(previewActions as unknown as Action[]), ...printhostActions, ...bridgeActions];
const IDS = new Set(ACTIONS.map((a) => a.id));

/** Same key, mutually exclusive `when` gates. First registered wins. */
const INTENTIONAL_OVERLAPS = new Set([
  // Esc: cancel a running slice > cancel lay-on-face picking > clear selection.
  'slice.cancel|edit.select-none',
  'slice.cancel|object.lay-on-face.cancel',
  'edit.select-none|object.lay-on-face.cancel',
  // … and close an open paint tool (before clearing the selection).
  'slice.cancel|paint.close',
  'paint.close|edit.select-none',
  'paint.close|object.lay-on-face.cancel',
]);

describe('action registry lint', () => {
  it('layouts reference only registered ids', () => {
    const referenced = [
      ...MENU_BAR.flatMap((m) => menuLayoutIds(m.layout)),
      ...menuLayoutIds(OBJECT_CONTEXT_MENU),
      ...menuLayoutIds(PLATE_CONTEXT_MENU),
      ...toolbarLayoutIds(PLATE_TOOLBAR),
    ];
    const missing = referenced.filter((id) => !IDS.has(id));
    expect(missing, `unregistered: ${missing.join(', ')}`).toEqual([]);
  });

  it('has unique ids', () => {
    const seen = new Set<string>();
    const dups = ACTIONS.filter((a) => (seen.has(a.id) ? true : (seen.add(a.id), false))).map((a) => a.id);
    expect(dups).toEqual([]);
  });

  it('has no conflicting key bindings', () => {
    const sig = (a: Action) => {
      const b = a.binding!;
      return `${b.code ?? b.key?.toLowerCase()}|${!!b.ctrlOrMeta}|${!!b.shift}|${!!b.alt}`;
    };
    const overlaps = (x: Action, y: Action) => {
      const sx = x.binding!.scope ?? 'global', sy = y.binding!.scope ?? 'global';
      return sx === 'global' || sy === 'global' || sx === sy;
    };
    const dispatching = ACTIONS.filter((a) => a.binding && !a.binding.displayOnly && (a.binding.key || a.binding.code));
    const conflicts: string[] = [];
    for (let i = 0; i < dispatching.length; i++) {
      for (let j = i + 1; j < dispatching.length; j++) {
        const a = dispatching[i], b = dispatching[j];
        if (sig(a) !== sig(b) || !overlaps(a, b)) continue;
        if (INTENTIONAL_OVERLAPS.has(`${a.id}|${b.id}`)) continue;
        conflicts.push(`${a.id} ↔ ${b.id} (${formatBinding(a.binding, 'other')})`);
      }
    }
    expect(conflicts).toEqual([]);
  });

  it('keeps the requested slice/view bindings', () => {
    const b = (id: string) => formatBinding(ACTIONS.find((a) => a.id === id)?.binding, 'other');
    expect(b('slice.run')).toBe('Ctrl+R');
    expect(b('slice.cancel')).toBe('Esc');
    expect(b('slice.export-gcode')).toBe('Ctrl+G');
    expect(b('slice.export-gcode-e')).toBe('Ctrl+E');
    expect(b('view.prepare')).toBe('Ctrl+1');
    expect(b('view.preview')).toBe('Ctrl+2');
    expect(b('help.palette')).toBe('Ctrl+K');
    expect(b('help.palette-alt')).toBe('Ctrl+Shift+P');
    // Orca KBShortcutsDialog.cpp: Ctrl+Shift+G = "Print plate" (send to the print host).
    expect(b('printer.print')).toBe('Ctrl+Shift+G');
  });

  it('follows OrcaSlicer\'s plater keys (KBShortcutsDialog.cpp)', () => {
    const b = (id: string) => formatBinding(ACTIONS.find((a) => a.id === id)?.binding, 'other');
    expect(b('arrange.all')).toBe('A');
    expect(b('arrange.plate')).toBe('Shift+A'); // Orca: "Arrange objects on selected plates"
    expect(b('edit.duplicate')).toBe('+');
    expect(b('edit.instance-remove')).toBe('-');
    expect(b('object.auto-orient')).toBe('Q');
    expect(b('plate.auto-orient-all')).toBe('Shift+Q');
    expect(b('object.gizmo.all')).toBe('G');
    expect(b('object.gizmo.move')).toBe('M');
    expect(b('object.gizmo.rotate')).toBe('R');
    expect(b('object.gizmo.scale')).toBe('S');
    expect(b('object.lay-on-face')).toBe('F');
    expect(b('object.toggle-printable')).toBe('V');
    expect(b('edit.redo')).toBe('Ctrl+Y');
    expect(b('edit.delete-all')).toBe('Ctrl+D');
    expect(b('edit.copy')).toBe('Ctrl+C');
    expect(b('edit.paste')).toBe('Ctrl+V');
    expect(b('view.toggle-view')).toBe('Tab');
    expect(b('view.panel.sidebar')).toBe('Shift+Tab');
    expect(b('view.camera.iso')).toBe('0');
    expect(b('view.camera.right')).toBe('6');
  });

  it('every visible action is reachable from some surface', () => {
    const onSurface = new Set([
      ...MENU_BAR.flatMap((m) => menuLayoutIds(m.layout)),
      ...menuLayoutIds(OBJECT_CONTEXT_MENU),
      ...toolbarLayoutIds(PLATE_TOOLBAR),
    ]);
    const orphans = ACTIONS.filter((a) => !a.hidden && a.paletteHidden && !onSurface.has(a.id) && !a.binding).map((a) => a.id);
    expect(orphans).toEqual([]);
  });
});

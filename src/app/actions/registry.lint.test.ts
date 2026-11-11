/**
 * Registry lint (mirrors cad-project's registry.lint.unit.test.ts):
 *  1. every layout id is registered;
 *  2. no duplicate ids;
 *  3. no two dispatching actions share a binding in an overlapping scope,
 *     unless the pair is on the documented allowlist (mutually exclusive `when`s);
 *  4. every non-hidden action is reachable from a menu, toolbar or the palette.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtinActions } from './buildActions';
import { MENU_BAR, OBJECT_CONTEXT_MENU, PLATE_CONTEXT_MENU } from './layouts/menus';
import { PLATE_TOOLBAR } from './layouts/toolbar';
import { menuLayoutIds } from './project/menu';
import { toolbarLayoutIds } from './project/toolbar';
import { formatBinding } from './formatBinding';
import { bindingConflicts } from './lint';
import { clearActions, getAction, getActionSource, getAllActions, registerActions, unregisterSource } from './registry';
import type { Action } from './types';

// Everything the app registers at boot (core + every area), so ids and
// bindings are linted across the whole app, not just the shell.
const ACTIONS = builtinActions();
const IDS = new Set(ACTIONS.map((a) => a.id));

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
    const conflicts = bindingConflicts(ACTIONS).map(([a, b]) => `${a.id} ↔ ${b.id} (${formatBinding(a.binding, 'other')})`);
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
    // Orca 2.5: Space opens the Speed Dial.
    expect(b('help.palette-space')).toBe('Space');
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

  it('keeps Orca\'s keys over CubbyCAD\'s modelling ones where they clash', () => {
    const b = (id: string) => formatBinding(ACTIONS.find((a) => a.id === id)?.binding, 'other');
    // CubbyCAD: Ctrl+G group, Ctrl+Shift+G ungroup, H hide, L lock. Here those are
    // Export G-code, Print plate, fuzzy-skin and support painting.
    for (const id of ['object.group', 'object.ungroup', 'object.toggle-locked', 'object.toggle-hidden', 'object.make-hole']) expect(b(id), id).toBe('');
    expect(b('paint.fuzzy')).toBe('H');
    expect(b('paint.support')).toBe('L');
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

  it('scopes tool panel keys through the registry (no panel listeners)', () => {
    const b = (id: string) => formatBinding(ACTIONS.find((a) => a.id === id)?.binding, 'other');
    expect(b('tool.close')).toBe('Esc');
    expect(b('tool.delete-selected')).toBe('Delete');
    expect(b('tool.confirm')).toBe('Enter');
    // Tool keys come before the slice / edit ones they shadow (first match wins).
    const at = (id: string) => ACTIONS.findIndex((a) => a.id === id);
    expect(at('tool.close')).toBeLessThan(at('slice.cancel'));
    expect(at('tool.delete-selected')).toBeLessThan(at('edit.delete'));
  });
});

describe('runtime registration (plugins)', () => {
  afterEach(() => { clearActions(); vi.restoreAllMocks(); });
  const plugin = { id: 'plugin:demo', name: 'Demo plugin' };
  const act = (id: string, extra: Partial<Action> = {}): Action => ({ id, title: id, category: 'Demo', run: () => {}, ...extra });

  it('tags actions with their source and disposes them as a set', () => {
    registerActions(builtinActions());
    const n = getAllActions().length;
    const dispose = registerActions([act('plugin.demo.a'), act('plugin.demo.b')], plugin);
    expect(dispose.ids).toEqual(['plugin.demo.a', 'plugin.demo.b']);
    expect(getActionSource('plugin.demo.a')).toEqual(plugin);
    expect(getActionSource('file.import')?.id).toBe('app');
    dispose();
    expect(getAllActions().length).toBe(n);
    registerActions([act('plugin.demo.c')], plugin);
    expect(unregisterSource('plugin:demo')).toBe(1);
    expect(getAction('plugin.demo.c')).toBeUndefined();
  });

  it('refuses ids owned by another source and malformed records', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerActions(builtinActions());
    const r = registerActions([act('file.import'), { id: '', title: 'x', category: 'Demo', run: () => {} }, act('plugin.demo.ok')], plugin);
    expect(r.refused).toEqual(['file.import', '']);
    expect(r.ids).toEqual(['plugin.demo.ok']);
    expect(getActionSource('file.import')?.id).toBe('app');
  });

  it('drops a plugin binding that collides with a live one (the lint rule, at runtime)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerActions(builtinActions());
    const r = registerActions([act('plugin.demo.save', { binding: { key: 's', ctrlOrMeta: true } }), act('plugin.demo.free', { binding: { key: 'j', alt: true } })], plugin);
    expect(r.unbound).toEqual(['plugin.demo.save']);
    expect(getAction('plugin.demo.save')?.binding).toBeUndefined();
    expect(getAction('plugin.demo.free')?.binding).toEqual({ key: 'j', alt: true });
    const all = getAllActions();
    expect(bindingConflicts(all)).toEqual([]);
  });

  it('upserts within a source; an old disposer no longer removes the replacement', () => {
    const first = registerActions([act('plugin.demo.a')], plugin);
    registerActions([act('plugin.demo.a', { title: 'New' })], plugin);
    first();
    expect(getAction('plugin.demo.a')?.title).toBe('New');
  });
});

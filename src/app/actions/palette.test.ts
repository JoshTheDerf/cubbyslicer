import { describe, expect, it } from 'vitest';
import { buildActions } from './buildActions';
import { projectPalette } from './project/palette';
import { projectMenu } from './project/menu';
import { EDIT_MENU, OBJECT_CONTEXT_MENU, OBJECT_MENU, VIEW_MENU } from './layouts/menus';
import { fixtureContext } from './testing/fixtureContext';

const ACTIONS = buildActions();

describe('palette projection', () => {
  it('omits unavailable and palette-hidden actions', () => {
    const items = projectPalette(ACTIONS, fixtureContext({ canUndo: false, selection: { count: 0, ids: [], single: null, allHidden: false, allNotPrintable: false } }), 'other');
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain('edit.undo');
    expect(ids).not.toContain('edit.delete');
    expect(ids).not.toContain('edit.redo-shift-z');
    expect(ids).toContain('file.import');
  });

  it('uses dynamic and toggle titles', () => {
    const items = projectPalette(ACTIONS, fixtureContext({ selection: { count: 1, ids: ['a'], single: 'a', allHidden: true, allNotPrintable: false } }), 'other');
    expect(items.find((i) => i.id === 'object.toggle-hidden')?.label).toBe('Show');
    expect(items.find((i) => i.id === 'view.panel.sidebar')?.label).toBe('Hide sidebar');
    expect(items.find((i) => i.id === 'view.preview')?.label).toBe('Go to Preview');
    expect(items.find((i) => i.id === 'edit.undo')?.label).toBe('Undo move');
  });
});

describe('palette labels for stateful actions', () => {
  const ctx = fixtureContext({});
  const mk = (id: string, title: string, on: boolean, aliases: string[] = []) =>
    ({ id, title, category: 'Preview', aliases, state: () => (on ? 'on' : 'off'), run: () => {} }) as unknown as (typeof ACTIONS)[number];
  const label = (a: (typeof ACTIONS)[number]) => projectPalette([a], ctx, 'other')[0];

  it('says what a toggle will do', () => {
    expect(label(mk('preview.toggle.travel', 'Show travel moves', true)).label).toBe('Hide travel moves');
    expect(label(mk('preview.toggle.travel', 'Show travel moves', false)).label).toBe('Show travel moves');
    expect(label(mk('preview.toggle.dimBelow', 'Dim layers below top', true)).label).toBe('Turn off dim layers below top');
    expect(label(mk('preview.toggle.dimBelow', 'Dim layers below top', true)).current).toBeUndefined();
  });

  it('marks the selected choice of a set instead of "Go to"', () => {
    const on = label(mk('settings.mode.simple', 'Simple settings mode', true));
    expect(on.label).toBe('Simple settings mode');
    expect(on.current).toBe(true);
    expect(label(mk('settings.mode.expert', 'Expert settings mode', false)).current).toBeUndefined();
  });

});

describe('menu projection', () => {
  it('projects labels, ✓ state, kbd chips and disabled gates', () => {
    const ctx = fixtureContext({ canRedo: false });
    const edit = projectMenu(ACTIONS, ctx, EDIT_MENU, { platform: 'other' });
    const undo = edit.find((i) => i.label === 'Undo move')!;
    expect(undo.kbds).toEqual(['Ctrl', 'Z']);
    expect(edit.find((i) => i.label === 'Redo')?.disabled).toBe(true);
    expect(edit.filter((i) => i.separator)).toHaveLength(EDIT_MENU.groups.length - 1);
    const obj = projectMenu(ACTIONS, ctx, OBJECT_MENU, { platform: 'other' });
    expect(obj.find((i) => i.label === 'Transform gizmo')?.children?.find((c) => c.label === 'Move')?.checked).toBe(true);
    const addPart = obj.find((i) => i.label === 'Add part or modifier')?.children?.find((c) => c.label === 'Add part');
    expect(addPart?.children?.map((c) => c.label)).toContain('Box');
    expect(obj.find((i) => i.label === 'Mirror')?.children).toHaveLength(3);
    const view = projectMenu(ACTIONS, ctx, VIEW_MENU, { platform: 'other' });
    expect(view.find((i) => i.label === 'Prepare')?.checked).toBe(true);
    expect(view.find((i) => i.label === 'Preview')?.checked).toBeUndefined();
  });

  it('context menus leave out what does not apply', () => {
    const labels = (items: ReturnType<typeof projectMenu>) => items.filter((i) => !i.separator).map((i) => i.label);
    const none = projectMenu(ACTIONS, fixtureContext({ selection: { ...fixtureContext().selection, count: 0 } }), OBJECT_CONTEXT_MENU);
    expect(none.some((i) => i.disabled)).toBe(false);
    expect(labels(none)).not.toContain('Delete');
    const one = projectMenu(ACTIONS, fixtureContext(), OBJECT_CONTEXT_MENU);
    expect(labels(one)).toContain('Delete');
    expect(one.some((i) => i.disabled)).toBe(false);
    expect(one[0].separator).toBeUndefined();
    expect(one.at(-1)?.separator).toBeUndefined();
  });

  it('runs the action on select', () => {
    const ctx = fixtureContext();
    const obj = projectMenu(ACTIONS, ctx, OBJECT_MENU, { platform: 'other' });
    obj.find((i) => i.label === 'Mirror')!.children!.find((c) => c.label === 'Mirror along Y')!.action!();
    expect(ctx.calls).toEqual(['mirror(1)']);
  });
});


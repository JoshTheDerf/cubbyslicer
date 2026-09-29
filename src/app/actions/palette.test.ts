import { describe, expect, it } from 'vitest';
import { buildActions } from './buildActions';
import { fuzzyScore, projectPalette, rankPalette, sectionPalette } from './project/palette';
import { projectMenu } from './project/menu';
import { EDIT_MENU, OBJECT_MENU, VIEW_MENU } from './layouts/menus';
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

describe('palette ranking', () => {
  const items = projectPalette(ACTIONS, fixtureContext({ slice: { available: true, busy: false, hasResult: true, stale: false } }), 'other');
  const top = (q: string, recent: string[] = []) => rankPalette(items, q, recent)[0]?.id;

  it('prefers label prefix matches', () => {
    expect(top('slice')).toBe('slice.run');
    expect(top('arr')).toBe('arrange.all');
    expect(top('undo')).toBe('edit.undo');
  });

  it('matches aliases and word initials', () => {
    expect(top('gcode')).toBe('slice.export-gcode');
    expect(rankPalette(items, 'flip').map((i) => i.id)).toContain('object.mirror.x');
    expect(rankPalette(items, 'ep3').map((i) => i.id)[0]).toBe('export.plate-3mf');
  });

  it('boosts recent commands', () => {
    const r = rankPalette(items, 'mirror', ['object.mirror.z']);
    expect(r[0].id).toBe('object.mirror.z');
    const empty = rankPalette(items, '', ['view.fit-plate', 'file.save']);
    expect(empty.slice(0, 2).map((i) => i.id)).toEqual(['view.fit-plate', 'file.save']);
    const sections = sectionPalette(items, ['file.save']);
    expect(sections[0]).toMatchObject({ id: 'recent' });
    expect(sections[0].items.map((i) => i.id)).toEqual(['file.save']);
  });

  it('returns nothing for gibberish', () => {
    expect(rankPalette(items, 'qqqzzz')).toEqual([]);
    expect(fuzzyScore('xyz', 'export').score).toBe(0);
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
    expect(obj.find((i) => i.label === 'Move')?.checked).toBe(true);
    expect(obj.find((i) => i.label === 'Mirror')?.children).toHaveLength(3);
    const view = projectMenu(ACTIONS, ctx, VIEW_MENU, { platform: 'other' });
    expect(view.find((i) => i.label === 'Prepare')?.checked).toBe(true);
    expect(view.find((i) => i.label === 'Preview')?.checked).toBeUndefined();
  });

  it('runs the action on select', () => {
    const ctx = fixtureContext();
    const obj = projectMenu(ACTIONS, ctx, OBJECT_MENU, { platform: 'other' });
    obj.find((i) => i.label === 'Mirror')!.children!.find((c) => c.label === 'Mirror along Y')!.action!();
    expect(ctx.calls).toEqual(['mirror(1)']);
  });
});

describe('fuzzy noise', () => {
  it('does not match scattered letters across unrelated words', () => {
    expect(fuzzyScore('mir', 'undo import cylinder.stl').score).toBe(0);
    expect(fuzzyScore('ep3', 'export plate as 3mf').score).toBeGreaterThan(0);
    expect(fuzzyScore('slce', 'slice plate').score).toBeGreaterThan(0);
  });
});

/**
 * The Speed Dial model against Orca 2.5.0's speeddial.js / ActionRegistry behaviour
 * (resources/web/dialog/SpeedDial/speeddial.js, src/slic3r/GUI/ActionRegistry.cpp).
 */
import { describe, expect, it } from 'vitest';
import { buildActions } from './buildActions';
import {
  actionCategory, actionEyebrow, actionLabels, commandList, completionFor, detailActionId, filterTabs, frecencySort, groupActions, markSegments,
  modeBadge, modeFilterFromQuery, needsModeSwitch, nextSel, parsePercent, phaseClickIgnored, phaseItems, plateItems, projectPalette, searchActions,
  selectedActionId, settingItems, spacerHeight, visibleFavourites, type PaletteItem, type SettingEntry,
} from './project/palette';
import { capFavourites, digitFromEvent, frecencyScore, parseStats, pinnedIndexForDigit, pinnedSlot, recentIds } from './recent';
import { fixtureContext } from './testing/fixtureContext';

const cmd = (id: string, label: string, group = 'Object', extra: Partial<PaletteItem> = {}): PaletteItem =>
  ({ id, label, category: group, group, kind: 'command', keywords: '', ...extra });
const setting = (key: string, label: string, page: string, group: string, extra: Partial<SettingEntry> = {}): SettingEntry =>
  ({ key, label, tab: 'process', pageTitle: page, groupTitle: group, ...extra });
const ids = (l: readonly { id: string }[]) => l.map((x) => x.id);

describe('Speed Dial search (searchActions)', () => {
  const pool = [
    cmd('a', 'Auto-Orient'),
    cmd('b', 'Arrange', 'Object'),
    cmd('c', 'Export G-code', 'Slice & Export'),
    cmd('d', 'Orient tools', 'Help'),
    ...settingItems([setting('inner_wall_acceleration', 'Inner wall', 'Speed', 'Acceleration'),
      setting('wall_loops', 'Wall loops', 'Strength', 'Walls', { mode: 'advanced' }),
      setting('xy_hole', 'X-Y hole compensation', 'Quality', 'Precision', { mode: 'expert', fullLabel: 'Hole size compensation' })], () => {}),
  ];

  it('ranks whole-word title hits by how early they start, and highlights the word, not a stray letter', () => {
    const r = searchActions(pool, 'orient');
    expect(ids(r.list).slice(0, 2)).toEqual(['d', 'a']);
    expect(r.matches.get('a')?.title).toEqual([[5, 11]]);
  });

  it('matches words spread over the title and the breadcrumb, after any single-field phrase', () => {
    const r = searchActions(pool, 'speed acceleration inner');
    expect(ids(r.list)).toEqual(['setting:inner_wall_acceleration']);
    const m = r.matches.get('setting:inner_wall_acceleration')!;
    expect(m.title).toEqual([[0, 5]]);
    expect(m.useEyebrowGroup).toBe(false);
    expect(m.source?.length).toBe(2);
  });

  it('a phrase in one field beats a match spread over fields', () => {
    const p = [cmd('x', 'Wall speed', 'Edit'), cmd('y', 'Speed', 'Wall')];
    expect(ids(searchActions(p, 'wall speed').list)).toEqual(['x', 'y']);
  });

  it('title outranks group, contiguous outranks fuzzy, ties sort by title', () => {
    const p = [cmd('g', 'Something', 'Plate'), cmd('t', 'Plate add', 'Edit'), cmd('f', 'Pl ate', 'Edit')];
    expect(ids(searchActions(p, 'plate').list)).toEqual(['t', 'g', 'f']);
    expect(ids(searchActions([cmd('2', 'Beta'), cmd('1', 'Alpha')], 'object').list)).toEqual(['1', '2']);
  });

  it('searches the full name and aliases but never highlights them', () => {
    const r = searchActions(pool, 'hole size');
    expect(ids(r.list)).toEqual(['setting:xy_hole']);
    expect(r.matches.get('setting:xy_hole')?.title).toBeNull();
    expect(ids(searchActions([cmd('k', 'Clone', 'Object', { keywords: 'duplicate copy' })], 'duplicate').list)).toEqual(['k']);
  });

  it('mode words also list every setting of that mode, after the text matches', () => {
    expect(modeFilterFromQuery('Expert wall')).toEqual(['expert']);
    expect(modeFilterFromQuery('developer')).toEqual(['develop']);
    expect(modeFilterFromQuery('simple')).toEqual([]);
    expect(ids(searchActions(pool, 'advanced').list)).toEqual(['setting:wall_loops']);
  });

  it('finds plugin commands by "plugin" and shows "Plugins" as their eyebrow', () => {
    const p = cmd('p', 'Inspector', '', { kind: 'plugin', source: 'Orca Inspector' });
    expect(ids(searchActions([p, cmd('q', 'Other')], 'plugin').list)).toEqual(['p']);
    expect(actionEyebrow(p, 'plugin', false)).toBe('Plugins');
    expect(actionEyebrow(p, '', false)).toBe('Orca Inspector');
    expect(actionCategory(p)).toBe('Plugins');
  });

  it('folds accents and case without shifting highlight offsets', () => {
    const r = searchActions([cmd('e', 'Évaluer la pièce')], 'piece');
    expect(r.matches.get('e')?.title).toEqual([[11, 16]]);
  });

  it('returns nothing for gibberish', () => {
    expect(searchActions(pool, 'qqqzzz').list).toEqual([]);
  });
});

describe('Speed Dial empty list (commandList / groupActions)', () => {
  it('lists Recent first, then the rest by category A→Z ignoring case, input order inside', () => {
    const items = [cmd('v1', 'Zoom', 'View'), cmd('e1', 'Undo', 'Edit'), cmd('v2', 'Fit', 'View'), cmd('x', 'Thing', 'alpha'),
      ...settingItems([setting('k', 'Layer height', 'Quality', 'Layer height')], () => {})];
    const out = commandList(items, [items[2]], '');
    expect(ids(out.list)).toEqual(['v2', 'x', 'e1', 'setting:k', 'v1']);
    expect([...out.sections]).toEqual([[0, 'Recent'], [1, 'alpha'], [2, 'Edit'], [3, 'Process'], [4, 'View']]);
    expect(out.recentCount).toBe(1);
    expect(groupActions([cmd('1', 'a', ''), cmd('2', 'b', 'B')]).map(actionCategory)).toEqual(['B', 'Other']);
  });

  it('a typed query has no sections', () => {
    expect(commandList([cmd('a', 'Undo', 'Edit')], [], 'undo').sections.size).toBe(0);
  });

  it('the pool is frecency-sorted, ties by title', () => {
    const now = Date.UTC(2026, 0, 31);
    const day = 86_400_000;
    const items = [cmd('a', 'Beta'), cmd('b', 'Alpha'), cmd('c', 'Gamma'), cmd('d', 'Delta')];
    const stats = { c: { count: 3, last: now - 30 * day }, d: { count: 2, last: now } };
    expect(ids(frecencySort(items, stats, now))).toEqual(['d', 'c', 'b', 'a']);
    expect(frecencyScore(stats.c, now)).toBeCloseTo(1.5);
    expect(frecencyScore(undefined, now)).toBe(0);
  });
});

describe('Speed Dial history (ActionRegistry stats / favourites)', () => {
  it('Recent = the last N launched, newest first', () => {
    const stats = { a: { count: 9, last: 10 }, b: { count: 1, last: 30 }, c: { count: 1, last: 20 }, z: { count: 1, last: 0 } };
    expect(recentIds(stats, 5)).toEqual(['b', 'c', 'a']);
    expect(recentIds(stats, 2)).toEqual(['b', 'c']);
    expect(recentIds(stats, 0)).toEqual([]);
    expect(recentIds(stats, 5, (id) => id !== 'c')).toEqual(['b', 'a']);
  });

  it('reads stored stats and migrates the old recent id list', () => {
    const s = parseStats(['x', 'y', 'x', 3], 100_000);
    expect(recentIds(s, 5)).toEqual(['x', 'y']);
    expect(parseStats({ a: { count: 2, last: 5 }, b: 'junk' })).toEqual({ a: { count: 2, last: 5 } });
  });

  it('caps and dedupes the pin list at 10', () => {
    expect(capFavourites([...'abcdefghijkl'.split(''), 'a'])).toHaveLength(10);
    expect(capFavourites(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('numbers the favourite slots 1–9 then 0, from the physical key', () => {
    expect([0, 8, 9, 10].map(pinnedSlot)).toEqual(['1', '9', '0', '']);
    expect(['1', '9', '0', 'x'].map(pinnedIndexForDigit)).toEqual([0, 8, 9, -1]);
    expect(digitFromEvent({ code: 'Digit1', key: '¡' })).toBe('1');
    expect(digitFromEvent({ code: 'Numpad0', key: 'Insert' })).toBe('0');
  });

  it('the bar shows only pins that resolve, once each', () => {
    expect(visibleFavourites(['a', 'gone', 'b', 'a'], (id) => id !== 'gone')).toEqual(['a', 'b']);
  });
});

describe('Speed Dial navigation (nextSel)', () => {
  it('wraps the list, enters the bar from the top, and moves within the bar', () => {
    expect(nextSel({ zone: 'list', i: 4 }, 'ArrowDown', 5, 0)).toEqual({ zone: 'list', i: 0 });
    expect(nextSel({ zone: 'list', i: 0 }, 'ArrowUp', 5, 0)).toEqual({ zone: 'list', i: 4 });
    expect(nextSel({ zone: 'list', i: 0 }, 'ArrowUp', 5, 3)).toEqual({ zone: 'fav', i: 0 });
    expect(nextSel({ zone: 'fav', i: 2 }, 'ArrowDown', 5, 3)).toEqual({ zone: 'list', i: 0 });
    expect(nextSel({ zone: 'fav', i: 2 }, 'ArrowRight', 5, 3)).toEqual({ zone: 'fav', i: 2 });
    expect(nextSel({ zone: 'fav', i: 0 }, 'ArrowLeft', 5, 3)).toEqual({ zone: 'fav', i: 0 });
    expect(nextSel({ zone: 'fav', i: 1 }, 'ArrowUp', 5, 3)).toEqual({ zone: 'fav', i: 1 });
    expect(nextSel({ zone: 'list', i: 2 }, 'ArrowLeft', 5, 3)).toEqual({ zone: 'list', i: 2 });
  });

  it('the footer follows the hovered entry, else the selection', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    expect(detailActionId(null, { zone: 'list', i: 1 }, list, ['f'])).toBe('b');
    expect(detailActionId('h', { zone: 'list', i: 1 }, list, ['f'])).toBe('h');
    expect(selectedActionId({ zone: 'fav', i: 0 }, list, ['f'])).toBe('f');
  });

  it('ignores the second click of a double-click that opened a phase', () => {
    expect(phaseClickIgnored(1000, 700)).toBe(true);
    expect(phaseClickIgnored(1300, 700)).toBe(false);
    expect(phaseClickIgnored(1000, 0)).toBe(false);
  });
});

describe('Speed Dial entries', () => {
  it('settings carry their breadcrumb, mode, and the reason a hidden one is hidden', () => {
    const s = settingItems([
      setting('a', 'Wall loops', 'Strength', 'Walls', { mode: 'advanced', tooltip: 'How many walls.', disabled: 'Needs walls.' }),
      setting('b', 'Hidden one', 'Quality', 'G', { hidden: '' }),
      setting('c', 'Hidden two', 'Quality', 'G', { hidden: 'Only with a brim.', tooltip: 'Tip.' }),
    ], () => {});
    expect(ids(s)).toEqual(['setting:a', 'setting:c']);
    expect(s[0]).toMatchObject({ source: 'Process : Strength : Walls', group: '', kind: 'setting', mode: 'advanced', description: 'Needs walls.\n\nHow many walls.' });
    expect(s[1].description).toBe('Only with a brim.\n\nTip.');
    expect(actionCategory(s[0])).toBe('Process');
    expect(actionEyebrow(s[0], '', false)).toBe('Process : Strength : Walls');
  });

  it('badges and asks for settings above the current mode', () => {
    expect(needsModeSwitch({ mode: 'expert' }, 'advanced')).toBe(true);
    expect(needsModeSwitch({ mode: 'simple' }, 'simple')).toBe(false);
    expect(needsModeSwitch({}, 'simple')).toBe(false);
    expect(modeBadge({ mode: 'expert' }, 'simple')).toBe('Expert');
    expect(modeBadge({ mode: 'advanced' }, 'expert')).toBe('');
  });

  it('one "Go to Plate N" per plate, and the two-phase commands', () => {
    const picked: number[] = [];
    const plates = plateItems(2, (i) => picked.push(i));
    expect(plates.map((p) => [p.label, p.group])).toEqual([['Go to Plate 1', 'Plate'], ['Go to Plate 2', 'Plate']]);
    plates[1].run!('');
    expect(picked).toEqual([1]);
    const got: Array<number | string> = [];
    const [layer, tab] = phaseItems((p) => got.push(p), (t) => got.push(t));
    expect([layer.input, tab.input, layer.group, tab.label]).toEqual(['percent', 'tab', 'Commands', 'Go to tab...']);
    layer.run!('42');
    tab.run!('view.preview');
    expect(got).toEqual([42, 'view.preview']);
  });

  it('accepts a layer percentage from 0 to 100 only', () => {
    expect(['50', ' 0 ', '100', '12.5'].map(parsePercent)).toEqual([50, 0, 100, 12.5]);
    expect(['', 'abc', '-1', '101'].map(parsePercent)).toEqual([null, null, null, null]);
  });

  it('the tab picker matches title or id', () => {
    const tabs = [{ id: 'view.prepare', title: 'Prepare' }, { id: 'view.preview', title: 'Preview' }];
    expect(ids(filterTabs(tabs, 'prv'))).toEqual(['view.preview']);
    expect(ids(filterTabs(tabs, ''))).toEqual(['view.prepare', 'view.preview']);
  });

  it('projects plugin commands as Orca plugin actions', () => {
    const actions = buildActions();
    const items = projectPalette(actions, fixtureContext(), 'other', (id) => (id === 'file.import' ? 'Some plugin' : undefined));
    const p = items.find((i) => i.id === 'file.import')!;
    expect(p).toMatchObject({ kind: 'plugin', group: '', source: 'Some plugin' });
    expect(items.find((i) => i.id === 'edit.undo')).toMatchObject({ kind: 'command', group: 'Edit' });
  });

  it('accessible names read "Title from Source" and tell twins apart', () => {
    const l = actionLabels([cmd('a', 'Fit', 'View'), cmd('b', 'Fit', 'view'), cmd('c', 'Undo', 'Edit')]);
    expect(l.get('a')).toBe('Fit from View (a)');
    expect(l.get('c')).toBe('Undo from Edit');
  });
});

describe('Speed Dial completion and rendering helpers', () => {
  it('completes the last word from the top results, title before breadcrumb', () => {
    const list = [cmd('a', 'Export G-code', 'Slice & Export'), ...settingItems([setting('k', 'Inner wall', 'Speed', 'Acceleration')], () => {})];
    expect(completionFor('exp', list)).toEqual({ suffix: 'ort', word: 'Export', id: 'a' });
    expect(completionFor('inner acc', list.slice(1))?.suffix).toBe('eleration');
    expect(completionFor('export', list)).toBeNull();
    expect(completionFor('  ', list)).toBeNull();
  });

  it('splits text at the match ranges', () => {
    expect(markSegments('Auto-Orient', [[5, 11]])).toEqual([{ t: 'Auto-', m: false }, { t: 'Orient', m: true }]);
    expect(markSegments('Plain', null)).toEqual([{ t: 'Plain', m: false }]);
  });

  it('reserves the height of rows and headers not rendered yet', () => {
    expect(spacerHeight(120, 50, 4, 2)).toBe(70 * 44 + 2 * 30);
    expect(spacerHeight(10, 50, 0, 0)).toBe(0);
  });
});

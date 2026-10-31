import { describe, expect, it } from 'vitest';
import { fixtureContext } from '../testing/fixtureContext';
import type { Action } from '../types';
import { projectToolbar, toolbarLayoutIds, type ToolbarLayout } from './toolbar';

const act = (id: string, on = false, when = true): Action => ({
  id, title: id.toUpperCase(), icon: `i-${id}`, category: 'Object', state: () => (on ? 'active' : undefined), when: () => when, run: () => {},
});
const LAYOUT: ToolbarLayout = {
  groups: [
    { label: 'A', items: ['a'] },
    { label: 'B', segmented: true, items: ['b', { menu: 'm', label: 'Menu', icon: 'i-menu', items: ['c', 'd'] }] },
  ],
};

describe('projectToolbar', () => {
  it('lists the ids inside menus', () => {
    expect(toolbarLayoutIds(LAYOUT)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a menu shows its active entry', () => {
    const [, g] = projectToolbar([act('a'), act('b'), act('c'), act('d', true)], fixtureContext(), LAYOUT);
    expect(g.segmented).toBe(true);
    const m = g.items[1];
    expect(m.children?.map((c) => c.id)).toEqual(['c', 'd']);
    expect(m).toMatchObject({ active: true, icon: 'i-d', label: 'Menu · D', disabled: false });
  });

  it('a menu is idle and disabled when all its entries are', () => {
    const [, g] = projectToolbar([act('c', false, false), act('d', false, false)], fixtureContext(), LAYOUT);
    expect(g.items[1]).toMatchObject({ active: false, icon: 'i-menu', label: 'Menu', disabled: true });
  });
});

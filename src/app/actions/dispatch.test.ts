import { beforeEach, describe, expect, it } from 'vitest';
import { actionMatchesKey, dispatchActionKey, setActionScope } from './dispatch';
import { buildActions } from './buildActions';
import { fixtureContext } from './testing/fixtureContext';
import { key } from './testing/keys';
import type { Action } from './types';

const ACTIONS = buildActions();

beforeEach(() => setActionScope('prepare'));

describe('actionMatchesKey', () => {
  const a = (binding: Action['binding']): Action => ({ id: 't', title: 't', category: 'Edit', binding, run: () => {} });
  it('is strict about unspecified modifiers', () => {
    expect(actionMatchesKey(a({ key: 'r' }), key('r'))).toBe(true);
    expect(actionMatchesKey(a({ key: 'r' }), key('r', { ctrl: true }))).toBe(false);
    expect(actionMatchesKey(a({ key: 'r', ctrlOrMeta: true }), key('r', { meta: true }))).toBe(true);
    expect(actionMatchesKey(a({ key: 'z', ctrlOrMeta: true }), key('Z', { ctrl: true, shift: true }))).toBe(false);
  });
  it('ignores Shift for shifted symbol keys', () => {
    expect(actionMatchesKey(a({ key: '?' }), key('?', { shift: true }))).toBe(true);
  });
  it('matches code bindings regardless of key', () => {
    expect(actionMatchesKey(a({ code: 'Numpad1' }), key('End', { code: 'Numpad1' }))).toBe(true);
  });
  it('never matches display-only bindings', () => {
    expect(actionMatchesKey(a({ key: 'd', displayOnly: true }), key('d'))).toBe(false);
  });
});

describe('dispatchActionKey', () => {
  it('runs the matching action', async () => {
    const ctx = fixtureContext();
    expect(await dispatchActionKey(key('a'), ACTIONS, ctx, { textInputFocused: false })).toBe(true);
    expect(ctx.calls).toEqual(['arrangeAll']);
  });

  it('Ctrl+R slices and Esc cancels while slicing (before clearing selection)', async () => {
    const ctx = fixtureContext({ slice: { available: true, busy: false, hasResult: false, stale: false } });
    await dispatchActionKey(key('r', { ctrl: true }), ACTIONS, ctx, { textInputFocused: false });
    expect(ctx.calls).toEqual(['slice']);
    const busy = fixtureContext({ slice: { available: true, busy: true, hasResult: false, stale: false } });
    await dispatchActionKey(key('Escape'), ACTIONS, busy, { textInputFocused: false });
    expect(busy.calls).toEqual(['cancelSlice']);
    const idle = fixtureContext();
    await dispatchActionKey(key('Escape'), ACTIONS, idle, { textInputFocused: false });
    expect(idle.calls).toEqual(['clearSelection']);
  });

  it('Esc cancels lay-on-face picking instead of clearing the selection', async () => {
    const ctx = fixtureContext({ layOnFace: true });
    await dispatchActionKey(key('Escape'), ACTIONS, ctx, { textInputFocused: false });
    expect(ctx.calls).toEqual(['toggleLayOnFace']);
  });

  it('preventDefaults a gated-off match but runs nothing', async () => {
    const ctx = fixtureContext({ canUndo: false });
    const e = key('z', { ctrl: true });
    expect(await dispatchActionKey(e, ACTIONS, ctx, { textInputFocused: false })).toBe(false);
    expect(e.prevented).toBe(true);
    expect(ctx.calls).toEqual([]);
  });

  it('lets Tab / Esc fall through when unavailable', async () => {
    const ctx = fixtureContext({ focusIdle: false, selection: { count: 0, ids: [], single: null, allHidden: false, allNotPrintable: false } });
    const tab = key('Tab');
    await dispatchActionKey(tab, ACTIONS, ctx, { textInputFocused: false });
    expect(tab.prevented).toBe(false);
    const esc = key('Escape');
    await dispatchActionKey(esc, ACTIONS, ctx, { textInputFocused: false });
    expect(esc.prevented).toBe(false);
  });

  it('Tab switches views when focus is idle', async () => {
    const ctx = fixtureContext({ focusIdle: true });
    await dispatchActionKey(key('Tab'), ACTIONS, ctx, { textInputFocused: false });
    expect(ctx.calls).toEqual(['setActiveView(preview)']);
  });

  it('Q auto-orients, Ctrl+G exports, arrows nudge (Shift = 1 mm)', async () => {
    const ctx = fixtureContext({ slice: { available: true, busy: false, hasResult: true, stale: false } });
    await dispatchActionKey(key('q'), ACTIONS, ctx, { textInputFocused: false });
    await dispatchActionKey(key('Q', { shift: true }), ACTIONS, ctx, { textInputFocused: false });
    await dispatchActionKey(key('g', { ctrl: true }), ACTIONS, ctx, { textInputFocused: false });
    await dispatchActionKey(key('ArrowLeft'), ACTIONS, ctx, { textInputFocused: false });
    await dispatchActionKey(key('ArrowUp', { shift: true }), ACTIONS, ctx, { textInputFocused: false });
    expect(ctx.calls).toEqual(['autoOrient(auto)', 'autoOrient(all)', 'exportGcode', 'nudge(-10,0)', 'nudge(0,1)']);
  });

  it('focus-idle bindings (Ctrl+C, arrows, Shift+Tab) keep their native meaning inside panels', async () => {
    const ctx = fixtureContext({ focusIdle: false, clipboard: true });
    for (const e of [key('c', { ctrl: true }), key('v', { ctrl: true }), key('ArrowDown'), key('Tab', { shift: true })]) {
      await dispatchActionKey(e, ACTIONS, ctx, { textInputFocused: false });
      expect(e.prevented).toBe(false);
    }
    expect(ctx.calls).toEqual([]);
    const idle = fixtureContext({ clipboard: true });
    await dispatchActionKey(key('c', { ctrl: true }), ACTIONS, idle, { textInputFocused: false });
    await dispatchActionKey(key('v', { ctrl: true }), ACTIONS, idle, { textInputFocused: false });
    await dispatchActionKey(key('Tab', { shift: true }), ACTIONS, idle, { textInputFocused: false });
    expect(idle.calls).toEqual(['copy', 'paste', 'toggleSidebar']);
  });

  it('leaves unbound keys alone', async () => {
    const e = key('q', { ctrl: true });
    expect(await dispatchActionKey(e, ACTIONS, fixtureContext(), { textInputFocused: false })).toBe(false);
    expect(e.prevented).toBe(false);
  });

  it('respects scope: Prepare-only keys do nothing in Preview', async () => {
    setActionScope('preview');
    const ctx = fixtureContext({ view: 'preview' });
    const e = key('m');
    await dispatchActionKey(e, ACTIONS, ctx, { textInputFocused: false });
    expect(ctx.calls).toEqual([]);
    await dispatchActionKey(key('2', { ctrl: true }), ACTIONS, ctx, { textInputFocused: false });
    await dispatchActionKey(key('1', { ctrl: true }), ACTIONS, ctx, { textInputFocused: false });
    expect(ctx.calls).toEqual(['setActiveView(preview)', 'setActiveView(prepare)']);
  });

  it('skips bare keys while typing but keeps Ctrl+S / Ctrl+K', async () => {
    const ctx = fixtureContext();
    await dispatchActionKey(key('a'), ACTIONS, ctx, { textInputFocused: true });
    await dispatchActionKey(key('z', { ctrl: true }), ACTIONS, ctx, { textInputFocused: true });
    expect(ctx.calls).toEqual([]);
    await dispatchActionKey(key('s', { ctrl: true }), ACTIONS, ctx, { textInputFocused: true });
    await dispatchActionKey(key('k', { meta: true }), ACTIONS, ctx, { textInputFocused: true });
    expect(ctx.calls).toEqual(['saveProject', 'openPalette']);
  });

  it('only modifier combos dispatch while a modal is open', async () => {
    const ctx = fixtureContext({ modalOpen: true });
    await dispatchActionKey(key('Delete'), ACTIONS, ctx, { textInputFocused: false });
    await dispatchActionKey(key('s', { ctrl: true }), ACTIONS, ctx, { textInputFocused: false });
    expect(ctx.calls).toEqual(['saveProject']);
  });
});

import { describe, expect, it } from 'vitest';
import { LEGACY_SLOT, MAX_ORPHANS, ORPHAN_MAX_AGE_MS, planSlots, slotKey, type SlotMeta } from './slots';

const NOW = 1_000_000_000_000;
const slot = (key: string, ageMin: number, objects = 1): SlotMeta => ({ key, editedAt: NOW - ageMin * 60_000, objects });

describe('planSlots', () => {
  it('restores its own slot on reload', () => {
    const p = planSlots([slot('tab:a', 5), slot('tab:b', 1)], { id: 'a', clonedFrom: null }, new Set(['a', 'b']), NOW);
    expect(p).toEqual({ restore: 'tab:a', adopt: false, prune: [] });
  });

  it('copies the source slot in a duplicated tab', () => {
    const p = planSlots([slot('tab:a', 5)], { id: 'c', clonedFrom: 'a' }, new Set(['a', 'c']), NOW);
    expect(p).toEqual({ restore: 'tab:a', adopt: false, prune: [] });
  });

  it('adopts the newest orphan in a new tab, never an open tab’s slot', () => {
    const p = planSlots([slot('tab:open', 0), slot('tab:closed1', 30), slot('tab:closed2', 10)], { id: 'new', clonedFrom: null }, new Set(['open', 'new']), NOW);
    expect(p.restore).toBe('tab:closed2');
    expect(p.adopt).toBe(true);
    expect(p.prune).toEqual([]);
  });

  it('picks up the pre-tabs slot', () => {
    const p = planSlots([slot(LEGACY_SLOT, 60)], { id: 'new', clonedFrom: null }, new Set(['new']), NOW);
    expect(p).toEqual({ restore: LEGACY_SLOT, adopt: true, prune: [] });
  });

  it('skips empty orphans and prunes them', () => {
    const p = planSlots([slot('tab:empty', 1, 0), slot('tab:full', 20)], { id: 'n', clonedFrom: null }, new Set(['n']), NOW);
    expect(p.restore).toBe('tab:full');
    expect(p.prune).toEqual(['tab:empty']);
  });

  it('starts empty when every slot belongs to an open tab', () => {
    const p = planSlots([slot('tab:a', 1), slot('tab:b', 2)], { id: 'n', clonedFrom: null }, new Set(['a', 'b', 'n']), NOW);
    expect(p).toEqual({ restore: null, adopt: false, prune: [] });
  });

  it('keeps a bounded number of recent orphans', () => {
    const slots = Array.from({ length: MAX_ORPHANS + 3 }, (_, i) => slot(`tab:o${i}`, i + 1));
    slots.push(slot('tab:old', ORPHAN_MAX_AGE_MS / 60_000 + 1));
    const p = planSlots(slots, { id: 'n', clonedFrom: null }, new Set(['n']), NOW);
    expect(p.restore).toBe('tab:o0');
    expect(p.prune).toEqual(['tab:o9', 'tab:o10', 'tab:old']);
  });

  it('without Web Locks: restores the newest slot but neither adopts nor prunes recent ones', () => {
    const p = planSlots([slot('tab:a', 5), slot('tab:b', 1), slot('tab:old', ORPHAN_MAX_AGE_MS / 60_000 + 1)], { id: 'n', clonedFrom: null }, null, NOW);
    expect(p).toEqual({ restore: 'tab:b', adopt: false, prune: ['tab:old'] });
  });

  it('slot keys are per tab', () => { expect(slotKey('x')).toBe('tab:x'); });
});

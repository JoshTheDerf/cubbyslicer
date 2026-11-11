import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArrangeArgs, ArrangeResult, FlatConfig, SliceObjectInput } from '../../engine/types';

const engine = vi.hoisted(() => ({ orcaArrange: vi.fn<(c: FlatConfig, o: SliceObjectInput[], a: ArrangeArgs) => Promise<ArrangeResult>>() }));
const toasts = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock('../../engine/client', () => engine);
vi.mock('../../ui', () => ({ toast: toasts }));
vi.mock('../../presets/store', () => ({ currentPresets: { value: { infos: { value: { printer: { vendor: 'BBL' } } } } } }));

import * as S from '../../project/store';
import { activeEngine, resolvedConfig } from '../state';
import { DEFAULT_ARRANGE_SETTINGS, arrangeSettings } from '../arrangeSettings';
import { weldVertices, recenter } from '../../project/mesh';
import { cubeSoup } from '../../project/testutil';
import { arrangeSeqPrint, runArrange } from './arrange';
import { ui } from './uiState';

function cube(name: string) {
  const w = weldVertices(cubeSoup(20), null);
  recenter(w.positions);
  return { name, positions: w.positions, indices: w.indices, transform: null };
}

const placeAll = (_c: FlatConfig, objs: SliceObjectInput[]): Promise<ArrangeResult> => Promise.resolve({
  items: objs.map((_, i) => ({ moved: true as const, plate: 0, x: 30 + i * 40, y: 30, dRot: 0 })),
  plates: 1, unplaced: [], warnings: [], order: [], seqPrint: false,
});

beforeEach(() => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  activeEngine.value = 'orca';
  Object.assign(arrangeSettings, structuredClone(DEFAULT_ARRANGE_SETTINGS));
  S.resetProject();
  engine.orcaArrange.mockReset().mockImplementation(placeAll);
  for (const f of Object.values(toasts)) f.mockReset();
});

describe('runArrange', () => {
  it('sends the project and the arrange options to the engine and applies the result', async () => {
    const [a, b] = S.addParsedObjects([cube('A'), cube('B')]);
    arrangeSettings.fff = { distance: 4, enableRotation: true };
    const out = await runArrange('all');
    expect(out).toEqual({ moved: 2, unplaced: 0, imex: false });
    const [config, objs, args] = engine.orcaArrange.mock.calls[0];
    expect(config.printable_area).toBe('0x0,220x0,220x220,0x220');
    expect(objs.map((o) => o.id)).toEqual([a, b]);
    expect(args).toMatchObject({ mode: 'all', currentPlate: 0, bbl: true, settings: { distance: 4, enableRotation: true } });
    expect(args.items).toHaveLength(2);
    expect(args.plates).toEqual([{ locked: false, seq: '', toolChanges: [], imexMode: '' }]);
    expect(S.getObject(a)!.position.slice(0, 2)).toEqual([30, 30]);
    expect(S.getObject(b)!.position.slice(0, 2)).toEqual([70, 30]);
    expect(S.historyState.value.undo).toBe('Arrange');
    expect(ui.busy).toBeFalsy();
  });

  it('uses one run\'s overrides and marks the given ids as the selection', async () => {
    const [, b] = S.addParsedObjects([cube('A'), cube('B')]);
    await runArrange('selection', { ids: [b], distance: -3, enableRotation: false });
    const args = engine.orcaArrange.mock.calls[0][2];
    expect(args.mode).toBe('selection');
    expect(args.settings).toMatchObject({ distance: 0, enableRotation: false });
    expect(args.items.map((i) => i.selected)).toEqual([false, true]);
  });

  it('arranges everything when "selection" has nothing selected', async () => {
    S.addParsedObjects([cube('A')], { select: false });
    await runArrange('selection');
    expect(engine.orcaArrange.mock.calls[0][2].mode).toBe('all');
  });

  it('does nothing on an empty project', async () => {
    expect(await runArrange('all')).toBeNull();
    expect(engine.orcaArrange).not.toHaveBeenCalled();
  });

  it('runs one arrange at a time', async () => {
    S.addParsedObjects([cube('A')]);
    const first = runArrange('all');
    const second = runArrange('plate');
    expect(second).toBe(first);
    await first;
    expect(engine.orcaArrange).toHaveBeenCalledTimes(1);
  });

  it('reports engine failures without changing the project', async () => {
    const [a] = S.addParsedObjects([cube('A')]);
    const before = [...S.getObject(a)!.position];
    engine.orcaArrange.mockRejectedValueOnce(new Error('boom'));
    expect(await runArrange('all')).toBeNull();
    expect(toasts.error).toHaveBeenCalledWith("Couldn't arrange.", { detail: 'boom' });
    expect(S.getObject(a)!.position).toEqual(before);
    expect(ui.busy).toBeFalsy();
  });

  it('warns about unplaced items and passes engine warnings on', async () => {
    S.addParsedObjects([cube('A')]);
    engine.orcaArrange.mockResolvedValueOnce({ items: [{ moved: false }], plates: 1, unplaced: ['A'], warnings: ['Heads up\nmore'], order: [], seqPrint: false });
    expect(await runArrange('all')).toEqual({ moved: 0, unplaced: 1, imex: false });
    expect(toasts.warn).toHaveBeenCalledWith('Heads up', { detail: 'more' });
    expect(toasts.warn).toHaveBeenCalledWith(expect.stringContaining('unpacked items'), { detail: 'Placed beside the plates: A' });
  });

  it('an IDEX/IQEX zone arrange explains unplaced parts by the zone', async () => {
    S.addParsedObjects([cube('A')]);
    engine.orcaArrange.mockResolvedValueOnce({ items: [{ moved: false }], plates: 1, unplaced: ['A'], warnings: [], order: [], seqPrint: false, imex: true });
    expect(await runArrange('all')).toEqual({ moved: 0, unplaced: 1, imex: true });
    expect(toasts.warn).toHaveBeenCalledWith(expect.stringContaining('first head'), expect.objectContaining({ detail: expect.stringContaining('A') }));
  });

  it('gives preFlight\'s bed and print sequence in Orca\'s terms', async () => {
    S.addParsedObjects([cube('A')]);
    activeEngine.value = 'preflight';
    resolvedConfig.value = { bed_shape: '0x0,200x0,200x180,0x180', complete_objects: '1', max_print_height: '150' };
    await runArrange('all');
    const config = engine.orcaArrange.mock.calls[0][0];
    expect(config.printable_area).toEqual(['0x0', '200x0', '200x180', '0x180']);
    expect(config.print_sequence).toBe('by object');
  });
});

describe('arrangeSeqPrint', () => {
  it('is on for by-object printing in either engine\'s keys', () => {
    expect(arrangeSeqPrint({ print_sequence: 'by object' })).toBe(true);
    expect(arrangeSeqPrint({ complete_objects: ['1'] })).toBe(true);
    expect(arrangeSeqPrint({ print_sequence: 'by layer' })).toBe(false);
    expect(arrangeSeqPrint({})).toBe(false);
  });
});

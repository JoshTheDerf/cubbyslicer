/** Test fixture: a plain AppContext with vi.fn()-style dispatch stubs. */
import type { ActionDispatch, AppContext } from '../context';

export function fixtureContext(over: Partial<Omit<AppContext, 'dispatch'>> = {}, dispatch: Partial<ActionDispatch> = {}): AppContext & { calls: string[] } {
  const calls: string[] = [];
  const d = new Proxy(dispatch as ActionDispatch, {
    get: (t, k: string) => (t as unknown as Record<string, unknown>)[k] ?? ((...args: unknown[]) => { calls.push(args.length ? `${k}(${args.join(',')})` : k); }),
  });
  return {
    view: 'prepare',
    objectCount: 2,
    selection: { count: 1, ids: ['a'], single: 'a', allHidden: false, allNotPrintable: false },
    canUndo: true,
    canRedo: false,
    undoLabel: 'Move',
    redoLabel: null,
    gizmo: 'translate',
    layOnFace: false,
    cameraType: 'perspective',
    snapIncrement: 0,
    sidebar: true,
    clipboard: false,
    orienting: false,
    slice: { available: true, busy: false, hasResult: false, stale: false, slicedPlates: 0 },
    plates: { count: 1, active: 0, locked: false, activeObjects: 2 },
    modalOpen: false,
    focusIdle: true,
    ...over,
    dispatch: d,
    calls,
  };
}

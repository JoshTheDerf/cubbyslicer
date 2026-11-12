import { beforeEach, describe, expect, it, vi } from 'vitest';

// A localStorage that outlives module reloads (a page reload, for the dock layout).
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
});
const load = async () => { vi.resetModules(); return import('./dockLayout'); };

describe('plugin dock layout (Orca create_dock_panel / add_dock_pane)', () => {
  beforeEach(() => store.clear());

  it('opens where the plugin asks: side and size from width, bottom from height, float, right by default', async () => {
    const d = await load();
    d.openPane(1, 'p', 'A', 'left', 300, 480);
    d.openPane(2, 'p', 'B', 'bottom', 300, 240);
    d.openPane(3, 'p', 'C', 'float', 300, 480);
    d.openPane(4, 'p', 'D', 'top', 0, 0);
    expect(d.panes[1]).toMatchObject({ dock: 'left', side: 'left', size: 300, name: 'plugin:p:A' });
    expect(d.panes[2]).toMatchObject({ dock: 'bottom', size: 240 });
    expect(d.panes[3]).toMatchObject({ dock: 'float', side: 'right' });
    expect(d.panes[4]).toMatchObject({ dock: 'right', size: d.DOCK_MIN });
  });

  it('names panes as Orca does, unique among open ones', async () => {
    const d = await load();
    d.openPane(1, 'k', 'a|b;c', 'right', 320, 480);
    d.openPane(2, 'k', 'a|b;c', 'right', 320, 480);
    expect([d.panes[1].name, d.panes[2].name]).toEqual(['plugin:k:a_b_c', 'plugin:k:a_b_c#2']);
    expect(d.dockedOn('right')).toEqual([1, 2]);
    d.setPaneShown(1, false);
    expect(d.dockedOn('right')).toEqual([2]);
  });

  it('remembers side, dock size and floating frame by pane name across a reload', async () => {
    let d = await load();
    d.openPane(7, 'p', 'Panel', 'right', 320, 480);
    d.setDockSize('right', 410);
    d.setPaneDock(7, 'float', { x: 10, y: 20, w: 300, h: 400 });
    d.closePane(7);
    d = await load();
    d.openPane(9, 'p', 'Panel', 'right', 320, 480);
    expect(d.panes[9]).toMatchObject({ dock: 'float', side: 'right', size: 410, float: { x: 10, y: 20, w: 300, h: 400 } });
    d.setPaneDock(9, 'left');
    d = await load();
    d.openPane(1, 'p', 'Panel', 'right', 320, 480);
    expect(d.panes[1]).toMatchObject({ dock: 'left', side: 'left', size: 410 });
  });

  it('Reset window layout docks floating panes on their side', async () => {
    const d = await load();
    d.openPane(1, 'p', 'A', 'bottom', 320, 200);
    d.setPaneDock(1, 'float');
    d.redockFloatingPanes();
    expect(d.panes[1].dock).toBe('bottom');
  });

  it('a dock size applies to every pane in that dock and is never below the minimum', async () => {
    const d = await load();
    d.openPane(1, 'p', 'A', 'left', 320, 480);
    d.openPane(2, 'p', 'B', 'left', 280, 480);
    d.openPane(3, 'p', 'C', 'right', 280, 480);
    d.setDockSize('left', 50);
    expect([d.panes[1].size, d.panes[2].size, d.panes[3].size]).toEqual([d.DOCK_MIN, d.DOCK_MIN, 280]);
  });
});

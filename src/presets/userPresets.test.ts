import { describe, expect, it } from 'vitest';
import { memoryKv, openKv, resilient, type KvBackend } from './kv';
import { PresetNameError, toOrcaJson, UserPresetStore } from './userPresets';

const broken: KvBackend = {
  kind: 'indexeddb',
  getAll: async () => { throw new Error('storage disabled'); },
  set: async () => { throw new Error('storage disabled'); },
  delete: async () => { throw new Error('storage disabled'); },
};

describe('UserPresetStore', () => {
  it('works when storage is unavailable (falls back to memory)', async () => {
    const s = new UserPresetStore('orca', resilient(broken));
    await s.ready;
    const p = s.create({ kind: 'filament', name: 'My PLA', parentId: 'sys:X/PLA', inherits: 'PLA', values: { nozzle_temperature: ['220'] } });
    expect(s.get(p.id)?.values).toEqual({ nozzle_temperature: ['220'] });
    expect(s.storageKind).toBe('memory');
  });

  it('works when the storage backend itself rejects on open', async () => {
    const s = new UserPresetStore('orca', Promise.reject(new Error('no idb')));
    await s.ready;
    s.create({ kind: 'process', name: 'Fast', values: { layer_height: '0.3' } });
    expect(s.byKind('process')).toHaveLength(1);
  });

  it('opens a backend in a bare environment (no indexedDB / localStorage)', async () => {
    const kv = await openKv();
    await kv.set('k', { a: 1 });
    expect(await kv.getAll('k')).toEqual([['k', { a: 1 }]]);
  });

  it('supports create / update / rename / delete with name validation', async () => {
    const kv = memoryKv();
    const s = new UserPresetStore('orca', kv);
    await s.ready;
    const a = s.create({ kind: 'process', name: 'A', values: { wall_loops: '3' } });
    expect(() => s.create({ kind: 'process', name: 'A', values: {} })).toThrow(PresetNameError);
    expect(() => s.create({ kind: 'process', name: '  ', values: {} })).toThrow(PresetNameError);
    // same name in another kind is fine
    s.create({ kind: 'filament', name: 'A', values: {} });
    expect(s.uniqueName('process', 'A')).toBe('A (2)');

    s.update(a.id, { values: { wall_loops: '4' } });
    expect(s.get(a.id)?.values.wall_loops).toBe('4');
    const b = s.create({ kind: 'process', name: 'B', values: {} });
    expect(() => s.rename(b.id, 'A')).toThrow(PresetNameError);
    s.rename(a.id, 'A2');
    expect(s.findByName('process', 'A2')?.id).toBe(a.id);

    // persisted — a fresh store over the same backend sees it
    const again = new UserPresetStore('orca', kv);
    await again.ready;
    expect(again.findByName('process', 'A2')?.values.wall_loops).toBe('4');
    expect(new Set(again.list.value.map((p) => p.engine))).toEqual(new Set(['orca']));

    s.remove(a.id);
    expect(s.get(a.id)).toBeUndefined();
    const third = new UserPresetStore('orca', kv);
    await third.ready;
    expect(third.findByName('process', 'A2')).toBeUndefined();
    // engines are isolated
    const pf = new UserPresetStore('preflight', kv);
    await pf.ready;
    expect(pf.list.value).toHaveLength(0);
  });

  it('exports Orca user preset JSON', () => {
    const j = toOrcaJson('filament', 'My PLA', { nozzle_temperature: ['220'] }, 'Generic PLA @System');
    expect(j).toEqual({
      type: 'filament', name: 'My PLA', from: 'User', instantiation: 'true', inherits: 'Generic PLA @System',
      nozzle_temperature: ['220'], filament_settings_id: ['My PLA'],
    });
  });
});

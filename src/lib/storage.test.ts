import { afterEach, describe, expect, it } from 'vitest';
import { hasKey, readJson, readString, removeKey, storageKeys, webStorage, writeJson, writeString } from './storage';

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

const g = globalThis as Record<string, unknown>;
const saved = { local: Object.getOwnPropertyDescriptor(g, 'localStorage'), session: Object.getOwnPropertyDescriptor(g, 'sessionStorage') };
function install(local: unknown, session: unknown = new MemStorage()): void {
  Object.defineProperty(g, 'localStorage', { configurable: true, get: () => { if (local instanceof Error) throw local; return local; } });
  Object.defineProperty(g, 'sessionStorage', { configurable: true, get: () => session });
}
afterEach(() => {
  for (const [k, d] of [['localStorage', saved.local], ['sessionStorage', saved.session]] as const) {
    if (d) Object.defineProperty(g, k, d); else delete g[k];
  }
});

describe('storage', () => {
  it('round-trips strings and JSON', () => {
    install(new MemStorage());
    expect(writeString('a', 'x')).toBe(true);
    expect(readString('a')).toBe('x');
    expect(writeJson('j', { n: 1, l: [true] })).toBe(true);
    expect(readJson<{ n: number }>('j')).toEqual({ n: 1, l: [true] });
    expect(hasKey('j')).toBe(true);
  });
  it('null for missing, empty and corrupt values', () => {
    install(new MemStorage());
    expect(readJson('none')).toBeNull();
    writeString('empty', '');
    expect(readJson('empty')).toBeNull();
    writeString('bad', '{nope');
    expect(readJson('bad')).toBeNull();
  });
  it('keeps local and session apart', () => {
    install(new MemStorage(), new MemStorage());
    writeJson('k', 1, 'session');
    expect(readJson('k')).toBeNull();
    expect(readJson('k', 'session')).toBe(1);
  });
  it('remove / keys', () => {
    install(new MemStorage());
    writeString('p:1', 'a'); writeString('p:2', 'b'); writeString('q', 'c');
    expect(storageKeys('p:').sort()).toEqual(['p:1', 'p:2']);
    expect(removeKey('p:1')).toBe(true);
    expect(removeKey('p:1')).toBe(false);
    expect(storageKeys().sort()).toEqual(['p:2', 'q']);
  });
  it('never throws when storage is missing, blocked or full', () => {
    install(undefined);
    expect(webStorage()).toBeNull();
    expect(readString('a')).toBeNull();
    expect(writeJson('a', 1)).toBe(false);
    install(new Error('SecurityError'));
    expect(webStorage()).toBeNull();
    expect(readJson('a')).toBeNull();
    expect(removeKey('a')).toBe(false);
    expect(storageKeys()).toEqual([]);
    const full = new MemStorage();
    full.setItem = () => { throw new Error('QuotaExceededError'); };
    install(full);
    expect(writeString('a', 'x')).toBe(false);
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    install(new MemStorage());
    expect(writeJson('c', cyc)).toBe(false);
  });
});

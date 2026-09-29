/**
 * User presets: CRUD + persistence (IndexedDB → localStorage → memory) and
 * Orca JSON import/export.
 *
 * Like Orca, a user preset stores only its own values (the diff against its
 * system parent, referenced by `inherits`), or the full flattened config when
 * it has no system parent.
 */
import { shallowRef, type ShallowRef } from 'vue';
import type { EngineId } from '../engine/types';
import { openKv, type KvBackend } from './kv';
import { ORCA_JSON_TYPE, type PresetKind, type PresetValues } from './types';
import { cloneValue } from './values';
import { uuid } from './util';

export interface UserPreset {
  id: string;
  engine: EngineId;
  kind: PresetKind;
  name: string;
  /** System preset id this inherits from. */
  parentId?: string;
  /** Parent preset name (Orca JSON `inherits`). */
  inherits?: string;
  /** Own values (diff vs parent, or full values without a parent). */
  values: PresetValues;
  createdAt: number;
  updatedAt: number;
}

export class PresetNameError extends Error {
  constructor(message: string) { super(message); this.name = 'PresetNameError'; }
}

const PREFIX = 'userpreset:';

function copyValues(v: PresetValues): PresetValues {
  const out: PresetValues = {};
  for (const [k, x] of Object.entries(v)) out[k] = cloneValue(x);
  return out;
}

export class UserPresetStore {
  readonly list: ShallowRef<UserPreset[]> = shallowRef([]);
  readonly ready: Promise<void>;
  private kv: KvBackend | null = null;

  constructor(readonly engine: EngineId, kv?: KvBackend | Promise<KvBackend>) {
    this.ready = (async () => {
      try {
        this.kv = await (kv ?? openKv());
        const rows = await this.kv.getAll(`${PREFIX}${engine}:`);
        const loaded = rows.map(([, v]) => v).filter(isUserPreset).filter((p) => p.engine === engine);
        // Keep anything created before the backend finished loading.
        const byId = new Map(loaded.map((p) => [p.id, p]));
        for (const p of this.list.value) byId.set(p.id, p);
        this.list.value = sortPresets([...byId.values()]);
      } catch {
        this.kv = null;
      }
    })();
  }

  get storageKind(): string { return this.kv?.kind ?? 'memory'; }

  byKind(kind: PresetKind): UserPreset[] { return this.list.value.filter((p) => p.kind === kind); }
  get(id: string): UserPreset | undefined { return this.list.value.find((p) => p.id === id); }
  findByName(kind: PresetKind, name: string): UserPreset | undefined {
    return this.list.value.find((p) => p.kind === kind && p.name === name);
  }

  private validName(kind: PresetKind, name: string, exceptId?: string): string {
    const n = name.trim();
    if (!n) throw new PresetNameError('Preset name is empty');
    if (/[<>:"/\\|?*\u0000-\u001f]/.test(n)) throw new PresetNameError('Preset name contains invalid characters');
    const clash = this.findByName(kind, n);
    if (clash && clash.id !== exceptId) throw new PresetNameError(`A ${kind} preset named "${n}" already exists`);
    return n;
  }

  /** Unique variant of `name` ("Name", "Name (2)", …). */
  uniqueName(kind: PresetKind, name: string): string {
    const base = name.trim() || 'Preset';
    if (!this.findByName(kind, base)) return base;
    for (let i = 2; ; i++) { const n = `${base} (${i})`; if (!this.findByName(kind, n)) return n; }
  }

  private persist(p: UserPreset): void {
    this.kv?.set(`${PREFIX}${this.engine}:${p.id}`, p).catch(() => { /* resilient backend already degraded */ });
  }

  create(input: { kind: PresetKind; name: string; parentId?: string; inherits?: string; values: PresetValues }): UserPreset {
    const now = Date.now();
    const p: UserPreset = {
      id: `user:${uuid()}`,
      engine: this.engine,
      kind: input.kind,
      name: this.validName(input.kind, input.name),
      parentId: input.parentId,
      inherits: input.inherits,
      values: copyValues(input.values),
      createdAt: now,
      updatedAt: now,
    };
    this.list.value = sortPresets([...this.list.value, p]);
    this.persist(p);
    return p;
  }

  update(id: string, patch: Partial<Pick<UserPreset, 'values' | 'parentId' | 'inherits'>>): UserPreset {
    const cur = this.get(id);
    if (!cur) throw new Error(`Unknown preset ${id}`);
    const next: UserPreset = { ...cur, ...patch, values: patch.values ? copyValues(patch.values) : cur.values, updatedAt: Date.now() };
    this.list.value = sortPresets(this.list.value.map((p) => (p.id === id ? next : p)));
    this.persist(next);
    return next;
  }

  rename(id: string, name: string): UserPreset {
    const cur = this.get(id);
    if (!cur) throw new Error(`Unknown preset ${id}`);
    const next = { ...cur, name: this.validName(cur.kind, name, id), updatedAt: Date.now() };
    this.list.value = sortPresets(this.list.value.map((p) => (p.id === id ? next : p)));
    this.persist(next);
    return next;
  }

  remove(id: string): void {
    this.list.value = this.list.value.filter((p) => p.id !== id);
    this.kv?.delete(`${PREFIX}${this.engine}:${id}`).catch(() => { /* ignore */ });
  }
}

function sortPresets(list: UserPreset[]): UserPreset[] {
  return list.slice().sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

function isUserPreset(v: unknown): v is UserPreset {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as UserPreset;
  return typeof p.id === 'string' && typeof p.name === 'string' && typeof p.kind === 'string' && typeof p.values === 'object' && p.values !== null;
}

// ---- Orca JSON ----------------------------------------------------------------

/**
 * Orca user-preset JSON (`~/.config/OrcaSlicer/user/<id>/<type>/<name>.json`).
 * `values` may be the diff (with `inherits`) or a flattened config (without).
 */
export function toOrcaJson(kind: PresetKind, name: string, values: PresetValues, inherits?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: ORCA_JSON_TYPE[kind],
    name,
    from: 'User',
    instantiation: 'true',
  };
  if (inherits) out.inherits = inherits;
  const idKey = kind === 'printer' ? 'printer_settings_id' : kind === 'process' ? 'print_settings_id' : 'filament_settings_id';
  for (const [k, v] of Object.entries(values)) out[k] = cloneValue(v);
  out[idKey] = kind === 'filament' ? [name] : name;
  return out;
}

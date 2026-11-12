/**
 * `orca.host.preset_bundle()` readers from the active engine's preset store.
 *
 * Collections: printers = every listed printer preset; prints / filaments =
 * the presets compatible with the selected printer (CubbySlicer does not keep
 * the incompatible ones loaded), plus the selected ones. sla_* are empty.
 * `config_value` returns Orca's serialized text (configSerialize.ts); a
 * preset's keys are the schema options of its kind (print / filament /
 * machine scope), like Orca's per-type preset configs.
 */
import { afterSettingEdit } from '../../settings/applyAutoChanges';
import { currentPresets } from '../../presets/store';
import type { PresetInfo, PresetKind } from '../../presets/types';
import type { ConfigScope } from '../../engine/types';
import { parseOrcaValue, serializeOrcaValue } from './configSerialize';
import { validateValue } from '../../settings/validate';

const COLL_KIND: Record<string, PresetKind> = { prints: 'process', printers: 'printer', filaments: 'filament' };
const KIND_TYPE: Record<PresetKind, string> = { process: 'Print', printer: 'Printer', filament: 'Filament' };
const KIND_SCOPE: Record<PresetKind, ConfigScope> = { process: 'print', printer: 'machine', filament: 'filament' };

function presetMeta(info: PresetInfo, kind: PresetKind, selected: boolean, dirty: boolean) {
  return {
    type: KIND_TYPE[kind], name: info.name, alias: info.alias ?? '', file: '',
    is_default: info.source === 'default', is_system: info.source === 'system', is_external: false,
    is_visible: true, is_dirty: selected && dirty, is_compatible: true, bundle_id: '',
    selected,
  };
}

function collection(kind: PresetKind) {
  const s = currentPresets.value;
  const selectedInfo = s.selectedInfo(kind, 0);
  const list: PresetInfo[] = kind === 'printer' ? s.printerInfos.value.slice()
    : kind === 'process' ? s.compatible.value.process.slice() : s.compatible.value.filament.slice();
  const add = (i: PresetInfo) => { if (!list.some((x) => x.id === i.id)) list.push(i); };
  add(selectedInfo);
  if (kind === 'filament') for (const i of s.infos.value.filaments) add(i);
  const dirty = s.dirtyCount(kind, 0) > 0;
  return {
    selected: selectedInfo.name, dirty,
    presets: list.map((i) => presetMeta(i, kind, i.id === selectedInfo.id, dirty)),
  };
}

export function bundleSnapshot(): unknown {
  const s = currentPresets.value;
  return {
    collections: {
      prints: collection('process'), printers: collection('printer'), filaments: collection('filament'),
      sla_prints: { selected: '', dirty: false, presets: [] }, sla_materials: { selected: '', dirty: false, presets: [] },
    },
    filament_names: s.infos.value.filaments.map((i) => i.name),
  };
}

function keysOf(kind: PresetKind): string[] {
  const schema = currentPresets.value.schema.value;
  if (!schema) return [];
  return Object.entries(schema.options).filter(([, d]) => d.scope === KIND_SCOPE[kind] && d.type !== 'none').map(([k]) => k).sort();
}

/** One preset's full config, serialized. `edited`: the selected preset with unsaved edits. */
export async function presetConfig(collectionKey: string, name: string, edited: boolean): Promise<Record<string, string>> {
  const kind = COLL_KIND[collectionKey];
  if (!kind) return {};
  const s = currentPresets.value;
  const schema = s.schema.value;
  const out: Record<string, string> = {};
  const sel = s.selectedInfo(kind, 0);
  if (sel.name === name) {
    for (const k of keysOf(kind)) {
      const v = serializeOrcaValue(schema?.options[k]?.type, edited ? s.value(kind, k, 0) : s.presetValue(kind, k, 0));
      if (v !== null) out[k] = v;
    }
    return out;
  }
  const info = [...(kind === 'printer' ? s.printerInfos.value : kind === 'process' ? s.compatible.value.process : s.compatible.value.filament)].find((i) => i.name === name);
  if (!info) return {};
  const r = await s.resolvePreset(kind, info.id);
  for (const k of keysOf(kind)) {
    const def = schema?.options[k];
    const raw = r && k in r.values ? r.values[k] : def ? (def.default ?? '') : undefined;
    const v = def && raw !== undefined && !(k in (r?.values ?? {})) ? def.default : serializeOrcaValue(def?.type, raw);
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** PresetBundle.full_config(): the resolved config the slicer would use, serialized. */
export function fullConfig(): Record<string, string> {
  const s = currentPresets.value;
  const schema = s.schema.value;
  const flat = s.resolve();
  const out: Record<string, string> = {};
  for (const k of Object.keys(flat).sort()) {
    const v = serializeOrcaValue(schema?.options[k]?.type, flat[k]);
    if (v !== null) out[k] = v;
  }
  return out;
}

export function presetsDirty(): boolean {
  const s = currentPresets.value;
  return s.dirtyCount('printer', 0) > 0 || s.dirtyCount('process', 0) > 0 || s.infos.value.filaments.some((_, i) => s.dirtyCount('filament', i) > 0);
}

// ---- preset writes: orca.host.preset.process / printer / filament (PluginHostPresets.cpp) -------

class HostError extends Error {
  constructor(message: string, readonly pyType = 'ValueError') { super(message); }
}

const CATEGORY_KIND: Record<string, PresetKind> = { Print: 'process', Printer: 'printer', Filament: 'filament' };
const TAB: Record<PresetKind, string> = { process: 'process', printer: 'printer', filament: 'filament' };

function selectable(kind: PresetKind): PresetInfo[] {
  const s = currentPresets.value;
  return kind === 'printer' ? s.printerInfos.value : kind === 'process' ? s.compatible.value.process : s.compatible.value.filament;
}

/** Ask what to do with unsaved edits before switching (Orca: the unsaved-changes dialog). null = cancelled. */
export type SwitchPrompt = (kind: PresetKind, from: string, to: string, edits: number) => Promise<'discard' | 'transfer' | null>;
let switchPrompt: SwitchPrompt = async () => 'discard';
export function setSwitchPrompt(fn: SwitchPrompt): void { switchPrompt = fn; }

/** begin_update(): resolve and bind the target (selecting it through the normal flow). */
export async function beginUpdate(a: { category: string; preset_name?: string; slot?: number }): Promise<Record<string, unknown>> {
  const kind = CATEGORY_KIND[a.category];
  if (!kind) throw new HostError('Unsupported preset category');
  const s = currentPresets.value;
  let index = 0;
  if (kind === 'filament') {
    const n = s.infos.value.filaments.length;
    const slot = Number(a.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > n) {
      throw new HostError(`Filament slot ${a.slot} is out of range; slot numbers are 1-based and this printer has ${n} filament slot(s)`, 'IndexError');
    }
    index = slot - 1;
  }
  const current = s.selectedInfo(kind, index);
  let selectionChanged = false;
  const name = (a.preset_name ?? '').trim();
  if (name && name !== current.name) {
    const target = selectable(kind).find((i) => i.name === name || i.alias === name);
    if (!target) throw new HostError(`The ${TAB[kind]} preset "${name}" is not offered by the preset selector for the selected printer`);
    const edits = s.dirtyCount(kind, index);
    let keep = false;
    if (edits > 0) {
      const choice = await switchPrompt(kind, current.name, target.name, edits);
      if (!choice) throw new HostError(`Switching the edited ${TAB[kind]} preset to "${target.name}" was canceled; nothing was staged`, 'RuntimeError');
      keep = choice === 'transfer';
    }
    if (kind === 'printer') await s.selectPrinter(target.id, { keepOverrides: keep });
    else if (kind === 'process') await s.selectProcess(target.id, { keepOverrides: keep });
    else await s.selectFilament(index, target.id, { keepOverrides: keep });
    if (s.selectedInfo(kind, index).id !== target.id) {
      throw new HostError(`The edited ${TAB[kind]} preset is "${s.selectedInfo(kind, index).name}", not "${target.name}"; the transaction was not created`, 'RuntimeError');
    }
    selectionChanged = true;
  }
  const bound = s.selectedInfo(kind, index);
  return {
    type: a.category, target_name: bound.name, target_id: bound.id, selection_changed: selectionChanged,
    slot_number: kind === 'filament' ? index + 1 : 0, category: TAB[kind],
  };
}

/** commit(): validate every staged key and value, then apply all of them or none. */
export async function commitUpdate(a: { category: string; target_id: string; target_name: string; slot_number?: number; staged: [string, string][]; selection_changed?: boolean }): Promise<Record<string, unknown>> {
  const kind = CATEGORY_KIND[a.category];
  if (!kind) throw new HostError('Unsupported preset category');
  const s = currentPresets.value;
  const index = kind === 'filament' ? Number(a.slot_number) - 1 : 0;
  const edited = s.selectedInfo(kind, index);
  if (edited.id !== a.target_id) {
    if (kind === 'filament') {
      throw new HostError(`Filament slot ${index + 1} now holds "${edited.name}", not "${a.target_name}" as when this transaction was created; the slot mapping changed, so nothing was applied`, 'RuntimeError');
    }
    throw new HostError(`The edited ${TAB[kind]} preset is "${edited.name}", not this transaction's target "${a.target_name}"; nothing was applied`, 'RuntimeError');
  }
  const schema = s.schema.value;
  const scope = KIND_SCOPE[kind];
  const parsed: Array<[string, ReturnType<typeof parseOrcaValue>]> = [];
  const seen = new Set<string>();
  for (const [key, value] of a.staged) {
    const def = schema?.options[key];
    if (!def || def.scope !== scope) throw new HostError(`Unknown ${TAB[kind]} preset setting "${key}"`);
    if (seen.has(key)) throw new HostError(`${TAB[kind]} preset setting "${key}" is set more than once in the same update`);
    seen.add(key);
    const v = parseOrcaValue(def.type, String(value));
    const bad = validateValue(def, v)[0];
    if (bad) throw new HostError(`Invalid value for ${key}: ${bad.message}`);
    parsed.push([key, v]);
  }
  // The edited preset is shared by every slot it is assigned to (Orca edits the preset, not a slot).
  const slots = kind === 'filament'
    ? s.infos.value.filaments.map((f, i) => (f.id === edited.id ? i : -1)).filter((i) => i >= 0)
    : [0];
  const before = slots.map((i) => ({ i, bag: { ...s.overrideBag(kind, i) } }));
  try {
    // Tab::apply_preset_config_values: each key goes through the hand-edit path in turn (field_changed →
    // on_value_change → update), so Orca's automatic value changes run, with their questions, as in the app.
    for (const [key, v] of parsed) {
      for (const i of slots) s.setValue(kind, key, v, i);
      const auto = await afterSettingEdit(kind, key, v, index);
      for (const i of slots) if (i !== index) for (const [k2, v2] of Object.entries(auto)) s.setValue(kind, k2, v2, i);
    }
  } catch (e) {
    for (const b of before) {
      const bag = s.overrideBag(kind, b.i);
      for (const k of Object.keys(bag)) if (!(k in b.bag)) delete bag[k];
      Object.assign(bag, b.bag);
    }
    throw new HostError(`The update was not applied: ${(e as Error).message}`, 'RuntimeError');
  }
  return {
    type: a.category, target_name: edited.name, selection_changed: !!a.selection_changed,
    slot_number: kind === 'filament' ? index + 1 : -1, slot_assignment_changed: kind === 'filament' && !!a.selection_changed,
    shared_slots: kind === 'filament' ? slots.map((i) => i + 1) : [], keys: parsed.map(([k]) => k),
    dirty: s.dirtyCount(kind, index) > 0, category: TAB[kind],
  };
}

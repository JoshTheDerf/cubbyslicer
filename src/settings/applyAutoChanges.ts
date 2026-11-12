/**
 * Runs Orca's automatic value changes (./rules/autoChanges.ts) after a settings edit: the process,
 * filament and printer tabs (SettingsGroups via setWithCoupled) and per-object settings. Prompts go
 * through the app's confirm dialog with Orca's message and buttons; the resulting writes are applied
 * to the same config the edit went to.
 */
import type { ConfigValue } from '../engine/types';
import { activeEngine } from '../app/state';
import { askConfirm } from '../app/shell/uiState';
import { currentPresets } from '../presets/store';
import type { PresetKind } from '../presets/types';
import { asList, toBool, valueAt } from '../lib/configValue';
import { readJson, writeJson } from '../lib/storage';
import { objects } from '../project/store/state';
import { MODE_RANK, perExtruderKeys } from './useLayout';
import { settingsUi } from './uiState';
import { bedExcludeVolumeOffer, isBedExclusionVolumeSyntax, runAutoChanges, runPresetChecks, type Answer, type AutoContext, type Prompt, type Writes } from './rules/autoChanges';
import { parseVolumes } from '../dialogs/bed/collisionVolumes';
import type { RuleFamily } from './rules/types';

const FAMILY: Record<PresetKind, RuleFamily> = { process: 'print', printer: 'printer', filament: 'filament' };
const FLAGS_KEY = 'cubby-slicer:dont-show-again';

/** Orca's asked-once members live per ConfigManipulation: the tabs and the object settings have their own. */
const memos = { global: {} as Record<string, unknown>, object: {} as Record<string, unknown> };

/** Show one prompt with Orca's buttons; resolves with the answer (closing = the prompt's `dismiss`). */
export async function askPrompt(p: Prompt): Promise<Answer> {
  const yesNo = p.buttons === 'yesno';
  const a = await askConfirm({
    title: p.title || 'Warning',
    message: p.message,
    confirmLabel: yesNo ? p.yesLabel ?? 'Yes' : 'OK',
    altLabel: yesNo ? p.noLabel ?? 'No' : undefined,
    cancelLabel: '',
    // Modal like Orca's MessageDialog: a click or focus outside (the field just edited) doesn't answer it.
    dismissible: false,
    checkLabel: p.dontShowKey ? "Don't show again" : undefined,
    testId: `auto-${p.id}`,
  });
  if (p.dontShowKey && a.checked) {
    const flags = readJson<Record<string, string>>(FLAGS_KEY) ?? {};
    flags[p.dontShowKey] = '1';
    writeJson(FLAGS_KEY, flags);
  }
  if (a.choice === 'confirm') return yesNo ? 'yes' : 'ok';
  if (a.choice === 'alt') return 'no';
  return p.dismiss;
}

function usedFilamentTypes(read: (slot: number) => string): string[] {
  const used = new Set<number>();
  for (const o of objects.value) {
    used.add(Math.max(1, Number(o.overrides?.extruder ?? 1) || 1));
    for (const part of o.parts ?? []) if (part.overrides?.extruder !== undefined) used.add(Math.max(1, Number(part.overrides.extruder) || 1));
  }
  return [...used].map((n) => read(n - 1)).filter(Boolean);
}

/** The context for one run. `self`: the edited config (per-object: overrides over the process). */
function context(kind: PresetKind, slot: number, extruder: number, self?: (key: string) => ConfigValue | undefined): AutoContext {
  const p = currentPresets.value;
  const mixedIds = new Set(p.mixedFilaments().map((m) => m.id));
  const typeOf = (i: number) => valueAt(p.value('filament', 'filament_type', i), 0) ?? '';
  const flags = readJson<Record<string, string>>(FLAGS_KEY) ?? {};
  return {
    family: FAMILY[kind],
    get: (k) => self?.(k) ?? p.value(kind, k, slot),
    printer: (k) => p.value('printer', k),
    isGlobal: !self,
    isBBL: p.selectedInfo('printer').vendor === 'BBL',
    mode: MODE_RANK[settingsUi.mode],
    variantIndex: extruder,
    filamentCount: p.filamentSlotCount(),
    isMixedSlot: (n) => mixedIds.has(n),
    filament: (i) => (i >= 0 && i < p.physicalColours().length ? {
      type: typeOf(i),
      isSupport: toBool(valueAt(p.value('filament', 'filament_is_support', i), 0)),
      soluble: toBool(valueAt(p.value('filament', 'filament_soluble', i), 0)),
    } : null),
    modelFilamentTypes: usedFilamentTypes(typeOf),
    platerValue: (k) => Number(valueAt(p.value('process', k), 0) ?? 0) || 0,
    hasVariableLayerHeight: objects.value.some((o) => (o.layerHeightProfile?.length ?? 0) > 4),
    appFlag: (k) => flags[k] === '1',
    memo: self ? memos.object : memos.global,
    userSavedPreset: !self && p.selectedInfo(kind, slot).source === 'user' && p.dirtyCount(kind, slot) === 0,
  };
}

let running: Promise<void> = Promise.resolve();

/** Answers a prompt: the app's dialog (askPrompt), or a non-interactive answerer (autoAnswer). */
export type Asker = (p: Prompt) => Promise<Answer>;
/** A prompt a non-interactive run answered by itself. */
export interface AutoNote { id: string; message: string; answer: Answer; button: string }

/**
 * The non-interactive answerer (the MCP bridge): take the button that goes ahead with the change and
 * Orca's suggestion (Yes / OK), and record each prompt so the caller can report it.
 */
export function autoAnswer(notes: AutoNote[]): Asker {
  return async (p) => {
    const answer: Answer = p.buttons === 'yesno' ? 'yes' : 'ok';
    notes.push({ id: p.id, message: p.message, answer, button: answer === 'yes' ? p.yesLabel ?? 'Yes' : 'OK' });
    return answer;
  };
}

/**
 * After `key` was set to `value` in a preset tab: run the checks and apply what they change (one run at a
 * time, like Orca's `is_msg_dlg_already_exist`). Resolves with the values the checks changed.
 */
export function afterSettingEdit(kind: PresetKind, key: string, value: ConfigValue, slot = 0, extruder = 0, ask: Asker = askPrompt): Promise<Writes> {
  if (activeEngine.value !== 'orca') return Promise.resolve({});
  const changed: Writes = {};
  running = running.then(async () => {
    const writes = await runAutoChanges(context(kind, slot, extruder), { key, value }, ask);
    const p = currentPresets.value;
    for (const [k, v] of Object.entries(writes)) if (!same(p.value(kind, k, slot), v)) { p.setValue(kind, k, v, slot); changed[k] = v; }
    // TabPrinter: turning single extruder multi-material on makes the printer one extruder (Orca's "#if 1").
    if (kind === 'printer' && key === 'single_extruder_multi_material' && toBool(valueAt(p.value('printer', key), 0))
      && asList(p.value('printer', 'nozzle_diameter')).length > 1) await setExtruderCount(1);
  }).catch((e) => { console.warn('settings auto changes:', e); });
  return running.then(() => changed);
}

/**
 * A preset was picked (Tab::select_preset → load_current_preset → update): the checks that run on every
 * update, for that tab — and for a printer also the process and filament tabs it reloads (m_dependent_tabs).
 */
export function afterPresetSelect(kind: PresetKind, slot = 0, ask: Asker = askPrompt): Promise<Writes> {
  return updateTabs(kind === 'printer' ? [['printer', 0], ['process', 0], ['filament', filamentTabSlot()]] : [[kind, slot]], ask);
}

/**
 * A project was opened (Plater::load_files → GUI_App::load_current_presets → Tab::load_current_preset →
 * update on every tab, in MainFrame's tab order: process, filament, printer). Desktop asks as it does on
 * a preset selection.
 */
export function afterProjectOpen(): Promise<Writes> {
  return updateTabs([['process', 0], ['filament', filamentTabSlot()], ['printer', 0]]);
}

const filamentTabSlot = () => Math.min(settingsUi.filamentSlot, Math.max(0, currentPresets.value.selection.filaments.length - 1));

/** Run the update checks of each tab in turn; resolves with the values they changed. */
function updateTabs(tabs: Array<[PresetKind, number]>, ask: Asker = askPrompt): Promise<Writes> {
  if (activeEngine.value !== 'orca') return Promise.resolve({});
  const changed: Writes = {};
  running = running.then(async () => {
    for (const [k, i] of tabs) {
      const writes = await runPresetChecks(context(k, i, 0), ask);
      const p = currentPresets.value;
      for (const [key, v] of Object.entries(writes)) if (!same(p.value(k, key, i), v)) { p.setValue(k, key, v, i); changed[key] = v; }
    }
  }).catch((e) => { console.warn('preset select auto changes:', e); });
  return running.then(() => changed);
}

/**
 * Collision-volume text typed into the printer's excluded bed area (Tab::on_value_change
 * "bed_exclude_area"): returns false when it isn't that syntax (the caller stores the points as usual).
 * Otherwise the area keeps its value and the definition is checked and offered to the collision volumes.
 */
export function offerBedExcludeVolumes(definition: string): boolean {
  if (activeEngine.value !== 'orca' || !isBedExclusionVolumeSyntax(definition)) return false;
  running = running.then(async () => {
    const p = currentPresets.value;
    const height = Number(valueAt(p.value('printer', 'printable_height'), 0) ?? 0) || 0;
    // is_valid_bed_exclude_volumes_string: every non-empty spec parses, and there is one.
    const { volumes, bad } = parseVolumes(definition, Math.max(0, height));
    const step = bedExcludeVolumeOffer(definition, bad === 0 && volumes.length > 0, (k) => p.value('printer', k));
    if (!('prompt' in step)) return;
    const answer = await askPrompt(step.prompt);
    for (const [k, v] of Object.entries(step.prompt.writes[answer] ?? {})) p.setValue('printer', k, v);
  }).catch((e) => { console.warn('bed exclude volumes:', e); });
  return true;
}

/**
 * TabPrinter::extruders_count_changed: resize the per-extruder lists and, when the count changed on a
 * printer that isn't single extruder multi-material, give it one physical filament per extruder
 * (Tab::on_value_change "extruders_count": Sidebar add / delete one slot at a time, mixed slots kept).
 */
export async function setExtruderCount(n: number): Promise<void> {
  const p = currentPresets.value;
  const before = asList(p.value('printer', 'nozzle_diameter')).length;
  p.setExtruderCount(n, perExtruderKeys.value);
  const count = asList(p.value('printer', 'nozzle_diameter')).length;
  if (count === before || activeEngine.value !== 'orca' || toBool(valueAt(p.value('printer', 'single_extruder_multi_material'), 0))) return;
  if (p.selection.filaments.length !== count) await p.setFilamentCount(count);
}

/** After an object / part override edit: the checks see the overrides over the process and write overrides. */
export function afterOverrideEdit(overrides: () => Readonly<Record<string, ConfigValue>>, set: (key: string, value: ConfigValue) => void, key: string, value: ConfigValue, ask: Asker = askPrompt): Promise<Writes> {
  if (activeEngine.value !== 'orca') return Promise.resolve({});
  const changed: Writes = {};
  running = running.then(async () => {
    const own = overrides();
    const writes = await runAutoChanges(context('process', 0, 0, (k) => own[k]), { key, value }, ask);
    const p = currentPresets.value;
    for (const [k, v] of Object.entries(writes)) {
      const cur = own[k] ?? p.value('process', k);
      if (!same(cur, v)) { set(k, v); changed[k] = v; }
    }
  }).catch((e) => { console.warn('object settings auto changes:', e); });
  return running.then(() => changed);
}

function same(a: ConfigValue | undefined, b: ConfigValue): boolean {
  return JSON.stringify(asList(a)) === JSON.stringify(asList(b));
}

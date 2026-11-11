/**
 * Per-plate spiral vase (Orca PartPlate::set_spiral_vase_mode / set_vase_mode_related_object_config and
 * PartPlateList::notify_instance_update):
 *
 * - turning spiral vase on for a plate that isn't in spiral mode yet asks the spiral question (Yes / No);
 *   Yes stores it and gives every object on the plate the vase settings it needs as object settings;
 * - an object moved onto a plate whose own spiral_mode is on, whose settings aren't vase-ready, gets the
 *   message with OK and the same settings; a newly added object gets them silently.
 */
import { watch } from 'vue';
import type { ConfigValue } from '../engine/types';
import { activeEngine } from '../app/state';
import { askPrompt } from '../settings/applyAutoChanges';
import { MSG, type Prompt } from '../settings/rules/autoChanges';
import { currentPresets } from '../presets/store';
import { toBool, toNumber, valueAt } from '../lib/configValue';
import { mutate, objects, plates } from '../project/store';
import { objectPlate, objectsOnPlate } from '../project/store/derived';

/** set_vase_mode_related_object_config's settings (no clumping detection here, unlike the global check). */
export const VASE_OBJECT_CONFIG: Readonly<Record<string, string>> = {
  wall_loops: '1', top_shell_layers: '0', sparse_infill_density: '0%', enable_support: '0', enforce_support_layers: '0',
  detect_thin_wall: '0', timelapse_type: '0', overhang_reverse: '0',
};

const same = (a: ConfigValue | undefined, b: string) => {
  const v = String(valueAt(a, 0) ?? '');
  const na = toNumber(v.replace('%', ''), NaN), nb = toNumber(b.replace('%', ''), NaN);
  return Number.isFinite(na) && Number.isFinite(nb) ? na === nb : v === b;
};

/**
 * The object settings to write: every vase key the global process differs on (global_config->diff), plus
 * the ones the object already overrides with another value.
 */
export function vaseObjectWrites(global: (k: string) => ConfigValue | undefined, own: Readonly<Record<string, ConfigValue>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(VASE_OBJECT_CONFIG)) {
    if (!same(global(k), v) || (k in own && !same(own[k], v))) out[k] = v;
  }
  return out;
}

/** is_object_config_compatible_with_spiral_vase: the object's own settings (not the process) are vase-ready. */
export function objectVaseReady(own: Readonly<Record<string, ConfigValue>>): boolean {
  const has = (k: string) => own[k] !== undefined;
  const n = (k: string) => toNumber(String(valueAt(own[k], 0) ?? '').replace('%', ''), NaN);
  const b = (k: string) => toBool(valueAt(own[k], 0));
  // ensure_vertical_shell_thickness is an enum in 2.5; desktop reads it as a bool (any value but "none").
  const evst = String(valueAt(own.ensure_vertical_shell_thickness, 0) ?? '');
  return has('wall_loops') && n('wall_loops') === 1 && has('top_shell_layers') && n('top_shell_layers') === 0
    && has('sparse_infill_density') && n('sparse_infill_density') === 0 && has('enable_support') && !b('enable_support')
    && has('enforce_support_layers') && n('enforce_support_layers') === 0
    && has('ensure_vertical_shell_thickness') && evst !== '' && evst !== '0' && evst !== 'ensure_none' && evst !== 'none'
    && has('detect_thin_wall') && !b('detect_thin_wall') && has('timelapse_type') && String(valueAt(own.timelapse_type, 0)) === '0';
}

/** ConfigManipulation::show_spiral_mode_settings_dialog(is_object_config). */
export function spiralPrompt(objectConfig: boolean, printerStructure: string): Prompt {
  let message: string = MSG.spiral;
  if (printerStructure === 'i3') message += MSG.spiralI3;
  if (!objectConfig) message += `\n\n${MSG.spiralAsk}`;
  return objectConfig
    ? { id: 'plate-spiral-object', title: '', message, buttons: 'ok', dismiss: 'ok', writes: {} }
    : { id: 'plate-spiral', title: '', message, buttons: 'yesno', dismiss: 'no', writes: {} };
}

/** PartPlate::get_spiral_vase_mode: the plate's own value, else the process. */
export function plateSpiral(i: number): boolean {
  const own = plates.value[i]?.config?.spiral_mode;
  return own !== undefined ? toBool(valueAt(own, 0)) : toBool(valueAt(currentPresets.value.value('process', 'spiral_mode'), 0));
}

const printerStructure = () => String(valueAt(currentPresets.value.value('printer', 'printer_structure'), 0) ?? '');
const globalValue = (k: string) => currentPresets.value.value('process', k);

function applyVaseConfig(ids: readonly string[]): void {
  mutate('Spiral vase object settings', () => {
    for (const id of ids) {
      const o = objects.value.find((x) => x.id === id);
      if (!o) continue;
      Object.assign(o.overrides, vaseObjectWrites(globalValue, o.overrides));
    }
  });
}

/**
 * The PlateSettingsDialog's spiral choice ('on' / 'off' / undefined = same as global) → the plate's
 * spiral_mode value to store (undefined = none), asking and writing object settings as desktop does.
 */
export async function resolvePlateSpiral(i: number, choice: 'on' | 'off' | undefined): Promise<string | undefined> {
  if (choice === undefined) return undefined;
  if (choice === 'off') return '0';
  const before = plates.value[i]?.config?.spiral_mode;
  const keep = before === undefined ? undefined : String(valueAt(before, 0));
  if (plateSpiral(i)) return keep; // already spiral: set_spiral_vase_mode returns without storing
  const answer = await askPrompt(spiralPrompt(false, printerStructure()));
  if (answer !== 'yes') return keep;
  applyVaseConfig(objectsOnPlate(i).map((o) => o.id));
  return '1';
}

let started = false;
/** notify_instance_update: objects arriving on a plate whose own spiral_mode is on (once, from Prepare). */
export function startPlateSpiralWatch(): void {
  if (started) return;
  started = true;
  let prev = new Map(objectPlate.value);
  let prevPlates = plates.value;
  watch(objectPlate, async (now) => {
    const before = prev, platesBefore = prevPlates;
    prev = new Map(now);
    prevPlates = plates.value;
    // A project load or undo / redo replaces the plates: not an arrival.
    if (platesBefore !== plates.value || activeEngine.value !== 'orca') return;
    const moved: string[] = [], added: string[] = [];
    for (const [id, i] of now) {
      const was = before.get(id);
      if (was === i || i < 0) continue;
      if (!toBool(valueAt(plates.value[i]?.config?.spiral_mode, 0))) continue;
      const o = objects.value.find((x) => x.id === id);
      if (!o || objectVaseReady(o.overrides)) continue;
      (was === undefined ? added : moved).push(id);
    }
    if (added.length) applyVaseConfig(added);
    for (const id of moved) {
      await askPrompt(spiralPrompt(true, printerStructure()));
      applyVaseConfig([id]);
    }
  });
}

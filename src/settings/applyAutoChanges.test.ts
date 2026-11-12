import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigValue } from '../engine/types';
import type { PresetKind } from '../presets/types';

/** A minimal preset store: one value bag per tab / slot. */
const bags: Record<string, Record<string, ConfigValue>> = {};
const bag = (kind: PresetKind, slot = 0) => (bags[`${kind}:${slot}`] ??= {});
const fake = {
  value: (kind: PresetKind, key: string, slot = 0) => bag(kind, slot)[key],
  setValue: vi.fn((kind: PresetKind, key: string, v: ConfigValue, slot = 0) => { bag(kind, slot)[key] = v; }),
  mixedFilaments: () => [],
  physicalColours: () => ['#ffffff'],
  filamentSlotCount: () => 1,
  selectedInfo: () => ({ id: 'sys:x', name: 'x', vendor: 'Prusa', source: 'system' }),
  dirtyCount: () => 0,
  selection: { filaments: ['sys:pla'] },
};
vi.mock('../presets/store', () => ({ currentPresets: { get value() { return fake; } } }));
vi.mock('../app/state', () => ({ activeEngine: { value: 'orca' } }));
const confirm = vi.fn();
vi.mock('../app/shell/uiState', () => ({ askConfirm: (...a: unknown[]) => confirm(...a) }));

const { afterProjectOpen, afterSettingEdit, autoAnswer } = await import('./applyAutoChanges');
const { MSG } = await import('./rules/autoChanges');

const SPIRAL = { spiral_mode: '1', wall_loops: '3', top_shell_layers: '4', sparse_infill_density: '15%', enable_support: '0', enforce_support_layers: '0',
  detect_thin_wall: '0', overhang_reverse: '0', timelapse_type: '0', enable_wrapping_detection: '0', layer_height: '0.2' };

beforeEach(() => {
  for (const k of Object.keys(bags)) delete bags[k];
  fake.setValue.mockClear();
  confirm.mockReset();
});

describe('automatic value changes: sources', () => {
  it('the non-interactive answerer goes ahead (Yes / OK), records the question and shows no dialog', async () => {
    Object.assign(bag('process'), SPIRAL);
    const notes: Parameters<typeof autoAnswer>[0] = [];
    const changed = await afterSettingEdit('process', 'spiral_mode', '1', 0, 0, autoAnswer(notes));
    expect(changed).toMatchObject({ wall_loops: '1', top_shell_layers: '0', sparse_infill_density: '0%' });
    expect(bag('process').wall_loops).toBe('1');
    expect(notes).toEqual([{ id: 'spiral-mode', message: `${MSG.spiral}\n\n${MSG.spiralAsk}`, answer: 'yes', button: 'Yes' }]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a renamed Yes button is reported by its label', async () => {
    bags['printer:0'] = { min_layer_height: ['0.07'], max_layer_height: ['0.3'] };
    Object.assign(bag('process'), { layer_height: '0.4' });
    const notes: Parameters<typeof autoAnswer>[0] = [];
    expect(await afterSettingEdit('process', 'layer_height', '0.4', 0, 0, autoAnswer(notes))).toEqual({ layer_height: '0.3' });
    expect(notes[0]).toMatchObject({ answer: 'yes', button: 'Adjust' });
  });

  it('project open runs the update checks of every tab with the app’s dialog (desktop load_current_presets)', async () => {
    Object.assign(bag('process'), SPIRAL);
    confirm.mockResolvedValue({ choice: 'confirm', checked: false });
    const changed = await afterProjectOpen();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({ message: `${MSG.spiral}\n\n${MSG.spiralAsk}`, confirmLabel: 'Yes', altLabel: 'No' });
    expect(changed).toMatchObject({ wall_loops: '1' });
    // "No": spiral mode goes off instead.
    Object.assign(bag('process'), SPIRAL);
    confirm.mockResolvedValue({ choice: 'alt', checked: false });
    expect(await afterProjectOpen()).toEqual({ spiral_mode: '0' });
  });
});

describe('plugin preset writes (Tab::apply_preset_config_values)', () => {
  it('commit runs the hand-edit path per key: the automatic changes and their questions, as in the app', async () => {
    const { commitUpdate } = await import('../plugins/host/presets');
    Object.assign(fake, {
      schema: { value: { options: { spiral_mode: { key: 'spiral_mode', type: 'bool', scope: 'print', label: 'Spiral vase' } } } },
      overrideBag: () => ({}),
    });
    Object.assign(bag('process'), { ...SPIRAL, spiral_mode: '0' });
    confirm.mockResolvedValue({ choice: 'confirm', checked: false });
    const r = await commitUpdate({ category: 'Print', target_id: 'sys:x', target_name: 'x', staged: [['spiral_mode', '1']] });
    expect(r).toMatchObject({ keys: ['spiral_mode'] });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(bag('process')).toMatchObject({ spiral_mode: '1', wall_loops: '1', sparse_infill_density: '0%' });
  });
});

import { describe, expect, it } from 'vitest';
import { MSG } from '../settings/rules/autoChanges';
import { objectVaseReady, spiralPrompt, VASE_OBJECT_CONFIG, vaseObjectWrites } from './spiral';

describe('per-plate spiral vase (PartPlate)', () => {
  it('set_vase_mode_related_object_config: keys the process differs on, plus the object\'s own differing ones', () => {
    const global = { ...VASE_OBJECT_CONFIG, wall_loops: '2', sparse_infill_density: '15%' } as Record<string, string>;
    expect(vaseObjectWrites((k) => global[k], {})).toEqual({ wall_loops: '1', sparse_infill_density: '0%' });
    expect(vaseObjectWrites((k) => global[k], { enable_support: '1', wall_loops: '1' })).toEqual({ wall_loops: '1', sparse_infill_density: '0%', enable_support: '0' });
    expect(vaseObjectWrites((k) => VASE_OBJECT_CONFIG[k], { sparse_infill_density: '0' })).toEqual({});
  });

  it('is_object_config_compatible_with_spiral_vase reads the object\'s own settings only', () => {
    expect(objectVaseReady({})).toBe(false);
    const ready = { ...VASE_OBJECT_CONFIG, ensure_vertical_shell_thickness: 'ensure_all' };
    expect(objectVaseReady(ready)).toBe(true);
    // The vase writer doesn't set ensure_vertical_shell_thickness, so its objects still count as not ready.
    expect(objectVaseReady({ ...VASE_OBJECT_CONFIG })).toBe(false);
  });

  it('the dialog: Yes / No with the ask on the plate, OK for an object; the i3 note', () => {
    expect(spiralPrompt(false, '')).toMatchObject({ buttons: 'yesno', message: `${MSG.spiral}\n\n${MSG.spiralAsk}` });
    expect(spiralPrompt(true, 'i3')).toMatchObject({ buttons: 'ok', message: MSG.spiral + MSG.spiralI3 });
  });
});

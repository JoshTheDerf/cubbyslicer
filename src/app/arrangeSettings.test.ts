import { describe, expect, it } from 'vitest';
import { DEFAULT_ARRANGE_SETTINGS, activeArrangeSet, arrangeSettings, resetArrangeSettings, sanitizeArrangeSettings } from './arrangeSettings';

describe('arrange settings', () => {
  it('defaults match Orca (auto spacing, no rotation, multi-material allowed)', () => {
    expect(sanitizeArrangeSettings(null)).toEqual(DEFAULT_ARRANGE_SETTINGS);
  });
  it('sanitizes stored values', () => {
    const s = sanitizeArrangeSettings({ fff: { distance: -3, enableRotation: 'yes' }, seqPrint: { distance: 12, enableRotation: true }, allowMultiMaterials: false, alignToYAxis: 1 });
    expect(s.fff).toEqual({ distance: 0, enableRotation: false });
    expect(s.seqPrint).toEqual({ distance: 12, enableRotation: true });
    expect(s.allowMultiMaterials).toBe(false);
    expect(s.alignToYAxis).toBe(false);
  });
  it('keeps spacing / rotation per print sequence; Reset turns Align to Y on for i3 printers', () => {
    arrangeSettings.fff.distance = 5;
    arrangeSettings.seqPrint.distance = 20;
    expect(activeArrangeSet(false).distance).toBe(5);
    expect(activeArrangeSet(true).distance).toBe(20);
    resetArrangeSettings(true, true);
    expect(arrangeSettings.seqPrint).toEqual({ distance: 0, enableRotation: false });
    expect(arrangeSettings.fff.distance).toBe(5);
    expect(arrangeSettings.alignToYAxis).toBe(true);
  });
});

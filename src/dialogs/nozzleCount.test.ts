import { describe, expect, it } from 'vitest';
import { manualMapProblem, nozzleCountError, nozzleCountTypes, orcaForceNoZero, zoneTitle } from './nozzleCount';

describe('nozzle rack GUI (MultiNozzleSync / FilamentMapPanel)', () => {
  it('rows of the "Set nozzle count" dialog', () => {
    expect(nozzleCountTypes('High Flow', ['Standard', 'High Flow'])).toEqual(['High Flow']);
    expect(nozzleCountTypes('Hybrid', ['Standard', 'High Flow'])).toEqual(['Standard', 'High Flow']);
    expect(nozzleCountTypes('Hybrid', [])).toEqual(['Standard', 'High Flow', 'E3D High Flow']);
  });

  it("the dialog's errors and Orca's force-no-zero rule", () => {
    expect(nozzleCountError(0, 6, true)).toBe('Error: Can not set both nozzle count to zero.');
    expect(nozzleCountError(0, 6, false)).toBeNull();
    expect(nozzleCountError(7, 6, false)).toBe('Error: Nozzle count can not exceed 6.');
    expect(nozzleCountError(3, 6, true)).toBeNull();
    expect(orcaForceNoZero('Hybrid', 2)).toBe(true);
    expect(orcaForceNoZero('Standard', 0)).toBe(true);
    expect(orcaForceNoZero('Standard', 1)).toBe(false);
    expect(orcaForceNoZero('Standard', null)).toBe(true); // a single extruder can't be emptied (unprintable)
  });

  it('manual grouping needs a nozzle of each used flow type', () => {
    const stats = ['Standard#1', 'Standard#4'];
    expect(manualMapProblem([1, 2, 2], ['Standard', 'Standard', 'High Flow'], ['Standard', 'Hybrid'], stats))
      .toEqual({ extruder: 1, type: 'High Flow', message: 'Error: Right extruder has no available High Flow nozzle, current group result is invalid.' });
    expect(manualMapProblem([1, 2], ['Standard', 'Standard'], ['Standard', 'Hybrid'], stats)).toBeNull();
    expect(manualMapProblem([1, 1], [], ['High Flow', 'Standard'], ['Standard#1', 'Standard#4'])?.message)
      .toBe('Error: Left extruder has no available High Flow nozzle, current group result is invalid.');
    // Unused extruders aren't checked.
    expect(manualMapProblem([2], [], ['High Flow', 'Standard'], ['Standard#1', 'Standard#4'])).toBeNull();
  });

  it('zone titles carry the rack counts', () => {
    expect(zoneTitle(0, 2, null, false)).toBe('Left Nozzle');
    expect(zoneTitle(0, 2, ['Standard#1', 'Standard#2|High Flow#3'], true)).toBe('Left Nozzle(1)');
    expect(zoneTitle(1, 2, ['Standard#1', 'Standard#2|High Flow#3'], true)).toBe('Right Nozzle(Std: 2, HF: 3)');
    expect(zoneTitle(1, 2, ['Standard#1', 'High Flow#5'], false)).toBe('Right Nozzle(5)');
  });
});

import { describe, expect, it } from 'vitest';
import { filterTree, insertionText, placeholderTree, SPECIFIC_PLACEHOLDERS } from './placeholders';
import { orcaPlaceholderGroups } from './placeholders.generated';

describe('G-code placeholders (Orca 2.5 catalogue)', () => {
  it('has the 2.5 print time components and slicing state', () => {
    const stats = orcaPlaceholderGroups.statistics.map((d) => d[0]);
    expect(stats).toEqual(expect.arrayContaining(['print_time_sec', 'print_time_total_sec', 'print_time_day', 'print_time_hour', 'print_time_minute']));
    expect(orcaPlaceholderGroups.statistics.find((d) => d[0] === 'print_time_sec')?.[2]).toBe('Print time (seconds component)');
    expect(orcaPlaceholderGroups.otherStates.map((d) => d[0])).toEqual(expect.arrayContaining(['curr_bed_type', 'imex_mode']));
  });

  it('every specific placeholder has a definition, per G-code option', () => {
    const defined = new Set(orcaPlaceholderGroups.specific.map((d) => d[0]));
    // toolchange_z is listed by Orca without a definition (EditGCodeDialog skips it too).
    const missing = Object.values(SPECIFIC_PLACEHOLDERS).flat().filter((k) => !defined.has(k) && k !== 'toolchange_z');
    expect(missing).toEqual([]);
    const tree = placeholderTree('change_filament_gcode', null, null);
    expect(tree[0].id).toBe('specific');
    expect(tree[0].items.map((i) => i.key)).toEqual(expect.arrayContaining(['next_extruder', 'flush_length', 'next_nozzle_id']));
    expect(placeholderTree('time_lapse_gcode', null, null)[0].items.map((i) => i.key)).toContain('timelapse_pos_x');
  });

  it('inserts and filters', () => {
    expect(insertionText({ key: 'position', vector: true, label: '', tooltip: '' }, false)).toBe('{position[]}');
    const f = filterTree(placeholderTree('machine_start_gcode', null, null), 'print_time_day');
    expect(f.flatMap((g) => g.items.map((i) => i.key))).toEqual(['print_time_day']);
  });
});

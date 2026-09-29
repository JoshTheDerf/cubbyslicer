import { describe, expect, it } from 'vitest';
import type { ConfigSchema, EngineId } from '../../engine/types';
import orcaSchema from '../__fixtures__/orca-schema.sample.json';
import preflightSchema from '../__fixtures__/preflight-schema.sample.json';
import { buildLayout, HIDDEN_KEYS, LAYOUTS, locateKeys, tabIdOfScope } from './build';

const schemas: Record<EngineId, ConfigSchema> = {
  fullspectrum: orcaSchema as unknown as ConfigSchema,
  orca: orcaSchema as unknown as ConfigSchema,
  preflight: preflightSchema as unknown as ConfigSchema,
};

describe.each(['orca', 'preflight'] as EngineId[])('%s layout', (engine) => {
  const schema = schemas[engine];

  it('reaches every preset-scope key (none dropped)', () => {
    const layout = buildLayout(schema, engine, 1);
    const loc = locateKeys(layout);
    const missing: string[] = [];
    for (const [k, def] of Object.entries(schema.options)) {
      const tab = tabIdOfScope(def.scope);
      if (!tab || HIDDEN_KEYS.has(k)) continue;
      const where = loc.get(k);
      if (!where) missing.push(k);
      else expect(where.tab).toBe(tab);
    }
    expect(missing).toEqual([]);
  });

  it('never places a key in the wrong tab or twice on a non-extruder page', () => {
    const layout = buildLayout(schema, engine, 2);
    for (const tab of Object.values(layout)) {
      const seen = new Set<string>();
      for (const page of tab.pages) {
        if (page.extruder !== undefined) continue;
        for (const g of page.groups) for (const k of g.keys) {
          expect(tabIdOfScope(schema.options[k].scope)).toBe(tab.id);
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
      }
    }
  });

  it('mirrors the engine Tab.cpp pages and expands extruder pages', () => {
    const one = buildLayout(schema, engine, 1);
    const three = buildLayout(schema, engine, 3);
    const extr = three.printer.pages.filter((p) => p.extruder !== undefined);
    expect(extr.map((p) => p.title)).toEqual(['Extruder 1', 'Extruder 2', 'Extruder 3']);
    expect(one.printer.pages.filter((p) => p.extruder !== undefined)).toHaveLength(1);
    expect(extr[0].groups.flatMap((g) => g.keys)).toContain('nozzle_diameter');
    const titles = one.process.pages.map((p) => p.title);
    if (engine === 'orca') {
      expect(titles.slice(0, 6)).toEqual(['Quality', 'Strength', 'Speed', 'Support', 'Multimaterial', 'Others']);
      expect(one.printer.pages.map((p) => p.title)).toEqual(expect.arrayContaining(['Basic information', 'Machine G-code', 'Motion ability']));
      const motion = one.printer.pages.find((p) => p.title === 'Motion ability')!;
      expect(motion.groups.find((g) => g.title === 'Speed limitation')?.keys).toEqual(['machine_max_speed_x', 'machine_max_speed_y', 'machine_max_speed_z', 'machine_max_speed_e']);
    } else {
      expect(titles).toEqual(expect.arrayContaining(['Layers and perimeters', 'Infill', 'Support material', 'Speed']));
    }
  });

  it('layout source only references keys the schema knows (stale layout detection)', () => {
    const src = LAYOUTS[engine];
    const unknown: string[] = [];
    for (const pages of Object.values(src)) for (const p of pages) for (const g of p.groups) for (const k of g.keys) if (!schema.options[k]) unknown.push(k);
    expect(unknown).toEqual([]);
  });
});

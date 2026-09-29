/**
 * Build the concrete settings layout for a schema: hand/generated layout
 * filtered to the schema, per-extruder pages expanded, and every remaining
 * key of the tab's scope collected into auto "Other" groups so nothing is
 * unreachable.
 */
import type { ConfigSchema, EngineId } from '../../engine/types';
import { tabOfScope } from '../../presets/resolve';
import { orcaLayout } from './orca';
import { preflightLayout } from './preflight';
import type { BuiltGroup, BuiltLayout, BuiltPage, BuiltTab, EngineLayoutSource, SettingsTabId } from './types';

// FullSpectrum is OrcaSlicer-based: Orca's layout; its extra (mixed filament) keys land in the auto groups.
export const LAYOUTS: Record<EngineId, EngineLayoutSource> = { orca: orcaLayout, preflight: preflightLayout, fullspectrum: orcaLayout };

/** Keys that are preset bookkeeping, never shown as editable settings. */
export const HIDDEN_KEYS: ReadonlySet<string> = new Set([
  'inherits', 'print_settings_id', 'filament_settings_id', 'printer_settings_id',
  'compatible_machine_expression_group', 'compatible_process_expression_group', 'inherits_group',
  'different_settings_to_system', 'print_compatible_printers', 'preset_name', 'preset_names',
]);

const SOURCE_OF: Record<SettingsTabId, keyof EngineLayoutSource> = { process: 'print', filament: 'filament', printer: 'machine' };
const TITLES: Record<SettingsTabId, string> = { process: 'Process', filament: 'Filament', printer: 'Printer' };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

export function tabIdOfScope(scope: string | undefined): SettingsTabId | null {
  const k = tabOfScope(scope as never);
  return k === 'printer' ? 'printer' : k === 'process' ? 'process' : k === 'filament' ? 'filament' : null;
}

export function buildLayout(schema: ConfigSchema, engine: EngineId, extruders = 1): BuiltLayout {
  const src = LAYOUTS[engine];
  const out = {} as BuiltLayout;
  for (const tab of ['process', 'filament', 'printer'] as SettingsTabId[]) {
    const belongs = (k: string) => !!schema.options[k] && tabIdOfScope(schema.options[k].scope) === tab && !HIDDEN_KEYS.has(k);
    const used = new Set<string>();
    const pages: BuiltPage[] = [];
    for (const p of src[SOURCE_OF[tab]]) {
      const groups = (idx?: number): BuiltGroup[] => p.groups.map((g, gi) => ({
        id: `${tab}:${slug(p.title)}${idx !== undefined ? `-${idx}` : ''}:${gi}-${slug(g.title)}`,
        title: g.title,
        keys: g.keys.filter(belongs),
      })).filter((g) => g.keys.length);
      const base = groups();
      if (!base.length) continue;
      for (const g of base) for (const k of g.keys) used.add(k);
      if (p.extruder && tab === 'printer') {
        for (let i = 0; i < Math.max(1, extruders); i++) {
          pages.push({ id: `${tab}:${slug(p.title)}-${i}`, title: extruders > 1 || p.title === 'Extruder' ? `Extruder ${i + 1}` : p.title, groups: groups(i), extruder: i });
        }
      } else {
        pages.push({ id: `${tab}:${slug(p.title)}`, title: p.title, groups: base });
      }
    }
    // Everything else of this scope → "Other", grouped by category.
    const rest = Object.keys(schema.options).filter((k) => belongs(k) && !used.has(k));
    if (rest.length) {
      const byCat = new Map<string, string[]>();
      for (const k of rest) {
        const c = schema.options[k].category || 'Other';
        let l = byCat.get(c);
        if (!l) byCat.set(c, (l = []));
        l.push(k);
      }
      const label = (k: string) => schema.options[k].fullLabel || schema.options[k].label || k;
      const groups: BuiltGroup[] = [...byCat.entries()]
        .sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)))
        .map(([c, keys]) => ({ id: `${tab}:other:${slug(c)}`, title: c, keys: keys.sort((a, b) => label(a).localeCompare(label(b))), auto: true }));
      pages.push({ id: `${tab}:other`, title: 'Other', groups });
    }
    const built: BuiltTab = { id: tab, kind: tab === 'printer' ? 'printer' : tab, title: TITLES[tab], pages };
    out[tab] = built;
  }
  return out;
}

/** Where a key lives in the layout (first occurrence). */
export interface KeyLocation { tab: SettingsTabId; pageId: string; groupId: string }

export function locateKeys(layout: BuiltLayout): Map<string, KeyLocation> {
  const m = new Map<string, KeyLocation>();
  for (const tab of Object.values(layout)) {
    for (const p of tab.pages) for (const g of p.groups) for (const k of g.keys) {
      if (!m.has(k)) m.set(k, { tab: tab.id, pageId: p.id, groupId: g.id });
    }
  }
  return m;
}

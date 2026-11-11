/**
 * G-code placeholder catalogue for the custom G-code editor (Orca
 * EditGCodeDialog::init_params_list), from ./placeholders.generated.ts
 * (extracted from Orca's PrintConfig.cpp): slicing states, print statistics,
 * objects info, dimensions, temperatures, timestamps, the variables specific
 * to one G-code field, and every preset option (from the engine schema,
 * grouped by settings page).
 */
import type { ConfigSchema } from '../../engine/types';
import type { BuiltLayout, SettingsTabId } from '../../settings/layout/types';
import { isVectorType } from '../../presets/values';
import { orcaPlaceholderGroups, orcaSpecificPlaceholders, type PlaceholderDef } from './placeholders.generated';

export interface PlaceholderItem {
  key: string;
  label: string;
  tooltip: string;
  /** Vector options are inserted as key[] (index inside the brackets). */
  vector: boolean;
}
export interface PlaceholderGroup {
  id: string;
  title: string;
  icon: string;
  items: PlaceholderItem[];
  groups?: PlaceholderGroup[];
}

type Def = PlaceholderDef;
const G = orcaPlaceholderGroups;
const SPECIFIC_DEFS: Record<string, Def> = Object.fromEntries(G.specific.map((d) => [d[0], d]));

const LAYER = ['layer_num', 'layer_z', 'max_layer_z'];
/**
 * Placeholders specific to one G-code option: Orca's s_CustomGcodeSpecificPlaceholders (generated), plus
 * preFlight's PrusaSlicer-named options mapped onto the same definitions.
 */
export const SPECIFIC_PLACEHOLDERS: Record<string, string[]> = {
  ...orcaSpecificPlaceholders,
  start_gcode: [], end_gcode: [...LAYER], before_layer_gcode: LAYER, layer_gcode: LAYER, toolchange_gcode: [...LAYER, 'next_extruder', 'previous_extruder'],
  start_filament_gcode: ['filament_extruder_id'], end_filament_gcode: [...LAYER, 'filament_extruder_id'],
};

const items = (defs: Def[]): PlaceholderItem[] => defs.map(([key, vector, label, tooltip]) => ({ key, vector, label, tooltip }));

const TAB_OF_SCOPE: Record<string, SettingsTabId> = { print: 'process', object: 'process', filament: 'filament', machine: 'printer' };

/** The placeholder tree for the G-code option `gcodeKey`. */
export function placeholderTree(gcodeKey: string, schema: ConfigSchema | null, layout: BuiltLayout | null): PlaceholderGroup[] {
  const out: PlaceholderGroup[] = [
    { id: 'state-global', title: '[Global] Slicing state', icon: 'i-lucide-globe', items: [], groups: [
      { id: 'state-ro', title: 'Read only', icon: 'i-lucide-lock', items: items(G.readOnlyStates) },
      { id: 'state-rw', title: 'Read write', icon: 'i-lucide-lock-open', items: items(G.readWriteStates) },
    ] },
    { id: 'state', title: 'Slicing state', icon: 'i-lucide-layers', items: items(G.otherStates) },
    { id: 'stats', title: 'Print statistics', icon: 'i-lucide-chart-no-axes-column', items: items(G.statistics) },
    { id: 'objects', title: 'Objects info', icon: 'i-lucide-box', items: items(G.objects) },
    { id: 'dimensions', title: 'Dimensions', icon: 'i-lucide-ruler', items: items(G.dimensions) },
    { id: 'temperatures', title: 'Temperatures', icon: 'i-lucide-thermometer', items: items(G.temperatures) },
    { id: 'timestamps', title: 'Timestamps', icon: 'i-lucide-clock', items: items(G.timestamps) },
  ];
  const specific = (SPECIFIC_PLACEHOLDERS[gcodeKey] ?? []).map((k) => SPECIFIC_DEFS[k]).filter(Boolean);
  if (specific.length) out.splice(0, 0, { id: 'specific', title: `Specific for ${gcodeKey}`, icon: 'i-lucide-file-code', items: items(specific) });

  // Presets: every option, grouped like the settings tabs.
  const presets: PlaceholderGroup = { id: 'presets', title: 'Presets', icon: 'i-lucide-settings', items: items(G.presets), groups: [] };
  if (schema) {
    const titles: Record<SettingsTabId, string> = { process: 'Print settings', filament: 'Filament settings', printer: 'Printer settings' };
    const icons: Record<SettingsTabId, string> = { process: 'i-lucide-layers', filament: 'i-lucide-disc', printer: 'i-lucide-printer' };
    for (const tab of ['process', 'filament', 'printer'] as SettingsTabId[]) {
      const inTab = Object.entries(schema.options).filter(([, d]) => TAB_OF_SCOPE[d.scope] === tab && d.type !== 'none');
      const keysInTab = new Set(inTab.map(([k]) => k));
      const seen = new Set<string>();
      const sub: PlaceholderGroup[] = [];
      for (const page of layout?.[tab]?.pages ?? []) {
        const keys = [...new Set(page.groups.flatMap((g) => g.keys))].filter((k) => keysInTab.has(k) && !seen.has(k));
        keys.forEach((k) => seen.add(k));
        if (keys.length) sub.push({ id: `p-${tab}-${page.id}`, title: page.title, icon: 'i-lucide-list', items: keys.sort().map((k) => optItem(schema, k)) });
      }
      const rest = inTab.map(([k]) => k).filter((k) => !seen.has(k)).sort();
      presets.groups!.push({ id: `p-${tab}`, title: titles[tab], icon: icons[tab], items: rest.map((k) => optItem(schema, k)), groups: sub });
    }
  }
  out.push(presets);
  return out;
}

function optItem(schema: ConfigSchema, key: string): PlaceholderItem {
  const d = schema.options[key];
  return { key, vector: isVectorType(d.type), label: d.fullLabel || d.label || key, tooltip: d.tooltip };
}

/** Text inserted for an item: `{key}` / `{key[]}`, or bare `key` / `key[]` inside an existing `{…}` / `[…]`. */
export function insertionText(item: PlaceholderItem, insideBraces: boolean): string {
  const core = item.vector ? `${item.key}[]` : item.key;
  return insideBraces ? core : `{${core}}`;
}

/** Whether offset `pos` of `text` sits inside an unclosed `{` or `[` placeholder bracket. */
export function insideBraces(text: string, pos: number): boolean {
  const before = text.slice(0, pos);
  const open = Math.max(before.lastIndexOf('{'), before.lastIndexOf('['));
  const close = Math.max(before.lastIndexOf('}'), before.lastIndexOf(']'));
  return open > close && !before.slice(open).includes('\n');
}

/** Case-insensitive filter over key, label and tooltip; empty groups dropped. */
export function filterTree(groups: PlaceholderGroup[], q: string): PlaceholderGroup[] {
  const s = q.trim().toLowerCase();
  if (!s) return groups;
  const hit = (i: PlaceholderItem) => i.key.toLowerCase().includes(s) || i.label.toLowerCase().includes(s);
  const walk = (g: PlaceholderGroup): PlaceholderGroup | null => {
    const its = g.items.filter(hit);
    const sub = (g.groups ?? []).map(walk).filter((x): x is PlaceholderGroup => !!x);
    return its.length || sub.length ? { ...g, items: its, groups: sub } : null;
  };
  return groups.map(walk).filter((x): x is PlaceholderGroup => !!x);
}

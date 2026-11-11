/**
 * Capability configuration (OrcaSlicer PluginConfig.cpp):
 *
 *  - global: orca_plugins/config.json = {"config": [{plugin_key, capability,
 *    capability_type, plugin_version, cap_config}, …]}, written with one tab of
 *    indent and a trailing newline; entries sorted by (plugin_key, capability, type);
 *    unrecognised entries are kept verbatim.
 *  - per preset: the same entry array as a string option of the edited preset
 *    (`print_plugin_config_overrides`, …; Orca 2.5 schema keys).
 *  - effective = the preset override when present, else the global entry, else {}.
 *    Only capability types that a plugin-backed preset option references can be
 *    overridden per preset: in 2.5 that is `slicing_pipeline_plugin` (process
 *    preset, type slicing-pipeline). Scripts are global only.
 */
import type { CapabilityId, CapabilityType } from '../types';

export interface ConfigEntry { id: CapabilityId; pluginVersion: string; config: unknown }

const TYPES: CapabilityType[] = ['printer-connection', 'pages', 'analysis', 'importer', 'exporter', 'visualization', 'script', 'slicing-pipeline', 'resource-texture', 'unknown'];
const typeOrder = (t: CapabilityType) => TYPES.indexOf(t);
export const capabilityTypeFromString = (s: string): CapabilityType => {
  const l = s.toLowerCase() as CapabilityType;
  return TYPES.includes(l) ? l : 'unknown';
};

const idKey = (id: CapabilityId) => `${id.pluginKey}\u0000${id.name}\u0000${id.type}`;

export class CapabilityConfigDocument {
  /** Recognised entries, kept as their raw JSON objects (unknown keys survive a rewrite). */
  private entries = new Map<string, { id: CapabilityId; raw: Record<string, unknown> }>();
  private opaque: unknown[] = [];

  static fromEntries(entries: unknown): CapabilityConfigDocument {
    const d = new CapabilityConfigDocument();
    if (!Array.isArray(entries)) return d;
    for (const e of entries) {
      if (e && typeof e === 'object' && !Array.isArray(e)) {
        const o = e as Record<string, unknown>;
        const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
        const id: CapabilityId = { pluginKey: s('plugin_key'), name: s('capability'), type: capabilityTypeFromString(s('capability_type')) };
        if (id.pluginKey && id.name) { d.entries.set(idKey(id), { id, raw: o }); continue; }
      }
      d.opaque.push(e);
    }
    return d;
  }

  static fromRootJson(root: unknown): CapabilityConfigDocument {
    if (!root || typeof root !== 'object') return new CapabilityConfigDocument();
    return CapabilityConfigDocument.fromEntries((root as Record<string, unknown>).config);
  }

  /** Parse config.json text; anything unreadable starts empty (Orca logs and starts empty). */
  static parseFile(text: string | null): CapabilityConfigDocument {
    if (!text) return new CapabilityConfigDocument();
    try { return CapabilityConfigDocument.fromRootJson(JSON.parse(text)); } catch { return new CapabilityConfigDocument(); }
  }

  /** parse_plugin_overrides: '' = empty; throws on invalid JSON / non-array (Orca's messages). */
  static parseOverrides(raw: string): CapabilityConfigDocument {
    if (!raw) return new CapabilityConfigDocument();
    let j: unknown;
    try { j = JSON.parse(raw); } catch { throw new Error('The preset stores invalid plugin capability configuration JSON.'); }
    if (!Array.isArray(j)) throw new Error("The preset's plugin capability configuration is not an array and cannot be edited.");
    return CapabilityConfigDocument.fromEntries(j);
  }

  find(id: CapabilityId): ConfigEntry | null {
    const e = this.entries.get(idKey(id)) ?? (id.type !== 'unknown' ? this.entries.get(idKey({ ...id, type: 'unknown' })) : undefined);
    if (!e) return null;
    const v = e.raw.cap_config;
    return { id, pluginVersion: typeof e.raw.plugin_version === 'string' ? e.raw.plugin_version : '', config: v === undefined ? {} : v };
  }

  upsert(entry: ConfigEntry): void {
    if (!entry.id.pluginKey || !entry.id.name || entry.id.type === 'unknown') return;
    this.entries.delete(idKey({ ...entry.id, type: 'unknown' }));
    const prev = this.entries.get(idKey(entry.id))?.raw ?? {};
    this.entries.set(idKey(entry.id), {
      id: entry.id,
      raw: { ...prev, plugin_key: entry.id.pluginKey, capability: entry.id.name, capability_type: entry.id.type, plugin_version: entry.pluginVersion, cap_config: entry.config },
    });
  }

  erase(id: CapabilityId): boolean {
    let any = this.entries.delete(idKey(id));
    if (id.type !== 'unknown') any = this.entries.delete(idKey({ ...id, type: 'unknown' })) || any;
    return any;
  }

  /** Drop entries whose (type, name) is not referenced (prune_unreferenced). */
  pruneUnreferenced(referenced: Array<[CapabilityType, string]>): boolean {
    const keep = new Set(referenced.map(([t, n]) => `${t}\u0000${n}`));
    let changed = false;
    for (const [k, e] of this.entries) if (!keep.has(`${e.id.type}\u0000${e.id.name}`)) { this.entries.delete(k); changed = true; }
    return changed;
  }

  /** Remove every entry of a plugin (on delete). */
  erasePlugin(pluginKey: string): boolean {
    let changed = false;
    for (const [k, e] of this.entries) if (e.id.pluginKey === pluginKey) { this.entries.delete(k); changed = true; }
    return changed;
  }

  get empty(): boolean { return this.entries.size === 0 && this.opaque.length === 0; }

  serializeEntries(): unknown[] {
    const sorted = [...this.entries.values()].sort((a, b) =>
      a.id.pluginKey < b.id.pluginKey ? -1 : a.id.pluginKey > b.id.pluginKey ? 1
        : a.id.name < b.id.name ? -1 : a.id.name > b.id.name ? 1 : typeOrder(a.id.type) - typeOrder(b.id.type));
    return [...sorted.map((e) => sortKeys(e.raw)), ...this.opaque];
  }

  /** config.json text: root_json().dump(1, '\t') + "\n". */
  toFile(): string { return JSON.stringify({ config: this.serializeEntries() }, null, '\t') + '\n'; }

  /** serialize_plugin_overrides: '' when empty, else the compact entry array. */
  toOverrides(): string { return this.empty ? '' : JSON.stringify(this.serializeEntries()); }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/** Orca 2.5: which preset option holds overrides for a capability type (null = global only). */
export function presetOverrideScope(type: CapabilityType): { kind: 'process' | 'filament' | 'printer'; key: string } | null {
  // slicing_pipeline_plugin is a print (process) option with plugin_type "slicing-pipeline"
  // (PrintConfig.cpp:6013-6021); its overrides live in print_plugin_config_overrides (Preset.cpp:1758-1763).
  return type === 'slicing-pipeline' ? { kind: 'process', key: 'print_plugin_config_overrides' } : null;
}

export interface EffectiveConfig {
  config: unknown;
  hasPresetOverride: boolean;
  hasBaseConfig: boolean;
  storedPluginVersion: string;
}

/** PresetPluginConfigService::get_effective_config */
export function effectiveConfig(global: CapabilityConfigDocument, overrides: CapabilityConfigDocument | null, id: CapabilityId): EffectiveConfig {
  const base = global.find(id);
  const over = overrides?.find(id) ?? null;
  if (over) return { config: over.config, hasPresetOverride: true, hasBaseConfig: !!base, storedPluginVersion: over.pluginVersion };
  return { config: base ? base.config : {}, hasPresetOverride: false, hasBaseConfig: !!base, storedPluginVersion: base?.pluginVersion ?? '' };
}

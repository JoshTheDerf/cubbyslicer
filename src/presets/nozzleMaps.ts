/**
 * Orca 2.5 nozzle bookkeeping desktop does between its GUI and Print::apply
 * (docs/ENGINE-CONTRACT.md "Extruder variants" / "Nozzle racks and Hybrid
 * extruders"), as pure functions over a flat config:
 *
 * - `extruder_nozzle_stats`: one "<type>#<count>|…" string per extruder on a
 *   printer with a nozzle rack (`extruder_max_nozzle_count` > 1). Desktop seeds
 *   it on every printer load (MultiNozzleSync seedExtruderNozzleStats: each
 *   extruder `extruder_max_nozzle_count` × its type, a Hybrid extruder all
 *   Standard); the user splits a Hybrid rack per type. The project keeps it.
 * - `filament_volume_map`: one NozzleVolumeType id per filament; default each
 *   filament's extruder's `nozzle_volume_type`
 *   (PresetBundle::get_default_nozzle_volume_types_for_filaments).
 * - `filament_nozzle_map` (Nozzle Manual): one physical nozzle per filament.
 * - `flush_multiplier`: one value per extruder (the matrix is sized elsewhere);
 *   absent = desktop's project default 0.3, extra extruders 1.0.
 */
import type { ConfigSchema, ConfigValue, FlatConfig } from '../engine/types';
import { NOZZLE_VOLUME_TYPE_IDS, asList, nozzleVolumeTypeName, toNumber } from '../lib/configValue';

/** One extruder's rack: nozzle count per volume type name ("Standard" → 3). */
export type NozzleCounts = Record<string, number>;

/** Nozzle types in NozzleVolumeType order (the order desktop lists a rack's nozzles in). */
const TYPE_ORDER = Object.keys(NOZZLE_VOLUME_TYPE_IDS).filter((t) => t !== 'Hybrid').sort((a, b) => NOZZLE_VOLUME_TYPE_IDS[a] - NOZZLE_VOLUME_TYPE_IDS[b]);

const list = (v: ConfigValue | undefined) => asList(v);
const ints = (v: ConfigValue | undefined) => list(v).map((s) => Math.trunc(toNumber(s, NaN)));

/** `extruder_max_nozzle_count` per extruder (nil / missing = 1). */
export function maxNozzleCounts(cfg: FlatConfig, extruders: number): number[] {
  const mx = list(cfg.extruder_max_nozzle_count);
  return Array.from({ length: extruders }, (_, e) => {
    const n = Math.trunc(toNumber(mx[e] ?? mx[0], 1));
    return Number.isFinite(n) && n >= 1 && n < 1000 ? n : 1;
  });
}

/** The printer has an extruder with a nozzle rack (cfg_has_multi_nozzle_extruder). */
export function hasNozzleRack(cfg: FlatConfig): boolean {
  return maxNozzleCounts(cfg, Math.max(1, list(cfg.nozzle_diameter).length)).some((n) => n > 1);
}

/** get_extruder_nozzle_stats for one entry; malformed tokens are skipped. */
export function parseNozzleStats(s: string): NozzleCounts {
  const out: NozzleCounts = {};
  for (const tok of s.split('|')) {
    const m = /^(.+)#(\d+)$/.exec(tok.trim());
    if (!m || !TYPE_ORDER.includes(m[1])) continue;
    const n = parseInt(m[2], 10);
    if (n > 0) out[m[1]] = (out[m[1]] ?? 0) + n;
  }
  return out;
}

export function formatNozzleStats(c: NozzleCounts): string {
  return TYPE_ORDER.filter((t) => (c[t] ?? 0) > 0).map((t) => `${t}#${c[t]}`).join('|');
}

export const nozzleTotal = (c: NozzleCounts) => Object.values(c).reduce((a, b) => a + b, 0);

/** seedExtruderNozzleStats: each extruder its max nozzle count of its type (Hybrid → Standard). */
export function seedNozzleStats(volumeTypes: readonly string[], max: readonly number[]): string[] {
  return max.map((n, e) => {
    const t = volumeTypes[e] && volumeTypes[e] !== 'Hybrid' ? volumeTypes[e] : 'Standard';
    return `${t}#${n}`;
  });
}

/**
 * The project's stats when they fit the printer (one valid entry per extruder,
 * no more nozzles than the rack holds, per-type counts for a Hybrid extruder),
 * else the seed. An entry that doesn't fit is reseeded on its own.
 */
export function effectiveNozzleStats(own: readonly string[] | undefined, volumeTypes: readonly string[], max: readonly number[]): string[] {
  const seed = seedNozzleStats(volumeTypes, max);
  // Desktop only reseeds missing stats; an extruder may hold no nozzles (ManualNozzleCountDialog) as long
  // as another one has some — then it is written `<type>#0`, as save_extruder_nozzle_stats_to_string does.
  const totals = seed.map((_, e) => nozzleTotal(parseNozzleStats(own?.[e] ?? '')));
  const others = (e: number) => totals.some((t, k) => k !== e && t > 0 && t <= max[k]);
  return seed.map((s, e) => {
    const c = parseNozzleStats(own?.[e] ?? '');
    const total = totals[e];
    if (total === 0 && own?.[e] !== undefined && others(e)) {
      const t = volumeTypes[e] && volumeTypes[e] !== 'Hybrid' ? volumeTypes[e] : 'Standard';
      return `${t}#0`;
    }
    if (total === 0 || total > max[e]) return s;
    // A single-type extruder holds only its own type (onNozzleVolumeTypeSwitch).
    const t = volumeTypes[e];
    if (t && t !== 'Hybrid' && Object.keys(c).some((k) => k !== t)) return s;
    return formatNozzleStats(c);
  });
}

/** onNozzleVolumeTypeSwitch: switching an extruder to one type makes all its nozzles that type (Hybrid keeps the split). */
export function statsAfterTypeSwitch(stats: readonly string[], extruder: number, type: string, max: number): string[] {
  if (type === 'Hybrid') return stats.slice();
  const next = stats.slice();
  const total = nozzleTotal(parseNozzleStats(stats[extruder] ?? '')) || max;
  next[extruder] = `${type}#${total}`;
  return next;
}

/** Physical nozzles in desktop's order (extruders in order, each by type in NozzleVolumeType order). */
export function nozzleList(stats: readonly string[]): Array<{ extruder: number; type: string }> {
  const out: Array<{ extruder: number; type: string }> = [];
  stats.forEach((s, e) => {
    const c = parseNozzleStats(s);
    for (const t of TYPE_ORDER) for (let k = 0; k < (c[t] ?? 0); k++) out.push({ extruder: e, type: t });
  });
  return out;
}

/**
 * Finish a slice config's nozzle maps (idempotent): the shape the engine
 * requires on a multi-extruder / rack printer. `filament_volume_map` keeps the
 * sent entries that are valid and fills the rest from each filament's
 * extruder; in Manual mode a filament on a single-type extruder takes that
 * type. Nozzle Manual gets a concrete volume map and a `filament_nozzle_map`
 * (each filament its extruder's first nozzle of its type) when the sent one
 * doesn't fit.
 */
export function finishNozzleMaps(cfg: FlatConfig, schema: ConfigSchema | null = null): FlatConfig {
  const has = (key: string) => !schema || key in schema.options;
  const out: FlatConfig = { ...cfg };
  const extruders = Math.max(1, list(cfg.nozzle_diameter).length);
  const filaments = Math.max(1, list(cfg.filament_diameter).length || list(cfg.filament_colour).length);
  const vt = Array.from({ length: extruders }, (_, e) => list(cfg.nozzle_volume_type)[e] ?? 'Standard');
  const mode = list(cfg.filament_map_mode)[0] ?? '';

  // Desktop: the project's multipliers (default 0.3), resized to the extruder count with 1.0
  // (Plater on_extruders_count_changed; ToolOrdering does the same with a short list).
  if (has('flush_multiplier')) {
    const own = list(cfg.flush_multiplier);
    const base = own.length ? own : (schema?.options.flush_multiplier?.default ?? '0.3').split(',').filter(Boolean);
    out.flush_multiplier = Array.from({ length: extruders }, (_, e) => base[e] ?? '1');
  }

  let fmap = ints(cfg.filament_map).map((e) => (e >= 1 && e <= extruders ? e : 1));
  if (fmap.length !== filaments) fmap = Array.from({ length: filaments }, (_, i) => fmap[i] ?? 1);
  if (cfg.filament_map !== undefined || extruders > 1) out.filament_map = fmap.map(String);

  const rack = hasNozzleRack(cfg);
  let stats: string[] | null = null;
  if (rack && has('extruder_nozzle_stats')) {
    stats = effectiveNozzleStats(cfg.extruder_nozzle_stats === undefined ? undefined : list(cfg.extruder_nozzle_stats), vt, maxNozzleCounts(cfg, extruders));
    out.extruder_nozzle_stats = stats;
  }

  if (!has('filament_volume_map') || (extruders === 1 && !rack && cfg.filament_volume_map === undefined)) return out;
  const valid = new Set(Object.values(NOZZLE_VOLUME_TYPE_IDS));
  const sent = ints(cfg.filament_volume_map);
  const vmap = Array.from({ length: filaments }, (_, f) => {
    const e = fmap[f] - 1;
    const extType = vt[e] ?? 'Standard';
    const dflt = NOZZLE_VOLUME_TYPE_IDS[extType] ?? 0;
    const own = sent[f];
    if (own === undefined || !valid.has(own)) return dflt;
    if ((mode === 'Manual' || mode === 'Nozzle Manual') && extType !== 'Hybrid') return dflt;
    return own;
  });

  if (mode === 'Nozzle Manual' && stats) {
    const nozzles = nozzleList(stats);
    const of = (e: number, t: string) => nozzles.findIndex((n) => n.extruder === e && n.type === t);
    const firstOf = (e: number) => nozzles.findIndex((n) => n.extruder === e);
    const nsent = ints(cfg.filament_nozzle_map);
    // A sent map stays when it names a nozzle of each filament's extruder; the volume map then follows it.
    const fits = nsent.length === filaments && nsent.every((n, f) => nozzles[n]?.extruder === fmap[f] - 1);
    const nmap = fits ? nsent : Array.from({ length: filaments }, (_, f) => {
      const e = fmap[f] - 1;
      const i = vmap[f] === NOZZLE_VOLUME_TYPE_IDS.Hybrid ? -1 : of(e, nozzleVolumeTypeName(vmap[f]));
      return i >= 0 ? i : Math.max(0, firstOf(e));
    });
    nmap.forEach((n, f) => { const t = nozzles[n]?.type; if (t) vmap[f] = NOZZLE_VOLUME_TYPE_IDS[t]; });
    out.filament_nozzle_map = nmap.map(String);
  }
  out.filament_volume_map = vmap.map(String);
  return out;
}

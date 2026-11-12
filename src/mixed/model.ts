/**
 * Orca 2.5 mixed filaments as plain per-slot config (PrintConfig.cpp
 * `filament_is_mixed`, `filament_mixed_*`; Plater.cpp
 * `create_mixed_filament_from_result` / `edit_mixed_filament`;
 * FilamentMixer.cpp). A mixed filament is a filament slot at the tail of the
 * list: its components are physical filaments (1-based), printed in
 * sub-layers or alternating layers by ratio (`enable_mixed_color_sublayer`),
 * optionally as a gradient over Z. Objects, parts, height ranges and colour
 * painting use its slot number like any filament's.
 *
 * In the presets store the physical slots are `selection.filaments`; the
 * mixed tail lives only in the project values, as the Orca vectors over every
 * slot (physical entries false / ''), so autosaves and project files carry
 * exactly what desktop Orca writes to project_settings.config.
 */
import { shallowReactive } from 'vue';
import type { ConfigValue, FlatConfig } from '../engine/types';
import type { PresetValues } from '../presets/types';
import { blendColours, gradientRamp, linearCurve, parseGradientCurve, serializeGradientCurve, type GradientAnchor } from './mixer';

export const IS_MIXED = 'filament_is_mixed';
/** Per-slot keys of a mixed filament, in Orca's order. */
export const MIXED_SLOT_KEYS = [
  IS_MIXED, 'filament_mixed_components', 'filament_mixed_sublayer_ratios', 'filament_mixed_gradient',
  'filament_mixed_gradient_range', 'filament_mixed_gradient_curve', 'filament_mixed_gradient_per_part',
] as const;
const BOOL_KEYS = new Set<string>([IS_MIXED, 'filament_mixed_gradient', 'filament_mixed_gradient_per_part']);

/** MixedFilamentDialog limits. */
export const MAX_COMPONENTS = 3;
export const MIN_COMPONENT_RATIO = 10;
/** EnforcerBlockerType::ExtruderMax: physical + mixed slots. */
export const MAX_FILAMENT_SLOTS = 32;

export interface MixedDef {
  /** Physical filaments, 1-based (0 = a component whose filament was deleted). */
  components: number[];
  /** Integer percentages, one per component, summing to 100. */
  ratios: number[];
  /** Ratio varies over Z (two components only). */
  gradient: boolean;
  /** A→B: the first component fades out towards the top; B→A the other way round. */
  direction: 'ab' | 'ba';
  /** Custom curve of the first component's share over Z; [] = the direction's straight line. */
  curve: GradientAnchor[];
  /** Gradient per part of an assembly instead of over the whole object. */
  perPart: boolean;
  /**
   * The slot's stored swatch (project `filament_colour`), shown while the mix can't blend (fewer than two
   * components or one that isn't a physical filament): Orca recomputes a mix's colour from its components
   * only when it is intact and otherwise keeps the stored one (Sidebar::update_mixed_filament_list), e.g.
   * the colour a published 3MF seeds an unassigned mixed filament with.
   */
  colour?: string;
}

export interface MixedFilament extends MixedDef {
  /** Filament number (slot, 1-based). */
  id: number;
  /** Display colour: the blend of the components' current colours. */
  color: string;
}

// ---- reading / writing the project vectors ------------------------------------------------

const list = (v: ConfigValue | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const truthy = (s: string | undefined) => s === '1' || s === 'true';

/** Integer percentages from "0.7000,0.3000" (Plater: `(int)(v * 100 + 0.5)`); even split when they don't match. */
export function parseRatios(s: string, n: number): number[] {
  const r = (s ?? '').split(',').map((t) => parseFloat(t)).filter((v) => Number.isFinite(v)).map((v) => Math.trunc(v * 100 + 0.5));
  if (r.length === n && n > 0) return r;
  return evenRatios(n);
}

export function evenRatios(n: number): number[] {
  if (n <= 0) return [];
  const each = Math.trunc(100 / n);
  const out = new Array<number>(n).fill(each);
  out[0] += 100 - each * n;
  return out;
}

/** `format_mixed_ratios`: weights normalised to 1, four decimals. */
export function formatRatios(weights: readonly number[]): string {
  let sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) sum = 100;
  return weights.map((w) => (Math.fround(w) / Math.fround(sum)).toFixed(4)).join(',');
}

export function parseComponents(s: string): number[] {
  return (s ?? '').split(',').map((t) => parseInt(t, 10)).filter((v) => Number.isInteger(v) && v >= 0);
}

/** The mixed slots of a config / project, in slot order, with their slot index (0-based). */
export function readMixedSlots(v: Record<string, ConfigValue | undefined>): Array<{ index: number; def: MixedDef }> {
  const flags = list(v[IS_MIXED]);
  const at = (k: string, i: number) => list(v[k])[i] ?? '';
  const out: Array<{ index: number; def: MixedDef }> = [];
  flags.forEach((f, i) => {
    if (!truthy(f)) return;
    const components = parseComponents(at('filament_mixed_components', i));
    const gradient = truthy(at('filament_mixed_gradient', i)) && components.length === 2;
    const [r0, r1] = at('filament_mixed_gradient_range', i).split(',').map(parseFloat);
    const def: MixedDef = {
      components,
      ratios: parseRatios(at('filament_mixed_sublayer_ratios', i), components.length),
      gradient,
      direction: Number.isFinite(r0) && Number.isFinite(r1) && r0 < r1 ? 'ba' : 'ab',
      curve: gradient ? parseGradientCurve(at('filament_mixed_gradient_curve', i)) : [],
      perPart: gradient && truthy(at('filament_mixed_gradient_per_part', i)),
    };
    // A mix that can't blend keeps its stored swatch.
    const stored = at('filament_colour', i);
    if ((components.length < 2 || components.includes(0)) && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(stored)) def.colour = stored;
    out.push({ index: i, def });
  });
  return out;
}

/** A curve worth storing: not the direction's own straight line (`serialize_mixed_gradient_curve_if_custom`). */
function customCurve(d: MixedDef): string {
  if (!d.gradient || d.components.length !== 2 || d.curve.length < 2) return '';
  const lin = linearCurve(d.direction);
  const eps = 1e-4;
  const isDefault = d.curve.length === 2 && d.curve.every((a, i) =>
    Math.abs(a.x - lin[i].x) < eps && Math.abs(a.y - lin[i].y) < eps && !Number.isFinite(a.mIn) && !Number.isFinite(a.mOut));
  return isDefault ? '' : serializeGradientCurve(d.curve);
}

/** The per-slot values of one mixed filament, as Orca writes them. */
export function slotValues(d: MixedDef): Record<(typeof MIXED_SLOT_KEYS)[number], string> {
  const gradient = d.gradient && d.components.length === 2;
  return {
    filament_is_mixed: '1',
    filament_mixed_components: d.components.join(','),
    filament_mixed_sublayer_ratios: formatRatios(d.ratios),
    filament_mixed_gradient: gradient ? '1' : '0',
    filament_mixed_gradient_range: gradient ? (d.direction === 'ab' ? '0.9000,0.1000' : '0.1000,0.9000') : '',
    filament_mixed_gradient_curve: gradient ? customCurve(d) : '',
    filament_mixed_gradient_per_part: gradient && d.perPart ? '1' : '0',
  };
}

/** Physical entries of a per-slot project list (the entries not flagged mixed), in order. */
export function physicalEntries(project: PresetValues, key: string): string[] {
  const flags = list(project[IS_MIXED]);
  return list(project[key]).filter((_, i) => !truthy(flags[i]));
}

/**
 * Lay the project's per-slot lists out as `physical` slots followed by
 * `mixed` (Orca keeps mixes at the tail). `filament_colour` keeps its
 * physical entries ('' = the preset's colour), padded / cut to `physical`;
 * `mixedColours` are the mixes' display colours. With no mixes the mixed
 * keys are removed and `filament_colour` lists only the physical slots.
 */
export function writeMixedLayout(project: PresetValues, physical: number, mixed: readonly MixedDef[], mixedColours: readonly string[]): void {
  const colours = physicalEntries(project, 'filament_colour').slice(0, physical);
  while (colours.length < physical) colours.push('');
  if (!mixed.length) {
    for (const k of MIXED_SLOT_KEYS) delete project[k];
    if (colours.some((c) => c)) project.filament_colour = colours; else delete project.filament_colour;
    return;
  }
  const rows = mixed.map(slotValues);
  for (const k of MIXED_SLOT_KEYS) {
    const blank = BOOL_KEYS.has(k) ? '0' : '';
    project[k] = [...new Array<string>(physical).fill(blank), ...rows.map((r) => r[k])];
  }
  project.filament_colour = [...colours, ...mixed.map((_, i) => mixedColours[i] ?? '#808080')];
}

/**
 * Orca `remap_mixed_components_on_delete`: physical filament `removed`
 * (1-based) is gone; components pointing at it become 0 (broken), later ones
 * shift down.
 */
export function remapOnDelete(defs: readonly MixedDef[], removed: number): MixedDef[] {
  return defs.map((d) => ({ ...d, components: d.components.map((c) => (c === removed ? 0 : c > removed ? c - 1 : c)) }));
}

// ---- colours ------------------------------------------------------------------------------

/**
 * Lab-measured blends (`lookup_measured_blend_color`, in the engine only): a
 * source registered by the store asks the engine once per colour set and
 * ratios; the answer lands here and every computed colour re-evaluates.
 */
type MeasuredSource = (hexes: string[], weights: number[]) => Promise<string | null>;
const measuredBlends = shallowReactive(new Map<string, string>());
const measuredAsked = new Set<string>();
let measuredSource: MeasuredSource | null = null;
export function setMeasuredBlendSource(fn: MeasuredSource | null): void { measuredSource = fn; }

/** `blend_mixed_color`: the mix's display colour from the physical colours (1-based components). */
export function mixedColour(d: Pick<MixedDef, 'components' | 'ratios' | 'colour'>, physicalColours: readonly string[]): string {
  if (d.colour && (d.components.length < 2 || d.components.some((c) => c < 1 || c > physicalColours.length))) return d.colour;
  const hexes = d.components.map((c) => (c >= 1 && c <= physicalColours.length ? physicalColours[c - 1] : '#808080'));
  if (measuredSource && hexes.length >= 2) {
    const key = `${hexes.join(',').toUpperCase()}|${d.ratios.join(',')}`;
    const m = measuredBlends.get(key);
    if (m) return m;
    if (!measuredAsked.has(key)) {
      measuredAsked.add(key); // plain set: no reactive write while a computed evaluates
      measuredSource(hexes, [...d.ratios]).then((c) => { if (c) measuredBlends.set(key, c.toUpperCase()); }, () => { /* keep the local blend */ });
    }
  }
  return blendColours(hexes, d.ratios);
}

/** The curve a gradient is sampled with: its custom curve, else the direction's line (`mixed_gradient_curve`). */
export function effectiveCurve(d: Pick<MixedDef, 'curve' | 'direction'>): GradientAnchor[] {
  return d.curve.length >= 2 ? d.curve : linearCurve(d.direction);
}

/** Colours over the height (bottom → top) for a gradient mix, or [] when it isn't one. */
export function mixedRamp(d: MixedDef, physicalColours: readonly string[], steps = 24): string[] {
  if (!d.gradient || d.components.length !== 2) return [];
  const col = (c: number) => physicalColours[c - 1] ?? '#D9D9D9';
  return gradientRamp(col(d.components[0]), col(d.components[1]), effectiveCurve(d), steps);
}

/** CSS background for a swatch: the ramp bottom → top, or the plain colour. */
export function swatchCss(m: MixedFilament, physicalColours: readonly string[]): string {
  const ramp = mixedRamp(m, physicalColours);
  if (!ramp.length) return m.color;
  const step = 100 / ramp.length;
  return `linear-gradient(to top, ${ramp.map((c, i) => `${c} ${(i * step).toFixed(1)}% ${((i + 1) * step).toFixed(1)}%`).join(', ')})`;
}

export function mixedLabel(m: Pick<MixedDef, 'components' | 'ratios' | 'gradient' | 'direction'>): string {
  if (m.gradient && m.components.length === 2) {
    const [a, b] = m.direction === 'ab' ? m.components : [m.components[1], m.components[0]];
    return `${a || '—'} → ${b || '—'}`;
  }
  return m.components.map((c, i) => `${c || '—'} (${m.ratios[i] ?? 0}%)`).join(' + ');
}

// ---- checks (Plater update_mixed_filament_list) ----------------------------------------------

export interface MixedProblem { id: number; reason: 'missing' | 'types' }

/**
 * `check_mixed_filament_integrity` (components must be 2+ existing physical
 * filaments) and `check_mixed_filament_type_consistency` (one filament type).
 */
export function mixedProblems(mixed: readonly MixedFilament[], physicalTypes: readonly string[]): MixedProblem[] {
  const out: MixedProblem[] = [];
  for (const m of mixed) {
    if (m.components.length < 2 || m.components.some((c) => c < 1 || c > physicalTypes.length)) { out.push({ id: m.id, reason: 'missing' }); continue; }
    if (new Set(m.components.map((c) => physicalTypes[c - 1] || 'PLA')).size > 1) out.push({ id: m.id, reason: 'types' });
  }
  return out;
}

/** Why a definition can't be saved (MixedFilamentDialog OK button), or null. */
export function defError(d: MixedDef, physicalTypes: readonly string[]): string | null {
  const n = d.components.length;
  if (n < 2 || n > MAX_COMPONENTS) return `Mix 2 to ${MAX_COMPONENTS} filaments.`;
  if (d.components.some((c) => c < 1 || c > physicalTypes.length)) return 'Please select a filament for all components';
  if (new Set(d.components).size !== n) return 'Use each filament once.';
  // Ratios read back from a file are rounded to whole percent (33 + 33 + 33): allow that much slack.
  if (d.ratios.length !== n || Math.abs(d.ratios.reduce((a, b) => a + b, 0) - 100) >= n) return 'The ratios must add up to 100 %.';
  if (!d.gradient && d.ratios.some((r) => r < MIN_COMPONENT_RATIO)) return `Each filament needs at least ${MIN_COMPONENT_RATIO} %.`;
  return typeMismatchMessage(d.components, physicalTypes);
}

/**
 * MixedFilamentDialog `update_ok_button_state`: the components' slots grouped
 * by type (types in sorted order), or null when they are all one type.
 */
export function typeMismatchMessage(components: readonly number[], physicalTypes: readonly string[]): string | null {
  const groups = new Map<string, number[]>();
  for (const c of components) {
    if (c < 1 || c > physicalTypes.length) continue;
    const t = physicalTypes[c - 1] || 'PLA';
    const g = groups.get(t);
    if (g) g.push(c); else groups.set(t, [c]);
  }
  if (groups.size <= 1) return null;
  const parts = [...groups.keys()].sort().map((t) => `Slot ${groups.get(t)!.join(', ')} (${t})`).join('; ');
  return `Different filament types cannot be mixed: ${parts}. Please select the same filament type.`;
}

/**
 * "Mixing Recommendations" (MixedFilamentDialog::rebuild_recommendation_items):
 * same-type pairs at 50/50, or with three components same-type triples at
 * 25/25/50 with each filament taking the 50 % in turn. Support filaments
 * (type ending in "-S") are left out; at most 100.
 */
export function recommendations(colours: readonly string[], types: readonly string[], three: boolean): Array<{ components: number[]; ratios: number[]; color: string }> {
  const groups = new Map<string, number[]>();
  colours.forEach((_, i) => {
    const t = types[i] || 'PLA';
    if (t.endsWith('-S')) return;
    const g = groups.get(t);
    if (g) g.push(i); else groups.set(t, [i]);
  });
  const out: Array<{ components: number[]; ratios: number[]; color: string }> = [];
  const add = (idx: number[], ratios: number[]) => {
    if (out.length >= 100) return;
    const components = idx.map((i) => i + 1);
    out.push({ components, ratios, color: mixedColour({ components, ratios }, colours) });
  };
  for (const g of [...groups.keys()].sort().map((k) => groups.get(k)!)) {
    for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) {
      if (!three) { add([g[a], g[b]], [50, 50]); continue; }
      for (let c = b + 1; c < g.length; c++) {
        const idx = [g[a], g[b], g[c]];
        for (let dom = 0; dom < 3; dom++) add([idx[(dom + 1) % 3], idx[(dom + 2) % 3], idx[dom]], [25, 25, 50]);
      }
    }
  }
  return out;
}

// ---- the slice config -------------------------------------------------------------------------

/** Matrix of `n`×`n` per nozzle → `total`×`total`, the extra (mixed) rows and columns 0: mixed slots never flush. */
export function expandFlushMatrix(flat: readonly string[], n: number, total: number, nozzles: number): string[] | null {
  if (total <= n || flat.length !== n * n * nozzles) return null;
  const out: string[] = [];
  for (let z = 0; z < nozzles; z++) {
    for (let r = 0; r < total; r++) for (let c = 0; c < total; c++) out.push(r < n && c < n ? flat[z * n * n + r * n + c] : '0');
  }
  return out;
}

/**
 * Finish a resolved config whose filament vectors already carry the mixed
 * slots (component 1's preset): the mixed vectors, the blended colours
 * (`filament_colour`, `filament_multi_colour`) and the flush matrix over every
 * slot (WipeTowerDialog: N×N per nozzle, physical rows / columns used).
 */
export function withMixedSlots(cfg: FlatConfig, physical: number, mixed: readonly MixedFilament[], flushKey: string | null, nozzles: number): FlatConfig {
  if (!mixed.length) return cfg;
  const total = physical + mixed.length;
  const out: FlatConfig = { ...cfg };
  const rows = mixed.map(slotValues);
  for (const k of MIXED_SLOT_KEYS) out[k] = [...new Array<string>(physical).fill(BOOL_KEYS.has(k) ? '0' : ''), ...rows.map((r) => r[k])];
  for (const k of ['filament_colour', 'filament_multi_colour']) {
    if (!(k in out)) continue;
    const cur = list(out[k]).slice(0, physical);
    while (cur.length < physical) cur.push(cur[cur.length - 1] ?? '');
    out[k] = [...cur, ...mixed.map((m) => m.color)];
  }
  if (flushKey && out[flushKey] !== undefined) {
    const e = expandFlushMatrix(list(out[flushKey]), physical, total, Math.max(1, nozzles));
    if (e) out[flushKey] = e;
  }
  return out;
}

// ---- desktop project files ----------------------------------------------------------------

/**
 * Split a desktop project's filament slots (project_settings.config) into
 * physical slots (their config indices, in order) and mixed filaments, with
 * components renumbered to physical filament numbers (desktop may have moved
 * mixes off the tail, `mixed_slot_relocations`; anything not physical becomes
 * 0, i.e. missing).
 */
export function splitProjectSlots(settings: Record<string, ConfigValue | undefined>, slotCount: number): { physical: number[]; mixed: MixedDef[] } {
  const slots = readMixedSlots(settings);
  const mixedAt = new Set(slots.map((s) => s.index));
  const physical = Array.from({ length: slotCount }, (_, i) => i).filter((i) => !mixedAt.has(i));
  const toPhysical = (c: number) => physical.indexOf(c - 1) + 1;
  return { physical, mixed: slots.filter((s) => s.index < slotCount).map((s) => ({ ...s.def, components: s.def.components.map(toPhysical) })) };
}

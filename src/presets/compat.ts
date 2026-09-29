/**
 * Preset compatibility (Orca Preset.cpp is_compatible_with_printer /
 * is_compatible_with_print):
 *
 *  - library filament excluded for this printer (m_excluded_from) → incompatible
 *  - compatible_printers empty + condition set → evaluate condition against the
 *    printer config (+ printer_preset, num_extruders); eval error → compatible
 *  - compatible_printers empty → compatible
 *  - otherwise the printer name (or, for user printers, their system parent) must be listed
 *  - filaments additionally: compatible_prints / compatible_prints_condition vs the print preset
 *
 * Conditions are evaluated through an injected evaluator (engine
 * cs_eval_condition via the worker). Evaluations are deduplicated per
 * (expression, config) and run with bounded concurrency; `null` (could not
 * evaluate) counts as compatible.
 */
import type { FlatConfig } from '../engine/types';
import type { PresetInfo } from './types';
import { mapLimit } from './util';

export type ConditionEvaluator = (expr: string, config: FlatConfig) => Promise<boolean | null>;

export interface CompatContext {
  printerName: string;
  /** System parent of a user printer (Orca is_compatible_with_parent_printer). */
  printerParentName?: string;
  /** Printer config the printer condition is evaluated against. */
  printerConfig: FlatConfig;
  /** Selected print (process) preset — for filament compatible_prints*. */
  printName?: string;
  printConfig?: FlatConfig;
  evaluate: ConditionEvaluator | null;
}

/** Config hash key for the evaluation cache (stable, cheap enough for ~800 keys). */
function hashConfig(cfg: FlatConfig): string {
  let h = 2166136261 >>> 0;
  const keys = Object.keys(cfg).sort();
  for (const k of keys) {
    const v = cfg[k];
    const s = `${k}=${Array.isArray(v) ? v.join('\u0001') : v}\u0002`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  }
  return `${keys.length}:${h.toString(36)}`;
}

const evalCache = new Map<string, Promise<boolean | null>>();
const EVAL_CACHE_MAX = 5000;

export function clearCompatCache(): void { evalCache.clear(); }

async function evaluateAll(exprs: string[], config: FlatConfig, evaluate: ConditionEvaluator | null): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  const uniq = [...new Set(exprs.filter((e) => e.trim() !== ''))];
  if (!uniq.length) return out;
  if (!evaluate) { for (const e of uniq) out.set(e, null); return out; }
  const h = hashConfig(config);
  await mapLimit(uniq, 4, async (expr) => {
    const key = `${h}|${expr}`;
    let p = evalCache.get(key);
    if (!p) {
      if (evalCache.size > EVAL_CACHE_MAX) evalCache.clear();
      p = evaluate(expr, config).catch(() => null);
      evalCache.set(key, p);
    }
    out.set(expr, await p);
  });
  return out;
}

export function withPrinterPlaceholders(printerConfig: FlatConfig, printerName: string): FlatConfig {
  const nd = printerConfig.nozzle_diameter;
  const n = Array.isArray(nd) ? nd.length : nd ? String(nd).split(',').length : 1;
  return { ...printerConfig, printer_preset: printerName, num_extruders: String(Math.max(1, n)) };
}

/** Pure structural check (no conditions). `undefined` = needs condition evaluation. */
export function printerListCompat(p: PresetInfo, ctx: Pick<CompatContext, 'printerName' | 'printerParentName'>): boolean | undefined {
  const names = [ctx.printerName, ctx.printerParentName].filter((x): x is string => !!x);
  if (p.excludedPrinters?.length && names.some((n) => p.excludedPrinters!.includes(n))) return false;
  const list = p.compatiblePrinters ?? [];
  if (!list.length) return p.compatiblePrintersCondition ? undefined : true;
  return names.some((n) => list.includes(n));
}

export function printListCompat(p: PresetInfo, printName: string | undefined): boolean | undefined {
  const list = p.compatiblePrints ?? [];
  if (list.length) return !printName || list.includes(printName);
  return p.compatiblePrintsCondition ? undefined : true;
}

/** Filter presets by compatibility with the current printer (and print, for filaments). */
export async function filterCompatible(presets: PresetInfo[], ctx: CompatContext): Promise<PresetInfo[]> {
  const printerCfg = withPrinterPlaceholders(ctx.printerConfig, ctx.printerName);
  const needPrinter: string[] = [];
  const needPrint: string[] = [];
  const pre = presets.map((p) => {
    if (p.source === 'default') return { p, a: true as boolean | undefined, b: true as boolean | undefined };
    const a = printerListCompat(p, ctx);
    if (a === undefined) needPrinter.push(p.compatiblePrintersCondition!);
    const b = p.kind === 'filament' ? printListCompat(p, ctx.printName) : true;
    if (b === undefined) needPrint.push(p.compatiblePrintsCondition!);
    return { p, a, b };
  });
  const [rPrinter, rPrint] = await Promise.all([
    evaluateAll(needPrinter, printerCfg, ctx.evaluate),
    evaluateAll(needPrint, { ...printerCfg, ...(ctx.printConfig ?? {}) }, ctx.evaluate),
  ]);
  return pre.filter(({ p, a, b }) => {
    const okA = a ?? (rPrinter.get(p.compatiblePrintersCondition!) ?? null) !== false;
    const okB = b ?? (rPrint.get(p.compatiblePrintsCondition!) ?? null) !== false;
    return okA && okB;
  }).map(({ p }) => p);
}

/**
 * Enable / show rules for settings rows (Orca ConfigManipulation and
 * Tab*::toggle_options). The generated table lists every toggle call in
 * source order; running them in order with "last call wins" reproduces
 * Orca's imperative toggling without the GUI.
 */
import type { EngineId } from '../../engine/types';
import { CppError, evalCpp, truthy, type CppEnv, type CppValue } from './cpp';
import { builtins, CHOICES, EXTRA_RULES, HAND_LOCALS, HELPERS, type Choices } from './orca';
import { orcaRulesGenerated } from './orca.generated';
import type { RowState, RuleContext, RuleFamily, RuleText, RulesSource } from './types';

export type { RowState, RuleContext, RuleFamily } from './types';
export { coupledEdits } from './orca';

const SOURCES: Partial<Record<EngineId, RulesSource>> = { orca: orcaRulesGenerated };

/** Identifier resolution for one evaluation: builtins → hand-ported locals → extracted locals → enums → helpers. */
export function makeEnv(source: RulesSource, family: RuleFamily, ctx: RuleContext): CppEnv & { local(name: string): CppValue } {
  const b = builtins(ctx);
  const memo = new Map<string, CppValue>();
  const hand = HAND_LOCALS[family];
  const locals = source[family].locals;
  const env: CppEnv & { local(name: string): CppValue } = {
    read: (scope, key) => ctx.read(scope, key),
    ident(name) {
      if (name in b) return b[name];
      if (memo.has(name)) return memo.get(name);
      let v: CppValue | undefined;
      if (hand[name]) v = hand[name].eval(ctx, (n) => env.local(n));
      else if (locals[name] !== undefined) v = evalCpp(locals[name], env);
      else if (source.enums[name] !== undefined) return source.enums[name];
      else if (name in HELPERS) return HELPERS[name];
      else return undefined;
      memo.set(name, v);
      return v;
    },
    local(name) {
      const v = env.ident(name);
      if (v === undefined) throw new CppError(`unknown identifier ${name}`);
      return v;
    },
  };
  return env;
}

function text(t: RuleText | undefined, env: CppEnv): string | undefined {
  if (t === undefined || typeof t === 'string') return t || undefined;
  return text(truthy(evalCpp(t.if, env)) ? t.then : t.else, env);
}

const warned = new Set<string>();
function safe(cond: string, env: CppEnv, vars?: Record<string, CppValue>): boolean {
  try {
    return truthy(evalCpp(cond, env, vars));
  } catch (e) {
    // A condition the evaluator can't run leaves the row as it is (the rules test catches these).
    if (!warned.has(cond)) { warned.add(cond); console.warn(`settings rules: ${(e as Error).message}`); }
    return true;
  }
}

export interface EvaluateOptions {
  /** Apply `show` rules (Orca's per-object panel can't hide rows; it only greys them out). */
  hide?: boolean;
  /** Only these keys (skips the rest of the table). */
  keys?: ReadonlySet<string>;
}

/** Row states of one family; keys without a rule are absent. */
export function evaluateRules(engine: EngineId, family: RuleFamily, ctx: RuleContext, opts: EvaluateOptions = {}): Map<string, RowState> {
  const out = new Map<string, RowState>();
  const source = SOURCES[engine];
  if (!source) return out;
  const env = makeEnv(source, family, ctx);
  const hide = opts.hide ?? true;
  const state = (key: string) => { let s = out.get(key); if (!s) out.set(key, (s = {})); return s; };
  const reasons = new Map<string, { hidden?: string; disabled?: string }>();
  for (const t of source[family].toggles) {
    if (opts.keys && !opts.keys.has(t.key)) continue;
    if (t.kind === 'show' && !hide) continue;
    const vars = { $key: t.key };
    if (t.guards && !t.guards.every((g) => safe(g, env, vars))) continue;
    if (t.kind === 'label') {
      try { const l = text(t.text, env); if (l) state(t.key).label = l; } catch { /* keep the schema label */ }
      continue;
    }
    const on = safe(t.when!, env, vars);
    const s = state(t.key);
    const r = reasons.get(t.key) ?? {};
    let why: string | undefined;
    try { why = on ? undefined : text(t.reason, env); } catch { why = undefined; }
    if (t.kind === 'show') { s.hidden = !on; r.hidden = why; } else { s.disabled = !on; r.disabled = why; }
    reasons.set(t.key, r);
  }
  for (const x of EXTRA_RULES[family]) {
    if (x.kind === 'show' && !hide) continue;
    let on = true;
    try { on = x.when(ctx); } catch { on = true; }
    for (const key of x.keys) {
      if (opts.keys && !opts.keys.has(key)) continue;
      const s = state(key);
      const r = reasons.get(key) ?? {};
      if (x.kind === 'show') { s.hidden = !on; r.hidden = on ? undefined : x.reason; } else { s.disabled = !on; r.disabled = on ? undefined : x.reason; }
      reasons.set(key, r);
    }
  }
  for (const [key, s] of out) {
    const r = reasons.get(key);
    s.reason = s.hidden ? r?.hidden : s.disabled ? r?.disabled : undefined;
    if (!s.hidden) delete s.hidden;
    if (!s.disabled) delete s.disabled;
    if (!s.reason) delete s.reason;
    if (!s.hidden && !s.disabled && !s.label) out.delete(key);
  }
  return out;
}

/** Narrowed enum choices for a key (support style by support type, …), or null. */
export function choicesFor(engine: EngineId, family: RuleFamily, key: string, ctx: RuleContext): Choices | null {
  if (!SOURCES[engine]) return null;
  const f = CHOICES[family][key];
  try { return f ? f(ctx) : null; } catch { return null; }
}
